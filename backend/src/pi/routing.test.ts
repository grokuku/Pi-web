/**
 * Tests unitaires de la couche de routage pur (routing.ts).
 * Aucun appel réseau : le classifieur LLM est testé avec un runtime simulé.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractSignals,
  heuristicClassifier,
  isRoutingEnabled,
  llmClassifier,
  pickModel,
  resolveRoute,
} from "./routing.js";
import type { ModelLibrary, RegisteredModel } from "./model-library.js";
import { DEFAULT_ROUTING_CONFIG, type Route, type RoutingConfig, type RoutingSignals } from "./routing-types.js";

// ── Helpers ───────────────────────────────────────────

/** Signaux neutres normalisés (point de départ pour les cas de test). */
const BASE_SIGNALS: RoutingSignals = extractSignals({});

function makeConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return { ...structuredClone(DEFAULT_ROUTING_CONFIG), ...overrides };
}

function makeModel(id: string, overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    id,
    providerId: "prov",
    modelId: id,
    name: id,
    isDefault: false,
    reasoning: false,
    vision: false,
    contextWindow: 128000,
    maxTokens: 16384,
    thinkingLevel: "medium",
    ...overrides,
  };
}

function makeLibrary(models: RegisteredModel[], defaultModelId: string | null): ModelLibrary {
  return {
    models,
    defaultModelId,
    commitModelId: null,
    visionModelId: null,
    audioModelId: null,
    librarianModelId: null,
    projectModes: {},
    concurrency: { maxLLMSlots: 3, maxAgentSlots: 5 },
  };
}

/** Runtime LLM simulé : jamais d'appel réel, réponse contrôlée par le test. */
function makeRuntime(response: unknown = { content: [] }) {
  return {
    getModel: vi.fn(() => ({ id: "simulated" })),
    completeSimple: vi.fn(async () => response),
  };
}

// ── isRoutingEnabled ─────────────────────────────────

describe("isRoutingEnabled (kill switch)", () => {
  const ORIGINAL = process.env.ROUTING_ENABLED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ROUTING_ENABLED;
    else process.env.ROUTING_ENABLED = ORIGINAL;
  });

  it("actif par défaut quand la variable est absente", () => {
    delete process.env.ROUTING_ENABLED;
    expect(isRoutingEnabled()).toBe(true);
  });

  it.each([
    ["0", false],
    ["false", false],
    ["FALSE", false],
  ])("désactivé pour ROUTING_ENABLED=%s", (value, expected) => {
    process.env.ROUTING_ENABLED = value;
    expect(isRoutingEnabled()).toBe(expected);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["", true], // chaîne vide → comportement par défaut (actif)
    ["oui", true], // toute autre valeur non nulle → actif
  ])("activé pour ROUTING_ENABLED=%s", (value, expected) => {
    process.env.ROUTING_ENABLED = value;
    expect(isRoutingEnabled()).toBe(expected);
  });
});

// ── extractSignals ───────────────────────────────────

describe("extractSignals (normalisation)", () => {
  it("retourne des valeurs par défaut pour une entrée vide / undefined", () => {
    expect(extractSignals()).toEqual({
      toolErrorRate: 0,
      spinning: false,
      exploringRatio: 0,
      recentProductionIntensity: 0,
      riskKeywords: false,
      changedFiles: 0,
      diffSize: 0,
      contextUsage: 0,
    });
  });

  it("borne les ratios dans [0,1] et arrondit les compteurs", () => {
    const s = extractSignals({
      toolErrorRate: 1.5, // > 1 → borné à 1
      exploringRatio: -2, // < 0 → borné à 0
      recentProductionIntensity: 3, // → 1
      changedFiles: -5, // négatif → 0
      diffSize: 10.9, // → floor 10
      contextUsage: 0.42,
      spinning: true,
      riskKeywords: true,
    });
    expect(s.toolErrorRate).toBe(1);
    expect(s.exploringRatio).toBe(0);
    expect(s.recentProductionIntensity).toBe(1);
    expect(s.changedFiles).toBe(0);
    expect(s.diffSize).toBe(10);
    expect(s.contextUsage).toBe(0.42);
    expect(s.spinning).toBe(true);
    expect(s.riskKeywords).toBe(true);
  });
});

// ── heuristicClassifier ──────────────────────────────

