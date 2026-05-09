import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const PROVIDERS_FILE = path.join(DATA_DIR, "providers.json");

// ── Types ────────────────────────────────────────────

export type ProviderType = "ollama" | "openai-compatible" | "anthropic" | "google";

export interface ProviderConfig {
  id: string;
  name: string;           // custom display name
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;         // encrypted/stored, empty for ollama
  /** Discovered models from last test/scan */
  discoveredModels?: DiscoveredModel[];
  /** Connection status from last test */
  connectionStatus?: "ok" | "error" | "untested";
  connectionError?: string;
  lastTestedAt?: string;
}

export interface DiscoveredModel {
  id: string;              // model ID on the provider (e.g., "glm-5.1:cloud")
  name: string;            // display name
  size?: number;            // file size in bytes (for Ollama)
  quantization?: string;   // e.g., "Q4_K_M"
  family?: string;         // model family (e.g., "llama", "gemma")
}

// ── Provider type presets ────────────────────────────

export const PROVIDER_PRESETS: Record<ProviderType, {
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  apiType: string;
  description: string;
}> = {
  ollama: {
    defaultBaseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    apiType: "openai-completions",
    description: "Ollama (local or remote server)",
  },
  "openai-compatible": {
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    apiType: "openai-completions",
    description: "OpenAI-compatible API (DeepSeek, Groq, etc.)",
  },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com",
    requiresApiKey: true,
    apiType: "anthropic",
    description: "Anthropic Claude API",
  },
  google: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requiresApiKey: true,
    apiType: "google",
    description: "Google Gemini API",
  },
};

// ── Persistence ──────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadProviders(): ProviderConfig[] {
  try {
    ensureDataDir();
    if (existsSync(PROVIDERS_FILE)) {
      const data = JSON.parse(readFileSync(PROVIDERS_FILE, "utf-8"));
      return (data.providers || []).map(migrateProvider);
    }
  } catch (e) {
    console.error("[providers] Failed to load:", e);
  }
  return [];
}

export function saveProviders(providers: ProviderConfig[]): void {
  ensureDataDir();
  writeFileSync(PROVIDERS_FILE, JSON.stringify({ providers }, null, 2));
}

function migrateProvider(p: any): ProviderConfig {
  return {
    id: p.id || "",
    name: p.name || p.id || "",
    type: p.type || "ollama",
    baseUrl: p.baseUrl || "",
    apiKey: p.apiKey,
    discoveredModels: p.discoveredModels || [],
    connectionStatus: p.connectionStatus || "untested",
    connectionError: p.connectionError,
    lastTestedAt: p.lastTestedAt,
  };
}

// ── CRUD ──────────────────────────────────────────────

