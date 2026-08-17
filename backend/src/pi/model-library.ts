import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { inferReasoning, inferVision, inferContextWindow } from "./providers.js";
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "./routing-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const LIBRARY_FILE = path.join(DATA_DIR, "model-library.json");

// Re-export for convenience
export { inferReasoning } from "./providers.js";
export type { ProviderType, ProviderConfig } from "./providers.js";

// ── Types ────────────────────────────────────────────

export interface RegisteredModel {
  id: string;                  // unique internal ID
  providerId: string;          // references ProviderConfig.id
  modelId: string;             // the model's id on the provider
  name: string;                // display name
  isDefault: boolean;          // default model for modes without a specific model

  // Model capabilities (auto-detected from provider, not user-editable)
  reasoning: boolean;
  vision: boolean;             // supports image input
  contextWindow: number;       // tokens
  maxTokens: number;           // max output tokens

  // Thinking
  thinkingLevel: string;       // off, minimal, low, medium, high
}

export type AgentMode = "code" | "harness";

export interface ModeConfig {
  modelId: string | null;     // RegisteredModel.id to use for this mode (null = default)
}

export interface ProjectModeConfig {
  code: ModeConfig;
  harness: ModeConfig & { enabled: boolean; config: HarnessConfig; routing?: RoutingConfig };
  activeMode?: AgentMode;   // mode actif persisté ("code" | "harness"), défaut "code"
}

export interface HarnessAgentConfig {
  role: string;
  description: string;        // what this agent specializes in
  modelId: string | null;
  enabled: boolean;
  systemPrompt?: string;       // override default system prompt
  tools?: string[];            // override default tools
}

export interface HarnessConfig {
  agents: HarnessAgentConfig[];
  synthesize: boolean;         // whether to synthesize final output
  agentTimeout?: number;       // inactivity timeout in seconds (default: 600 = 10min without any event)
  agentMaxTimeout?: number;     // global max timeout in seconds (default: 1800 = 30min safety net)
  maxTasks?: number;           // safety limit on total tasks (default: 20)
}

export interface ModelLibrary {
  models: RegisteredModel[];
  defaultModelId: string | null;
  commitModelId: string | null;           // model for AI commit messages (null = use default)
  visionModelId: string | null;           // model for image/file analysis (null = use default or fallback)
  audioModelId: string | null;            // model for audio transcription (null = not configured)
  librarianModelId: string | null;        // model for librarian doc synthesis (null = use default)
  projectModes: Record<string, ProjectModeConfig>;  // projectId → mode config
  concurrency: {                          // Concurrency Manager config
    maxLLMSlots: number;
    maxAgentSlots: number;
  };
}

// ── Defaults ─────────────────────────────────────────

const DEFAULT_THINKING: Record<string, string> = { code: "medium" };

/** Clone la config de routage par défaut pour éviter tout partage de référence. */
function createDefaultRoutingConfig(): RoutingConfig {
  return {
    enabled: DEFAULT_ROUTING_CONFIG.enabled,
    trivial: { ...DEFAULT_ROUTING_CONFIG.trivial },
    standard: { ...DEFAULT_ROUTING_CONFIG.standard },
    complex: { ...DEFAULT_ROUTING_CONFIG.complex },
    review: { ...DEFAULT_ROUTING_CONFIG.review },
    reviewRiskThreshold: DEFAULT_ROUTING_CONFIG.reviewRiskThreshold,
    confidenceThreshold: DEFAULT_ROUTING_CONFIG.confidenceThreshold,
    classifierModelId: DEFAULT_ROUTING_CONFIG.classifierModelId,
  };
}

/**
 * Normalise une config de routage issue du disque (migration/rétro-compatibilité).
 * Garantit que `enabled` vaut `true` si l'ancienne config ne le renseignait pas.
 */