describe("heuristicClassifier (branches de catégories)", () => {
  it("catégorie review quand le riskScore dépasse le seuil (mots-clés de risque)", () => {
    const route = heuristicClassifier("ajoute une migration SQL pour la table users", BASE_SIGNALS);
    expect(route.category).toBe("review");
    expect(route.function).toBe("review");
    expect(route.riskScore).toBeGreaterThanOrEqual(0.5);
    expect(route.modelId).toBeNull();
  });

  it("catégorie trivial pour une courte demande sans verbe d'action ni fichier", () => {
    const route = heuristicClassifier("explique-moi le fonctionnement de git", BASE_SIGNALS);
    expect(route.category).toBe("trivial");
    expect(route.function).toBe("execute");
    expect(route.confidence).toBe(0.7);
  });

  it("catégorie standard pour un fix localisé (verbe d'action + fichier)", () => {
    const route = heuristicClassifier("corrige le bug dans app.ts", BASE_SIGNALS);
    expect(route.category).toBe("standard");
    expect(route.function).toBe("execute");
    expect(route.confidence).toBe(0.6);
  });

  it("catégorie complex si mot-clé de complexité → fonction planning", () => {
    const route = heuristicClassifier("refactore l'architecture du système", BASE_SIGNALS);
    expect(route.category).toBe("complex");
    expect(route.function).toBe("planning");
    expect(route.confidence).toBe(0.65);
  });

  it("catégorie complex si signal spinning (session qui tourne en boucle)", () => {
    const route = heuristicClassifier("corrige app.ts", extractSignals({ spinning: true }));
    expect(route.category).toBe("complex");
  });

  it("catégorie complex si demande très longue (>= 500 caractères)", () => {
    const route = heuristicClassifier("x".repeat(500), BASE_SIGNALS);
    expect(route.category).toBe("complex");
  });

  it("catégorie complex si taux d'erreur outil élevé", () => {
    const route = heuristicClassifier("corrige app.ts", extractSignals({ toolErrorRate: 0.5 }));
    expect(route.category).toBe("complex");
  });

  it("la trace (reason) contient les signaux normalisés", () => {
    const route = heuristicClassifier("explique-moi le fonctionnement de git", BASE_SIGNALS);
    expect(route.reason).toContain("heuristique: catégorie trivial");
    expect(route.reason).toContain("riskScore=0.10");
    expect(route.reason).toContain("seuil=0.50");
  });
});

// ── llmClassifier (runtime simulé) ───────────────────

