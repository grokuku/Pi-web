/**
 * Tests unitaires de providers.ts.
 *
 * - Les fonctions pures (capacités inférées, presets, vue publique) sont testées
 *   directement.
 * - La persistance touche `.data/providers.json` : le module `fs` est mocké avec
 *   un stockage en mémoire pour ne JAMAIS lire/écrire le vrai disque.
 * - `testProviderConnection` effectue des appels réseau : `fetch` est simulé
 *   (aucun appel HTTP réel).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";

// ── Mock fs : stockage en mémoire PAR CHEMIN (providers.json et
// model-library.json ne doivent pas se marcher dessus) ──
const { fsState } = vi.hoisted(() => ({
  fsState: { files: {} as Record<string, string> },
}));

vi.mock("fs", () => ({
  existsSync: vi.fn((p: string) => Object.prototype.hasOwnProperty.call(fsState.files, p)),
  mkdirSync: vi.fn(() => {}),
  readFileSync: vi.fn((p: string) => fsState.files[p]),
  writeFileSync: vi.fn((p: string, data: string) => {
    fsState.files[p] = data;
  }),
}));

import {
  PROVIDER_PRESETS,
  addProvider,
  deleteProvider,
  getProvider,
  inferContextWindow,
  inferReasoning,
  inferVision,
  loadProviders,
  saveProviders,
  testProviderConnection,
  toPublicProvider,
  updateProvider,
  type ProviderConfig,
} from "./providers.js";

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    name: "Ollama local",
    type: "ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKey: undefined,
    discoveredModels: [],
    connectionStatus: "untested",
    ...overrides,
  };
}

/** Reconstruit le chemin du fichier de données comme le fait le module testé. */
function dataFilePath(fileName: string): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".data", fileName);
}

/** Pré-remplit un fichier de données simulé (comme s'il existait sur disque). */
function seedFile(fileName: string, content: string): void {
  fsState.files[dataFilePath(fileName)] = content;
}

// ── toPublicProvider ─────────────────────────────────

