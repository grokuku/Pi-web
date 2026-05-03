import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { fileURLToPath } from "url";
import path from "path";
import { loadModelLibrary, DEFAULT_INSTRUCTIONS } from "./model-library.js";
import type { AgentMode } from "./model-library.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, "..", "..", ".pi-agent");

export interface PiSessionState {
  session: AgentSession | null;
  isStreaming: boolean;
  cwd: string;
  unsubscribe: (() => void) | null;
  projectId: string;
  activeMode: AgentMode;       // current active mode (default "code")
  reviewCycle: number;          // current auto-review cycle count
  autoReviewInProgress: boolean; // is an auto-review cycle running
  autoReviewAborted: boolean;   // was auto-review aborted by user
}

// ─── Multi-project session map ──────────────────────────
// Instead of a single global session, we maintain one session per project.
// Sessions survive across WebSocket connections and can be resumed from disk.
const sessionsByProject = new Map<string, PiSessionState>();

// Shared instances - reused across sessions
let sharedAuthStorage = AuthStorage.create();
let sharedModelRegistry = ModelRegistry.create(sharedAuthStorage);

// Pending config per project: applied when a session is created/resumed
const pendingModelByProject = new Map<string, { provider: string; modelId: string }>();
const pendingThinkingByProject = new Map<string, string>();

type EventCallback = (event: AgentSessionEvent, projectId: string) => void;
let eventCallbacks = new Set<EventCallback>();

// Track active tool executions
const activeToolCalls: Map<
  string,
  {
    toolName: string;
    args: any;
    output: string;
    startTime: number;
    projectId: string;
  }
> = new Map();

export function getActiveToolCalls() {
  return activeToolCalls;
}

export function reloadModelRegistry(): void {
  // Refresh existing registry (keeps dynamically registered providers like Ollama)
  // instead of creating a new empty one that would lose them.
  try {
    sharedModelRegistry.refresh();
  } catch {
    // If refresh fails, recreate from scratch
    sharedModelRegistry = ModelRegistry.create(sharedAuthStorage);
  }
}

export function getModelRegistry(): ModelRegistry {
  return sharedModelRegistry;
}

export function subscribeToEvents(callback: EventCallback): () => void {
  eventCallbacks.add(callback);
  return () => { eventCallbacks.delete(callback); };
}

function emitToSubscribers(event: AgentSessionEvent, projectId: string) {
  for (const cb of eventCallbacks) {
    try { cb(event, projectId); } catch (e) { console.error("Event callback error:", e); }
  }
}

function emitSessionUpdate(projectId: string) {
  const info = getSessionInfo(projectId);
  for (const cb of eventCallbacks) {
    try {
      cb({ type: "session_update", session: info } as any, projectId);
    } catch (e) {
      console.error("Session update callback error:", e);
    }
  }
}

/**
 * Create or resume a Pi session for a project.
 *
 * - If a session already exists in memory for this project, return it.
 * - If the project has a saved sessionId, resume it from disk.
 * - Otherwise, try to continue the most recent session for this cwd.
 * - If no session exists, create a new one.
 */