describe("llmClassifier (branches d'erreur et succès)", () => {
  it("retourne null sans runtime ou sans classifierModelId", async () => {
    const runtime = makeRuntime();
    await expect(llmClassifier("req", null, "prov__m")).resolves.toBeNull();
    await expect(llmClassifier("req", runtime, "")).resolves.toBeNull();
    expect(runtime.completeSimple).not.toHaveBeenCalled();
  });

  it.each(["noseparator", "__model"])("retourne null pour un id malformé : %s", async (id) => {
    // Pas de `__` exploitable (index <= 0) → pas d'appel LLM.
    const runtime = makeRuntime();
    await expect(llmClassifier("req", runtime, id)).resolves.toBeNull();
    expect(runtime.getModel).not.toHaveBeenCalled();
  });

  it("coupe l'id à la première occurrence de __ (le modelId peut en contenir)", async () => {
    const runtime = makeRuntime({
      content: [{ type: "text", text: '{"category":"standard","riskScore":0.2,"confidence":0.9}' }],
    });
    const route = await llmClassifier("req", runtime, "prov__model__with__underscores");
    expect(route).not.toBeNull();
    // Le provider et le modèle (avec ses __ restants) sont bien extraits.
    expect(runtime.getModel).toHaveBeenCalledWith("prov", "model__with__underscores");
  });

  it("retourne null si le modèle est introuvable dans la bibliothèque du runtime", async () => {
    const runtime = { getModel: () => undefined, completeSimple: vi.fn() };
    await expect(llmClassifier("req", runtime, "prov__ghost")).resolves.toBeNull();
    expect(runtime.completeSimple).not.toHaveBeenCalled();
  });

  it("parse une réponse JSON simple et mappe la catégorie vers la fonction", async () => {
    const runtime = makeRuntime({
      content: [{ type: "text", text: '{"category":"complex","riskScore":0.7,"confidence":0.9}' }],
    });
    const route = await llmClassifier("gros refactoring", runtime, "prov__glm");
    expect(route).toEqual({
      category: "complex",
      function: "planning",
      modelId: null,
      confidence: 0.9,
      riskScore: 0.7,
      reason: "classifieur LLM (prov__glm)",
    });
  });

  it("tolère les code fences ```json, normalise la casse et borne les valeurs", async () => {
    const runtime = makeRuntime({
      content: [
        { type: "text", text: '```json\n{"category":"REVIEW","riskScore":2,"confidence":5}\n```' },
      ],
    });
    const route = await llmClassifier("req", runtime, "prov__m");
    expect(route?.category).toBe("review");
    expect(route?.riskScore).toBe(1); // clamp(2) → 1
    expect(route?.confidence).toBe(1); // clamp(5) → 1
  });

  it("retourne null pour un JSON invalide", async () => {
    const runtime = makeRuntime({ content: [{ type: "text", text: "{'category': standard}" }] });
    await expect(llmClassifier("req", runtime, "prov__m")).resolves.toBeNull();
  });

  it("retourne null si aucun texte dans la réponse", async () => {
    const runtime = makeRuntime({ content: [{ type: "other", text: "ignored" }] });
    await expect(llmClassifier("req", runtime, "prov__m")).resolves.toBeNull();
  });

  it("retourne null pour une catégorie inconnue", async () => {
    const runtime = makeRuntime({
      content: [{ type: "text", text: '{"category":"urgent","riskScore":0.1,"confidence":0.9}' }],
    });
    await expect(llmClassifier("req", runtime, "prov__m")).resolves.toBeNull();
  });

  it("retourne null si riskScore/confidence absents ou non numériques", async () => {
    const runtime = makeRuntime({
      content: [{ type: "text", text: '{"category":"standard","confidence":0.9}' }],
    });
    await expect(llmClassifier("req", runtime, "prov__m")).resolves.toBeNull();
  });

  it("retourne null (avec warning) si l'appel LLM lève une exception", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = {
      getModel: () => ({ id: "m" }),
      completeSimple: async () => {
        throw new Error("timeout réseau simulé");
      },
    };
    await expect(llmClassifier("req", runtime, "prov__m")).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── resolveRoute (fusion LLM / heuristique) ──────────

describe("resolveRoute (fusion et garde-fous)", () => {
  it("utilise la route LLM si sa confiance suffit ; la fonction est recalculée depuis la catégorie", () => {
    const llm: Route = {
      category: "complex",
      function: "execute", // volontairement incohérent : doit être recalculé en planning
      modelId: null,
      confidence: 0.9,
      riskScore: 0.2,
      reason: "llm",
    };
    const route = resolveRoute("refactore le module", makeConfig(), BASE_SIGNALS, llm);
    expect(route.category).toBe("complex");
    expect(route.function).toBe("planning");
    expect(route.reason).toBe("llm");
    // riskScore conservateur : max(LLM, heuristique)
    expect(route.riskScore).toBe(0.2);
  });

  it("retombe sur l'heuristique si la confiance LLM est sous le seuil", () => {
    const llm: Route = {
      category: "review",
      function: "review",
      modelId: null,
      confidence: 0.3, // < seuil 0.6
      riskScore: 0.9,
      reason: "llm peu sûr",
    };
    const route = resolveRoute("corrige le bug dans app.ts", makeConfig(), BASE_SIGNALS, llm);
    expect(route.category).toBe("standard");
    expect(route.reason).toContain("heuristique");
    expect(route.reason).not.toContain("llm peu sûr");
  });

  it("gate review : un riskScore élevé force la catégorie review même si le LLM dit standard", () => {
    const llm: Route = {
      category: "standard",
      function: "execute",
      modelId: null,
      confidence: 0.95,
      riskScore: 0.05,
      reason: "llm",
    };
    // La demande contient des mots-clés de risque → l'heuristique remonte un riskScore >= 0.5.
    const route = resolveRoute("ajoute une migration SQL", makeConfig(), BASE_SIGNALS, llm);
    expect(route.category).toBe("review");
    expect(route.function).toBe("review");
    expect(route.reason).toContain("gate review");
  });

  it("fail-safe : confiance insuffisante → repli standard/execute", () => {
    // « corrige le bug dans app.ts » → heuristique standard avec confiance 0.6 < 0.7.
    const config = makeConfig({ confidenceThreshold: 0.7 });
    const route = resolveRoute("corrige le bug dans app.ts", config, BASE_SIGNALS, null);
    expect(route.category).toBe("standard");
    expect(route.function).toBe("execute");
    expect(route.reason).toContain("confiance insuffisante");
    expect(route.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

// ── pickModel (résolution du modèle cible) ───────────

describe("pickModel (résolution et fallbacks)", () => {
  const stdRoute: Route = {
    category: "standard",
    function: "execute",
    modelId: null,
    confidence: 0.9,
    riskScore: 0.1,
    reason: "",
  };
  const lib = makeLibrary([makeModel("m-std"), makeModel("m-default", { isDefault: true })], "m-default");

  it("retourne le modèle configuré pour la catégorie", () => {
    const config = makeConfig({ standard: { modelId: "m-std" } });
    expect(pickModel(stdRoute, config, lib)?.id).toBe("m-std");
  });

  it("retombe sur le modèle par défaut si l'id configuré est introuvable", () => {
    const config = makeConfig({ standard: { modelId: "id-inconnu" } });
    expect(pickModel(stdRoute, config, lib)?.id).toBe("m-default");
  });

  it("retombe sur le défaut si aucun modèle configuré pour la catégorie", () => {
    expect(pickModel(stdRoute, makeConfig(), lib)?.id).toBe("m-default");
  });

  it("gère une config partielle (clé de catégorie absente) sans lever", () => {
    const partialConfig = { ...makeConfig(), standard: undefined } as unknown as RoutingConfig;
    expect(pickModel(stdRoute, partialConfig, lib)?.id).toBe("m-default");
  });

  it("defaultModelId pendant → retombe sur le premier modèle de la bibliothèque", () => {
    const brokenLib = makeLibrary([makeModel("premier"), makeModel("second")], "model-fantôme");
    expect(pickModel(stdRoute, makeConfig(), brokenLib)?.id).toBe("premier");
  });

  it("bibliothèque vide → null (aucun modèle disponible)", () => {
    expect(pickModel(stdRoute, makeConfig(), makeLibrary([], null))).toBeNull();
  });
});