describe("toPublicProvider (masquage de la clé API)", () => {
  it("remplace apiKey par hasApiKey=true et ne fuit jamais la clé", () => {
    const pub = toPublicProvider(makeProvider({ apiKey: "sk-secret-123" }));
    expect(pub.hasApiKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-secret-123");
    expect((pub as Record<string, unknown>).apiKey).toBeUndefined();
    expect(pub.id).toBe("p1"); // le reste de la config est préservé
  });

  it("hasApiKey=false pour un provider sans clé (ollama local)", () => {
    const pub = toPublicProvider(makeProvider({ apiKey: undefined }));
    expect(pub.hasApiKey).toBe(false);
  });
});

// ── PROVIDER_PRESETS ─────────────────────────────────

describe("PROVIDER_PRESETS (cohérence des presets)", () => {
  it("définit les 4 types de providers avec une URL par défaut", () => {
    expect(Object.keys(PROVIDER_PRESETS).sort()).toEqual(
      ["anthropic", "google", "ollama", "openai-compatible"],
    );
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      expect(preset.defaultBaseUrl).toMatch(/^https?:\/\//);
      expect(preset.apiType).toBeTruthy();
      expect(preset.description).toBeTruthy();
    }
  });

  it("seul ollama fonctionne sans clé API", () => {
    expect(PROVIDER_PRESETS.ollama.requiresApiKey).toBe(false);
    expect(PROVIDER_PRESETS["openai-compatible"].requiresApiKey).toBe(true);
    expect(PROVIDER_PRESETS.anthropic.requiresApiKey).toBe(true);
    expect(PROVIDER_PRESETS.google.requiresApiKey).toBe(true);
  });
});

// ── Inférence de capacités (fonctions pures) ─────────

describe("inferReasoning", () => {
  it.each([
    ["deepseek-r1:32b", true],
    ["o3-mini", true],
    ["qwen3-32b", true],
    ["glm-4:cloud", true],
    ["o1", true],
    ["qwq:32b", true],
    ["llama3.1:8b", false],
    ["mistral-7b", false],
  ])("infère reasoning=%s → %s", (modelId, expected) => {
    expect(inferReasoning(modelId)).toBe(expected);
  });

  it("utilise la famille en priorité sur l'id du modèle", () => {
    // L'id est quelconque mais la famille trahit un modèle de raisonnement.
    expect(inferReasoning("custom-build", "Qwen3-8B")).toBe(true);
  });
});

describe("inferVision", () => {
  it.each([
    ["llava:13b", true],
    ["gemma3:7b", true],
    ["qwen2.5-vl:7b", true],
    ["gpt-4o", true],
    ["minicpm-v", true],
    ["deepseek-r1:32b", false],
    ["llama3:8b", false],
  ])("infère vision=%s → %s", (modelId, expected) => {
    expect(inferVision(modelId)).toBe(expected);
  });

  it("la famille prime : un modèle vision détecté même avec un id opaque", () => {
    expect(inferVision("mon-modele", "gemma3")).toBe(true);
  });
});

describe("inferContextWindow", () => {
  it("correspondance exacte dans la table d'overrides", () => {
    expect(inferContextWindow("gpt-4o")).toBe(128000);
    expect(inferContextWindow("claude-sonnet-4")).toBe(200000);
  });

  it("correspondance par préfixe (variantes de version)", () => {
    expect(inferContextWindow("gpt-4o-2024-11-20")).toBe(128000);
    expect(inferContextWindow("llava-13b")).toBe(4096);
  });

  it("les ':' et '_' sont normalisés en '-' avant recherche", () => {
    expect(inferContextWindow("llama3.1:8b")).toBe(128000);
  });

  it("modèle inconnu → valeur par défaut 128000", () => {
    expect(inferContextWindow("modele-totalement-inconnu-xyz")).toBe(128000);
  });

  it("la famille est utilisée comme clé si fournie", () => {
    expect(inferContextWindow("id-opaque", "deepseek-v3")).toBe(128000);
  });

  it("distinctions notables de la table (llama2 limité, kimi 256k)", () => {
    expect(inferContextWindow("llama2-7b")).toBe(4096);
    expect(inferContextWindow("kimi-k2.5")).toBe(256000);
  });
});

// ── Persistance (fs mocké en mémoire) ────────────────

describe("persistance des providers (fs simulé)", () => {
  beforeEach(() => {
    fsState.files = {};
  });

  it("loadProviders retourne [] si aucun fichier n'existe", () => {
    expect(loadProviders()).toEqual([]);
  });

  it("loadProviders retourne [] et logge si le JSON est corrompu", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    seedFile("providers.json", "{ json invalide");
    expect(loadProviders()).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("loadProviders migre les entrées incomplètes (valeurs par défaut)", () => {
    seedFile("providers.json", JSON.stringify({ providers: [{ id: "legacy" }] }));
    const providers = loadProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: "legacy",
      name: "legacy", // retombe sur l'id
      type: "ollama", // type par défaut
      connectionStatus: "untested",
      discoveredModels: [],
      baseUrl: "",
    });
  });

  it("saveProviders puis loadProviders : aller-retour fidèle (clé API conservée)", () => {
    const provider = makeProvider({ apiKey: "sk-test", connectionStatus: "ok" });
    saveProviders([provider]);
    expect(loadProviders()).toEqual([provider]);
  });

  it("addProvider génère un id unique et initialise le statut", () => {
    const created = addProvider({ name: "Groq", type: "openai-compatible", baseUrl: "https://api.groq.com/v1" });
    expect(created.id).toMatch(/^provider_\d+_/);
    expect(created.connectionStatus).toBe("untested");
    expect(created.discoveredModels).toEqual([]);
    // Persisté sur le "disque" simulé
    expect(loadProviders()).toHaveLength(1);
  });

  it("updateProvider fusionne les champs et lève si l'id est inconnu", () => {
    saveProviders([makeProvider()]);
    const updated = updateProvider("p1", { name: "Renommé", connectionStatus: "ok" });
    expect(updated.name).toBe("Renommé");
    expect(updated.type).toBe("ollama"); // inchangé
    expect(() => updateProvider("inconnu", { name: "x" })).toThrow(/Provider not found/);
  });

  it("getProvider retrouve un provider existant, undefined sinon", () => {
    saveProviders([makeProvider()]);
    expect(getProvider("p1")?.id).toBe("p1");
    expect(getProvider("inconnu")).toBeUndefined();
  });

  it("deleteProvider supprime le provider et lève s'il est inconnu", async () => {
    saveProviders([makeProvider(), makeProvider({ id: "p2", name: "Second" })]);
    await expect(deleteProvider("p1")).resolves.toBeUndefined();
    const remaining = loadProviders();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("p2");
    await expect(deleteProvider("inconnu")).rejects.toThrow(/Provider not found/);
  });
});