export async function createPiSession(
  cwd: string,
  projectId: string,
  options?: { resume?: boolean; sessionId?: string }
): Promise<PiSessionState> {
  // ── Reuse existing in-memory session ──
  const existing = sessionsByProject.get(projectId);
  if (existing?.session) {
    console.log(`[PiSession] Reusing existing session for project ${projectId}`);
    return existing;
  }

  const authStorage = sharedAuthStorage;
  const modelRegistry = sharedModelRegistry;

  // ── Determine which session to load ──
  let sessionManager: SessionManager;

  if (options?.sessionId) {
    // Resume a specific session by ID
    // Session files are stored in ~/.pi/agent/sessions/<encoded-cwd>/
    // We use continueRecent and then find the matching session
    console.log(`[PiSession] Resuming specific session: ${options.sessionId}`);
    sessionManager = SessionManager.create(cwd);
    // Find the session file by ID
    try {
      const sessions = await SessionManager.list(cwd);
      const target = sessions.find(s => s.id === options.sessionId);
      if (target) {
        sessionManager.setSessionFile(target.path);
      }
    } catch (e) {
      console.warn(`[PiSession] Could not find session ${options.sessionId}, creating new`);
    }
  } else if (options?.resume !== false) {
    // Try to continue the most recent session for this cwd
    console.log(`[PiSession] Attempting to resume recent session for ${cwd}`);
    sessionManager = SessionManager.continueRecent(cwd);
  } else {
    // Create a brand new session
    console.log(`[PiSession] Creating new session for ${cwd}`);
    sessionManager = SessionManager.create(cwd);
  }

  try {
    const { session } = await createAgentSession({
      cwd,
      sessionManager,
      authStorage,
      modelRegistry,
    });

    const unsubscribe = session.subscribe((event) => {
      // Track tool executions
      if (event.type === "tool_execution_start") {
        activeToolCalls.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          output: "",
          startTime: Date.now(),
          projectId,
        });
      } else if (event.type === "tool_execution_update") {
        const existing = activeToolCalls.get(event.toolCallId);
        if (existing && event.partialResult?.content) {
          existing.output = event.partialResult.content
            .map((c: any) => c.text || "")
            .join("");
        }
      } else if (event.type === "tool_execution_end") {
        const existing = activeToolCalls.get(event.toolCallId);
        if (existing) {
          if (event.result?.content) {
            existing.output = event.result.content
              .map((c: any) => c.text || "")
              .join("");
          }
        }
      } else if (event.type === "agent_start") {
        const state = sessionsByProject.get(projectId);
        if (state) state.isStreaming = true;
        emitSessionUpdate(projectId);
      } else if (event.type === "agent_end") {
        const state = sessionsByProject.get(projectId);
        if (state) state.isStreaming = false;
        // Clean up tool calls for this project
        for (const [id, tc] of activeToolCalls) {
          if (tc.projectId === projectId) activeToolCalls.delete(id);
        }
        emitSessionUpdate(projectId);
      }

      // Forward to WebSocket subscribers (with projectId for routing)
      emitToSubscribers(event, projectId);
    });

    const newSession: PiSessionState = {
      session,
      isStreaming: false,
      cwd,
      unsubscribe,
      projectId,
      activeMode: "code",
      reviewCycle: 0,
      autoReviewInProgress: false,
      autoReviewAborted: false,
    };

    sessionsByProject.set(projectId, newSession);

    // Apply pending model/thinking if queued before session existed
    const pendingModel = pendingModelByProject.get(projectId);
    if (pendingModel) {
      try {
        const model = sharedModelRegistry.find(pendingModel.provider, pendingModel.modelId);
        if (model) {
          await session.setModel(model);
          console.log(`Applied pending model for ${projectId}: ${pendingModel.provider}/${pendingModel.modelId}`);
        }
      } catch (e) {
        console.error("Failed to apply pending model:", e);
      }
      pendingModelByProject.delete(projectId);
    }
    const pendingThinking = pendingThinkingByProject.get(projectId);
    if (pendingThinking) {
      try {
        session.setThinkingLevel(pendingThinking as any);
        console.log(`Applied pending thinking level for ${projectId}: ${pendingThinking}`);
      } catch (e) {
        console.error("Failed to apply pending thinking level:", e);
      }
      pendingThinkingByProject.delete(projectId);
    }

    console.log(`[PiSession] Session ready for project ${projectId}: ${session.sessionId}`);
    emitSessionUpdate(projectId);
    return newSession;
  } catch (error) {
    console.error("Failed to create/resume Pi session:", error);
    throw error;
  }
}

/**
 * Get the session state for a project (or null if no session).
 */
export function getSession(projectId: string): PiSessionState | undefined {
  return sessionsByProject.get(projectId);
}

/**
 * Get the current session for backward compatibility (returns first active session).
 * Prefer getSession(projectId) for multi-project support.
 */
export function getCurrentSession(): PiSessionState {
  // Return first active session, or empty state
  for (const [, state] of sessionsByProject) {
    if (state.session) return state;
  }
  return {
    session: null,
    isStreaming: false,
    cwd: process.cwd(),
    unsubscribe: null,
    projectId: "",
    activeMode: "code",
    reviewCycle: 0,
    autoReviewInProgress: false,
    autoReviewAborted: false,
  };
}

export async function sendPrompt(
  message: string,
  projectId: string,
  images?: { data: string; mimeType: string }[]
): Promise<{ command?: string; result?: string } | void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) {
    throw new Error("No active Pi session for this project");
  }

  // ── Handle slash commands ──
  const trimmed = message.trim();
  if (trimmed.startsWith("/")) {
    const session = state.session!;  // Guaranteed by the check above
    const spaceIndex = trimmed.indexOf(" ");
    const cmd = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

    switch (cmd) {
      case "/new": {
        await createPiSession(state.cwd, projectId, { resume: false });
        return { command: "new", result: "✓ New session started" };
      }
      case "/compact": {
        // Check if there are enough messages
        const sessionManager = session.sessionManager;
        const entries = sessionManager.getEntries();
        const msgCount = entries.filter((e: any) => e.type === "message").length;
        if (msgCount < 2) {
          return { command: "compact", result: "Nothing to compact (no messages yet)" };
        }
        try {
          await session.compact(args || undefined);
          return { command: "compact", result: "✓ Context compacted" };
        } catch {
          return { command: "compact", result: "Compaction failed or cancelled" };
        }
      }
      case "/model": {
        // /model — list available, /model <name> — switch
        if (!args) {
          const available = session.modelRegistry.getAvailable();
          const lines = available.map((m: any) => {
            const isActive = session.model?.provider === m.provider && session.model?.id === m.id;
            return `${isActive ? "→ " : "  "}${m.provider}/${m.id}`;
          });
          return { command: "model", result: `Available models:\n${lines.join("\n")}` };
        }
        // Try to find and set the model
        const available = session.modelRegistry.getAvailable();
        const match = available.find((m: any) =>
          m.id === args || m.name === args ||
          `${m.provider}/${m.id}` === args ||
          m.id.includes(args)
        );
        if (match) {
          await session.setModel(match);
          return { command: "model", result: `✓ Model set to ${match.provider}/${match.id}` };
        }
        return { command: "model", result: `Model not found: ${args}. Use /model to list available.` };
      }
      case "/help": {
        return {
          command: "help",
          result: `Available commands:\n  /new      — Start a new session\n  /compact   — Compact conversation context\n  /model     — List or switch model\n  /clear     — Clear screen (keep session)\n  /help      — Show this help`,
        };
      }
      case "/clear": {
        return { command: "clear", result: "" };
      }
      default: {
        // Unknown command — try extension commands via session.prompt()
        // Pi extensions may register custom commands
        break;
      }
    }
  }

  const imageAttachments = images?.map((img) => ({
    type: "image" as const,
    data: img.data,
    mimeType: img.mimeType,
  }));

  if (state.isStreaming) {
    await state.session.steer(message, imageAttachments);
  } else {
    const options: any = {};
    if (imageAttachments && imageAttachments.length > 0) {
      options.images = imageAttachments;
    }
    await state.session.prompt(message, options);
  }

  // ── Trigger auto-review if applicable ──
  // Slash commands are handled above and return early
  // so this only runs after a real AI prompt
  if (!trimmed.startsWith("/")) {
    triggerAutoReviewIfNeeded(projectId);
  }
}

