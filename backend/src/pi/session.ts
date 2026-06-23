import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "url";
import path from "path";
import { unlinkSync, existsSync, mkdirSync } from "fs";
import os from "os";
import {
  loadModelLibrary,
  getModeModel,
  getProjectModeConfig,
  getDefaultModel,
  getCommitModel,
  setProjectModeEnabled,
}
from "./model-library.js";
import type { AgentMode } from "./model-library.js";
import { recordUsage } from "../routes/usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, "..", "..", ".pi-agent");

/**
 * Compute a project-specific session directory.
 * Uses ~/.pi/agent/sessions/projects/<projectId>/ to isolate sessions
 * per project, preventing cwd collisions between projects.
 */
function getProjectSessionDir(projectId: string): string {
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const dir = path.join(agentDir, "sessions", "projects", projectId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

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

// Stale entry cleanup: remove entries older than 5 minutes
const TOOL_CALL_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, tc] of activeToolCalls) {
    if (now - tc.startTime > TOOL_CALL_TTL_MS) {
      activeToolCalls.delete(id);
    }
  }
}, 60_000);

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

export function emitToSubscribers(event: AgentSessionEvent, projectId: string) {
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
  const sessionDir = getProjectSessionDir(projectId);

  if (options?.sessionId) {
    // Resume a specific session by ID, using project-specific directory
    console.log(`[PiSession] Resuming specific session: ${options.sessionId}`);
    sessionManager = SessionManager.create(cwd, sessionDir);
    // Find the session file by ID
    try {
      const sessions = await SessionManager.list(cwd, sessionDir);
      const target = sessions.find(s => s.id === options.sessionId);
      if (target) {
        sessionManager.setSessionFile(target.path);
      }
    } catch (e) {
      console.warn(`[PiSession] Could not find session ${options.sessionId}, creating new`);
    }
  } else if (options?.resume !== false) {
    // Try to continue the most recent session for this project
    console.log(`[PiSession] Attempting to resume recent session for project ${projectId}`);
    sessionManager = SessionManager.continueRecent(cwd, sessionDir);
  } else {
    // Create a brand new session for this project
    console.log(`[PiSession] Creating new session for project ${projectId}`);
    sessionManager = SessionManager.create(cwd, sessionDir);
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
      console.log("[event]", event.type);
        const state = sessionsByProject.get(projectId);
        if (state) state.isStreaming = true;
        emitSessionUpdate(projectId);
      } else if (event.type === "turn_end") {
        // Record usage for statistics
        const usage = (event as any).message?.usage;
        if (usage?.input || usage?.output) {
          const state = sessionsByProject.get(projectId);
          const model = (state?.session as any)?.model || {};
          try {
            recordUsage({
              timestamp: new Date().toISOString(),
              modelId: (model as any).modelId || (model as any).id || "unknown",
              providerId: (model as any).provider || "unknown",
              modelName: (model as any).name || "unknown",
              mode: state?.activeMode || "code",
              inputTokens: usage.input || 0,
              outputTokens: usage.output || 0,
              projectId,
            });
          } catch {}
        }
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
export function getCurrentSession(): PiSessionState | undefined {
  for (const [, state] of sessionsByProject) {
    if (state.session) return state;
  }
  return undefined;
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

  // ── Ensure model matches current mode config ──
  try {
    const library = loadModelLibrary();
    const currentMode = state.activeMode || "code";
    const desiredModel = getModeModel(library, projectId, currentMode);
    const currentModel = state.session.model;
    console.log(`[prompt] Session model: ${currentModel?.provider || "none"}/${currentModel?.id || "none"}, desired: ${desiredModel?.providerId || "none"}/${desiredModel?.modelId || "none"}`);
    if (desiredModel && currentModel) {
      const needsUpdate = currentModel.id !== desiredModel.modelId ||
        currentModel.provider !== desiredModel.providerId;
      if (needsUpdate) {
        console.log(`[prompt] Model mismatch! Applying ${desiredModel.providerId}/${desiredModel.modelId}...`);
        await applyModeToSession(currentMode, projectId);
        console.log("[prompt] Model applied, continuing to send...");
      }
    } else if (desiredModel && !currentModel) {
      console.log(`[prompt] No model on session, applying ${desiredModel.providerId}/${desiredModel.modelId}`);
      await applyModeToSession(currentMode, projectId);
        console.log("[prompt] Model applied, continuing to send...");
    }
  } catch (e: any) {
    console.warn(`[prompt] Failed to sync model:`, e.message);
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
        // Destroy the existing session before creating a new one
        const oldState = sessionsByProject.get(projectId);
        if (oldState?.session) {
          // Clear messages on the old session
          try { (oldState.session as any).agent.state.messages = []; } catch {}
          // Remove from map so createPiSession won't reuse it
          sessionsByProject.delete(projectId);
          activeToolCalls.forEach((_, key) => {
            if (key.endsWith(`:${projectId}`)) activeToolCalls.delete(key);
          });
        }
        await createPiSession(state.cwd, projectId, { resume: false });
        // Re-apply current mode to the new session
        const newMode = oldState?.activeMode || "code";
        try { await applyModeToSession(newMode, projectId); } catch {}
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
          emitSessionUpdate(projectId);
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
      case "/plan": {
        const library = loadModelLibrary();
        const currentMode = state.activeMode || "code";
        if (currentMode === "plan") {
          // Toggle off → back to code
          await restoreCodeMode(projectId);
          return { command: "plan", result: "✓ Switched back to CODE mode" };
        } else {
          // Enable plan mode (auto-enable if not already enabled)
          const pm = getProjectModeConfig(library, projectId);
          if (!pm.plan?.enabled) {
            setProjectModeEnabled(projectId, "plan", true);
          }
          await switchMode("plan", projectId);
          return { command: "plan", result: "✓ Switched to PLAN mode" };
        }
      }
      case "/review": {
        const library = loadModelLibrary();
        const currentMode = state.activeMode || "code";
        if (currentMode === "review") {
          // Toggle off → back to code
          await restoreCodeMode(projectId);
          return { command: "review", result: "✓ Switched back to CODE mode" };
        } else {
          // Enable review mode (auto-enable if not already enabled)
          const pm = getProjectModeConfig(library, projectId);
          if (!pm.review?.enabled) {
            setProjectModeEnabled(projectId, "review", true);
          }
          await switchMode("review", projectId);
          return { command: "review", result: "✓ Switched to REVIEW mode" };
        }
      }
      case "/help": {
        return {
          command: "help",
          result: `Available commands:\n  /new       — Start a new session\n  /compact   — Compact conversation context\n  /plan      — Toggle PLAN mode\n  /review    — Toggle REVIEW mode\n  /reload    — Reload extensions, skills, and settings\n  /clear     — Clear screen (keep session)\n  /quit      — Return to home screen\n  /help      — Show this help`,
        };
      }
      case "/clear": {
        return { command: "clear", result: "" };
      }
      case "/quit":
      case "/close": {
        return { command: "quit", result: "" };
      }
      case "/reload": {
        // Reload Pi session — picks up new extensions, skills, prompts
        const state = sessionsByProject.get(projectId);
        if (state?.session) {
          try {
            await (state.session as any).reload?.();
            return { command: "reload", result: "✓ Session reloaded (extensions, skills, prompts updated)" };
          } catch (e: any) {
            return { command: "reload", result: `Error: ${e.message}` };
          }
        }
        return { command: "reload", result: "No active session to reload" };
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

  if (state.isStreaming && imageAttachments && imageAttachments.length > 0) {
    // steer() doesn't support images — abort current stream and send as new prompt
    try { await state.session.abort(); } catch {}
    const options: any = {};
    options.images = imageAttachments;
    console.log("[prompt] Calling session.prompt()...");
    await state.session.prompt(message, options);
    console.log("[prompt] session.prompt() returned!");
  } else if (state.isStreaming) {
    await state.session.steer(message);
  } else {
    const options: any = {};
    if (imageAttachments && imageAttachments.length > 0) {
      options.images = imageAttachments;
    }
    console.log("[prompt] Calling session.prompt()...");
    await state.session.prompt(message, options);
    console.log("[prompt] session.prompt() returned!");
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
    activeMode: state.activeMode || "code",
    contextUsage: (state.session as any).getContextUsage?.() || null,
  };
}

/**
 * Dispose a specific project session (but keep session file on disk for resume).
 */
export async function disposeSession(projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (state) {
    if (state.unsubscribe) state.unsubscribe();
    // Fully dispose the AgentSession so a fresh one is created on next interaction.
    // This ensures extensions/skills are reloaded from settings.
    try {
      if (state.session) await state.session.dispose();
    } catch (e: any) {
      console.warn(`[PiSession] Error disposing session for ${projectId}:`, e.message);
    }
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
 * Re-apply active mode for all active sessions (e.g. after model library update).
 * Reloads the model registry first, then re-applies the current mode model.
 */
export async function reapplyAllSessions(): Promise<void> {
  reloadModelRegistry();
  const library = loadModelLibrary();
  for (const [projectId, state] of sessionsByProject) {
    if (!state.session) continue;
    const mode = state.activeMode || "code";
    try {
      await applyModeToSession(mode, projectId);
    } catch (e: any) {
      console.warn(`[reapply] Failed for ${projectId}:`, e.message);
    }
  }
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
// For plan mode: no bash at all — it can create files
const PLAN_TOOLS = ["read", "grep", "find", "ls"];
// For review mode: bash + read + grep for inspecting changed files
// (no find/ls to prevent full-project exploration — reviewer should focus on diff)
const REVIEW_TOOLS = ["read", "bash", "grep"];
const BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Get extension tool names registered in the session */
function getExtensionToolNames(session: any): string[] {
  try {
    const allTools = session.getAllTools?.() ?? [];
    return allTools
      .map((t: any) => t.name)
      .filter((name: string) => !BASE_TOOLS.includes(name));
  } catch { return []; }
}

/** Merge base tools + extension tools for a given mode */
function toolsForMode(session: any, baseTools: string[]): string[] {
  return [...baseTools, ...getExtensionToolNames(session)];
}

// Mode-specific instructions (hardcoded defaults; no longer stored in model-library)
/**
 * Strip any previously injected mode blocks and identity overrides from the prompt.
 * This prevents accumulation when switching modes.
 */
const MODE_IDENTITY_MARKER = "<!-- PI_IDENTITY -->";
const MODE_BLOCK_MARKER_START = "<!-- PI_MODE:" ;
const MODE_BLOCK_MARKER_END = "-->";

function cleanPromptForModeChange(rawPrompt: string): string {
  // Remove existing mode blocks (e.g. <!-- PI_MODE:PLAN -->...<!-- /PI_MODE:PLAN -->)
  let prompt = rawPrompt.replace(/\n*<!-- PI_MODE:\w+ -->[\s\S]*?<!-- \/PI_MODE:\w+ -->\n*/g, "\n");
  // Remove identity override block
  prompt = prompt.replace(/\n*<!-- PI_IDENTITY -->[\s\S]*?<!-- \/PI_IDENTITY -->\n*/g, "\n");
  return prompt.trim() + "\n";
}

/**
 * Strip the default Pi identity paragraph from the base prompt so we can replace it.
 * The default starts with "You are an expert coding assistant" and ends before "Available tools:".
 */
function stripDefaultIdentity(prompt: string): { identity: string; rest: string } {
  const marker = "You are an expert coding assistant";
  const idx = prompt.indexOf(marker);
  if (idx === -1) return { identity: "", rest: prompt };
  // Find the end of the identity paragraph — ends at "Available tools:", "Guidelines:", or double newline
  const afterMarker = prompt.slice(idx);
  const endMatch = afterMarker.match(/\n(?:Available tools:|Guidelines:)/);
  if (endMatch && endMatch.index !== undefined) {
    const endIdx = idx + endMatch.index;
    return {
      identity: prompt.slice(idx, endIdx).trim(),
      rest: prompt.slice(0, idx) + prompt.slice(endIdx),
    };
  }
  // Fallback: identity goes to first double newline
  const doubleNl = afterMarker.indexOf("\n\n");
  if (doubleNl !== -1) {
    const endIdx = idx + doubleNl;
    return {
      identity: prompt.slice(idx, endIdx).trim(),
      rest: prompt.slice(0, idx) + prompt.slice(endIdx),
    };
  }
  return { identity: "", rest: prompt };
}

/** Identity overrides for each mode — replaces the default "expert coding assistant" paragraph */
const MODE_IDENTITIES: Record<string, string> = {
  code: "",  // Keep default identity for code mode
  review: "You are a senior code reviewer. Your job is to READ code, analyze it, and provide detailed feedback. You do NOT make changes.",
  plan: "You are a PLANNING agent. You do NOT write code, edit files, or suggest shell commands. You analyze the codebase and produce structured implementation plans.",
};

const MODE_INSTRUCTIONS: Record<string, string> = {
  code: `General coding rules:
- Do NOT run git push or git push-like commands unless the user explicitly asks you to
- Do NOT commit changes unless the user explicitly asks you to
- When working on files, make minimal targeted changes — avoid rewriting entire files
- Before editing, always read the current file content to understand the existing code
- Prefer using the edit tool for small changes, write tool only for new files or complete rewrites
- When creating new files, follow existing project conventions (naming, structure, style)
- Test your changes mentally — think about edge cases and error paths
- If a change affects multiple files, list all affected files before starting
- Keep commits atomic — one logical change per commit when possible

## Code exploration: prefer graph tools over grep/find/ls
When the project has been indexed by the knowledge graph (cbm_* tools are visible):
- Use **cbm_search** instead of grep/find to find code by name, label, or meaning
- Use **cbm_search_code** instead of grep -r for text/regex searches
- Use **cbm_trace** instead of manually reading files to trace callers/callees
- Use **cbm_code** to get source code of specific symbols
- Use **cbm_arch** to understand the overall project structure
- Use **cbm_diff** to analyze the impact of uncommitted changes

These are 100x more token-efficient than file-by-file exploration. Use them when possible.
grep/find/ls are still available as fallback for files outside the project or if cbm_* tools are not available.`,
  plan: `You are in PLAN mode — you analyze the codebase and produce structured implementation plans WITHOUT modifying any files.

## Core Rules
- You CANNOT use: edit, write (file modifications are disabled)
- You CAN ONLY READ files and describe changes verbally
- Bash is restricted to read-only commands: cat, head, tail, wc, find, grep, ls, tree, du, pwd, file, stat
- NEVER execute any command that modifies the filesystem or state
- NEVER attempt to edit files — the edit tool will fail in this mode
- Focus on producing clear, actionable implementation plans

## Knowledge Graph
When available (cbm_* tools visible), use cbm_arch for architecture overview, cbm_trace for call chains, cbm_search to find code by name/pattern. Much faster than reading files one by one.`,
  review: `You are in REVIEW mode — a focused code review of **recently changed files only**.

## Core Rules
- You can ONLY use read-only tools: read, bash (read-only commands), grep
- You CANNOT use: edit, write, find, ls (file modifications and project-wide exploration are disabled)
- Bash is restricted to read-only commands: cat, head, tail, wc, grep, git status, git log, git diff, git show, pwd, echo
- NEVER execute any command that modifies the filesystem or state
- NEVER browse the entire project — focus ONLY on the files listed in the review context

## Review Focus
1. **Correctness** — Logic errors, off-by-one, null handling, race conditions, missing error handling
2. **Security** — Injection risks, exposed secrets, insecure defaults, missing input validation
3. **Performance** — Unnecessary allocations, N+1 queries, memory leaks, blocking operations
4. **Readability** — Naming, code organization, dead code, overly complex logic
5. **Maintainability** — Hardcoded values, tight coupling, missing types, undocumented behavior

## Review Format
For each finding:
- **[HIGH/MEDIUM/LOW]** Severity level
- **File:Line** Location
- **Description** What the issue is
- **Suggestion** How to fix it (specific code, not vague advice)

## Important
- Review ONLY the changed files provided in the context — do NOT explore the rest of the project
- Be specific — cite exact file paths and line numbers
- Prioritize findings by severity (HIGH first)
- If code looks good, say so — don't fabricate issues
- If you lack context to judge something, state it explicitly

## Knowledge Graph
When available (cbm_* tools visible), use cbm_diff to analyze git diff impact (affected symbols, blast radius). Use cbm_trace to find callers of changed functions. Use cbm_search for targeted lookups instead of grep+read chains.`,
};

// Default thinking levels per mode
const DEFAULT_THINKING: Record<string, string> = {
  code: "medium",
  review: "medium",
  plan: "high",
};

/**
 * Apply a mode's configuration to the Pi session:
 * - Switch model (from project-specific mode config or default)
 * - Set thinking level
 * - Filter tools (read-only for plan/review)
 * - Inject mode instructions into system prompt
 */
export async function applyModeToSession(mode: AgentMode, projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) throw new Error("No active Pi session");

  const library = loadModelLibrary();
  const session = state.session;
  const model = getModeModel(library, projectId, mode);

  // ── Apply model ──
  if (model) {
    try {
      reloadModelRegistry();
      const piModel = sharedModelRegistry.find(model.providerId, model.modelId);

      if (piModel) {
        // Check if we need to override model capabilities (reasoning, contextWindow)
        const needsOverride = (
          (model.reasoning !== undefined && piModel.reasoning !== model.reasoning) ||
          (model.contextWindow !== undefined && piModel.contextWindow !== model.contextWindow) ||
          (model.maxTokens !== undefined && piModel.maxTokens !== model.maxTokens)
        );

        if (needsOverride) {
          // Re-register the ENTIRE provider with all its models,
          // overriding only the one model that needs capability changes.
          // This avoids losing other models on the same provider.
          const existingAuth = await sharedModelRegistry.getApiKeyAndHeaders(piModel);
          const existingApiKey = existingAuth.ok ? existingAuth.apiKey : undefined;
          const providerApi = (piModel as any).api || "openai-completions";
          const providerBaseUrl = (piModel as any).baseUrl || "";

          // Get ALL models from this provider in the registry
          const allProviderModels = sharedModelRegistry.getAvailable()
            .filter((m: any) => m.provider === model.providerId);

          const models = allProviderModels.map((m: any) => {
            // Override our target model's capabilities
            if (m.id === model.modelId || m.id === piModel.id) {
              return {
                id: m.id,
                name: m.name || m.id,
                api: m.api || providerApi,
                reasoning: model.reasoning ?? m.reasoning ?? false,
                input: m.input || (model.vision ? ["text", "image"] : ["text"]),
                contextWindow: model.contextWindow ?? m.contextWindow ?? 128000,
                maxTokens: model.maxTokens ?? m.maxTokens ?? 16384,
                cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              };
            }
            return {
              id: m.id,
              name: m.name || m.id,
              api: m.api || providerApi,
              reasoning: m.reasoning ?? false,
              input: m.input || ["text"],
              contextWindow: m.contextWindow ?? 128000,
              maxTokens: m.maxTokens ?? 16384,
              cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
          });

          // If no other models were found, at least include the target model
          if (models.length === 0) {
            models.push({
              id: piModel.id || model.modelId,
              name: piModel.name || model.name || model.modelId,
              api: providerApi,
              reasoning: model.reasoning ?? piModel.reasoning ?? false,
              input: (piModel as any).input || (model.vision ? ["text", "image"] : ["text"]),
              contextWindow: model.contextWindow ?? piModel.contextWindow ?? 128000,
              maxTokens: model.maxTokens ?? piModel.maxTokens ?? 16384,
              cost: (piModel as any).cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            });
          }

          console.log(`[mode] Re-registering provider ${model.providerId} with ${models.length} models (override: ${model.modelId})`);
          sharedModelRegistry.registerProvider(model.providerId, {
            baseUrl: providerBaseUrl,
            api: providerApi,
            apiKey: existingApiKey || "ollama",
            models,
          });

          // Re-find after re-registration
          const updatedModel = sharedModelRegistry.find(model.providerId, model.modelId);
          if (updatedModel) {
            await session.setModel(updatedModel);
          console.log("[mode] Model set to (updated):", (session as any).model?.id);
          } else {
            await session.setModel(piModel);
          }
        } else {
          // No override needed — just set the model
          await session.setModel(piModel);
        }
      } else {
        // Model not in registry — try setModel with provider/id
        await setModel(model.providerId, model.modelId, projectId);
      }

      await setThinkingLevel(model.thinkingLevel || DEFAULT_THINKING[mode] || "medium", projectId);
    } catch (e: any) {
      console.error(`[mode] Failed to apply model for ${mode}:`, e.message);
      console.log("[mode] Model switch FAILED, session model is now:", (session as any).model?.id || "unknown");
    }
  }

  // ── Apply tool filtering ──
  // Include extension tools alongside base mode tools
  if (mode === "plan") {
    (session as any).setActiveToolsByName(toolsForMode(session, PLAN_TOOLS));
  } else if (mode === "review") {
    (session as any).setActiveToolsByName(toolsForMode(session, REVIEW_TOOLS));
  } else {
    // Code mode: all base tools + extension tools
    (session as any).setActiveToolsByName(toolsForMode(session, BASE_TOOLS));
  }

  // ── Inject mode instructions into system prompt ──
  const instructions = MODE_INSTRUCTIONS[mode] || "";
  const identityOverride = MODE_IDENTITIES[mode] || "";

  // Clean any previously injected mode blocks and identity overrides
  const rawPrompt = (session as any)._baseSystemPrompt || "";
  let prompt = cleanPromptForModeChange(rawPrompt);

  // For plan/review: replace the default identity paragraph
  if (identityOverride) {
    const { rest } = stripDefaultIdentity(prompt);
    prompt = rest.trim() + "\n";
    // Inject new identity with markers
    prompt += `\n${MODE_IDENTITY_MARKER}\n${identityOverride}\n${MODE_IDENTITY_MARKER.replace("<!-- PI", "<!-- /PI")}\n\n`;
  }

  // Append mode-specific instructions with markers
  if (instructions.trim()) {
    prompt += `\n${MODE_BLOCK_MARKER_START}${mode.toUpperCase()} ${MODE_BLOCK_MARKER_END}\n## Current Mode: ${mode.toUpperCase()}\n\n${instructions}\n${MODE_BLOCK_MARKER_START.replace("<!-- PI", "<!-- /PI")}${mode.toUpperCase()} ${MODE_BLOCK_MARKER_END}\n`;
  }

  (session as any)._baseSystemPrompt = prompt;
  (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;

  // ── Update state ──
  state.activeMode = mode;
  state.reviewCycle = 0;
  state.autoReviewAborted = false;

  emitModeChange(projectId, mode, false);
  emitSessionUpdate(projectId);
}

/**
 * Switch to a different mode.
 */
export async function switchMode(mode: AgentMode, projectId: string): Promise<void> {
  const library = loadModelLibrary();
  const pm = getProjectModeConfig(library, projectId);

  // Check mode is enabled (code is always enabled)
  if (mode !== "code") {
    const modeCfg = pm[mode as "plan" | "review"];
    if (!modeCfg.enabled) {
      throw new Error(`Mode ${mode} is not enabled`);
    }
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
  const model = getModeModel(library, projectId, "code");

  // Apply the code-mode model
  if (model) {
    try {
      const piModel = sharedModelRegistry.find(model.providerId, model.modelId);
      if (piModel) {
        await session.setModel(piModel);
      }
      await setThinkingLevel(model.thinkingLevel || "medium", projectId);
    } catch (e: any) {
      console.error("[mode] Failed to restore code model:", e.message);
    }
  }

  // Restore all tools (base + extension)
  (session as any).setActiveToolsByName(toolsForMode(session, BASE_TOOLS));

  // Restore clean prompt: strip mode blocks and identity overrides, then apply CODE mode
  let prompt = cleanPromptForModeChange((session as any)._baseSystemPrompt || "");
  // Restore default identity if it was stripped
  const { identity } = stripDefaultIdentity(prompt);
  if (!identity) {
    // Default identity was stripped by plan/review mode — we can't restore it perfectly,
    // but the rest of the prompt (tools, guidelines, context) is still there.
    // The Pi framework will have set it originally, so we just need to make sure
    // the "Available tools" and other sections remain intact.
  }
  prompt = prompt.trim() + "\n";
  prompt += `\n${MODE_BLOCK_MARKER_START}CODE ${MODE_BLOCK_MARKER_END}\n## Current Mode: CODE\n\n${MODE_INSTRUCTIONS.code}\n${MODE_BLOCK_MARKER_START.replace("\u003c!-- PI", "\u003c!-- /PI")}CODE ${MODE_BLOCK_MARKER_END}\n`;
  (session as any)._baseSystemPrompt = prompt;
  (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;

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
  const pm = getProjectModeConfig(library, projectId);
  return {
    inProgress: state?.autoReviewInProgress ?? false,
    cycle: state?.reviewCycle ?? 0,
    maxReviews: pm.review.maxReviews ?? 1,
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
  const pm = getProjectModeConfig(library, projectId);
  const maxReviews = pm.review.maxReviews ?? 1;

  // Check conditions
  if (state.activeMode !== "code") return;            // Only after code mode
  if (!pm.review.enabled) return;                     // Review must be enabled
  if (maxReviews <= 0) return;                        // Auto-review disabled
  if (state.reviewCycle >= maxReviews) return;        // Already done max reviews
  if (state.autoReviewInProgress) return;            // Already running
  if (state.autoReviewAborted) return;              // Aborted by user
  if (state.isStreaming) return;                     // Still streaming

  // Check that there's a review model available
  const reviewModel = getModeModel(library, projectId, "review");
  if (!reviewModel) return;                          // No model for review

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
  const pm = getProjectModeConfig(library, projectId);

  // Get the git diff AND list of changed files to provide focused context to the reviewer
  let diffSummary = "";
  let changedFiles: string[] = [];
  try {
    const { getGitDiff, getChangedFiles } = await import("../projects/git.js");
    const diff = await getGitDiff(state.cwd);
    if (diff && !diff.startsWith("No changes")) {
      // Truncate to 20K for review
      diffSummary = diff.length > 20000 ? diff.slice(0, 20000) + "\n... (truncated)" : diff;
    }
    changedFiles = await getChangedFiles(state.cwd);
  } catch (e: any) {
    console.warn("[auto-review] Could not get git diff:", e.message);
  }

  let reviewFindings = "";
  let tempSession: AgentSession | null = null;
  let tempSessionFile: string | undefined;

  try {
    // Create a fresh, temporary session for neutral review
    const tempSessionManager = SessionManager.create(state.cwd);
    tempSessionFile = tempSessionManager.getSessionFile();
    const result = await createAgentSession({
      cwd: state.cwd,
      sessionManager: tempSessionManager,
      authStorage: sharedAuthStorage,
      modelRegistry: sharedModelRegistry,
    });
    tempSession = result.session;

    // Apply review model
    const reviewModel = getModeModel(library, projectId, "review");
    if (reviewModel) {
      try {
        const piModel = sharedModelRegistry.find(reviewModel.providerId, reviewModel.modelId);
        if (piModel) await tempSession.setModel(piModel);
        if (reviewModel.thinkingLevel) await tempSession.setThinkingLevel(reviewModel.thinkingLevel as any);
      } catch (e: any) {
        console.warn("[auto-review] Could not set review model:", e.message);
      }
    }

    // Restrict to read-only tools (include extension tools like cbm_* for graph queries)
    (tempSession as any).setActiveToolsByName(toolsForMode(tempSession, REVIEW_TOOLS));

    // Inject review mode instructions
    const instructions = MODE_INSTRUCTIONS.review;
    const basePrompt = (tempSession as any)._baseSystemPrompt || "";
    const modeBlock = `\n\n## Current Mode: REVIEW\n\n${instructions}`;
    (tempSession as any)._baseSystemPrompt = basePrompt + modeBlock;
    (tempSession as any).agent.state.systemPrompt = (tempSession as any)._baseSystemPrompt;

    // Build the review prompt — focused on changed files ONLY
    let reviewPrompt =
      "Perform a focused code review of the recently changed files in this project.\n" +
      "Do NOT explore or review the entire project — focus ONLY on the files listed below.\n";
    if (changedFiles.length > 0) {
      reviewPrompt +=
        "\n## Changed files to review (review ONLY these):\n" +
        changedFiles.map(f => `- ${f}`).join("\n") + "\n";
    }
    if (diffSummary) {
      reviewPrompt +=
        "\nHere is the git diff showing the exact changes:\n\n```diff\n" + diffSummary + "\n```\n";
    }
    if (!diffSummary && changedFiles.length === 0) {
      reviewPrompt +=
        "\nNo git changes were detected. Review the most recent conversation context for any code that was written or modified.\n";
    }
    reviewPrompt +=
      "\n## Instructions\n" +
      "- Review ONLY the changed files listed above. Do NOT use find/ls to browse the project.\n" +
      "- You may use `read` to open a changed file for full context, and `grep` to check how a function/variable is used.\n" +
      "- Do NOT read files that are not in the changed files list unless absolutely necessary for understanding a change.\n" +
      "- For each finding, provide:\n" +
      "  - **File:Line** location\n" +
      "  - **[HIGH/MEDIUM/LOW]** severity\n" +
      "  - **Description** of the issue\n" +
      "  - **Suggested fix** (specific code, not vague advice)\n" +
      "- If the changes look good, say so — don't fabricate issues.";

    // Subscribe to temp session events to forward tool calls for UI display
    const tempUnsub = tempSession.subscribe((event) => {
      const taggedEvent = { ...event, _autoReview: true } as any;
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
      emitToSubscribers(taggedEvent, projectId);
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
    // Clean up temp session file from disk
    if (tempSessionFile) {
      try { if (existsSync(tempSessionFile)) unlinkSync(tempSessionFile); } catch (e: any) {
        console.warn("[auto-review] Failed to clean temp session file:", e.message);
      }
    }
    tempSession = null;
  } catch (e: any) {
    console.error("[auto-review] Review session failed:", e.message);
    if (tempSession) {
      try { (tempSession as any).dispose?.(); } catch {}
    }
    if (tempSessionFile) {
      try { if (existsSync(tempSessionFile)) unlinkSync(tempSessionFile); } catch {}
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
function emitModeChange(projectId: string, mode: AgentMode, auto: boolean): void {
  emitToSubscribers({ type: "mode_change", mode, auto } as any, projectId);
}

function emitAutoReviewStatus(projectId: string, phase: string, cycle: number, maxReviews: number): void {
  emitToSubscribers({ type: "auto_review_status", phase, cycle, maxReviews } as any, projectId);
}

// Commit message instructions (hardcoded)
const COMMIT_INSTRUCTIONS = `You generate commit messages from git diffs. You must be concise, specific, and descriptive.

Rules:
- First line: type(scope): short description (max 72 chars)
- Types: feat, fix, refactor, chore, docs, style, test, perf, ci, build
- Body: 2-4 bullet points explaining WHAT changed and WHY
- Describe the INTENT of the change, not just list file names
- Use verb infinitive ("add", "fix", "refactor") not gerundive ("adding", "fixing")
- No markdown, no code blocks, plain text only
- If the diff is unclear, focus on the most significant change`;

/**
 * Return info about which model would be used for commit AI generation,
 * without actually calling the model. Used by the UI to display model details.
 */
export function getCommitModelInfo(): {
  provider: string;
  modelId: string;
  source: "default-model" | "session" | "registry" | "none";
  thinkingLevel?: string;
} {
  const library = loadModelLibrary();

  // 1. Default model from library
  const defaultModel = getDefaultModel(library);
  if (defaultModel) {
    return {
      provider: defaultModel.providerId,
      modelId: defaultModel.modelId,
      source: "default-model",
      thinkingLevel: defaultModel.thinkingLevel || "off",
    };
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

  const library = loadModelLibrary();

  let model: any = null;
  let apiKey: string | undefined;

  // Ensure registry is loaded
  reloadModelRegistry();

  // 1. Use the commit model (or default) from the library
  const commitModel = getCommitModel(library);
  if (commitModel) {
    model = sharedModelRegistry.find(commitModel.providerId, commitModel.modelId);
    if (model) {
      const auth = await sharedModelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok) apiKey = (auth as any).apiKey;
    }
  }

  // 2. Fallback: use the session model (if available)
  if (!model?.id) {
    const state = sessionsByProject.get(projectId);
    if (state?.session?.model) {
      model = state.session.model;
      const auth = await sharedModelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok) apiKey = (auth as any).apiKey;
    }
  }

  // 3. Last resort: first available model from the registry
  if (!model?.id) {
    const availableModels = sharedModelRegistry.getAvailable();
    if (availableModels.length > 0) {
      model = availableModels[0];
      const auth = await sharedModelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok) apiKey = (auth as any).apiKey;
    }
  }

  // 4. Absolute last resort: scan all library models
  if (!model?.id) {
    for (const m of library.models) {
      model = sharedModelRegistry.find(m.providerId, m.modelId);
      if (model) {
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

  console.log(`[commit] === Using model: ${model.provider}/${model.modelId || model.id} (apiKey=${apiKey ? "present" : "MISSING"}, api=${model.api}) ===`);

  const systemPrompt = COMMIT_INSTRUCTIONS;

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

    const response = await completeSimple(model, context, {
      temperature: 0.2,
      maxTokens: 400,
      apiKey,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = response.content
      ?.filter((c: any) => c.type === "text")
      ?.map((c: any) => c.text || "")
      ?.join("\n")
      ?.trim() || "";

    if (!text) {
      console.warn("[commit] Empty response from model");
      return null;
    }

    const lines = text.split("\n");
    const subject = lines[0].trim();
    const body = lines.slice(1).join("\n").trim();

    return { subject: subject || text, body };
  } catch (error: any) {
    console.error("[commit] === completeSimple FAILED ===", error?.message || error);
    return null;
  }
}

// ── YOLO Mode — Multi-Agent Debate ───────────────────

export interface YoloConfig {
  model1: { providerId: string; modelId: string } | null;
  model2: { providerId: string; modelId: string } | null;
  planCycles: number;
  codeCycles: number;
  globalCycles: number;
}

const YOLO_PLAN_AGENT1 = `
## YOLO MODE — PLAN PHASE (Agent 1: Architect)

You are Agent 1 in a collaborative YOLO session. Your role is ARCHITECT.

Rules:
- Analyze the user's request and propose a detailed implementation PLAN.
- Do NOT write any code. Only plan.
- Use read/grep/find/bash to explore the existing codebase.
- Break the plan into clear steps with file paths.
- Consider edge cases, error handling, and testing.
- Keep your plan concise but thorough.

After you propose a plan, Agent 2 will critique it. Then you'll get a chance to improve it.`;

const YOLO_PLAN_AGENT2 = `
## YOLO MODE — PLAN PHASE (Agent 2: Critic)

You are Agent 2 in a collaborative YOLO session. Your role is CRITIC.

Rules:
- Evaluate the plan proposed by Agent 1.
- Identify flaws, missing edge cases, architectural issues.
- Suggest concrete improvements.
- Do NOT write any code. Only critique and amending the plan.
- Be constructive but thorough.`;

const YOLO_CODE_AGENT1 = `
## YOLO MODE — CODE PHASE (Agent 1: Implementer)

You are Agent 1 in a collaborative YOLO session. Your role is IMPLEMENTER.

Rules:
- Implement the approved plan using ALL available tools (read, edit, write, bash, grep, find).
- Write production-quality code.
- Handle edge cases and errors.
- Make small atomic edits, one file at a time.
- After implementing, Agent 2 will review and improve your code.`;

const YOLO_CODE_AGENT2 = `
## YOLO MODE — CODE PHASE (Agent 2: Reviewer / Debugger)

You are Agent 2 in a collaborative YOLO session. Your role is REVIEWER / DEBUGGER.

Rules:
- Review the code written by Agent 1.
- Find bugs, style issues, logic errors, missing edge cases.
- Fix them directly using edit/write tools.
- Run the code with bash to test if applicable.
- Do not change the fundamental approach unless it's broken.
- Improve readability and performance.`;

/**
 * Run a YOLO session: two agents debate and iterate on a task.
 */
export async function runYoloSession(
  projectId: string,
  userPrompt: string,
  config: YoloConfig
): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) throw new Error("No active session for project");

  const library = loadModelLibrary();
  const pm = getProjectModeConfig(library, projectId);

  // Mark that we're in yolo mode to track state
  const prevMode = state.activeMode;
  state.activeMode = "yolo";
  state.isStreaming = true;
  emitSessionUpdate(projectId);

  try {
    // ── Global cycles ──
    let previousCode = "";
    for (let g = 0; g < config.globalCycles; g++) {
      if (state.autoReviewAborted) { console.log("[yolo] Aborted by user"); break; }

      // Notify frontend
      emitYoloStatus(projectId, "plan", g, 0, config);

      // ── Phase 1: PLAN (N cycles of debate) ──
      const planContext = g === 0
        ? `## User Request\n\n${userPrompt}\n\nPropose a detailed implementation plan.`
        : `## User Request (cycle ${g + 1})\n\n${userPrompt}\n\n## Existing implementation from previous cycle\n\`\`\`\n${previousCode.slice(0, 15000)}\n\`\`\`\n\nAnalyze what was built. Propose improvements while staying true to the original request.`;

      let planText = await runYoloDebate(
        projectId, state, config,
        "plan", g,
        config.planCycles,
        planContext,
        YOLO_PLAN_AGENT1, YOLO_PLAN_AGENT2,
        true  // read-only for plan phase
      );

      if (state.autoReviewAborted) break;

      // ── Phase 2: CODE (M cycles of debate) ──
      emitYoloStatus(projectId, "code", g, 0, config);

      const codeContext = `## Approved Plan\n\n${planText.slice(0, 10000)}\n\n## Original Request\n\n${userPrompt}\n\nImplement the plan above.`;

      previousCode = await runYoloDebate(
        projectId, state, config,
        "code", g,
        config.codeCycles,
        codeContext,
        YOLO_CODE_AGENT1, YOLO_CODE_AGENT2,
        false  // full tools for code phase
      );
    }

    emitYoloStatus(projectId, "done", config.globalCycles - 1, 0, config);
  } finally {
    state.activeMode = prevMode;
    state.isStreaming = false;
    state.autoReviewAborted = false;
    emitSessionUpdate(projectId);
  }
}

/** Run a single phase's debate cycle: agent1 → agent2 → agent1 → ... */
async function runYoloDebate(
  projectId: string,
  state: PiSessionState,
  config: YoloConfig,
  phase: "plan" | "code",
  globalCycle: number,
  cycles: number,
  initialContext: string,
  systemPrompt1: string,
  systemPrompt2: string,
  readOnly: boolean
): Promise<string> {
  let agent1Result = "";
  let agent2Result = "";

  for (let c = 0; c < cycles; c++) {
    if (state.autoReviewAborted) break;

    // ── Agent 1 produces ──
    emitYoloStatus(projectId, phase, globalCycle, c + 1, config);

    const agent1Prompt = c === 0
      ? `${systemPrompt1}\n\n${initialContext}`
      : `${systemPrompt1}\n\n## Previous proposal by you:\n\n${agent1Result.slice(0, 15000)}\n\n## Critique from Agent 2:\n\n${agent2Result.slice(0, 15000)}\n\nImprove your proposal based on the critique above.`;

    agent1Result = await runYoloAgent(
      projectId, state, config, config.model1,
      phase, globalCycle, c, "agent1", agent1Prompt, readOnly
    );

    if (state.autoReviewAborted) break;

    // ── Agent 2 critiques ──
    const agent2Prompt = `${systemPrompt2}\n\n## Proposal from Agent 1:\n\n${agent1Result.slice(0, 20000)}\n\nEvaluate this ${phase === "plan" ? "plan" : "code"}. ${phase === "plan" ? "Identify issues and suggest improvements without writing code." : "Find bugs, fix them, and improve the code."}`;

    agent2Result = await runYoloAgent(
      projectId, state, config, config.model2,
      phase, globalCycle, c, "agent2", agent2Prompt, readOnly
    );

    // For the plan phase, the final result is the latest agent1 proposal
    // For the code phase, the final result is the code as modified by both agents
  }

  return agent1Result || agent2Result || "";
}

/** Run a single agent in a temp session and return the response text */
async function runYoloAgent(
  projectId: string,
  state: PiSessionState,
  config: YoloConfig,
  modelInfo: { providerId: string; modelId: string } | null,
  phase: "plan" | "code",
  globalCycle: number,
  localCycle: number,
  agentKey: "agent1" | "agent2",
  prompt: string,
  readOnly: boolean
): Promise<string> {
  let tempSession: AgentSession | null = null;
  let tempSessionFile: string | undefined;

  try {
    const tempSessionManager = SessionManager.create(state.cwd);
    tempSessionFile = tempSessionManager.getSessionFile();
    const result = await createAgentSession({
      cwd: state.cwd,
      sessionManager: tempSessionManager,
      authStorage: sharedAuthStorage,
      modelRegistry: sharedModelRegistry,
    });
    tempSession = result.session;

    // Apply model
    if (modelInfo) {
      try {
        const piModel = sharedModelRegistry.find(modelInfo.providerId, modelInfo.modelId);
        if (piModel) await tempSession.setModel(piModel);
      } catch (e: any) {
        console.warn(`[yolo] Could not set model for ${agentKey}:`, e.message);
      }
    }

    // Restrict tools if read-only
    if (readOnly) {
      (tempSession as any).setActiveToolsByName([
        "read", "grep", "find", "ls", "list",
        "firecrawl_scrape", "firecrawl_map", "firecrawl_search",
        "memory_search", "memory_list", "global_memory_search", "global_memory_list",
        // CBM graph tools — all read-only, safe for plan phase
        "cbm_search", "cbm_trace", "cbm_code", "cbm_search_code",
        "cbm_arch", "cbm_cypher", "cbm_schema", "cbm_diff",
      ]);
    }

    // Inject system prompt
    (tempSession as any).agent.state.systemPrompt = prompt;

    // Subscribe to forward events with yolo tags
    const tempUnsub = tempSession.subscribe((event) => {
      const modelName = modelInfo
        ? sharedModelRegistry.getAvailable().find((m: any) => m.provider === modelInfo.providerId && m.id === modelInfo.modelId)?.name
          || `${modelInfo.providerId}/${modelInfo.modelId}`
        : "unknown";
      const taggedEvent = {
        ...event,
        _yolo: true,
        _yoloAgent: agentKey,
        _yoloModel: modelName,
        _yoloPhase: phase,
        _yoloGlobalCycle: globalCycle,
        _yoloLocalCycle: localCycle,
        _readOnly: readOnly,
      } as any;

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
        if (existing && event.result?.content) {
          existing.output = event.result.content
            .map((c: any) => c.text || "")
            .join("");
        }
      }

      emitToSubscribers(taggedEvent, projectId);
    });

    // Run the prompt
    await tempSession.prompt(prompt, {});

    // Extract the all assistant messages as the result
    const messages: any[] = tempSession.messages || [];
    const assistantMessages = messages
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "");
    const fullResponse = assistantMessages.join("\n\n");

    // Clean up
    tempUnsub();
    try { (tempSession as any).dispose?.(); } catch {}
    if (tempSessionFile) {
      try {
        const { existsSync, unlinkSync, readdirSync, rmdirSync } = require("fs");
        if (existsSync(tempSessionFile)) unlinkSync(tempSessionFile);
        // Clean up the temp session directory
        const dir = tempSessionFile.replace(/\/[^/]+\.json$/, "");
        if (existsSync(dir)) {
          try {
            const files = readdirSync(dir);
            for (const f of files) unlinkSync(require("path").join(dir, f));
            rmdirSync(dir);
          } catch {}
        }
      } catch {}
    }

    return fullResponse;
  } catch (err: any) {
    console.error(`[yolo] Agent ${agentKey} error:`, err.message);
    return `[Error: ${agentKey} failed — ${err.message}]`;
  }
}

function emitYoloStatus(
  projectId: string,
  phase: "plan" | "code" | "done",
  globalCycle: number,
  localCycle: number,
  config: YoloConfig
) {
  emitToSubscribers({
    type: "yolo_status",
    phase,
    globalCycle,
    localCycle,
    globalCycles: config.globalCycles,
    planCycles: config.planCycles,
    codeCycles: config.codeCycles,
  } as any, projectId);
}