/**
 * Tests de la limite de concurrence LLM portée par le provider.
 *
 * Source de vérité = champ `maxConcurrentCalls` de chaque provider. La map
 * moteur `concurrency.providerMaxLLMSlots` (model-library.json) en est dérivée
 * par `syncConcurrencyProviderLimits`. Le `fs` est mocké en mémoire (aucune
 * écriture réelle) — même approche que providers.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";

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
  DEFAULT_MAX_CONCURRENT_CALLS,
  MAX_CONCURRENT_CALLS,
  addProvider,
  deleteProvider,
  getProvider,
  getProviderMaxConcurrentCalls,
  loadProviders,
  normalizeMaxConcurrentCalls,
  saveProviders,
  syncConcurrencyProviderLimits,
  updateProvider,
  type ProviderConfig,
} from "./providers.js";
import { loadModelLibrary } from "./model-library.js";
import { concurrencyManager } from "./concurrency.js";

function dataFilePath(fileName: string): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".data", fileName);
}

function seedFile(fileName: string, content: string): void {
  fsState.files[dataFilePath(fileName)] = content;
}

function seedLibrary(providerMaxLLMSlots: Record<string, number> = {}): void {
  seedFile(
    "model-library.json",
    JSON.stringify({
      models: [],
      concurrency: { maxLLMSlots: 3, maxAgentSlots: 5, providerMaxLLMSlots, queueTimeoutMs: 600_000 },
    })
  );
}

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    name: "Ollama local",
    type: "ollama",
    baseUrl: "http://localhost:11434/v1",
    discoveredModels: [],
    connectionStatus: "untested",
    ...overrides,
  };
}

beforeEach(() => {
  fsState.files = {};
  seedLibrary();
});

describe("normalizeMaxConcurrentCalls", () => {
  it("accepte un entier 1..MAX_CONCURRENT_CALLS", () => {
    expect(normalizeMaxConcurrentCalls(1)).toBe(1);
    expect(normalizeMaxConcurrentCalls(2500)).toBe(2500);
    expect(normalizeMaxConcurrentCalls(MAX_CONCURRENT_CALLS)).toBe(MAX_CONCURRENT_CALLS);
  });

  it("rejette absent, non numérique, non entier, hors bornes", () => {
    expect(normalizeMaxConcurrentCalls(undefined)).toBeUndefined();
    expect(normalizeMaxConcurrentCalls(null)).toBeUndefined();
    expect(normalizeMaxConcurrentCalls("3")).toBeUndefined();
    expect(normalizeMaxConcurrentCalls(2.5)).toBeUndefined();
    expect(normalizeMaxConcurrentCalls(0)).toBeUndefined();
    expect(normalizeMaxConcurrentCalls(-1)).toBeUndefined();
    expect(normalizeMaxConcurrentCalls(MAX_CONCURRENT_CALLS + 1)).toBeUndefined();
    expect(normalizeMaxConcurrentCalls(NaN)).toBeUndefined();
  });
});

describe("getProviderMaxConcurrentCalls", () => {
  it("provider sans valeur → défaut 3", () => {
    expect(getProviderMaxConcurrentCalls(makeProvider())).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
    expect(getProviderMaxConcurrentCalls(makeProvider({ maxConcurrentCalls: 0 }))).toBe(3);
  });

  it("provider avec valeur explicite → cette valeur", () => {
    expect(getProviderMaxConcurrentCalls(makeProvider({ maxConcurrentCalls: 2500 }))).toBe(2500);
  });
});

describe("syncConcurrencyProviderLimits", () => {
  it("provider sans valeur → limite effective 3 et valeur persistée", async () => {
    saveProviders([makeProvider({ id: "p1" })]);
    await syncConcurrencyProviderLimits();

    expect(getProvider("p1")?.maxConcurrentCalls).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
    expect(concurrencyManager.getEffectiveLLMLimit("p1")).toBe(3);
    expect(loadModelLibrary().concurrency.providerMaxLLMSlots).toEqual({ p1: 3 });
  });

  it("provider avec 2500 → limite effective 2500", async () => {
    saveProviders([makeProvider({ id: "p1", maxConcurrentCalls: 2500 })]);
    await syncConcurrencyProviderLimits();

    expect(concurrencyManager.getEffectiveLLMLimit("p1")).toBe(2500);
    expect(loadModelLibrary().concurrency.providerMaxLLMSlots).toEqual({ p1: 2500 });
  });

  it("migration : reprend l'override historique providerMaxLLMSlots", async () => {
    seedLibrary({ p1: 7 });
    saveProviders([makeProvider({ id: "p1" })]);
    await syncConcurrencyProviderLimits();

    expect(getProvider("p1")?.maxConcurrentCalls).toBe(7);
    expect(concurrencyManager.getEffectiveLLMLimit("p1")).toBe(7);
  });

  it("préserve la sentinelle __default__ et les providers absents de la liste", async () => {
    seedLibrary({ __default__: 9, extension_prov: 5 });
    saveProviders([makeProvider({ id: "p1" })]);
    await syncConcurrencyProviderLimits();

    expect(loadModelLibrary().concurrency.providerMaxLLMSlots).toEqual({
      __default__: 9,
      extension_prov: 5,
      p1: 3,
    });
  });

  it("synchronisation après création d'un provider (défaut 3)", async () => {
    const created = addProvider({ name: "Groq", type: "openai-compatible", baseUrl: "https://api.groq.com/v1" });
    await syncConcurrencyProviderLimits();

    expect(concurrencyManager.getEffectiveLLMLimit(created.id)).toBe(3);
    expect(loadModelLibrary().concurrency.providerMaxLLMSlots[created.id]).toBe(3);
  });

  it("synchronisation après modification (2500 → 4)", async () => {
    saveProviders([makeProvider({ id: "p1", maxConcurrentCalls: 2500 })]);
    await syncConcurrencyProviderLimits();
    expect(concurrencyManager.getEffectiveLLMLimit("p1")).toBe(2500);

    updateProvider("p1", { maxConcurrentCalls: 4 });
    await syncConcurrencyProviderLimits();
    expect(concurrencyManager.getEffectiveLLMLimit("p1")).toBe(4);
  });

  it("synchronisation après suppression : entrée retirée (repli sur le défaut global)", async () => {
    saveProviders([makeProvider({ id: "p1", maxConcurrentCalls: 8 }), makeProvider({ id: "p2" })]);
    await syncConcurrencyProviderLimits();
    expect(concurrencyManager.getEffectiveLLMLimit("p1")).toBe(8);

    await deleteProvider("p1");
    await syncConcurrencyProviderLimits();

    expect(loadProviders().map((p) => p.id)).toEqual(["p2"]);
    expect(loadModelLibrary().concurrency.providerMaxLLMSlots).not.toHaveProperty("p1");
    // Provider inconnu → repli sur le défaut global (3), jamais de rejet.
    expect(concurrencyManager.getEffectiveLLMLimit("p1")).toBe(3);
  });

  it("liste de providers vide → map moteur vide (hors entrées inconnues)", async () => {
    saveProviders([]);
    await syncConcurrencyProviderLimits();
    expect(loadModelLibrary().concurrency.providerMaxLLMSlots).toEqual({});
    expect(concurrencyManager.getEffectiveLLMLimit("inconnu")).toBe(3);
  });
});