export async function steerPrompt(message: string, projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) {
    throw new Error("No active Pi session for this project");
  }
  await state.session.steer(message);
}

export async function abortPi(projectId?: string): Promise<void> {
  if (projectId) {
    const state = sessionsByProject.get(projectId);
    if (state?.session) await state.session.abort();
  } else {
    // Abort all sessions
    for (const [, state] of sessionsByProject) {
      if (state?.session) await state.session.abort();
    }
  }
}

export async function setModel(
  provider: string,
  modelId: string,
  projectId?: string
): Promise<boolean> {
  reloadModelRegistry();

  const model = sharedModelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);

  if (projectId) {
    const state = sessionsByProject.get(projectId);
    if (state?.session) {
      await state.session.setModel(model);
      emitSessionUpdate(projectId);
      return false; // applied immediately
    }
    // No session yet — queue for later
    pendingModelByProject.set(projectId, { provider, modelId });
    return true; // queued
  }

  // Apply to all active sessions
  let queued = false;
  for (const [pid, state] of sessionsByProject) {
    if (state?.session) {
      await state.session.setModel(model);
      emitSessionUpdate(pid);
    } else {
      pendingModelByProject.set(pid, { provider, modelId });
      queued = true;
    }
  }
  return queued;
}

export async function cycleModel(projectId: string): Promise<any> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) throw new Error("No active Pi session for this project");
  return await state.session.cycleModel();
}

export async function setThinkingLevel(level: string, projectId?: string): Promise<boolean> {
  const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (!validLevels.includes(level)) {
    throw new Error(`Invalid thinking level: ${level}`);
  }

  if (projectId) {
    const state = sessionsByProject.get(projectId);
    if (state?.session) {
      state.session.setThinkingLevel(level as any);
      emitSessionUpdate(projectId);
      return false;
    }
    pendingThinkingByProject.set(projectId, level);
    return true;
  }

  // Apply to all
  let queued = false;
  for (const [pid, state] of sessionsByProject) {
    if (state?.session) {
      state.session.setThinkingLevel(level as any);
      emitSessionUpdate(pid);
    } else {
      pendingThinkingByProject.set(pid, level);
      queued = true;
    }
  }
  return queued;
}

export async function newSession(projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  const cwd = state?.cwd || process.cwd();

  // Dispose existing session
  if (state?.session) {
    if (state.unsubscribe) state.unsubscribe();
    await state.session.dispose();
    sessionsByProject.delete(projectId);
  }

  // Create brand new session (no resume)
  await createPiSession(cwd, projectId, { resume: false });
  emitSessionUpdate(projectId);
}

export async function compactSession(
  projectId: string,
  customInstructions?: string
): Promise<any> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) throw new Error("No active Pi session for this project");
  const result = await state.session.compact(customInstructions);
  emitSessionUpdate(projectId);
  return result;
}

/**
 * List all sessions for a project directory.
 */
export async function listSessions(cwd: string): Promise<any[]> {
  try {
    return await SessionManager.list(cwd);
  } catch {
    return [];
  }
}

/**
 * Inject a notification into the session context (e.g. git push success).
 * The message is added as a CustomMessage visible to the LLM
 * and displayed distinctly in the UI.
 *
 * Uses sendCustomMessage which handles both streaming and non-streaming cases.
 * The message will be included in the next LLM turn without triggering one.
 */
export async function injectSessionNotification(
  projectId: string,
  notification: string,
  details?: Record<string, unknown>
): Promise<boolean> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) {
    console.warn(`[injectNotification] No session for project ${projectId}`);
    return false;
  }

  try {
    await state.session.sendCustomMessage(
      {
        customType: "git_notification",
        content: notification,
        display: true,
        details,
      },
      { triggerTurn: false }
    );
    console.log(`[injectNotification] Injected notification for ${projectId}: ${notification.slice(0, 80)}...`);
    return true;
  } catch (e: any) {
    console.error(`[injectNotification] Failed for ${projectId}:`, e.message);
    return false;
  }
}

