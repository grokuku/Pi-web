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
  };
}

export async function sendPrompt(
  message: string,
  projectId: string,
  images?: { data: string; mimeType: string }[]
): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) {
    throw new Error("No active Pi session for this project");
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

  // Ensure registry is loaded — might not be loaded yet if no session started
  reloadModelRegistry();

  // 1. Try the dedicated commit model from the library
  const library = loadModelLibrary();
  const commitMode = library.modes.commit;
  console.log(`[commit] commitMode.enabled=${commitMode.enabled}, activeModelId=${commitMode.activeModelId}, models=${commitMode.models.length}`);

  let model: any = null;
  let apiKey: string | undefined;

  if (commitMode.enabled && commitMode.activeModelId) {
    const entry = commitMode.models.find(m => m.id === commitMode.activeModelId);
    console.log(`[commit] Found commit entry: ${entry ? JSON.stringify({id: entry.id, provider: entry.provider, modelId: entry.modelId, name: entry.name}) : "NONE"}`);
    if (entry) {
      // Use registry.find for a proper model object (has all expected fields)
      model = sharedModelRegistry.find(entry.provider, entry.modelId);
      if (!model) {
        // Fallback: build manually
        model = {
          id: entry.id,
          provider: entry.provider,
          api: entry.provider,
          modelId: entry.modelId,
        };
      }
      console.log(`[commit] Commit model resolved: ${model.provider}/${model.modelId}`);
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
          model = { id: entry.id, provider: entry.provider, api: entry.provider, modelId: entry.modelId };
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

  console.log(`[commit] === Using model: ${model.provider}/${model.modelId} (apiKey=${apiKey ? "present" : "MISSING"}) ===`);

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

    console.log(`[commit] completeSimple returned, content items: ${response.content?.length || 0}`);

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