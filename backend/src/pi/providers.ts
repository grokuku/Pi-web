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
  /**
   * Nombre max d'appels LLM menés en PARALLÈLE vers ce provider (source de
   * vérité du limiteur de concurrence ; défaut 3). Les appels en trop attendent
   * leur tour dans la file du provider.
   */
  maxConcurrentCalls?: number;
  /** Discovered models from last test/scan */
  discoveredModels?: DiscoveredModel[];
  /** Connection status from last test */
  connectionStatus?: "ok" | "error" | "untested";
  connectionError?: string;
  lastTestedAt?: string;
}

// ── Limite de concurrence LLM par provider ────────────
// Source de vérité : le champ `maxConcurrentCalls` porté par l'enregistrement
// du provider (un provider supprimé/renommé n'y laisse donc pas d'entrée
// orpheline, contrairement à une map séparée). Le moteur de concurrence consomme
// la map dérivée `concurrency.providerMaxLLMSlots` de model-library.json,
// resynchronisée depuis les providers au démarrage et après chaque
// création/mise à jour/suppression (voir syncConcurrencyProviderLimits).

export const DEFAULT_MAX_CONCURRENT_CALLS = 3;
/** Plafond haut (miroir de MAX_SLOTS côté route concurrency). */
export const MAX_CONCURRENT_CALLS = 100_000;

export interface DiscoveredModel {
  id: string;              // model ID on the provider (e.g., "glm-5.1:cloud")
  name: string;            // display name
  size?: number;            // file size in bytes (for Ollama)
  quantization?: string;   // e.g., "Q4_K_M"
  family?: string;         // model family (e.g., "llama", "gemma")
  /** Detected from provider API – takes precedence over heuristics */
  contextWindow?: number;  // real context window in tokens (from model_info)
  reasoning?: boolean;     // real reasoning support
  vision?: boolean;        // real vision support
  /** Niveaux de réflexion supportés / défaut (Ollama /api/show → objet `thinking`). */
  reasoningLevels?: string[];
  reasoningDefault?: string;
}

/** Vue publique d'un provider : la clé API n'est jamais renvoyée. */
export type PublicProviderConfig = Omit<ProviderConfig, "apiKey"> & {
  hasApiKey: boolean;
};

/** Masque la clé API réelle en la remplaçant par un booléen hasApiKey. */
export function toPublicProvider(provider: ProviderConfig): PublicProviderConfig {
  const { apiKey, ...rest } = provider;
  return { ...rest, hasApiKey: !!apiKey };
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
    // Conservée telle quelle : l'absence de valeur = héritage du défaut (3),
    // appliqué par getProviderMaxConcurrentCalls / la synchronisation.
    maxConcurrentCalls: p.maxConcurrentCalls,
  };
}

/** Entier sûr dans [1, MAX_CONCURRENT_CALLS], sinon undefined (absent/invalide). */
export function normalizeMaxConcurrentCalls(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  if (value < 1 || value > MAX_CONCURRENT_CALLS) return undefined;
  return value;
}

/** Limite LLM effective d'un provider : champ dédié sinon défaut (3). */
export function getProviderMaxConcurrentCalls(provider: ProviderConfig): number {
  return normalizeMaxConcurrentCalls(provider.maxConcurrentCalls) ?? DEFAULT_MAX_CONCURRENT_CALLS;
}

/**
 * Synchronise la map moteur `concurrency.providerMaxLLMSlots` (model-library)
 * depuis les enregistrements de providers (SOURCE DE VÉRITÉ).
 *
 * Migration / rétro-compatibilité : un provider sans `maxConcurrentCalls`
 * reprend l'override historique `providerMaxLLMSlots[p.id]` s'il existe, sinon
 * le défaut 3 ; cette valeur est alors persistée sur le provider. Les entrées
 * de providers ABSENTS de la liste (provider d'extension, sentinelle
 * "__default__") sont conservées telles quelles. Le moteur (getEffectiveLLMLimit)
 * reste inchangé : il lit toujours `providerMaxLLMSlots[providerId] ?? défaut`.
 *
 * Idempotente : appelée au démarrage et après chaque mutation de provider.
 */