export function getSessionInfo(projectId?: string) {
  const state = projectId
    ? sessionsByProject.get(projectId)
    : getCurrentSession();

  if (!state?.session) return null;

  return {
    sessionId: state.session.sessionId,
    sessionFile: state.session.sessionFile,
    isStreaming: state.isStreaming,
    cwd: state.cwd,
    projectId: state.projectId,
    thinkingLevel: state.session.thinkingLevel,
    model: state.session.model
      ? {
          id: (state.session.model as any).id,
          name: (state.session.model as any).name,
          provider: (state.session.model as any).provider,
          modelId: (state.session.model as any).modelId,
          contextWindow: (state.session.model as any).contextWindow,
          reasoning: !!(state.session.model as any).reasoning,
        }
      : null,
    messageCount: state.session.messages?.length || 0,
    messages: state.session.messages?.map((m: any) => ({
      role: m.role,
      content: m.content,
      id: m.id,
    })) || [],
  };
}

/**
 * Dispose a specific project session (but keep session file on disk for resume).
 */
export async function disposeSession(projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (state) {
    if (state.unsubscribe) state.unsubscribe();
    // Don't dispose the AgentSession - just disconnect from events.
    // The session file persists on disk for resume.
    // If we want a full cleanup, call state.session.dispose() explicitly.
    sessionsByProject.delete(projectId);
  }
}

/**
 * Dispose all sessions.
 */
export async function disposeAllSessions(): Promise<void> {
  for (const [projectId, state] of sessionsByProject) {
    if (state.unsubscribe) state.unsubscribe();
    if (state.session) await state.session.dispose();
  }
  sessionsByProject.clear();
}

/**
 * Get the full message history for a project's session.
 * Useful for reconstructing chat UI after reconnection.
 */
export function getSessionMessages(projectId: string): any[] {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) return [];
  return state.session.messages || [];
}

// ── Mode Management ───────────────────────────────────

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Apply a mode's configuration to the Pi session:
 * - Switch model
 * - Set thinking level
 * - Filter tools (read-only for plan/review)
 * - Inject mode instructions into system prompt
 */
export async function applyModeToSession(mode: AgentMode, projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) throw new Error("No active Pi session");

  const library = loadModelLibrary();
  const cfg = library.modes[mode];

  // ── Apply model ──
  if (cfg.activeModelId && cfg.enabled) {
    const entry = cfg.models.find(m => m.id === cfg.activeModelId);
    if (entry) {
      try {
        reloadModelRegistry();

        // Register provider override if custom reasoning/contextWindow
        if (entry.reasoning !== undefined || entry.contextWindow !== undefined) {
          const registry = getModelRegistry();
          const existingModel = registry.find(entry.provider, entry.modelId);
          if (
            (entry.reasoning !== undefined && existingModel?.reasoning !== entry.reasoning) ||
            (entry.contextWindow !== undefined && existingModel?.contextWindow !== entry.contextWindow)
          ) {
            registry.registerProvider(entry.provider, {
              baseUrl: existingModel?.baseUrl,
              models: [{
                id: existingModel?.id || entry.modelId,
                name: existingModel?.name || entry.name || entry.modelId,
                reasoning: entry.reasoning ?? existingModel?.reasoning ?? false,
                input: existingModel?.input || ["text"],
                contextWindow: entry.contextWindow ?? existingModel?.contextWindow ?? 128000,
                maxTokens: entry.maxTokens ?? existingModel?.maxTokens ?? 16384,
                cost: existingModel?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }],
            });
          }
        }

        await setModel(entry.provider, entry.modelId);
        await setThinkingLevel(entry.thinkingLevel);
      } catch (e: any) {
        console.error(`[mode] Failed to apply model for ${mode}:`, e.message);
      }
    }
  }

  // ── Apply tool filtering ──
  const session = state.session;
  if (cfg.readOnly || (cfg.tools.length > 0 && !cfg.tools.includes("edit") && !cfg.tools.includes("write"))) {
    // Read-only mode: use the mode's tool list or default read-only tools
    const toolNames = cfg.tools.length > 0 ? cfg.tools : READ_ONLY_TOOLS;
    (session as any).setActiveToolsByName(toolNames);
  } else if (cfg.tools.length > 0) {
    (session as any).setActiveToolsByName(cfg.tools);
  } else {
    // Code mode: all tools
    (session as any).setActiveToolsByName(ALL_TOOLS);
  }

  // ── Inject mode instructions into system prompt ──
  if (cfg.instructions && cfg.instructions.trim()) {
    const basePrompt = (session as any)._baseSystemPrompt || "";
    const modeBlock = `\n\n## Current Mode: ${mode.toUpperCase()}\n\n${cfg.instructions}`;
    (session as any)._baseSystemPrompt = basePrompt + modeBlock;
    (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;
  }

  // ── Update state ──
  state.activeMode = mode;
  state.reviewCycle = 0;
  state.autoReviewAborted = false;

  emitModeChange(projectId, mode, false);
  emitSessionUpdate(projectId);
}

/**
 * Switch to a different mode. Only works if the mode is enabled and has a model.
 */
export async function switchMode(mode: AgentMode, projectId: string): Promise<void> {
  const library = loadModelLibrary();
  const cfg = library.modes[mode];

  if (mode !== "code" && (!cfg.enabled || !cfg.activeModelId)) {
    throw new Error(`Mode ${mode} is not enabled or has no active model`);
  }

  await applyModeToSession(mode, projectId);
}

