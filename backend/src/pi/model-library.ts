import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { inferReasoning } from "./providers.js";

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

  // Model capabilities/dimensions
  reasoning: boolean;
  vision: boolean;             // supports image input
  contextWindow: number;       // tokens
  maxTokens: number;           // max output tokens

  // Inference parameters
  temperature?: number;        // 0-2, default per provider
  topP?: number;               // 0-1
  minP?: number;               // 0-1
  topK?: number;               // 1-100
  repeatPenalty?: number;      // 1-2

  // Thinking
  thinkingLevel: string;       // off, minimal, low, medium, high
}

export type AgentMode = "code" | "review" | "plan";

export interface ModeConfig {
  modelId: string | null;     // RegisteredModel.id to use for this mode (null = default)
}

export interface ProjectModeConfig {
  code: ModeConfig;
  plan: ModeConfig & { enabled: boolean };
  review: ModeConfig & { enabled: boolean; maxReviews: number };
}

export interface ModelLibrary {
  models: RegisteredModel[];
  defaultModelId: string | null;
  commitModelId: string | null;           // model for AI commit messages (null = use default)
  projectModes: Record<string, ProjectModeConfig>;  // projectId → mode config
}

// ── Defaults ─────────────────────────────────────────

const DEFAULT_THINKING: Record<string, string> = { code: "medium", plan: "high", review: "medium" };

function createDefaultProjectMode(): ProjectModeConfig {
  return {
    code: { modelId: null },
    plan: { modelId: null, enabled: false },
    review: { modelId: null, enabled: false, maxReviews: 1 },
  };
}

function getDefaultLibrary(): ModelLibrary {
  return {
    models: [],
    defaultModelId: null,
    commitModelId: null,
    projectModes: {},
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
    projectModes: {},
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
  const lib: ModelLibrary = { models: [], defaultModelId: null, commitModelId: null, projectModes: {} };

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
    reasoning: m.reasoning ?? inferReasoning(m.modelId || m.name || ""),
    vision: m.vision ?? false,
    contextWindow: m.contextWindow || 128000,
    maxTokens: m.maxTokens || 16384,
    temperature: m.temperature,
    topP: m.topP,
    minP: m.minP,
    topK: m.topK,
    repeatPenalty: m.repeatPenalty,
    thinkingLevel: m.thinkingLevel || "medium",
  };
}

function migrateProjectMode(pm: any): ProjectModeConfig {
  const d = createDefaultProjectMode();
  return {
    code: { modelId: pm?.code?.modelId ?? d.code.modelId },
    plan: {
      modelId: pm?.plan?.modelId ?? d.plan.modelId,
      enabled: pm?.plan?.enabled ?? d.plan.enabled,
    },
    review: {
      modelId: pm?.review?.modelId ?? d.review.modelId,
      enabled: pm?.review?.enabled ?? d.review.enabled,
      maxReviews: pm?.review?.maxReviews ?? d.review.maxReviews,
    },
  };
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

  // Clean up project mode references
  for (const projectId of Object.keys(library.projectModes)) {
    const pm = library.projectModes[projectId];
    if (pm.code.modelId === id) pm.code.modelId = null;
    if (pm.plan.modelId === id) pm.plan.modelId = null;
    if (pm.review.modelId === id) pm.review.modelId = null;
  }

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

export function setProjectModeEnabled(projectId: string, mode: "plan" | "review", enabled: boolean): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  (library.projectModes[projectId] as any)[mode].enabled = enabled;
  saveModelLibrary(library);
  return library;
}

export function setProjectModeMaxReviews(projectId: string, maxReviews: number): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  library.projectModes[projectId].review.maxReviews = maxReviews;
  saveModelLibrary(library);
  return library;
}

/** Clean up project mode configs for deleted projects */
export function cleanupProjectModes(projectId: string): void {
  const library = loadModelLibrary();
  delete library.projectModes[projectId];
  saveModelLibrary(library);
}