export async function syncConcurrencyProviderLimits(): Promise<void> {
  try {
    const providers = loadProviders();
    const { loadModelLibrary, saveModelLibrary } = await import("../pi/model-library.js");
    const library = loadModelLibrary();
    // Garanti par migrateLibrary, mais on reste défensif.
    if (!library.concurrency) return;
    const existing = library.concurrency.providerMaxLLMSlots ?? {};

    // 1) Migration : doter chaque provider d'une valeur explicite (reprise de
    //    l'override existant sinon défaut 3).
    let migrated = false;
    const withLimit = providers.map((p) => {
      if (normalizeMaxConcurrentCalls(p.maxConcurrentCalls) !== undefined) return p;
      const inherited = normalizeMaxConcurrentCalls(existing[p.id]);
      migrated = true;
      return { ...p, maxConcurrentCalls: inherited ?? DEFAULT_MAX_CONCURRENT_CALLS };
    });
    if (migrated) saveProviders(withLimit);

    // 2) Map moteur = entrées existantes (providers inconnus préservés) écrasées
    //    par la valeur de chaque provider connu.
    const nextMap: Record<string, number> = { ...existing };
    for (const p of withLimit) {
      nextMap[p.id] = getProviderMaxConcurrentCalls(p);
    }
    library.concurrency.providerMaxLLMSlots = nextMap;
    saveModelLibrary(library);

    // 3) Appliquer au moteur runtime.
    const { concurrencyManager } = await import("./concurrency.js");
    concurrencyManager.setConfig(library.concurrency);
  } catch (e: any) {
    console.warn("[providers] Failed to sync concurrency limits:", e?.message || e);
  }
}

// ── CRUD ──────────────────────────────────────────────