/**
 * Return to CODE mode (restore all tools, remove mode instructions).
 */
export async function restoreCodeMode(projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) return;

  const session = state.session;
  const library = loadModelLibrary();
  const codeCfg = library.modes.code;

  // Apply code model (if enabled with a model)
  if (codeCfg.activeModelId && codeCfg.enabled) {
    const entry = codeCfg.models.find(m => m.id === codeCfg.activeModelId);
    if (entry) {
      try {
        await setModel(entry.provider, entry.modelId);
        await setThinkingLevel(entry.thinkingLevel);
      } catch (e: any) {
        console.error("[mode] Failed to restore code model:", e.message);
      }
    }
  }

  // Restore all tools
  (session as any).setActiveToolsByName(ALL_TOOLS);

  // Rebuild system prompt WITHOUT mode instructions
  // The _rebuildSystemPrompt call from setActiveToolsByName already clears custom additions
  // We re-apply only code mode instructions if they exist
  if (codeCfg.instructions && codeCfg.instructions.trim()) {
    const basePrompt = (session as any)._baseSystemPrompt || "";
    // Only add if not already present
    if (!basePrompt.includes("Current Mode: CODE")) {
      const modeBlock = `\n\n## Current Mode: CODE\n\n${codeCfg.instructions}`;
      (session as any)._baseSystemPrompt = basePrompt + modeBlock;
      (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;
    }
  }

  state.activeMode = "code";
  emitModeChange(projectId, "code", false);
  emitSessionUpdate(projectId);
}

/** Get the current active mode for a project */
export function getActiveMode(projectId: string): AgentMode {
  const state = sessionsByProject.get(projectId);
  return state?.activeMode || "code";
}

/** Get auto-review state for a project */
export function getAutoReviewState(projectId: string): {
  inProgress: boolean; cycle: number; maxReviews: number; mode: AgentMode
} {
  const state = sessionsByProject.get(projectId);
  const library = loadModelLibrary();
  const reviewCfg = library.modes.review;
  return {
    inProgress: state?.autoReviewInProgress ?? false,
    cycle: state?.reviewCycle ?? 0,
    maxReviews: reviewCfg.maxReviews ?? 1,
    mode: state?.activeMode ?? "code",
  };
}

/** Abort any running auto-review */
export function abortAutoReview(projectId: string): void {
  const state = sessionsByProject.get(projectId);
  if (state) {
    state.autoReviewAborted = true;
    state.autoReviewInProgress = false;
  }
}

/**
 * After a CODE mode prompt completes, trigger auto-review if enabled.
 * Runs in background — does not block the caller.
 */
export function triggerAutoReviewIfNeeded(projectId: string): void {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) return;

  const library = loadModelLibrary();
  const reviewCfg = library.modes.review;
  const maxReviews = reviewCfg.maxReviews ?? 1;

  // Check conditions
  if (state.activeMode !== "code") return;            // Only after code mode
  if (!reviewCfg.enabled || !reviewCfg.activeModelId) return;  // Review must be configured
  if (maxReviews <= 0) return;                     // Auto-review disabled
  if (state.reviewCycle >= maxReviews) return;       // Already done max reviews
  if (state.autoReviewInProgress) return;           // Already running
  if (state.autoReviewAborted) return;             // Aborted by user
  if (state.isStreaming) return;                    // Still streaming

  state.autoReviewInProgress = true;
  state.reviewCycle++;

  // Run auto-review in background
  runAutoReviewCycle(projectId, state.reviewCycle, maxReviews).catch(err => {
    console.error("[auto-review] Error:", err);
    state.autoReviewInProgress = false;
  });
}