function normalizeRoutingConfig(routing: any): RoutingConfig {
  const d = createDefaultRoutingConfig();
  if (!routing || typeof routing !== "object") return d;
  return {
    enabled: routing.enabled ?? d.enabled,
    trivial: { modelId: routing.trivial?.modelId ?? d.trivial.modelId },
    standard: { modelId: routing.standard?.modelId ?? d.standard.modelId },
    complex: { modelId: routing.complex?.modelId ?? d.complex.modelId },
    review: { modelId: routing.review?.modelId ?? d.review.modelId },
    reviewRiskThreshold: routing.reviewRiskThreshold ?? d.reviewRiskThreshold,
    confidenceThreshold: routing.confidenceThreshold ?? d.confidenceThreshold,
    classifierModelId: routing.classifierModelId ?? d.classifierModelId,
  };
}

function createDefaultProjectMode(): ProjectModeConfig {
  return {
    code: { modelId: null },
    harness: { modelId: null, enabled: false,
      config: { agents: [], synthesize: true, agentTimeout: 600, agentMaxTimeout: 1800, maxTasks: 20 },
      routing: createDefaultRoutingConfig() },
    activeMode: "code",
  };
}

function getDefaultLibrary(): ModelLibrary {
  return {
    models: [],
    defaultModelId: null,
    commitModelId: null,
    visionModelId: null,
    audioModelId: null,
    librarianModelId: null,
    projectModes: {},
    concurrency: { maxLLMSlots: 3, maxAgentSlots: 5 },
  };
}

// ── Persistence ──────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadModelLibrary(): ModelLibrary {
  try {
    ensureDataDir();
    if (existsSync(LIBRARY_FILE)) {
      const data = JSON.parse(readFileSync(LIBRARY_FILE, "utf-8"));
      return migrateLibrary(data);
    }
  } catch (e) {
    console.error("[model-library] Failed to load:", e);
  }
  return getDefaultLibrary();
}

export function saveModelLibrary(library: ModelLibrary): void {
  ensureDataDir();
  writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2));
}

// ── Concurrency config ─────────────────────────────

export function getConcurrencyConfig() {
  const lib = loadModelLibrary();
  return lib.concurrency || { maxLLMSlots: 3, maxAgentSlots: 5 };
}

export async function setConcurrencyConfig(config: { maxLLMSlots?: number; maxAgentSlots?: number }) {
  const lib = loadModelLibrary();
  if (!lib.concurrency) lib.concurrency = { maxLLMSlots: 3, maxAgentSlots: 5 };
  if (config.maxLLMSlots !== undefined && config.maxLLMSlots > 0) lib.concurrency.maxLLMSlots = config.maxLLMSlots;
  if (config.maxAgentSlots !== undefined && config.maxAgentSlots > 0) lib.concurrency.maxAgentSlots = config.maxAgentSlots;
  saveModelLibrary(lib);
  // Sync with the runtime manager
  const { concurrencyManager } = await import("./concurrency.js");
  concurrencyManager.setConfig(lib.concurrency);
  return lib.concurrency;
}

// ── Migration ─────────────────────────────────────────

function migrateLibrary(data: any): ModelLibrary {
  // If it's the old format (has "modes" key), migrate
  if (data.modes && !data.models) {
    return migrateFromOldFormat(data);
  }

  const lib: ModelLibrary = {
    models: (data.models || []).map(migrateModel),
    defaultModelId: data.defaultModelId || null,
    commitModelId: data.commitModelId || null,
    visionModelId: data.visionModelId || null,
    audioModelId: data.audioModelId || null,
    librarianModelId: data.librarianModelId || null,
    projectModes: {},
    concurrency: data.concurrency || { maxLLMSlots: 3, maxAgentSlots: 5 },
  };

  // Migrate project modes
  if (data.projectModes) {
    for (const [projectId, pm] of Object.entries(data.projectModes)) {
      lib.projectModes[projectId] = migrateProjectMode(pm as any);
    }
  }

  return lib;
}

