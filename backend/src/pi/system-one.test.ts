/**
 * Classifieur de routage « System One » — client NATIF de l'API de décision.
 *
 * Aucun réseau : `fetch` est mocké (`vi.stubGlobal`). Les fournisseurs sont
 * simulés (module `providers.js` mocké) pour rester indépendant du disque.
 *
 * Ce que cette suite verrouille :
 *   - l'URL (`{base}/v1/systemone`, jamais `/v1/chat/…`) et l'authentification ;
 *   - le corps envoyé (`model` / `state` / `questions` typées, AUCUN contrôle de
 *     génération) ;
 *   - la lecture NATIVE des réponses (`choice` + `probabilities` + `confidence`,
 *     `noul`) et le mapping — fait UNE fois — vers `{category, riskScore,
 *     confidence}` ;
 *   - l'échec HONNÊTE : 401, réseau, réponse inutilisable → `error` non nulle et
 *     AUCUNE décision inventée (repli heuristique visible) ;
 *   - la non-régression du classifieur chat (`classifierType` par défaut).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelLibrary } from "./model-library.js";
import type { ProviderConfig } from "./providers.js";

const providersMock = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock("./providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers.js")>();
  return { ...actual, getProvider: providersMock.getProvider };
});

const {
  askSystemOne,
  buildClassificationQuestions,
  mapAnswersToRoute,
  systemOneEndpoint,
  SystemOneError,
  CATEGORY_QUESTION,
  RISK_QUESTION,
} = await import("./system-one.js");
const { heuristicClassifier, resolveRoute, systemOneClassifier } = await import("./routing.js");
const { extractSignals } = await import("./routing.js");
const { DEFAULT_ROUTING_CONFIG } = await import("./routing-types.js");

// ── Helpers ──

const PROVIDER: ProviderConfig = {
  id: "p-ollama",
  name: "Ollama Cloud",
  type: "openai-compatible",
  baseUrl: "https://ollama.com/v1",
  apiKey: "sk-FOURNISSEUR_SECRET",
};

/** Bibliothèque minimale : un modèle `clef` chez le fournisseur simulé. */
function makeLibrary(modelId = "clef"): ModelLibrary {
  return {
    models: [
      {
        id: `p-ollama__${modelId}`,
        providerId: "p-ollama",
        modelId,
        name: modelId,
        isDefault: true,
        reasoning: false,
        vision: true,
        contextWindow: 65536,
        maxTokens: 0,
      },
    ],
    defaultModelId: `p-ollama__${modelId}`,
    commitModelId: null,
    visionModelId: null,
    audioModelId: null,
    librarianModelId: null,
    projectModes: {},
    concurrency: { maxLLMSlots: 3, providerMaxLLMSlots: {}, queueTimeoutMs: 1000 },
  } as unknown as ModelLibrary;
}