async function runAutoReviewCycle(projectId: string, cycle: number, maxReviews: number): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) return;
  if (state.autoReviewAborted) { state.autoReviewInProgress = false; return; }

  // ── Phase 1: Review (NEUTRAL — fresh session, no conversation history) ──
  emitModeChange(projectId, "review", true);
  emitAutoReviewStatus(projectId, "reviewing", cycle, maxReviews);

  const library = loadModelLibrary();
  const reviewCfg = library.modes.review;

  // Get the git diff to provide context to the reviewer
  let diffSummary = "";
  try {
    const { getGitDiff } = await import("../projects/git.js");
    const diff = await getGitDiff(state.cwd);
    if (diff && !diff.startsWith("No changes")) {
      // Truncate to 20K for review (more generous than default 8K)
      diffSummary = diff.length > 20000 ? diff.slice(0, 20000) + "\n... (truncated)" : diff;
    }
  } catch (e: any) {
    console.warn("[auto-review] Could not get git diff:", e.message);
  }

  let reviewFindings = "";
  let tempSession: AgentSession | null = null;

  try {
    // Create a fresh, temporary session for neutral review
    const tempSessionManager = SessionManager.create(state.cwd);
    const result = await createAgentSession({
      cwd: state.cwd,
      sessionManager: tempSessionManager,
      authStorage: sharedAuthStorage,
      modelRegistry: sharedModelRegistry,
    });
    tempSession = result.session;

    // Apply review model
    if (reviewCfg.activeModelId) {
      const entry = reviewCfg.models.find(m => m.id === reviewCfg.activeModelId);
      if (entry) {
        try {
          const model = sharedModelRegistry.find(entry.provider, entry.modelId);
          if (model) await tempSession.setModel(model);
          if (entry.thinkingLevel) await tempSession.setThinkingLevel(entry.thinkingLevel as any);
        } catch (e: any) {
          console.warn("[auto-review] Could not set review model:", e.message);
        }
      }
    }

    // Restrict to read-only tools
    (tempSession as any).setActiveToolsByName(READ_ONLY_TOOLS);

    // Inject review mode instructions
    const instructions = reviewCfg.instructions || DEFAULT_REVIEW_INSTRUCTIONS;
    const basePrompt = (tempSession as any)._baseSystemPrompt || "";
    const modeBlock = `\n\n## Current Mode: REVIEW\n\n${instructions}`;
    (tempSession as any)._baseSystemPrompt = basePrompt + modeBlock;
    (tempSession as any).agent.state.systemPrompt = (tempSession as any)._baseSystemPrompt;

    // Build the review prompt — neutral, no mention of who wrote the code
    let reviewPrompt =
      "Perform a thorough code review of this project.";
    if (diffSummary) {
      reviewPrompt +=
        "\n\nHere is the current git diff showing recent changes:\n\n```diff\n" + diffSummary + "\n```";
    }
    reviewPrompt +=
      "\n\nFocus on: bugs, security issues, code quality, anti-patterns, and potential improvements.\n" +
      "List each finding with:\n" +
      "- File and location (if applicable)\n" +
      "- Severity: HIGH / MEDIUM / LOW\n" +
      "- Description of the issue\n" +
      "- Suggested fix";

    // Subscribe to temp session events to forward tool calls for UI display
    const tempUnsub = tempSession.subscribe((event) => {
      // Forward tool call events to subscribers so the UI can show review activity
      if (event.type === "tool_execution_start") {
        activeToolCalls.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          output: "",
          startTime: Date.now(),
          projectId,
        });
      } else if (event.type === "tool_execution_update") {
        const existing = activeToolCalls.get(event.toolCallId);
        if (existing && event.partialResult?.content) {
          existing.output = event.partialResult.content.map((c: any) => c.text || "").join("");
        }
      } else if (event.type === "tool_execution_end") {
        const existing = activeToolCalls.get(event.toolCallId);
        if (existing && event.result?.content) {
          existing.output = event.result.content.map((c: any) => c.text || "").join("");
        }
      } else if (event.type === "agent_start") {
        state.isStreaming = true;
        emitSessionUpdate(projectId);
      } else if (event.type === "agent_end") {
        state.isStreaming = false;
        emitSessionUpdate(projectId);
      }
      emitToSubscribers(event, projectId);
    });

    // Run the review prompt
    await tempSession.prompt(reviewPrompt, {});

    // Extract the last assistant message as the review findings
    const messages: any[] = tempSession.messages || [];
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
    if (lastAssistant) {
      reviewFindings = lastAssistant.content
        ? lastAssistant.content.map((c: any) => c.text || "").join("")
        : JSON.stringify(lastAssistant);
    }

    // Clean up temp session
    tempUnsub();
    try { (tempSession as any).dispose?.(); } catch {}
    tempSession = null;
  } catch (e: any) {
    console.error("[auto-review] Review session failed:", e.message);
    // Clean up temp session on error
    if (tempSession) {
      try { (tempSession as any).dispose?.(); } catch {}
    }
    state.autoReviewInProgress = false;
    await restoreCodeMode(projectId);
    return;
  }

  if (state.autoReviewAborted) { state.autoReviewInProgress = false; await restoreCodeMode(projectId); return; }

  // ── Phase 2: Fix (uses main session so it has full context) ──
  emitModeChange(projectId, "code", true);
  emitAutoReviewStatus(projectId, "fixing", cycle, maxReviews);

  await restoreCodeMode(projectId);

  try {
    // Feed the neutral review findings into the main (code) session
    // The main session has full conversation context to understand the code
    const fixPrompt = reviewFindings
      ? `A code review found the following issues. Fix each one specifically. Do not make any other changes.\n\n${reviewFindings}`
      : "Fix any issues you can find in the recent changes.";
    await state.session.prompt(fixPrompt, {});
  } catch (e: any) {
    console.error("[auto-review] Fix prompt failed:", e.message);
  }

  state.autoReviewInProgress = false;
  emitAutoReviewStatus(projectId, "done", cycle, maxReviews);

  // Check if another cycle is needed
  if (!state.autoReviewAborted && state.reviewCycle < maxReviews) {
    triggerAutoReviewIfNeeded(projectId);
  }
}

// Default review instructions used by temp sessions
const DEFAULT_REVIEW_INSTRUCTIONS = `You are in REVIEW mode. Your job is to review code and provide feedback.

Rules:
- You can READ code but should NOT make changes
- Only use read-only tools: read, grep, find, ls
- Focus on: correctness, security, performance, readability
- Identify bugs, anti-patterns, and potential issues
- Suggest improvements with specific explanations
- Rate confidence level for each finding (high/medium/low)

When reviewing:
1. Read the relevant files thoroughly
2. Summarize what the code does
3. List issues found with severity
4. Suggest specific fixes (but do not implement them)

Be thorough and specific. Each finding should include:
- File and line reference
- Severity (HIGH/MEDIUM/LOW)
- Description of the issue
- Suggested fix`;

