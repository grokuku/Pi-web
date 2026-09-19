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
      concurrency: { maxLLMSlots: 7, maxAgentSlots: 9 },
    });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 7, maxAgentSlots: 9, providerMaxLLMSlots: {} });
    expect(lib.defaultModelId).toBe("m1");
  });

  it("sans bloc concurrency du tout → défauts complets", () => {
    const lib = migrateLibrary({ models: [] });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots: {} });
  });

  it("concurrency null → défauts complets", () => {
    const lib = migrateLibrary({ models: [], concurrency: null });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots: {} });
  });

  it("providerMaxLLMSlots existant est préservé (valeurs valides uniquement)", () => {
    const lib = migrateLibrary({
      models: [],
      concurrency: {
        maxLLMSlots: 3,
        maxAgentSlots: 5,
        providerMaxLLMSlots: { anthropic: 2, openai: 5, mauvais: 0, negatif: -1, flottant: 2.5 },
      },
    });
    expect(lib.concurrency).toEqual({
      maxLLMSlots: 3,
      maxAgentSlots: 5,
      providerMaxLLMSlots: { anthropic: 2, openai: 5 },
    });
  });

  it("clé __proto__ dans la map (payload JSON) : ignorée, aucune pollution", () => {
    const data = JSON.parse('{"models":[],"concurrency":{"maxLLMSlots":3,"maxAgentSlots":5,"providerMaxLLMSlots":{"openai":4,"__proto__":9}}}');
    const lib = migrateLibrary(data);
    expect(lib.concurrency.providerMaxLLMSlots).toEqual({ openai: 4 });
    expect(({} as any).polluted).toBeUndefined();
  });

  it("providerMaxLLMSlots non-objet (string/array) → remplacé par {}", () => {
    const lib = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots: "oops" } });
    expect(lib.concurrency.providerMaxLLMSlots).toEqual({});
    const lib2 = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots: [1] } });
    expect(lib2.concurrency.providerMaxLLMSlots).toEqual({});
  });

  it("maxLLMSlots/maxAgentSlots invalides (<= 0, non numériques) retombent sur les défauts", () => {
    const lib = migrateLibrary({ models: [], concurrency: { maxLLMSlots: 0, maxAgentSlots: -2 } });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots: {} });
    const lib2 = migrateLibrary({ models: [], concurrency: { maxLLMSlots: "beaucoup" } });
    expect(lib2.concurrency).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots: {} });
  });

  it("ancien format (modes) → concurrency par défaut normalisé", () => {
    const lib = migrateLibrary({
      modes: { default: { models: [{ id: "m1", provider: "ollama", modelId: "llama3", name: "Llama 3" }] } },
    });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots: {} });
    expect(lib.models).toHaveLength(1);
    expect(lib.defaultModelId).toBe("m1");
  });

  it("config concurrency complète et valide : inchangée", () => {
    const lib = migrateLibrary({
      models: [],
      concurrency: { maxLLMSlots: 10, maxAgentSlots: 20, providerMaxLLMSlots: { openai: 4 } },
    });
    expect(lib.concurrency).toEqual({ maxLLMSlots: 10, maxAgentSlots: 20, providerMaxLLMSlots: { openai: 4 } });
  });
});