function migrateFromOldFormat(data: any): ModelLibrary {
  const lib: ModelLibrary = { models: [], defaultModelId: null, commitModelId: null, visionModelId: null, audioModelId: null, librarianModelId: null, projectModes: {}, concurrency: { maxLLMSlots: 3, maxAgentSlots: 5 } };

  // Collect all unique models from all modes
  const seenIds = new Set<string>();
  for (const modeConfig of Object.values(data.modes || {})) {
    const mc = modeConfig as any;
    for (const entry of (mc?.models || [])) {
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        lib.models.push(migrateModel({
          ...entry,
          // Old format stored provider as a string, need to figure out providerId
          providerId: entry.provider || "ollama",
        }));
      }
    }
  }

  // Set first model as default
  if (lib.models.length > 0) {
    lib.defaultModelId = lib.models[0].id;
  }

  return lib;
}

function migrateModel(m: any): RegisteredModel {
  return {
    id: m.id || makeModelId(m.providerId || m.provider || "unknown", m.modelId || ""),
    providerId: m.providerId || m.provider || "unknown",
    modelId: m.modelId || m.name || "",
    name: m.name || m.modelId || "",
    isDefault: m.isDefault || false,
    reasoning: m.reasoning ?? inferReasoning(m.modelId || m.name || "", m.family),
    vision: m.vision ?? inferVision(m.modelId || m.name || "", m.family),
    contextWindow: m.contextWindow || inferContextWindow(m.modelId || m.name || "", m.family),
    maxTokens: m.maxTokens || 16384,
    thinkingLevel: m.thinkingLevel || "medium",
  };
}

function migrateProjectMode(pm: any): ProjectModeConfig {
  const d = createDefaultProjectMode();
  // Le mode plan a été retiré du backend. Si un projet l'utilisait encore,
  // on le bascule vers le mode code (comportement par défaut).
  if (pm?.plan?.enabled === true) {
    console.warn("[model-library] Migration: le mode plan a été retiré. Le projet était configuré avec plan.enabled=true ; bascule vers le mode code.");
  }
  return {
    code: { modelId: pm?.code?.modelId ?? d.code.modelId },
    harness: {
      modelId: pm?.harness?.modelId ?? d.harness.modelId,
      enabled: pm?.harness?.enabled ?? d.harness.enabled,
      config: {
        agents: pm?.harness?.config?.agents ?? [],
        synthesize: pm?.harness?.config?.synthesize ?? true,
        agentTimeout: pm?.harness?.config?.agentTimeout ?? 600,
        agentMaxTimeout: pm?.harness?.config?.agentMaxTimeout ?? 1800,
        maxTasks: pm?.harness?.config?.maxTasks ?? 20,
      },
      routing: normalizeRoutingConfig(pm?.harness?.routing ?? migrateRoutingConfig(pm)),
    },
    // Rétro-compatibilité : les anciens fichiers n'ont pas le champ activeMode.
    // On dérive le défaut de harness.enabled : un projet existant avec le routing
    // activé (harness.enabled=true) migre vers "harness" pour préserver le routing.
    // Si le champ existe déjà, on le conserve (validé "harness" | "code", sinon fallback).
    activeMode:
      pm?.activeMode === "harness" || pm?.activeMode === "code"
        ? pm.activeMode
        : (pm?.harness?.enabled === true ? "harness" : "code"),
  };
}

/**
 * Migration best-effort de l'ancienne config `harness.config.agents` vers le
 * nouveau `RoutingConfig`. On ne supprime rien : la config legacy reste en place.
 * Mapping retenu : architect → complex, code-reviewer/security-reviewer → review.
 */
function migrateRoutingConfig(pm: any): RoutingConfig {
  const routing = createDefaultRoutingConfig();
  const agents = pm?.harness?.config?.agents;
  if (!Array.isArray(agents)) return routing;

  for (const agent of agents) {
    if (!agent?.modelId) continue;
    if (agent.role === "architect") {
      // Premier modèle d'architecte trouvé → catégorie complex.
      if (!routing.complex.modelId) routing.complex.modelId = agent.modelId;
    } else if (agent.role === "code-reviewer" || agent.role === "security-reviewer") {
      // Premier modèle de reviewer trouvé → catégorie review.
      if (!routing.review.modelId) routing.review.modelId = agent.modelId;
    }
  }

  return routing;
}

// ── Helpers ───────────────────────────────────────────

