/**
 * Tests unitaires de sync-providers.ts — sentinelle apiKey (bug « No API key »).
 *
 * Scénario du bug : un provider openai-compatible SANS clé (llama.cpp server)
 * était écrit dans models.json sans champ `apiKey` (la sentinelle "ollama" n'était
 * posée que pour type === "ollama"). Au reload suivant du registre (boot, delete
 * provider, sync model-library…), le SDK échouait à composer le provider et le
 * retirait du runtime → `setModel` throw « No API key for provider_x/model » au
 * sendPrompt suivant. Le fix pose la sentinelle sur TOUS les types via le helper
 * partagé resolveProviderApiKey (provider-auth.ts).
 *
 * Le module écrit dans ~/.pi/agent/models.json : `os.homedir` et `fs` sont mockés
 * pour ne JAMAIS toucher le vrai disque.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "path";

// ── Mocks (hoistés) : fs en mémoire + home factice ──
// MODELS_JSON_PATH est calculé au chargement du module (os.homedir()), le mock
// `os` doit donc être en place AVANT l'import dynamique de sync-providers.js.
const { fsState, FAKE_HOME } = vi.hoisted(() => ({
  fsState: { files: {} as Record<string, string> },
  FAKE_HOME: "/tmp/pi-web-fake-home",
}));

vi.mock("fs", () => ({
  default: {},
  existsSync: vi.fn((p: string) => Object.prototype.hasOwnProperty.call(fsState.files, p)),
  mkdirSync: vi.fn(() => {}),
  readFileSync: vi.fn((p: string) => {
    const content = fsState.files[p];
    if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return content;
  }),
  writeFileSync: vi.fn((p: string, data: string) => {
    fsState.files[p] = data;
  }),
}));

vi.mock("os", () => ({
  default: { homedir: vi.fn(() => FAKE_HOME), platform: vi.fn(() => "linux") },
  homedir: vi.fn(() => FAKE_HOME),
}));

import { writeModelsJson } from "./sync-providers.js";
import { resolveProviderApiKey, LOCAL_PROVIDER_API_KEY_FALLBACK } from "./provider-auth.js";
import type { ProviderConfig } from "./providers.js";
import type { ModelLibrary, RegisteredModel } from "./model-library.js";

const MODELS_JSON_PATH = path.join(FAKE_HOME, ".pi", "agent", "models.json");

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "provider_1788877705392_kx0r7",
    name: "llamaCPP boulot",
    type: "openai-compatible",
    baseUrl: "http://192.168.1.20:8080/v1",
    apiKey: undefined,
    discoveredModels: [],
    connectionStatus: "untested",
    ...overrides,
  };
}

function makeModel(overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    id: "m1",
    providerId: "provider_1788877705392_kx0r7",
    modelId: "qwen3.8-flash-next",
    name: "Qwen 3.8 Flash",
    isDefault: true,
    reasoning: false,
    vision: false,
    contextWindow: 128000,
    maxTokens: 16384,
    thinkingLevel: "medium",
    ...overrides,
  };
}

function makeLibrary(models: RegisteredModel[]): ModelLibrary {
  return {
    models,
    defaultModelId: models[0]?.id ?? null,
    commitModelId: null,
    visionModelId: null,
    audioModelId: null,
    librarianModelId: null,
    projectModes: {},
    concurrency: { maxLLMSlots: 2, maxAgentSlots: 4 },
  };
}

/** Lit l'entrée provider écrite dans le models.json simulé. */
function writtenProvider(id: string): any {
  return JSON.parse(fsState.files[MODELS_JSON_PATH]).providers[id];
}

beforeEach(() => {
  fsState.files = {};
});

// ── Helper partagé ─────────────────────────────────────

describe("resolveProviderApiKey (sentinelle partagée)", () => {
  it("retourne la clé existante telle quelle", () => {
    expect(resolveProviderApiKey("sk-real-key")).toBe("sk-real-key");
  });

  it("retourne la sentinelle 'ollama' si la clé est absente/vide", () => {
    expect(resolveProviderApiKey(undefined)).toBe("ollama");
    expect(resolveProviderApiKey("")).toBe("ollama");
    expect(resolveProviderApiKey(null)).toBe("ollama");
  });

  it("expose la constante de sentinelle (convention projet)", () => {
    expect(LOCAL_PROVIDER_API_KEY_FALLBACK).toBe("ollama");
  });
});

// ── writeModelsJson — le chemin divergent du bug ────────

describe("writeModelsJson — sentinelle apiKey sur tous les types", () => {
  it("pose la sentinelle pour un provider openai-compatible SANS clé (llama.cpp, cas du bug)", async () => {
    const providers = [makeProvider({ apiKey: undefined })];
    const library = makeLibrary([makeModel()]);

    await writeModelsJson(providers, library);

    const entry = writtenProvider("provider_1788877705392_kx0r7");
    expect(entry).toBeDefined();
    // Sans ce fix : apiKey absent → le SDK retire le provider du runtime au
    // reload → « No API key for provider_x/qwen3.8-flash-next » au sendPrompt.
    expect(entry.apiKey).toBe("ollama");
    expect(entry.models).toHaveLength(1);
    expect(entry.models[0].id).toBe("qwen3.8-flash-next");
  });

  it("pose la sentinelle pour un provider google sans clé (provider avec modèle)", async () => {
    // NB : writeModelsJson saute les providers sans modèles (sauf ollama), on
    // attache donc un modèle pour que l'entry soit écrite.
    const providers = [makeProvider({ id: "provider_g", type: "google", apiKey: undefined })];
    const library = makeLibrary([
      makeModel({ id: "mg", providerId: "provider_g", modelId: "gemini-2.5-flash" }),
    ]);
    await writeModelsJson(providers, library);

    const entry = writtenProvider("provider_g");
    expect(entry.apiKey).toBe("ollama");
  });

  it("préserve la clé RÉELLE d'un provider qui en a une (jamais écrasée par la sentinelle)", async () => {
    const providers = [makeProvider({ apiKey: "sk-live-123" })];
    await writeModelsJson(providers, makeLibrary([makeModel()]));

    expect(writtenProvider("provider_1788877705392_kx0r7").apiKey).toBe("sk-live-123");
  });

  it("pose la sentinelle pour un provider ollama sans clé (comportement historique conservé)", async () => {
    const providers = [makeProvider({ id: "provider_o", type: "ollama", apiKey: undefined })];
    await writeModelsJson(providers, makeLibrary([]));

    expect(writtenProvider("provider_o").apiKey).toBe("ollama");
  });

  it("préserve les providers non gérés existants du models.json (merge)", async () => {
    // Existant : un provider "legacy" non managé doit survivre au sync
    fsState.files[MODELS_JSON_PATH] = JSON.stringify({
      providers: { legacy: { baseUrl: "http://legacy", api: "openai-completions", apiKey: "k" } },
    });

    const providers = [makeProvider({ apiKey: undefined })];
    await writeModelsJson(providers, makeLibrary([makeModel()]));

    const all = JSON.parse(fsState.files[MODELS_JSON_PATH]).providers;
    expect(all.legacy).toBeDefined();
    expect(all["provider_1788877705392_kx0r7"].apiKey).toBe("ollama");
  });
});