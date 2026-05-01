import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const LIBRARY_FILE = path.join(DATA_DIR, "model-library.json");

// ── Types ────────────────────────────────────────────

export type AgentMode = "code" | "review" | "plan" | "commit";

export interface ModelEntry {
  id: string;             // unique ID (provider/modelId slug)
  provider: string;       // "ollama" | "anthropic" | "openai" | etc.
  modelId: string;        // e.g. "claude-sonnet-4-20250514" or "llama3.2:3b"
  name: string;           // display name
  thinkingLevel: string;  // default thinking level for this model in this mode
}

export interface ModeConfig {
  enabled: boolean;
  activeModelId: string | null;  // ModelEntry.id of the active model
  models: ModelEntry[];          // models configured for this mode
  instructions: string;          // system steer / prompt for this mode (Pi "instructions" style)
  tools: string[];               // allowed tools for this mode (empty = all tools)
  readOnly: boolean;              // convenience flag: restrict to read-only tools
}

export interface ModelLibrary {
  modes: Record<AgentMode, ModeConfig>;
}

// ── Default mode instructions (inspired by Pi presets) ──

export const DEFAULT_INSTRUCTIONS: Record<AgentMode, string> = {
  code: "",
  commit: `You generate commit messages from git diffs. You must be concise, specific, and descriptive.

Rules:
- First line: type(scope): short description (max 72 chars)
- Types: feat, fix, refactor, chore, docs, style, test, perf, ci, build
- Body: 2-4 bullet points explaining WHAT changed and WHY
- Describe the INTENT of the change, not just list file names
- Use verb infinitive ("add", "fix", "refactor") not gerundive ("adding", "fixing")
- No markdown, no code blocks, plain text only
- If the diff is unclear, focus on the most significant change

Examples:
feat(chat): add streaming indicator to chat input area
- Move streaming status from sidebar to bottom of chat zone
- Show pulsing dot + "generating…" label near input field
- Keep git branch display in the same line for context

fix(git): remove stale index.lock before git operations
- Auto-detect and delete lock files older than 30 seconds
- Retry git operations once after lock cleanup
- Return clear GIT_LOCKED error code to frontend for user feedback

refactor(session): switch from singleton to per-project session map
- Store sessions by project ID instead of global singleton
- Allow parallel sessions across different projects
- Preserve terminal buffers across WebSocket reconnections`,
  review: `You are in REVIEW mode. Your job is to review code and provide feedback.

Rules:
- You can READ code but should NOT make changes
- Focus on: correctness, security, performance, readability
- Identify bugs, anti-patterns, and potential issues
- Suggest improvements with specific explanations
- Rate confidence level for each finding (high/medium/low)

When reviewing:
1. Read the relevant files thoroughly
2. Summarize what the code does
3. List issues found with severity
4. Suggest specific fixes (but do not implement them)`,

  plan: `You are in PLAN mode — a read-only exploration mode for safe code analysis.

Rules:
- You can only use read-only tools: read, grep, find, ls
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to read-only commands (cat, ls, grep, git status, etc.)

Tasks:
1. Explore the codebase thoroughly to understand the current state
2. Create a detailed numbered plan under a "Plan:" header
3. For each step: describe what to change, why, and potential risks
4. List files that will be modified
5. Note any tests that should be added or updated

Do NOT attempt to make changes — just describe what you would do.`,
};

const DEFAULT_TOOLS: Record<AgentMode, string[]> = {
  code: [],  // all tools
  commit: [],
  review: ["read", "bash", "grep", "find", "ls"],
  plan: ["read", "bash", "grep", "find", "ls"],
};

const DEFAULT_READONLY: Record<AgentMode, boolean> = {
  code: false,
  commit: true,
  review: true,
  plan: true,
};

// ── Persistence ──────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function createDefaultMode(mode: AgentMode): ModeConfig {
  return {
    enabled: mode === "code",
    activeModelId: null,
    models: [],
    instructions: DEFAULT_INSTRUCTIONS[mode],
    tools: DEFAULT_TOOLS[mode],
    readOnly: DEFAULT_READONLY[mode],
  };
}

function getDefaultLibrary(): ModelLibrary {
  return {
    modes: {
      code: createDefaultMode("code"),
      commit: createDefaultMode("commit"),
  review: createDefaultMode("review"),
      plan: createDefaultMode("plan"),
    },
  };
}

function migrateModeConfig(mode: AgentMode, config: any): ModeConfig {
  const defaults = createDefaultMode(mode);
  return {
    enabled: config.enabled ?? defaults.enabled,
    activeModelId: config.activeModelId ?? defaults.activeModelId,
    models: config.models ?? defaults.models,
    instructions: config.instructions ?? defaults.instructions,
    tools: config.tools ?? defaults.tools,
    readOnly: config.readOnly ?? defaults.readOnly,
  };
}