/** Réponse NATIVE conforme à la doc Ollama (choice + noul). */
function nativeAnswers(category: string, confidence: number, risk: number | undefined): unknown {
  return {
    model: "clef",
    answers: {
      [CATEGORY_QUESTION]: {
        type: "choice",
        choice: category,
        probabilities: { trivial: 0.02, standard: 0.05, complex: 0.9, review: 0.03 },
        confidence,
      },
      ...(risk === undefined ? {} : { [RISK_QUESTION]: { type: "noul", noul: risk } }),
    },
    usage: { input_tokens: 120, output_tokens: 0 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  providersMock.getProvider.mockReset();
  providersMock.getProvider.mockReturnValue(PROVIDER);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sentBody(callIndex = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body));
}

function sentInit(callIndex = 0): RequestInit {
  return fetchMock.mock.calls[callIndex][1] as RequestInit;
}

// ── URL ──

describe("systemOneEndpoint — chemin natif de l'API de décision", () => {
  it("`{base}/v1` → `{base}/v1/systemone` (pas `/v1/system`, pas `/chat/completions`)", () => {
    expect(systemOneEndpoint("https://ollama.com/v1")).toBe("https://ollama.com/v1/systemone");
    expect(systemOneEndpoint("http://switchy:3008/v1/")).toBe("http://switchy:3008/v1/systemone");
  });

  it("base sans `/v1` complétée, base vide refusée", () => {
    expect(systemOneEndpoint("http://localhost:11434")).toBe("http://localhost:11434/v1/systemone");
    expect(() => systemOneEndpoint("")).toThrowError(SystemOneError);
  });
});

// ── Corps envoyé ──

describe("schéma de questions du triage", () => {
  it("deux questions nommées, types documentés (choice + noul)", () => {
    const questions = buildClassificationQuestions();
    expect(Object.keys(questions)).toEqual([CATEGORY_QUESTION, RISK_QUESTION]);
    expect(questions[CATEGORY_QUESTION].type).toBe("choice");
    expect(Object.keys(questions[CATEGORY_QUESTION].criteria as object).sort()).toEqual([
      "complex",
      "review",
      "standard",
      "trivial",
    ]);
    expect(questions[RISK_QUESTION].type).toBe("noul");
    // Noms conformes à la contrainte cloud (lettres/chiffres/_/./-, ≤ 100).
    for (const name of Object.keys(questions)) expect(name).toMatch(/^[A-Za-z0-9_.-]{1,100}$/);
  });
});

describe("askSystemOne — requête native", () => {
  it("POST sur /v1/systemone avec Bearer, corps `model`/`state`/`questions` et AUCUN contrôle de génération", async () => {
    fetchMock.mockResolvedValue(jsonResponse(nativeAnswers("complex", 0.88, 0.71)));

    const response = await askSystemOne({
      endpoint: "https://ollama.com/v1/systemone",
      apiKey: "sk-FOURNISSEUR_SECRET",
      request: {
        model: "clef",
        state: "Refactorise le module d'authentification",
        questions: buildClassificationQuestions(),
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://ollama.com/v1/systemone");
    const init = sentInit();
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-FOURNISSEUR_SECRET");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("clef");
    expect(body.state).toBe("Refactorise le module d'authentification");
    expect(body.stream).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages).toBeUndefined(); // jamais converti en chat

    // Réponse NATIVE lue telle quelle.
    expect(response.answers[CATEGORY_QUESTION]).toMatchObject({ choice: "complex", confidence: 0.88 });
    expect(response.answers[RISK_QUESTION]).toMatchObject({ noul: 0.71 });
    expect(response.usage?.input_tokens).toBe(120);
  });

  it("aucune clé configurée → aucun en-tête Authorization (Ollama local n'en exige pas)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(nativeAnswers("standard", 0.9, 0.1)));
    await askSystemOne({
      endpoint: "http://localhost:11434/v1/systemone",
      request: { model: "clef", state: "x", questions: buildClassificationQuestions() },
    });
    expect((sentInit().headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

// ── Échecs honnêtes ──

describe("askSystemOne — échecs typés (jamais de faux succès)", () => {
  it("401 → auth_error avec message lisible, statut conservé", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid api key" }, 401));
    await expect(
      askSystemOne({
        endpoint: "https://ollama.com/v1/systemone",
        apiKey: "mauvaise",
        request: { model: "clef", state: "x", questions: buildClassificationQuestions() },
      }),
    ).rejects.toMatchObject({ code: "auth_error", status: 401 });
  });

  it("402 (crédits) et 404 (modèle) → message explicite", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "payment required" }, 402));
    await expect(
      askSystemOne({
        endpoint: "https://ollama.com/v1/systemone",
        request: { model: "clef", state: "x", questions: buildClassificationQuestions() },
      }),
    ).rejects.toThrowError(/crédits/);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "model not found" }, 404));
    await expect(
      askSystemOne({
        endpoint: "https://ollama.com/v1/systemone",
        request: { model: "inconnu", state: "x", questions: buildClassificationQuestions() },
      }),
    ).rejects.toThrowError(/modèle introuvable/);
  });

  it("réseau injoignable → network_error ; réponse sans `answers` → invalid_response", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(
      askSystemOne({
        endpoint: "https://ollama.com/v1/systemone",
        request: { model: "clef", state: "x", questions: buildClassificationQuestions() },
      }),
    ).rejects.toMatchObject({ code: "network_error" });

    fetchMock.mockResolvedValueOnce(jsonResponse({ model: "clef" }));
    await expect(
      askSystemOne({
        endpoint: "https://ollama.com/v1/systemone",
        request: { model: "clef", state: "x", questions: buildClassificationQuestions() },
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });

    fetchMock.mockResolvedValueOnce(new Response("<html>502</html>", { status: 200 }));
    await expect(
      askSystemOne({
        endpoint: "https://ollama.com/v1/systemone",
        request: { model: "clef", state: "x", questions: buildClassificationQuestions() },
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

// ── Mapping à la frontière ──

describe("mapAnswersToRoute — mapping UNIQUE vers {category, riskScore, confidence}", () => {
  it("choice + noul → catégorie, risque et confiance", () => {
    const route = mapAnswersToRoute(
      {
        [CATEGORY_QUESTION]: { choice: "complex", confidence: 0.88 },
        [RISK_QUESTION]: { noul: 0.71 },
      } as never,
      "clef",
    );
    expect(route.category).toBe("complex");
    expect(route.function).toBe("planning"); // functionForCategory("complex")
    expect(route.confidence).toBeCloseTo(0.88, 5);
    expect(route.riskScore).toBeCloseTo(0.71, 5);
    expect(route.modelId).toBeNull();
    expect(route.reason).toContain("System One");
  });

  it("sans probabilité de risque → riskScore 0 mais motif explicite", () => {
    const route = mapAnswersToRoute(
      { [CATEGORY_QUESTION]: { choice: "standard", confidence: 0.7 } } as never,
      "clef",
    );
    expect(route.riskScore).toBe(0);
    expect(route.reason).toContain("P(risque) indisponible");
  });

  it("catégorie ou confiance absente → SystemOneError (aucune décision inventée)", () => {
    expect(() => mapAnswersToRoute({} as never, "clef")).toThrowError(/sans catégorie exploitable/);
    expect(() =>
      mapAnswersToRoute({ [CATEGORY_QUESTION]: { choice: "peut-être", confidence: 0.9 } } as never, "clef"),
    ).toThrowError(/sans catégorie exploitable/);
    expect(() =>
      mapAnswersToRoute({ [CATEGORY_QUESTION]: { choice: "complex" } } as never, "clef"),
    ).toThrowError(/sans `confidence`/);
  });
});

// ── Classifieur intégré ──

describe("systemOneClassifier — intégration (fetch mocké)", () => {
  it("atteint {base}/v1/systemone avec le modèle RÉEL du fournisseur et `state` = demande", async () => {
    fetchMock.mockResolvedValue(jsonResponse(nativeAnswers("complex", 0.9, 0.2)));

    const result = await systemOneClassifier(
      "Refactorise le module d'authentification",
      makeLibrary("clef"),
      "p-ollama__clef",
    );

    expect(result.error).toBeNull();
    expect(result.route?.category).toBe("complex");
    expect(result.route?.confidence).toBeCloseTo(0.9, 5);
    expect(fetchMock.mock.calls[0][0]).toBe("https://ollama.com/v1/systemone");
    const body = sentBody();
    expect(body.model).toBe("clef");
    expect(body.state).toBe("Refactorise le module d'authentification");
  });

  it("via Switchy (baseUrl de la passerelle) : même chemin, `model` = nom du service", async () => {
    providersMock.getProvider.mockReturnValue({
      id: "p-switchy",
      name: "Switchy",
      type: "openai-compatible",
      baseUrl: "http://switchy:3008/v1",
      apiKey: "switchy-cle",
    } as ProviderConfig);
    fetchMock.mockResolvedValue(jsonResponse(nativeAnswers("trivial", 0.95, 0.05)));

    const library = makeLibrary("triage");
    library.models[0].providerId = "p-switchy";
    library.models[0].id = "p-switchy__triage";
    const result = await systemOneClassifier("renomme la variable", library, "p-switchy__triage");

    expect(result.route?.category).toBe("trivial");
    expect(fetchMock.mock.calls[0][0]).toBe("http://switchy:3008/v1/systemone");
    expect(sentBody().model).toBe("triage");
    expect((sentInit().headers as Record<string, string>).Authorization).toBe("Bearer switchy-cle");
  });

  it("échec 401 → error renseignée et route NULL (repli heuristique visible)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid api key" }, 401));

    const result = await systemOneClassifier("corrige le bug", makeLibrary(), "p-ollama__clef");
    expect(result.route).toBeNull();
    expect(result.error).toContain("401");
    expect(result.error).toContain("clé du fournisseur refusée");

    // Le repli produit une décision HEURISTIQUE assumée (motif « heuristique »),
    // jamais un motif « classifieur LLM ».
    const signals = extractSignals({});
    const route = resolveRoute("corrige le bug", { ...DEFAULT_ROUTING_CONFIG }, signals, result.route);
    expect(route.reason).toContain("heuristique");
    expect(route.reason).not.toContain("classifieur LLM");
    expect(route).toEqual(heuristicClassifier("corrige le bug", signals));
  });

  it("réponse inutilisable → error explicite (pas de décision plausible fabriquée)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ model: "clef", answers: {} }));
    const result = await systemOneClassifier("corrige le bug", makeLibrary(), "p-ollama__clef");
    expect(result.route).toBeNull();
    expect(result.error).toContain("sans catégorie exploitable");
  });

  it("modèle absent de la bibliothèque → error, aucun appel réseau", async () => {
    const result = await systemOneClassifier("corrige le bug", makeLibrary(), "p-ollama__fantome");
    expect(result.route).toBeNull();
    expect(result.error).toContain("introuvable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fournisseur absent → error, aucun appel réseau", async () => {
    providersMock.getProvider.mockReturnValue(undefined);
    const result = await systemOneClassifier("corrige le bug", makeLibrary(), "p-ollama__clef");
    expect(result.route).toBeNull();
    expect(result.error).toContain("fournisseur introuvable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("une décision confiante du modèle est bien celle qui s'applique (gate de risque comprise)", () => {
    const signals = extractSignals({});
    const route = mapAnswersToRoute(
      {
        [CATEGORY_QUESTION]: { choice: "standard", confidence: 0.9 },
        [RISK_QUESTION]: { noul: 0.8 },
      } as never,
      "clef",
    );
    const resolved = resolveRoute("ajoute un champ au formulaire", { ...DEFAULT_ROUTING_CONFIG }, signals, route);
    // riskScore 0.8 >= seuil 0.5 → la prudence du modèle force la relecture.
    expect(resolved.category).toBe("review");
    expect(resolved.reason).toContain("System One");
  });
});