// ── WS event emitters ──

function emitModeChange(projectId: string, mode: AgentMode, auto: boolean): void {
  emitToSubscribers({ type: "mode_change", mode, auto } as any, projectId);
}

function emitAutoReviewStatus(projectId: string, phase: string, cycle: number, maxReviews: number): void {
  emitToSubscribers({ type: "auto_review_status", phase, cycle, maxReviews } as any, projectId);
}


/**
 * Return info about which model would be used for commit AI generation,
 * without actually calling the model. Used by the UI to display model details.
 */
export function getCommitModelInfo(): {
  provider: string;
  modelId: string;
  source: "commit-mode" | "session" | "registry" | "none";
  thinkingLevel?: string;
} {
  const library = loadModelLibrary();
  const commitMode = library.modes.commit;

  // 1. Dedicated commit mode
  if (commitMode.enabled && commitMode.activeModelId) {
    const entry = commitMode.models.find(m => m.id === commitMode.activeModelId);
    if (entry) {
      return {
        provider: entry.provider,
        modelId: entry.modelId,
        source: "commit-mode",
        thinkingLevel: entry.thinkingLevel || "off",
      };
    }
  }

  // 2. Any session model
  for (const [, state] of sessionsByProject) {
    if (state?.session?.model) {
      const m = state.session.model as any;
      return {
        provider: m.provider || "unknown",
        modelId: m.modelId || "unknown",
        source: "session" as const,
      };
    }
  }

  // 3. Registry
  reloadModelRegistry();
  const availableModels = sharedModelRegistry.getAvailable();
  if (availableModels.length > 0) {
    const m = availableModels[0];
    return {
      provider: (m as any).provider || "unknown",
      modelId: (m as any).modelId || "unknown",
      source: "registry",
    };
  }

  return { provider: "none", modelId: "none", source: "none" };
}

/**
 * Generate a descriptive commit message using the current Pi model.
 *
 * Works even WITHOUT an active Pi session: falls back to the last used
 * model from ModelRegistry + AuthStorage.
 *
 * Returns { subject, body } or null if no model/API key is available.
 */