export function addProvider(config: Omit<ProviderConfig, "id" | "discoveredModels" | "connectionStatus">): ProviderConfig {
  const providers = loadProviders();
  const id = `provider_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const provider: ProviderConfig = {
    ...config,
    // Valeur par défaut explicite (3) : le champ est la source de vérité.
    maxConcurrentCalls:
      normalizeMaxConcurrentCalls(config.maxConcurrentCalls) ?? DEFAULT_MAX_CONCURRENT_CALLS,
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
    // Also clear vision/audio if they referenced removed models (BUG-33 fix)
    if (library.visionModelId && !library.models.find((m: any) => m.id === library.visionModelId)) {
      library.visionModelId = null;
    }
    if (library.audioModelId && !library.models.find((m: any) => m.id === library.audioModelId)) {
      library.audioModelId = null;
    }

    // Clean project mode configs (tous les modes, BUG-07 fix)
    if (library.projectModes) {
      for (const [projectId, modes] of Object.entries(library.projectModes)) {
        const m = modes as any;
        for (const mode of ["code", "review", "harness"]) {
          if (m[mode]?.modelId) {
            const stillExists = library.models.some((mod: any) => mod.id === m[mode].modelId);
            if (!stillExists) m[mode].modelId = null;
          }
        }
      }
    }
    // Limite de concurrence : le provider disparaît → retirer son entrée de la
    // map moteur (évite une entrée orpheline que la synchro ne recréera pas).
    if (library.concurrency?.providerMaxLLMSlots) {
      delete library.concurrency.providerMaxLLMSlots[id];
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

export function inferReasoning(modelId: string, family?: string): boolean {
  const name = (family || modelId).toLowerCase();
  // ⚠️ HEURISTIQUE DE NOM : simple DÉFAUT, à mettre à jour au fil des sorties de modèles.
  // Ce n'est PAS la source de vérité : l'override manuel (`reasoningOverride` dans la
  // Model Library) et la détection AUTORITAIRE du provider (Ollama `POST /api/show`,
  // objet `thinking`) PRIMENT sur cette liste. Ajouts récents (doc Ollama/DeepSeek) :
  // DeepSeek v3/v3.1/v4 (mais PAS `deepseek-chat`, non-raisonneur), Qwen 3, GPT-OSS,
  // GLM 4/5 — en plus des motifs historiques (R1, QwQ, o1/o3/o4, Claude 3.5+/4,
  // Gemini 2.5, Kimi, Llama-4 Maverick, Phi-4 reasoning…).
  return /deepseek.*(?:r1|v[34])|qwq|qwen.*think|qwen-?3|openthinker|deepscaler|marco-o1|glm[-_]?[45]|glm.*think|gpt[-_]?oss|o1(?=[-_]|$)|o3(?=[-_]|$)|o4(?=[-_]|mini|$)|claude.*3[._-]?5.*sonnet|claude.*4|gemini.*2[._-]?5|gemini.*think|kimi|reason|llama-?4.*maverick|phi-?4.*reason/i.test(name);
}

/**
 * Valeur EXACTE de `reasoning_effort` qui DÉSACTIVE la réflexion côté Ollama.
 *
 * Mesuré sur Ollama Cloud (`deepseek-v4.1-flash`, `/v1/chat/completions`) : seule
 * la chaîne exacte "none" (minuscule, sans espace) coupe la réflexion. "NONE",
 * "none ", "disabled", "false"… sont acceptés SANS erreur mais laissent la
 * réflexion ACTIVE en silence (« contrôle fantôme »). Toute normalisation doit
 * donc converger sur cette valeur unique, centralisée ici.
 */
export const OLLAMA_DISABLE_REASONING_VALUE = "none";

/** Synonymes (et valeurs non-string) considérés comme « extinction » (repli sûr). */
const REASONING_OFF_ALIASES = new Set(["none", "off", "disabled", "disable", "false", "no", "0"]);

/**
 * Normalise une valeur destinée à `reasoning_effort` AVANT transmission :
 * trim + minuscules, et repli sur la valeur canonique d'extinction
 * (`OLLAMA_DISABLE_REASONING_VALUE`) pour toute valeur « équivalente à off »
 * ou NON-STRING (un nombre/booléen ferait rejeter la requête : HTTP 400).
 * Garantit qu'AUCUNE variante (casse/espaces/synonyme) ne parte telle quelle.
 */
export function normalizeReasoningEffortValue(raw: unknown): string {
  if (typeof raw !== "string") return OLLAMA_DISABLE_REASONING_VALUE;
  const v = raw.trim().toLowerCase();
  if (v === "" || REASONING_OFF_ALIASES.has(v)) return OLLAMA_DISABLE_REASONING_VALUE;
  return v;
}

/**
 * Correspondance niveau SDK → `reasoning_effort` RÉELLE d'Ollama.
 *
 * Mesuré sur Ollama Cloud (`deepseek-v4.1-flash`, POST /api/show) :
 *   thinking = { values: [false, "low", "high", "max"], default: "high" }.
 * Le provider ne déclare QUE low/high/max (+ extinction via `false`) ; "minimal",
 * "medium" et "xhigh" NE SONT PAS déclarés. On les replie donc, pour Ollama
 * UNIQUEMENT, sur le niveau déclaré le plus proche (plutôt que d'envoyer une
 * valeur non déclarée au sens arbitraire) et on coupe via la chaîne exacte "none".
 */
export const OLLAMA_THINKING_LEVEL_MAP: Record<string, string> = {
  off: OLLAMA_DISABLE_REASONING_VALUE, // "none" — seule chaîne qui coupe réellement
  minimal: "low", // non déclaré → replié sur low
  low: "low",
  medium: "high", // non déclaré → replié sur high
  high: "high",
  xhigh: "high", // non déclaré → replié sur high
  max: "max",
};

/**
 * Construit une table de niveaux NORMALISÉE : chaque valeur est la chaîne exacte
 * attendue par le provider. Mutualise la normalisation pour éviter toute
 * divergence entre les chemins d'écriture (models.json / re-register session).
 */
export function buildOllamaThinkingLevelMap(
  source: Record<string, unknown> = OLLAMA_THINKING_LEVEL_MAP,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [level, raw] of Object.entries(source)) {
    out[level] = normalizeReasoningEffortValue(raw);
  }
  return out;
}

/**
 * Options de modèle à injecter pour les providers Ollama (endpoint
 * OpenAI-compatible `/v1/chat/completions`, celui que Pi-Web utilise).
 *
 * Constat SDK (pi-ai `api/openai-completions.js`) : quand le niveau de réflexion
 * vaut "off", le SDK ne pose `reasoning_effort` QUE si `model.thinkingLevelMap.off`
 * est une chaîne (branche finale « openai »). Sans cette table, RIEN n'est envoyé —
 * or Ollama **active le thinking de lui-même** quand `reasoning_effort` est absent.
 * Le contrôle « off » est donc un contrôle FANTÔME pour Ollama. La table couvre
 * TOUS les niveaux SDK avec les valeurs RÉELLES du provider (voir
 * OLLAMA_THINKING_LEVEL_MAP) pour ne jamais envoyer de niveau « inventé ».
 * (Contournement côté Pi-Web, sans modifier le SDK.)
 */
export function ollamaReasoningModelOptions(provider: { type?: string; baseUrl?: string }): {
  thinkingLevelMap?: Record<string, string>;
} {
  return isOllamaProvider(provider) ? { thinkingLevelMap: buildOllamaThinkingLevelMap() } : {};
}

export function inferVision(modelId: string, family?: string): boolean {
  const name = (family || modelId).toLowerCase();
  // Known vision families (Ollama / model architecture)
  const visionFamilies = /^(gemma3|gemma4|gemma-4|llama4|llama-4|pixtral|llava|minicpm|moondream|bakllava|qwen2[._-]?vl|qwen2[._-]?5.*vl|phi-4|phi4)/i;
  if (visionFamilies.test(name)) return true;
  return /llava|bakllava|moondream|minicpm-v|minicpm|gemma.*vl|qwen.*vl|qwen.*v|vision|multimodal|omni|multi.*mod|pixtral|kimi|gpt-4o|gpt-4.*vision|claude.*sonnet|claude.*opus|claude.*haiku|command-r.*plus|phi-?4.*vision|gemini.*2[._-]?5.*(pro|flash)|gemini.*1[._-]?5.*(pro|flash)|llama-?4|gemma-?4/i.test(name);
}

export function inferContextWindow(modelId: string, family?: string): number {
  const key = (family || modelId).toLowerCase().replace(/[:_]/g, "-");
  const overrides: Record<string, number> = {
    // Google
    "gemma4": 262144,
    "gemma-4": 262144,
    "gemma3": 128000,
    "gemma2": 128000,
    // Meta
    "llama4": 1048576,
    "llama-4": 1048576,
    "llama4-scout": 10485760,
    "llama-4-scout": 10485760,
    "llama3.3": 128000,
    "llama3.2": 128000,
    "llama3.1": 128000,
    "llama3": 128000,
    // Anthropic
    "claude-sonnet-4": 200000,
    "claude-sonnet-4-20250514": 200000,
    "claude-opus-4-5": 200000,
    "claude-opus-4": 200000,
    "claude-3-5-sonnet": 200000,
    "claude-3-5-haiku": 200000,
    "claude-3-opus": 200000,
    // OpenAI
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4-turbo": 128000,
    "gpt-4": 8192,
    "o1": 200000,
    "o1-mini": 128000,
    "o3": 200000,
    "o3-mini": 200000,
    "o4-mini": 200000,
    // DeepSeek
    "deepseek-r1": 128000,
    "deepseek-v3": 128000,
    "deepseek-v4": 1048576,
    "deepseek-chat": 128000,
    // Qwen
    "qwq": 128000,
    "qwq-32b": 128000,
    "qwen3.5": 128000,
    "qwen3": 128000,
    "qwen2.5": 128000,
    "qwen2": 128000,
    // Mistral
    "mistral": 128000,
    "mixtral": 64000,
    "pixtral": 128000,
    "codestral": 32000,
    // Others
    "command-r": 128000,
    "aya": 256000,
    "phi3": 128000,
    "phi4": 128000,
    "granite3": 128000,
    "nemotron": 128000,
    "kimi-k2.6": 256000,
    "kimi-k2.5": 256000,
    "kimi-k2.0": 200000,
    "kimi-k1.5": 256000,
    "llava": 4096,
    "bakllava": 4096,
    "moondream": 8192,
  };
  if (overrides[key] !== undefined) return overrides[key];
  for (const [prefix, ctx] of Object.entries(overrides)) {
    if (key.startsWith(prefix + "-")) return ctx;
  }
  if (key.includes("kimi")) return 256000;
  if (key.includes("deepseek-v4")) return 1048576;
  if (key.includes("deepseek-r1")) return 128000;
  if (key.includes("deepseek-v3")) return 128000;
  if (key.includes("qwq")) return 128000;
  if (key.includes("qwen3")) return 128000;
  if (key.includes("qwen2.5")) return 128000;
  if (key.includes("qwen2")) return 128000;
  if (key.includes("llama3")) return 128000;
  if (key.includes("mistral")) return 128000;
  if (key.includes("mixtral")) return 64000;
  if (key.includes("gemma4") || key.includes("gemma-4")) return 262144;
  if (key.includes("gemma3")) return 128000;
  if (key.includes("gemma2")) return 128000;
  if (key.includes("gemma")) return 8192;
  if (key.includes("llama4") || key.includes("llama-4")) return 1048576;
  if (key.includes("llama3")) return 128000;
  if (key.includes("llama2")) return 4096;
  if (key.includes("claude")) return 200000;
  if (key.includes("gpt-4o")) return 128000;
  if (key.includes("gpt-4")) return 8192;
  if (key.includes("o1") || key.includes("o3") || key.includes("o4")) return 200000;
  if (key.includes("deepseek-v4")) return 1048576;
  if (key.includes("deepseek-r1")) return 128000;
  if (key.includes("deepseek-v3")) return 128000;
  if (key.includes("deepseek-chat")) return 128000;
  if (key.includes("deepseek")) return 64000;
  if (key.includes("qwq")) return 128000;
  if (key.includes("qwen3")) return 128000;
  if (key.includes("qwen2.5")) return 128000;
  if (key.includes("qwen2")) return 128000;
  if (key.includes("qwen")) return 32000;
  if (key.includes("kimi")) return 256000;
  if (key.includes("mistral")) return 128000;
  if (key.includes("mixtral")) return 64000;
  if (key.includes("pixtral")) return 128000;
  if (key.includes("command-r")) return 128000;
  if (key.includes("aya")) return 256000;
  if (key.includes("phi4") || key.includes("phi-4")) return 128000;
  if (key.includes("phi3") || key.includes("phi-3")) return 128000;
  if (key.includes("granite")) return 128000;
  if (key.includes("codestral")) return 32000;
  if (key.includes("codellama")) return 16384;
  if (key.includes("nemotron")) return 128000;
  if (key.includes("llava")) return 4096;
  if (key.includes("bakllava")) return 4096;
  if (key.includes("moondream")) return 8192;
  if (key.includes("minicpm")) return 128000;
  if (key.includes("embed")) return 8192;
  if (key.includes("gemini")) return 1048576;
  return 128000;
}

// ── Ollama native API enrichment ────────────────────

/**
 * Analyse l'objet `thinking` renvoyé par `POST /api/show` d'Ollama.
 *  - absent / malformé  → `null` (capacité INCONNUE : repli sur l'heuristique) ;
 *  - `values: [false]`  → `{ enabled: false }` (thinking non supporté) ;
 *  - `values` non vide  → `{ enabled: true, levels, default }` (modèle raisonneur).
 */
export function parseOllamaThinking(
  thinking: unknown,
): { enabled: boolean; levels: string[]; default?: string } | null {
  if (!thinking || typeof thinking !== "object" || !Array.isArray((thinking as any).values)) {
    return null;
  }
  const values: unknown[] = (thinking as any).values;
  const levels = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  const enabled = levels.length > 0 || values.some((v) => v === true);
  // `false` dans `values` = extinction supportée par le provider : on l'expose
  // comme niveau SDK "off" pour que le sélecteur frontend ne propose "off" QUE
  // si le provider le déclare réellement (voir thinkingLevelsForModel).
  const offSupported = values.some((v) => v === false);
  const exposed = offSupported ? ["off", ...levels.filter((l) => l !== "off")] : levels;
  return {
    enabled,
    levels: exposed,
    default: typeof (thinking as any).default === "string" ? (thinking as any).default : undefined,
  };
}

/**
 * Critère UNIQUE « provider Ollama ».
 *
 * Un provider est Ollama soit par son TYPE natif (`type: "ollama"`), soit par son
 * URL : Ollama Cloud (`ollama.com`) ou une instance locale (`:11434`). Le provider
 * de l'utilisateur est typiquement `openai-compatible` + `https://ollama.com/v1` :
 * il DOIT être reconnu, sinon la découverte `/api/show` et le backfill sont sautés.
 *
 * Mutualisé volontairement : le `thinkingLevelMap` (voir
 * `ollamaReasoningModelOptions`) et la découverte/backfill des niveaux de
 * réflexion partagent ainsi EXACTEMENT le même critère — jamais deux définitions
 * divergentes.
 */
export function isOllamaProvider(provider: { type?: string; baseUrl?: string }): boolean {
  return provider.type === "ollama" || /ollama\.com|:11434/i.test(provider.baseUrl || "");
}

/** Derive the native Ollama API base URL from the OpenAI-compatible base URL. */
function deriveNativeOllamaUrl(baseUrl: string): string {
  // Remove trailing /v1 or /v1/
  let url = baseUrl.replace(/\/v1\/?$/, "");
  // Ensure no trailing slash
  url = url.replace(/\/+$/, "");
  return url;
}

/**
 * Fetch real model capabilities from the Ollama native /api/show endpoint.
 * This populates contextWindow, vision, reasoning on DiscoveredModel.
 */
async function enrichWithOllamaCapabilities(
  provider: ProviderConfig,
  models: DiscoveredModel[]
): Promise<void> {
  const nativeUrl = deriveNativeOllamaUrl(provider.baseUrl);
  const apiKey = provider.apiKey || "ollama";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  // Query models in parallel with concurrency limit
  const concurrency = 5;
  for (let i = 0; i < models.length; i += concurrency) {
    const batch = models.slice(i, i + concurrency);
    await Promise.all(batch.map(async (model) => {
      try {
        const resp = await fetch(`${nativeUrl}/api/show`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: model.id }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return;

        const data = await resp.json();
        const modelInfo: Record<string, any> = data.model_info || {};

        // Extract context window from model_info (pattern: <family>.context_length)
        for (const [key, value] of Object.entries(modelInfo)) {
          if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
            model.contextWindow = value;
            break;
          }
        }

        // Extract architecture for capability inference
        const arch = (modelInfo["general.architecture"] || "").toLowerCase();
        if (arch) {
          model.family = model.family || arch;
          // Vision detection from architecture
          if (/llava|bakllava|moondream|minicpm|pixtral|vision|multimodal|vl/i.test(arch)) {
            model.vision = true;
          }
          // Reasoning detection from architecture (repli historique)
          if (/reasoning|think|r1|o1|o3|o4/i.test(arch)) {
            model.reasoning = true;
          }
        }

        // ── Capacité de raisonnement AUTORITAIRE : objet `thinking` ──
        // Ollama renvoie `{ thinking: { values: [...], default: "medium" } }`.
        const parsedThinking = parseOllamaThinking((data as any).thinking);
        if (parsedThinking) {
          model.reasoning = parsedThinking.enabled;
          if (parsedThinking.levels.length > 0) model.reasoningLevels = parsedThinking.levels;
          if (parsedThinking.default) model.reasoningDefault = parsedThinking.default;
        }

        // Also extract num_ctx from parameters as fallback
        if (!model.contextWindow) {
          const params = data.parameters || "";
          const m = params.match(/num_ctx\s+(\d+)/i);
          if (m) model.contextWindow = parseInt(m[1], 10);
        }
      } catch (e: any) {
        // API native indisponible pour CE modèle (provider injoignable, modèle
        // absent…) : capacité de réflexion INCONNUE → on ne change rien, on
        // journalise un avertissement et les heuristiques prennent le relais.
        console.warn(
          `[providers] /api/show indisponible pour ${model.id} — capacités de réflexion laissées inchangées (${e?.message || e})`,
        );
        // Native API not available for this model – heuristics will fill in.
      }
    }));
  }
}