export function loadModelLibrary(): ModelLibrary {
  try {
    ensureDataDir();
    if (existsSync(LIBRARY_FILE)) {
      const data = JSON.parse(readFileSync(LIBRARY_FILE, "utf-8"));
      const defaults = getDefaultLibrary();
      for (const mode of Object.keys(defaults.modes) as AgentMode[]) {
        if (!data.modes[mode]) {
          data.modes[mode] = defaults.modes[mode];
        } else {
          data.modes[mode] = migrateModeConfig(mode, data.modes[mode]);
        }
      }
      return data as ModelLibrary;
    }
  } catch (e) {
    console.error("Failed to load model library:", e);
  }
  return getDefaultLibrary();
}

export function saveModelLibrary(library: ModelLibrary): void {
  ensureDataDir();
  writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2));
}

// ── CRUD operations ───────────────────────────────────

export function getModeConfig(mode: AgentMode): ModeConfig {
  const library = loadModelLibrary();
  return library.modes[mode];
}

export function setModeEnabled(mode: AgentMode, enabled: boolean): ModelLibrary {
  const library = loadModelLibrary();
  library.modes[mode].enabled = enabled;
  if (!enabled) {
    library.modes[mode].activeModelId = null;
  }
  saveModelLibrary(library);
  return library;
}

export function setModeInstructions(mode: AgentMode, instructions: string): ModelLibrary {
  const library = loadModelLibrary();
  library.modes[mode].instructions = instructions;
  saveModelLibrary(library);
  return library;
}

export function setModeTools(mode: AgentMode, tools: string[]): ModelLibrary {
  const library = loadModelLibrary();
  library.modes[mode].tools = tools;
  saveModelLibrary(library);
  return library;
}

export function setModeReadOnly(mode: AgentMode, readOnly: boolean): ModelLibrary {
  const library = loadModelLibrary();
  library.modes[mode].readOnly = readOnly;
  saveModelLibrary(library);
  return library;
}

export function addModelToMode(mode: AgentMode, entry: ModelEntry): ModelLibrary {
  const library = loadModelLibrary();
  const idx = library.modes[mode].models.findIndex((m) => m.id === entry.id);
  if (idx >= 0) {
    library.modes[mode].models[idx] = entry;
  } else {
    library.modes[mode].models.push(entry);
  }
  if (!library.modes[mode].activeModelId) {
    library.modes[mode].activeModelId = entry.id;
  }
  saveModelLibrary(library);
  return library;
}

export function removeModelFromMode(mode: AgentMode, entryId: string): ModelLibrary {
  const library = loadModelLibrary();
  library.modes[mode].models = library.modes[mode].models.filter(
    (m) => m.id !== entryId
  );
  if (library.modes[mode].activeModelId === entryId) {
    library.modes[mode].activeModelId =
      library.modes[mode].models[0]?.id || null;
  }
  saveModelLibrary(library);
  return library;
}

export function setActiveModel(mode: AgentMode, entryId: string): ModelLibrary {
  const library = loadModelLibrary();
  const entry = library.modes[mode].models.find((m) => m.id === entryId);
  if (!entry) throw new Error(`Model not found in library: ${entryId}`);
  library.modes[mode].activeModelId = entryId;
  saveModelLibrary(library);
  return library;
}

export function setModelThinkingLevel(
  mode: AgentMode,
  entryId: string,
  thinkingLevel: string
): ModelLibrary {
  const library = loadModelLibrary();
  const entry = library.modes[mode].models.find((m) => m.id === entryId);
  if (!entry) throw new Error(`Model not found in library: ${entryId}`);
  entry.thinkingLevel = thinkingLevel;
  saveModelLibrary(library);
  return library;
}

/** Generate a stable ID from provider + modelId */
export function makeModelEntryId(provider: string, modelId: string): string {
  return `${provider}__${modelId}`.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

/** Get the active model entry for a mode (or null) */
export function getActiveModelForMode(mode: AgentMode): ModelEntry | null {
  const config = getModeConfig(mode);
  if (!config.activeModelId) return null;
  return config.models.find((m) => m.id === config.activeModelId) || null;
}

/** Get the currently active mode (first enabled mode with an active model) */
export function getActiveMode(library: ModelLibrary): AgentMode | null {
  for (const mode of Object.keys(library.modes) as AgentMode[]) {
    if (library.modes[mode].enabled && library.modes[mode].activeModelId) {
      return mode;
    }
  }
  // Fallback: code mode if enabled
  if (library.modes.code.enabled) return "code";
  return null;
}