export function makeModelId(providerId: string, modelId: string): string {
  return `${providerId}__${modelId}`.replace(/[^a-zA-Z0-9_\-:]/g, "_");
}

export function getModel(library: ModelLibrary, modelId: string): RegisteredModel | undefined {
  return library.models.find((m) => m.id === modelId);
}

export function getDefaultModel(library: ModelLibrary): RegisteredModel | undefined {
  if (library.defaultModelId) {
    const m = library.models.find((m) => m.id === library.defaultModelId);
    if (m) return m;
  }
  // Fall back to first model
  return library.models[0];
}

export function getCommitModel(library: ModelLibrary): RegisteredModel | undefined {
  if (library.commitModelId) {
    const m = library.models.find((m) => m.id === library.commitModelId);
    if (m) return m;
  }
  return getDefaultModel(library);
}

/** Get the librarian model for doc synthesis (falls back to default) */
export function getLibrarianModel(library: ModelLibrary): RegisteredModel | undefined {
  if (library.librarianModelId) {
    const m = library.models.find((m) => m.id === library.librarianModelId);
    if (m) return m;
  }
  return getDefaultModel(library);
}

/** Set the librarian model id */
export function setLibrarianModelId(id: string | null): ModelLibrary {
  const library = loadModelLibrary();
  library.librarianModelId = id;
  saveModelLibrary(library);
  return library;
}

export function getModeModel(library: ModelLibrary, projectId: string, mode: AgentMode): RegisteredModel | undefined {
  const pm = library.projectModes[projectId] || createDefaultProjectMode();
  const modeConfig = pm[mode];
  const modelId = modeConfig?.modelId;
  if (modelId) {
    const m = library.models.find((m) => m.id === modelId);
    if (m) return m;
  }
  // Fall back to default model
  return getDefaultModel(library);
}

export function getProjectModeConfig(library: ModelLibrary, projectId: string): ProjectModeConfig {
  return library.projectModes[projectId] || createDefaultProjectMode();
}

/** Récupère la config de routage d'un projet (fallback sur la config par défaut). */
export function getProjectRoutingConfig(library: ModelLibrary, projectId: string): RoutingConfig {
  const pm = getProjectModeConfig(library, projectId);
  if (pm.harness?.routing) return pm.harness.routing;
  return createDefaultRoutingConfig();
}

/** Remplace la config de routage d'un projet. */
export function setProjectRoutingConfig(projectId: string, routing: RoutingConfig): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  library.projectModes[projectId].harness.routing = routing;
  saveModelLibrary(library);
  return library;
}

// ── CRUD ──────────────────────────────────────────────

export function addModel(entry: Omit<RegisteredModel, "id">): ModelLibrary {
  const library = loadModelLibrary();
  const id = makeModelId(entry.providerId, entry.modelId);
  const idx = library.models.findIndex((m) => m.id === id);
  const model: RegisteredModel = { ...entry, id };

  if (idx >= 0) {
    library.models[idx] = model;
  } else {
    library.models.push(model);
  }

  // If this is the first model or marked as default, set it as default
  if (model.isDefault || library.models.length === 1) {
    library.models.forEach((m) => (m.isDefault = m.id === id));
    library.defaultModelId = id;
  }

  saveModelLibrary(library);
  return library;
}

export function addModels(entries: Omit<RegisteredModel, "id">[]): ModelLibrary {
  let library = loadModelLibrary();
  for (const entry of entries) {
    const id = makeModelId(entry.providerId, entry.modelId);
    const idx = library.models.findIndex((m) => m.id === id);
    const model: RegisteredModel = { ...entry, id };
    if (idx >= 0) {
      library.models[idx] = model;
    } else {
      library.models.push(model);
    }
    if (model.isDefault || library.models.length === 1) {
      library.models.forEach((m) => (m.isDefault = m.id === id));
      library.defaultModelId = id;
    }
  }
  saveModelLibrary(library);
  return library;
}

