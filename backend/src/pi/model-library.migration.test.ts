/**
 * Tests de migration du bloc `concurrency` de model-library.ts.
 *
 * Objectif : toute config existante sur disque doit survivre au passage
 * aux limites LLM par provider — `providerMaxLLMSlots` est normalisé à {}
 * quand absent, les entrées invalides sont ignorées, et une config déjà
 * complète n'est pas altérée. migrateLibrary est une pure function
 * (exportée pour les tests) : aucun disque n'est touché ici.
 */
import { describe, expect, it } from "vitest";
import { migrateLibrary } from "./model-library.js";

describe("migration du bloc concurrency", () => {
  it("JSON legacy sans providerMaxLLMSlots → normalisé avec {}", () => {
    const lib = migrateLibrary({
      models: [{ id: "m1", providerId: "ollama", modelId: "llama3", name: "Llama 3" }],
      defaultModelId: "m1",
      concurrency: { maxLLMSlots: 7 },
    });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 7, providerMaxLLMSlots: {}, queueTimeoutMs: 3_600_000, streamSilenceTimeoutMs: 900_000, agentHardTimeoutMs: 0 });
    expect(lib.defaultModelId).toBe("m1");
  });

  it("sans bloc concurrency du tout → défauts complets", () => {
    const lib = migrateLibrary({ models: [] });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 3, providerMaxLLMSlots: {}, queueTimeoutMs: 3_600_000, streamSilenceTimeoutMs: 900_000, agentHardTimeoutMs: 0 });
  });

  it("concurrency null → défauts complets", () => {
    const lib = migrateLibrary({ models: [], concurrency: null });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 3, providerMaxLLMSlots: {}, queueTimeoutMs: 3_600_000, streamSilenceTimeoutMs: 900_000, agentHardTimeoutMs: 0 });
  });

  it("providerMaxLLMSlots existant est préservé (valeurs valides uniquement)", () => {
    const lib = migrateLibrary({
      models: [],
      concurrency: {
        maxLLMSlots: 3,
        providerMaxLLMSlots: { anthropic: 2, openai: 5, mauvais: 0, negatif: -1, flottant: 2.5 },
      },
    });
    expect(lib.concurrency).toEqual({
      maxLLMSlots: 3,
      providerMaxLLMSlots: { anthropic: 2, openai: 5 },
      queueTimeoutMs: 3_600_000,
      streamSilenceTimeoutMs: 900_000,
      agentHardTimeoutMs: 0,
    });
  });

  it("clé __proto__ dans la map (payload JSON) : ignorée, aucune pollution", () => {
    const data = JSON.parse('{"models":[],"concurrency":{"maxLLMSlots":3,"providerMaxLLMSlots":{"openai":4,"__proto__":9}}}');
    const lib = migrateLibrary(data);
    expect(lib.concurrency.providerMaxLLMSlots).toEqual({ openai: 4 });
    expect(({} as any).polluted).toBeUndefined();
  });

  it("providerMaxLLMSlots non-objet (string/array) → remplacé par {}", () => {
    const lib = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 3, providerMaxLLMSlots: "oops" } });
    expect(lib.concurrency.providerMaxLLMSlots).toEqual({});
    const lib2 = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 3, providerMaxLLMSlots: [1] } });
    expect(lib2.concurrency.providerMaxLLMSlots).toEqual({});
  });

  it("maxLLMSlots invalide (<= 0, non numérique) retombe sur le défaut", () => {
    const lib = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 0 } });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 3, providerMaxLLMSlots: {}, queueTimeoutMs: 3_600_000, streamSilenceTimeoutMs: 900_000, agentHardTimeoutMs: 0 });
    const lib2 = migrateLibrary({ models: [], concurrency: { maxLLMSlots: "beaucoup" } });
    expect(lib2.concurrency).toEqual({ maxLLMSlots: 3, providerMaxLLMSlots: {}, queueTimeoutMs: 3_600_000, streamSilenceTimeoutMs: 900_000, agentHardTimeoutMs: 0 });
  });

  it("config héritée avec maxAgentSlots : chargée sans erreur, clé ignorée puis supprimée à la réécriture", () => {
    // Le réglage « limite de sessions » (maxAgentSlots) a été retiré : une config
    // déjà stockée doit se charger sans crash, ignorer la clé, et la perdre à la
    // prochaine sauvegarde (saveModelLibrary sérialise l'objet normalisé).
    const legacy = {
      models: [],
      concurrency: { maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots: {}, queueTimeoutMs: 3_600_000 },
    };
    const lib = migrateLibrary(legacy);
    expect((lib.concurrency as Record<string, unknown>).maxAgentSlots).toBeUndefined();
    expect(JSON.stringify(lib)).not.toContain("maxAgentSlots");
  });

  it("ancien format (modes) → concurrency par défaut normalisé", () => {
    const lib = migrateLibrary({
      modes: { default: { models: [{ id: "m1", provider: "ollama", modelId: "llama3", name: "Llama 3" }] } },
    });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 3, providerMaxLLMSlots: {}, queueTimeoutMs: 3_600_000, streamSilenceTimeoutMs: 900_000, agentHardTimeoutMs: 0 });
    expect(lib.models).toHaveLength(1);
    expect(lib.defaultModelId).toBe("m1");
  });

  it("config concurrency complète et valide : inchangée", () => {
    const lib = migrateLibrary({
      models: [],
      concurrency: { maxLLMSlots: 10, providerMaxLLMSlots: { openai: 4 }, queueTimeoutMs: 120_000, streamSilenceTimeoutMs: 900_000, agentHardTimeoutMs: 0 },
    });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 10, providerMaxLLMSlots: { openai: 4 }, queueTimeoutMs: 120_000, streamSilenceTimeoutMs: 900_000, agentHardTimeoutMs: 0 });
  });

  it("queueTimeoutMs invalide ou hors bornes → repli sur le défaut (1 h)", () => {
    for (const bad of [0, -1, 1_000, 43_200_001, 1.5, "600000", null]) {
      const lib = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 3, queueTimeoutMs: bad } });
      expect(lib.concurrency.queueTimeoutMs).toBe(3_600_000);
    }
  });
});