/**
 * Rétro-renseignement (backfill) des niveaux de réflexion supportés sur les
 * modèles DÉJÀ ENREGISTRÉS d'un provider, à partir des capacités fraîchement
 * découvertes (`enrichWithOllamaCapabilities` → objet `thinking`).
 *
 * DÉCLENCHEUR : à chaque découverte/scan RÉUSSI d'un provider Ollama
 * (`testProviderConnection`, appelé par `POST /api/providers/:id/test` →
 * `handleScanAll`). Le coût réseau `POST /api/show` (concurrence 5, timeout 15 s)
 * est donc DÉJÀ payé par `enrichWithOllamaCapabilities` ; ce backfill ne fait que
 * persister la donnée (lecture + écriture de model-library.json).
 *
 * RÈGLES :
 *  - jamais d'ÉCRASEMENT d'une valeur existante (`reasoningLevels` déjà présent) ;
 *  - provider injoignable / `thinking` absent → aucune capacité découverte → les
 *    modèles enregistrés restent INCHANGÉS (repli « tous les niveaux ») ;
 *  - best-effort : toute erreur est journalisée mais ne fait jamais échouer le scan.
 *
 * @returns nombre de modèles rétro-renseignés (0 = aucune écriture).
 */
export async function backfillRegisteredModelReasoningLevels(
  provider: ProviderConfig,
  models: DiscoveredModel[],
): Promise<number> {
  if (!isOllamaProvider(provider)) return 0;
  try {
    const { loadModelLibrary, saveModelLibrary } = await import("./model-library.js");
    const library = loadModelLibrary();
    const candidates = library.models.filter((m) => m.providerId === provider.id);
    if (candidates.length === 0) return 0;

    // Index des capacités découvertes : seuls les modèles dont le provider
    // déclare EXPLICITEMENT des niveaux sont candidats au backfill.
    const discovered = new Map<string, DiscoveredModel>();
    for (const m of models) {
      if (Array.isArray(m.reasoningLevels) && m.reasoningLevels.length > 0) discovered.set(m.id, m);
    }
    if (discovered.size === 0) {
      console.warn(
        `[providers] Backfill réflexion (${provider.name || provider.id}) : aucune capacité « thinking » découverte — modèles enregistrés inchangés`,
      );
      return 0;
    }

    let changed = 0;
    for (const model of candidates) {
      // Ne JAMAIS écraser une valeur déjà présente.
      if (Array.isArray(model.reasoningLevels) && model.reasoningLevels.length > 0) continue;
      const dm = discovered.get(model.modelId);
      if (!dm?.reasoningLevels?.length) continue;
      model.reasoningLevels = [...dm.reasoningLevels];
      if (dm.reasoningDefault) model.reasoningDefault = dm.reasoningDefault;
      changed++;
    }
    if (changed > 0) saveModelLibrary(library);
    return changed;
  } catch (e: any) {
    // Best-effort : ne jamais faire échouer la découverte des modèles.
    console.warn("[providers] Backfill des niveaux de réflexion échoué :", e?.message || e);
    return 0;
  }
}