export async function generateAiCommitMessage(
  diff: string,
  projectId: string
): Promise<{ subject: string; body: string } | null> {
  console.log(`[commit] === Starting commit message generation ===`);
  console.log(`[commit] diff length: ${diff?.length || 0}`);
  console.log(`[commit] projectId: ${projectId}`);

  // 1. Try the dedicated commit model from the library
  const library = loadModelLibrary();
  const commitMode = library.modes.commit;
  console.log(`[commit] commitMode.enabled=${commitMode.enabled}, activeModelId=${commitMode.activeModelId}, models=${commitMode.models.length}`);

  let model: any = null;
  let apiKey: string | undefined;

  // Ensure registry is loaded
  reloadModelRegistry();
  console.log(`[commit] Registry available models: ${sharedModelRegistry.getAvailable().length}`);
  console.log(`[commit] Registry all models: ${sharedModelRegistry.getAll().length}`);
  
  // Log all available model info for debugging
  const availModels = sharedModelRegistry.getAvailable();
  if (availModels.length > 0) {
    console.log(`[commit] Available models: ${availModels.slice(0, 5).map((m: any) => `${m.provider}/${m.id} (api=${m.api}, reasoning=${m.reasoning})`).join(', ')}`);
  }
  const allModels = sharedModelRegistry.getAll();
  if (allModels.length > 0) {
    console.log(`[commit] All models: ${allModels.slice(0, 5).map((m: any) => `${m.provider}/${m.id}`).join(', ')}`);
  }

  if (commitMode.enabled && commitMode.activeModelId) {
    const entry = commitMode.models.find(m => m.id === commitMode.activeModelId);
    console.log(`[commit] Found commit entry: ${entry ? JSON.stringify({id: entry.id, provider: entry.provider, modelId: entry.modelId, name: entry.name, reasoning: entry.reasoning, contextWindow: entry.contextWindow}) : "NONE"}`);
    if (entry) {
      // Use registry.find for a proper model object (has all expected fields)
      model = sharedModelRegistry.find(entry.provider, entry.modelId);
      console.log(`[commit] Registry.find("${entry.provider}", "${entry.modelId}") = ${model ? `found: ${model.provider}/${model.id} (api=${model.api})` : "NOT FOUND"}`);
      if (!model) {
        // Fallback: build manually. Need to determine the correct api type.
        const providerApiMap: Record<string, string> = {
          ollama: "openai-completions",
          openai: "openai-completions",
          anthropic: "anthropic-messages",
          google: "google-generative-ai",
          deepseek: "openai-completions",
          groq: "openai-completions",
          xai: "openai-completions",
          openrouter: "openai-completions",
          mistral: "openai-completions",
        };
        const api = providerApiMap[entry.provider] || entry.provider;
        model = {
          id: entry.id,
          provider: entry.provider,
          api,
          modelId: entry.modelId,
          name: entry.name || entry.modelId,
          reasoning: entry.reasoning ?? false,
          contextWindow: entry.contextWindow ?? 128000,
          maxTokens: entry.maxTokens ?? 16384,
          baseUrl: "",  // will need apiKey from registry
        };
        console.log(`[commit] Built fallback model: ${model.provider}/${model.modelId} (api=${model.api})`);
      }
      console.log(`[commit] Commit model resolved: ${model.provider}/${model.modelId || model.id} (api=${model.api}, reasoning=${model.reasoning})`);
      const auth = await sharedModelRegistry.getApiKeyAndHeaders(model);
      console.log(`[commit] Commit model auth: ok=${auth.ok}, apiKey=${auth.ok ? "present" : "n/a"}`);
      if (auth.ok) apiKey = (auth as any).apiKey;
    }
  }

  // 2. Fallback: use the session model (if available)
  if (!model?.id) {
    console.log("[commit] No commit model, falling back to session model");
    const state = sessionsByProject.get(projectId);
    console.log(`[commit] Session state: ${state ? "found" : "NOT FOUND"}`);
    if (state?.session?.model) {
      model = state.session.model;
      console.log(`[commit] Session model: ${model.provider}/${model.modelId}`);
      const auth = await sharedModelRegistry.getApiKeyAndHeaders(model);
      console.log(`[commit] Session model auth: ok=${auth.ok}, apiKey=${auth.ok ? "present" : "n/a"}`);
      if (auth.ok) apiKey = (auth as any).apiKey;
    } else {
      console.log("[commit] No session model available");
    }
  }

  // 3. Last resort: first available model from the registry
  if (!model?.id) {
    console.log("[commit] No session model, searching registry...");
    const availableModels = sharedModelRegistry.getAvailable();
    console.log(`[commit] Registry has ${availableModels.length} available models`);
    if (availableModels.length > 0) {
      model = availableModels[0];
      console.log(`[commit] Using registry model: ${model.provider}/${model.modelId}`);
      const auth = await sharedModelRegistry.getApiKeyAndHeaders(model);
      console.log(`[commit] Registry model auth: ok=${auth.ok}, apiKey=${auth.ok ? "present" : "n/a"}`);
      if (auth.ok) apiKey = (auth as any).apiKey;
    }
  }

  // 4. Absolute last resort: scan all library modes for any model entry
  if (!model?.id) {
    console.log("[commit] Registry empty, scanning all library modes...");
    for (const mode of ["code", "plan", "review"] as AgentMode[]) {
      const cfg = library.modes[mode];
      if (cfg.models.length > 0) {
        const entry = cfg.models[0];
        model = sharedModelRegistry.find(entry.provider, entry.modelId);
        if (!model) {
          const providerApiMap: Record<string, string> = {
            ollama: "openai-completions",
            openai: "openai-completions",
            anthropic: "anthropic-messages",
            google: "google-generative-ai",
            deepseek: "openai-completions",
            groq: "openai-completions",
            xai: "openai-completions",
            openrouter: "openai-completions",
            mistral: "openai-completions",
          };
          const api = providerApiMap[entry.provider] || entry.provider;
          model = { id: entry.id, provider: entry.provider, api, modelId: entry.modelId };
        }
        console.log(`[commit] Found model from mode ${mode}: ${model.provider}/${model.modelId}`);
        const auth = await sharedModelRegistry.getApiKeyAndHeaders(model);
        if (auth.ok) apiKey = (auth as any).apiKey;
        break;
      }
    }
  }

  if (!model?.id) {
    console.warn("[commit] === No model available at all ===");
    return null;
  }

  console.log(`[commit] === Using model: ${model.provider}/${model.modelId || model.id} (apiKey=${apiKey ? "present" : "MISSING"}, api=${model.api}, baseUrl=${model.baseUrl || "none"}) ===`);

  const systemPrompt = (commitMode.instructions && commitMode.instructions.trim())
    ? commitMode.instructions
    : DEFAULT_INSTRUCTIONS.commit;

  console.log(`[commit] systemPrompt length: ${systemPrompt.length}`);

  const context = {
    systemPrompt,
    messages: [
      {
        role: "user" as const,
        content: `Here is the git diff for this commit:\n\n${diff.slice(0, 8000)}`,
        timestamp: Date.now(),
      },
    ],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    console.log("[commit] Calling completeSimple...");
    const response = await completeSimple(model, context, {
      temperature: 0.2,
      maxTokens: 400,
      apiKey,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    console.log(`[commit] completeSimple returned, content items: ${response.content?.length || 0}, stopReason: ${response.stopReason}, error: ${response.errorMessage || "none"}`);

    const text = response.content
      ?.filter((c: any) => c.type === "text")
      ?.map((c: any) => c.text || "")
      ?.join("\n")
      ?.trim() || "";

    console.log(`[commit] Extracted text length: ${text.length}`);
    console.log(`[commit] Text preview: ${text.slice(0, 200)}`);

    if (!text) {
      console.warn("[commit] Empty response from model");
      return null;
    }

    const lines = text.split("\n");
    const subject = lines[0].trim();
    const body = lines.slice(1).join("\n").trim();

    console.log(`[commit] === Success: subject="${subject}", body=${body.length} chars ===`);
    return { subject: subject || text, body };
  } catch (error: any) {
    console.error("[commit] === completeSimple FAILED ===", error?.message || error);
    return null;
  }
}