// ── Migration de l'ancien défaut d'attente en file (10 min → 1 h) ──
// Une valeur stockée EXACTEMENT égale à l'ancien défaut est « non
// personnalisée » → alignée sur le nouveau défaut ; tout autre délai est un
// choix explicite → préservé. La migration est idempotente.
describe("migration de l'ancien défaut d'attente en file (600000 → 3600000)", () => {
  const queueTimeoutOf = (raw: unknown) =>
    migrateLibrary({ models: [], concurrency: { maxLLMSlots: 3, queueTimeoutMs: raw } })
      .concurrency.queueTimeoutMs;

  it("valeur stockée == ancien défaut (600000) → alignée sur 1 h", () => {
    expect(queueTimeoutOf(600_000)).toBe(3_600_000);
  });

  it("valeurs personnalisées (30 min, 45 min, 5 s, 10 h) → inchangées", () => {
    for (const kept of [1_800_000, 2_700_000, 5_000, 36_000_000]) {
      expect(queueTimeoutOf(kept)).toBe(kept);
    }
  });

  it("idempotente : deux exécutions donnent le même résultat", () => {
    const first = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 3, queueTimeoutMs: 600_000 } });
    const second = migrateLibrary(JSON.parse(JSON.stringify(first)));
    expect(first.concurrency.queueTimeoutMs).toBe(3_600_000);
    expect(second.concurrency.queueTimeoutMs).toBe(3_600_000);
    // Une config déjà personnalisée n'est jamais retouchée, même re-migrée.
    const custom = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 3, queueTimeoutMs: 1_800_000 } });
    expect(migrateLibrary(JSON.parse(JSON.stringify(custom))).concurrency.queueTimeoutMs).toBe(1_800_000);
  });
});
// ── Migration du thinkingLevel par catégorie de routage ──
// Une config historique (sans `thinkingLevel`) reste valide et signifie
// « défaut du mode ». Un `thinkingLevel` valide est préservé ; une valeur
// invalide est ignorée (→ défaut du mode).
describe("migration du thinkingLevel de routage", () => {
  const withRouting = (routing: any) =>
    migrateLibrary({ models: [], projectModes: { p1: { harness: { routing } } } }).projectModes.p1.harness.routing!;

  it("config legacy sans thinkingLevel → catégories sans thinkingLevel (défaut du mode)", () => {
    const routing = withRouting({
      enabled: true,
      trivial: { modelId: "m1" },
      standard: { modelId: "m2" },
      complex: { modelId: "m3" },
      review: { modelId: "m4" },
    });
    expect(routing.trivial).toEqual({ modelId: "m1" });
    expect(routing.standard).toEqual({ modelId: "m2" });
    expect(routing.complex).toEqual({ modelId: "m3" });
    expect(routing.review).toEqual({ modelId: "m4" });
    expect(routing.trivial.thinkingLevel).toBeUndefined();
  });

  it("thinkingLevel valide préservé pour chaque catégorie", () => {
    const routing = withRouting({
      enabled: true,
      trivial: { modelId: "m1", thinkingLevel: "off" },
      standard: { modelId: "m2", thinkingLevel: "low" },
      complex: { modelId: "m3", thinkingLevel: "high" },
      review: { modelId: "m4", thinkingLevel: "max" },
    });
    expect(routing.trivial.thinkingLevel).toBe("off");
    expect(routing.standard.thinkingLevel).toBe("low");
    expect(routing.complex.thinkingLevel).toBe("high");
    expect(routing.review.thinkingLevel).toBe("max");
  });

  it("thinkingLevel invalide ignoré (→ défaut du mode), modelId conservé", () => {
    const routing = withRouting({
      enabled: true,
      standard: { modelId: "m2", thinkingLevel: "turbo" },
      complex: { modelId: "m3", thinkingLevel: 42 },
    });
    expect(routing.standard).toEqual({ modelId: "m2" });
    expect(routing.complex).toEqual({ modelId: "m3" });
  });

  it("même modèle sur plusieurs catégories avec des thinkingLevel différents", () => {
    const routing = withRouting({
      enabled: true,
      trivial: { modelId: "gemma", thinkingLevel: "off" },
      standard: { modelId: "gemma", thinkingLevel: "medium" },
      complex: { modelId: "gemma", thinkingLevel: "high" },
      review: { modelId: "gemma", thinkingLevel: "xhigh" },
    });
    expect(routing.trivial).toEqual({ modelId: "gemma", thinkingLevel: "off" });
    expect(routing.standard).toEqual({ modelId: "gemma", thinkingLevel: "medium" });
    expect(routing.complex).toEqual({ modelId: "gemma", thinkingLevel: "high" });
    expect(routing.review).toEqual({ modelId: "gemma", thinkingLevel: "xhigh" });
  });
});

// ── Migration du thinkingLevel par MODÈLE ──
// `RegisteredModel.thinkingLevel` est optionnel : absent/invalide = « défaut »
// (le niveau de réflexion du mode s'applique). Un niveau valide est préservé.
describe("migration du thinkingLevel par modèle", () => {
  const modelFrom = (rawThinking: unknown) =>
    migrateLibrary({
      models: [{
        id: "m1", providerId: "ollama", modelId: "llama3", name: "Llama 3",
        ...(rawThinking !== undefined ? { thinkingLevel: rawThinking } : {}),
      }],
    }).models[0];

  it("modèle sans thinkingLevel → undefined (défaut du mode)", () => {
    expect(modelFrom(undefined).thinkingLevel).toBeUndefined();
    expect("thinkingLevel" in (modelFrom(undefined) as any)).toBe(false);
  });

  it("thinkingLevel valide préservé", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(modelFrom(level).thinkingLevel).toBe(level);
    }
  });

  it("thinkingLevel invalide (type/ valeur) → undefined", () => {
    expect(modelFrom("turbo").thinkingLevel).toBeUndefined();
    expect(modelFrom(42).thinkingLevel).toBeUndefined();
    expect(modelFrom(null).thinkingLevel).toBeUndefined();
  });
});