export function addProvider(config: Omit<ProviderConfig, "id" | "discoveredModels" | "connectionStatus">): ProviderConfig {
  const providers = loadProviders();
  const id = `provider_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const provider: ProviderConfig = {
    ...config,
    id,
    discoveredModels: [],
    connectionStatus: "untested",
  };
  providers.push(provider);
  saveProviders(providers);
  return provider;
}

export function updateProvider(id: string, updates: Partial<Omit<ProviderConfig, "id">>): ProviderConfig {
  const providers = loadProviders();
  const idx = providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`Provider not found: ${id}`);
  providers[idx] = { ...providers[idx], ...updates };
  saveProviders(providers);
  return providers[idx];
}

export async function deleteProvider(id: string): Promise<void> {
  const providers = loadProviders();
  const filtered = providers.filter((p) => p.id !== id);
  if (filtered.length === providers.length) throw new Error(`Provider not found: ${id}`);
  saveProviders(filtered);

  // Clean up models belonging to this provider from model library
  try {
    const { loadModelLibrary, saveModelLibrary } = await import("../pi/model-library.js");
    const library = loadModelLibrary();
    const before = library.models.length;
    library.models = library.models.filter((m: any) => m.providerId !== id);
    // Also clear default/commit if they referenced removed models
    if (library.defaultModelId && !library.models.find((m: any) => m.id === library.defaultModelId)) {
      library.defaultModelId = null;
    }
    if (library.commitModelId && !library.models.find((m: any) => m.id === library.commitModelId)) {
      library.commitModelId = null;
    }
    // Clean project mode configs
    if (library.projectModes) {
      for (const [projectId, modes] of Object.entries(library.projectModes)) {
        const m = modes as any;
        for (const mode of ["code", "plan", "review"]) {
          if (m[mode]?.modelId) {
            const stillExists = library.models.some((mod: any) => mod.id === m[mode].modelId);
            if (!stillExists) m[mode].modelId = null;
          }
        }
      }
    }
    saveModelLibrary(library);
    console.log(`[providers] Cleaned up ${before - library.models.length} models from deleted provider ${id}`);
  } catch (e) {
    console.warn("[providers] Failed to clean up models for deleted provider:", e);
  }
}

export function getProvider(id: string): ProviderConfig | undefined {
  return loadProviders().find((p) => p.id === id);
}

export function inferReasoning(modelId: string): boolean {
  const name = modelId.toLowerCase();
  return /deepseek.*r1|qwq|qwen.*think|qwen3[._-]?[5]|qwen3-|openthinker|deepscaler|marco-o1|glm[-_]?[45]|glm.*think|o1(?=[-_]|$)|o3(?=[-_]|$)|o4(?=[-_]|mini|$)|claude.*3[._-]?5.*sonnet|claude.*4|gemini.*2[._-]?5|gemini.*think|kimi|reason/i.test(name);
}

export function inferVision(modelId: string): boolean {
  const name = modelId.toLowerCase();
  return /llava|bakllava|moondream|minicpm-v|gemma.*vl|qwen.*vl|qwen.*v|vision|multimodal|omni|multi.*mod|minicpm|kimi/i.test(name);
}

export function inferContextWindow(modelId: string): number {
  const key = modelId.toLowerCase().replace(/[:_]/g, "-");
  const overrides: Record<string, number> = {
    "kimi-k2.6": 256000,
    "kimi-k2.5": 256000,
    "kimi-k2.0": 200000,
    "kimi-k1.5": 256000,
    "deepseek-r1": 128000,
    "deepseek-v3": 128000,
    "qwq": 128000,
    "qwq-32b": 128000,
    "qwen3.5": 128000,
    "qwen3": 128000,
    "qwen2.5": 128000,
    "qwen2": 128000,
    "llama3.3": 128000,
    "llama3.2": 128000,
    "llama3.1": 128000,
    "llama3": 128000,
    "mistral": 128000,
    "mixtral": 64000,
    "gemma3": 128000,
    "gemma2": 128000,
    "command-r": 128000,
    "aya": 256000,
    "phi3": 128000,
    "phi4": 128000,
    "granite3": 128000,
    "codestral": 32000,
    "nemotron": 128000,
    "llava": 4096,
    "bakllava": 4096,
    "moondream": 8192,
  };
  if (overrides[key] !== undefined) return overrides[key];
  for (const [prefix, ctx] of Object.entries(overrides)) {
    if (key.startsWith(prefix + "-")) return ctx;
  }
  if (key.includes("kimi")) return 256000;
  if (key.includes("deepseek-r1")) return 128000;
  if (key.includes("deepseek-v3")) return 128000;
  if (key.includes("qwq")) return 128000;
  if (key.includes("qwen3")) return 128000;
  if (key.includes("qwen2.5")) return 128000;
  if (key.includes("qwen2")) return 128000;
  if (key.includes("llama3")) return 128000;
  if (key.includes("mistral")) return 128000;
  if (key.includes("mixtral")) return 64000;
  if (key.includes("gemma3")) return 128000;
  if (key.includes("gemma2")) return 128000;
  if (key.includes("gemma")) return 8192;
  if (key.includes("command-r")) return 128000;
  if (key.includes("aya")) return 256000;
  if (key.includes("phi3") || key.includes("phi-3")) return 128000;
  if (key.includes("phi4") || key.includes("phi-4")) return 128000;
  if (key.includes("granite3")) return 128000;
  if (key.includes("codestral")) return 32000;
  if (key.includes("codellama")) return 16384;
  if (key.includes("llava")) return 4096;
  if (key.includes("bakllava")) return 4096;
  if (key.includes("moondream")) return 8192;
  if (key.includes("minicpm")) return 128000;
  if (key.includes("embed")) return 8192;
  return 128000;
}

// ── Test connection ───────────────────────────────────

export async function testProviderConnection(provider: ProviderConfig): Promise<{
  ok: boolean;
  models: DiscoveredModel[];
  error?: string;
}> {
  const preset = PROVIDER_PRESETS[provider.type];
  const baseUrl = provider.baseUrl || preset.defaultBaseUrl;
  const apiKey = provider.apiKey || (provider.type === "ollama" ? "ollama" : undefined);

  try {
    let models: DiscoveredModel[] = [];

    if (provider.type === "ollama" || provider.type === "openai-compatible") {
      // OpenAI-compatible /v1/models endpoint
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const resp = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10000) });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, models: [], error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
      }

      const data = await resp.json();
      const rawModels = data.data || data.models || [];

      models = rawModels.map((m: any) => ({
        id: m.id || m.model || m.name || m.digest || "",
        name: m.name || m.id || m.model || "",
        size: m.size || m.details?.size || undefined,
        quantization: m.details?.quantization_level || m.quantization || undefined,
        family: m.details?.family || m.family || undefined,
      })).filter((m: DiscoveredModel) => m.id);
    } else if (provider.type === "anthropic") {
      // Anthropic doesn't have a model list endpoint, return known models
      models = [
        { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
        { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5" },
        { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5" },
      ];
    } else if (provider.type === "google") {
      // Google Gemini API
      if (!apiKey) return { ok: false, models: [], error: "API key required for Google Gemini" };

      const resp = await fetch(`${baseUrl}/models?key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) {
        return { ok: false, models: [], error: `HTTP ${resp.status}` };
      }

      const data = await resp.json();
      const rawModels = data.models || [];
      models = rawModels.map((m: any) => ({
        id: m.name?.replace("models/", "") || m.name || "",
        name: m.displayName || m.name || "",
      })).filter((m: DiscoveredModel) => m.id);
    }

    // Update provider status
    updateProvider(provider.id, {
      discoveredModels: models,
      connectionStatus: "ok",
      connectionError: undefined,
      lastTestedAt: new Date().toISOString(),
    });

    return { ok: true, models };
  } catch (e: any) {
    // Update provider status
    updateProvider(provider.id, {
      connectionStatus: "error",
      connectionError: e.message,
      lastTestedAt: new Date().toISOString(),
    });

    return { ok: false, models: [], error: e.message };
  }
}