// ── testProviderConnection (fetch simulé) ────────────

describe("testProviderConnection (aucun appel réseau réel)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fsState.files = {};
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ollama : liste les modèles et enrichit via l'API native /api/show", async () => {
    const provider = makeProvider();
    saveProviders([provider]);

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/show")) {
        // Enrichissement : fenêtre de contexte réelle + architecture
        return {
          ok: true,
          json: async () => ({
            model_info: { "llama.context_length": 131072, "general.architecture": "llama" },
            parameters: "num_ctx 8192",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: "llama3.1:8b", name: "Llama 3.1 8B" }] }),
      };
    });

    const result = await testProviderConnection(provider);
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ id: "llama3.1:8b", name: "Llama 3.1 8B", contextWindow: 131072 });
    // Clé par défaut « ollama » envoyée en Bearer
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer ollama");
    // Le statut ok est persisté
    expect(getProvider("p1")?.connectionStatus).toBe("ok");
    expect(getProvider("p1")?.lastTestedAt).toBeTruthy();
  });

  it("réponse HTTP en erreur → ok:false avec message tronqué", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom".repeat(100) });
    const result = await testProviderConnection(makeProvider());
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toContain("HTTP 500");
    expect(result.error!.length).toBeLessThanOrEqual(210); // texte tronqué à 200 chars
  });

  it("anthropic : aucun appel réseau, liste statique de modèles connus", async () => {
    const provider = makeProvider({ id: "pa", type: "anthropic", baseUrl: "" });
    saveProviders([provider]);
    const result = await testProviderConnection(provider);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.models.map((m) => m.id)).toContain("claude-sonnet-4-20250514");
  });

  it("google sans clé API → erreur immédiate sans appel réseau", async () => {
    const provider = makeProvider({ id: "pg", type: "google", baseUrl: "", apiKey: undefined });
    const result = await testProviderConnection(provider);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, models: [], error: "API key required for Google Gemini" });
  });

  it("google avec clé API : parse models/ et retire le préfixe", async () => {
    const provider = makeProvider({ id: "pg", type: "google", baseUrl: "", apiKey: "g-key" });
    saveProviders([provider]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }),
    });
    const result = await testProviderConnection(provider);
    expect(result.ok).toBe(true);
    expect(result.models[0]).toMatchObject({ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" });
    expect(fetchMock.mock.calls[0][0]).toContain("key=g-key");
  });

  it("échec réseau (fetch rejette) → ok:false et statut error persisté", async () => {
    const provider = makeProvider();
    saveProviders([provider]);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED simulé"));
    const result = await testProviderConnection(provider);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ECONNREFUSED simulé");
    const stored = getProvider("p1");
    expect(stored?.connectionStatus).toBe("error");
    expect(stored?.connectionError).toBe("ECONNREFUSED simulé");
    expect(stored?.lastTestedAt).toBeTruthy();
  });
});