export function updateModel(id: string, updates: Partial<RegisteredModel>): ModelLibrary {
  const library = loadModelLibrary();
  const idx = library.models.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error(`Model not found: ${id}`);

  library.models[idx] = { ...library.models[idx], ...updates };

  // If setting as default, unset others
  if (updates.isDefault) {
    library.models.forEach((m) => (m.isDefault = m.id === id));
    library.defaultModelId = id;
  }

  saveModelLibrary(library);
  return library;
}

export function removeModel(id: string): ModelLibrary {
  const library = loadModelLibrary();
  library.models = library.models.filter((m) => m.id !== id);

  // If we removed the default model, pick a new default
  if (library.defaultModelId === id) {
    library.defaultModelId = library.models[0]?.id || null;
    if (library.defaultModelId && library.models.length > 0) {
      library.models[0].isDefault = true;
    }
  }

  // Clean up project mode references (tous les modes)
  for (const projectId of Object.keys(library.projectModes)) {
    const pm = library.projectModes[projectId];
    if (pm.code.modelId === id) pm.code.modelId = null;
    if (pm.harness.modelId === id) pm.harness.modelId = null;

    // Nettoyage des références de routage par catégorie (ajout R1).
    const routing = pm.harness?.routing;
    if (routing) {
      for (const category of ["trivial", "standard", "complex", "review"] as const) {
        if (routing[category].modelId === id) routing[category].modelId = null;
      }
      if (routing.classifierModelId === id) routing.classifierModelId = null;
    }
  }

  // Clean up global model references (BUG-06 + BUG-32 fix)
  if (library.visionModelId === id) library.visionModelId = null;
  if (library.audioModelId === id) library.audioModelId = null;
  if (library.commitModelId === id) library.commitModelId = null;
  if (library.librarianModelId === id) library.librarianModelId = null;

  saveModelLibrary(library);
  return library;
}

export function setDefaultModel(id: string): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.models.find((m) => m.id === id)) throw new Error(`Model not found: ${id}`);
  library.defaultModelId = id;
  library.models.forEach((m) => (m.isDefault = m.id === id));
  saveModelLibrary(library);
  return library;
}

export function setProjectModeModel(projectId: string, mode: AgentMode, modelId: string | null): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  (library.projectModes[projectId] as any)[mode].modelId = modelId;
  saveModelLibrary(library);
  return library;
}

/**
 * Persiste le mode actif d'un projet ("code" | "harness") sur disque.
 * Survit au redémarrage du backend et au reboot/upgrade du conteneur.
 */
export function setProjectActiveMode(projectId: string, mode: "code" | "harness"): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  library.projectModes[projectId].activeMode = mode;
  saveModelLibrary(library);
  return library;
}

export function setProjectModeEnabled(projectId: string, mode: "review" | "harness", enabled: boolean): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  (library.projectModes[projectId] as any)[mode].enabled = enabled;
  saveModelLibrary(library);
  return library;
}

export function setProjectModeHarnessConfig(
  projectId: string,
  config: {
    agents?: { role: string; description?: string; modelId: string | null; enabled: boolean; systemPrompt?: string; tools?: string[] }[];
    synthesize?: boolean;
    agentTimeout?: number;
    agentMaxTimeout?: number;
    maxTasks?: number;
  }
): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  const harness = (library.projectModes[projectId] as any).harness;
  if (!harness.config) harness.config = { agents: [], synthesize: true, agentTimeout: 600, agentMaxTimeout: 1800, maxTasks: 20 };
  if (config.agents !== undefined) harness.config.agents = config.agents;
  if (config.synthesize !== undefined) harness.config.synthesize = config.synthesize;
  if (config.agentTimeout !== undefined) harness.config.agentTimeout = config.agentTimeout;
  if (config.agentMaxTimeout !== undefined) harness.config.agentMaxTimeout = config.agentMaxTimeout;
  if (config.maxTasks !== undefined) harness.config.maxTasks = Math.max(1, Math.min(50, config.maxTasks));
  saveModelLibrary(library);
  return library;
}

/** Clean up project mode configs for deleted projects */
export function cleanupProjectModes(projectId: string): void {
  const library = loadModelLibrary();
  delete library.projectModes[projectId];
  saveModelLibrary(library);
}