// ── Backfill global (déclencheur sans geste manuel) ──

/**
 * Déclencheur SIMPLE du backfill, indépendant d'un geste manuel : parcourt les
 * providers CONNUS (fichier providers.json) et rétro-renseigne les niveaux de
 * réflexion des modèles DÉJÀ enregistrés à partir des capacités CACHÉES du
 * dernier scan (`provider.discoveredModels`).
 *
 * Aucun appel réseau : c'est la contrepartie « gratuite » du backfill déclenché
 * par un scan/test de provider. Elle couvre le cas d'un utilisateur qui a scanné
 * AVANT que le backfill n'existe (donc dont les modèles enregistrés n'ont jamais
 * reçu leurs niveaux) : un simple redémarrage du backend suffit alors, sans
 * rescanner ni passer par l'UI.
 *
 * Best-effort et borné : jamais d'exception, jamais d'écrasement d'une valeur
 * existante (règles portées par `backfillRegisteredModelReasoningLevels`).
 *
 * @returns nombre total de modèles rétro-renseignés.
 */
export async function backfillAllOllamaProvidersReasoningLevels(): Promise<number> {
  let total = 0;
  try {
    for (const provider of loadProviders()) {
      // Seuls les providers Ollama exposent l'objet `thinking` (niveaux déclarés).
      if (!isOllamaProvider(provider)) continue;
      const cached = provider.discoveredModels || [];
      if (cached.length === 0) continue;
      try {
        total += await backfillRegisteredModelReasoningLevels(provider, cached);
      } catch (e: any) {
        // Backfill déjà best-effort : on isole chaque provider pour continuer.
        console.warn(
          `[providers] Backfill réflexion (${provider.name || provider.id}) échoué :`,
          e?.message || e,
        );
      }
    }
  } catch (e: any) {
    console.warn("[providers] Backfill global des niveaux de réflexion échoué :", e?.message || e);
  }
  return total;
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
        // Some providers (OpenRouter, etc.) include context_length in /v1/models
        contextWindow: m.context_length || m.context_window || m.max_context_length || undefined,
        // Some providers include capability hints
        reasoning: m.supports_reasoning || undefined,
        vision: m.supports_vision || m.multimodal || undefined,
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

    // ── Enrich with real capabilities from Ollama native API ──
    if (provider.type === "ollama" || provider.type === "openai-compatible") {
      await enrichWithOllamaCapabilities(provider, models);
    }

    // ── Backfill best-effort des niveaux de réflexion des modèles DÉJÀ
    // enregistrés (le coût /api/show est déjà payé ci-dessus). Ne bloque jamais
    // le scan : toute erreur est absorbée. Voir la fonction pour les règles. ──
    await backfillRegisteredModelReasoningLevels(provider, models);

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