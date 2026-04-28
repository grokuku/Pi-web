import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, "..", "..", ".pi-agent");

export interface PiSessionState {
  session: AgentSession | null;
  isStreaming: boolean;
  cwd: string;
  unsubscribe: (() => void) | null;
}

let currentSession: PiSessionState = {
  session: null,
  isStreaming: false,
  cwd: process.cwd(),
  unsubscribe: null,
};

// Shared instances - reused across sessions
let sharedAuthStorage = AuthStorage.create();
let sharedModelRegistry = ModelRegistry.create(sharedAuthStorage);

// Pending config: applied when a session is created
let pendingModel: { provider: string; modelId: string } | null = null;
let pendingThinkingLevel: string | null = null;

type EventCallback = (event: AgentSessionEvent) => void;
let eventCallbacks = new Set<EventCallback>();

// Track active tool executions
const activeToolCalls: Map<
  string,
  {
    toolName: string;
    args: any;
    output: string;
    startTime: number;
  }
> = new Map();

export function getActiveToolCalls() {
  return activeToolCalls;
}

export function reloadModelRegistry(): void {
  sharedModelRegistry = ModelRegistry.create(sharedAuthStorage);
}

export function subscribeToEvents(callback: EventCallback): () => void {
  eventCallbacks.add(callback);
  return () => { eventCallbacks.delete(callback); };
}

function emitToSubscribers(event: AgentSessionEvent) {
  for (const cb of eventCallbacks) {
    try { cb(event); } catch (e) { console.error("Event callback error:", e); }
  }
}

export async function createPiSession(cwd: string): Promise<PiSessionState> {
  // Dispose previous session
  if (currentSession.session) {
    if (currentSession.unsubscribe) currentSession.unsubscribe();
    await currentSession.session.dispose();
  }

  const authStorage = sharedAuthStorage;
  const modelRegistry = sharedModelRegistry;
  const sessionManager = SessionManager.create(cwd);

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
        currentSession.isStreaming = true;
      } else if (event.type === "agent_end") {
        currentSession.isStreaming = false;
        // Clean up old tool calls
        activeToolCalls.clear();
      }

      // Forward to WebSocket subscribers
      emitToSubscribers(event);
    });

    currentSession = {
      session,
      isStreaming: false,
      cwd,
      unsubscribe,
    };

    // Apply pending model/thinking if queued before session existed
    if (pendingModel) {
      try {
        const model = sharedModelRegistry.find(pendingModel.provider, pendingModel.modelId);
        if (model) {
          await session.setModel(model);
          console.log(`Applied pending model: ${pendingModel.provider}/${pendingModel.modelId}`);
        }
      } catch (e) {
        console.error("Failed to apply pending model:", e);
      }
      pendingModel = null;
    }
    if (pendingThinkingLevel) {
      try {
        session.setThinkingLevel(pendingThinkingLevel as any);
        console.log(`Applied pending thinking level: ${pendingThinkingLevel}`);
      } catch (e) {
        console.error("Failed to apply pending thinking level:", e);
      }
      pendingThinkingLevel = null;
    }

    return currentSession;
  } catch (error) {
    console.error("Failed to create Pi session:", error);
    throw error;
  }
}

export function getCurrentSession(): PiSessionState {
  return currentSession;
}

export async function sendPrompt(
  message: string,
  images?: { data: string; mimeType: string }[]
): Promise<void> {
  const { session, isStreaming } = currentSession;

  if (!session) {
    throw new Error("No active Pi session");
  }

  if (isStreaming) {
    // Queue as steer message
    await session.steer(message);
  } else {
    const options: any = {};
    if (images && images.length > 0) {
      options.images = images.map((img) => ({
        type: "image",
        source: {
          type: "base64",
          mediaType: img.mimeType,
          data: img.data,
        },
      }));
    }

    await session.prompt(message, options);
  }
}

export async function abortPi(): Promise<void> {
  const { session } = currentSession;
  if (session) {
    await session.abort();
  }
}

export async function setModel(
  provider: string,
  modelId: string
): Promise<boolean> {
  // Reload registry to pick up any newly configured models (e.g. from Ollama)
  reloadModelRegistry();

  const model = sharedModelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);

  const { session } = currentSession;
  if (session) {
    await session.setModel(model);
    return false; // applied immediately
  }

  // No session yet — queue for later
  pendingModel = { provider, modelId };
  return true; // queued
}

export async function cycleModel(): Promise<any> {
  const { session } = currentSession;
  if (!session) throw new Error("No active Pi session");
  return await session.cycleModel();
}

export async function setThinkingLevel(level: string): Promise<boolean> {
  const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (!validLevels.includes(level)) {
    throw new Error(`Invalid thinking level: ${level}`);
  }

  const { session } = currentSession;
  if (session) {
    session.setThinkingLevel(level as any);
    return false; // applied immediately
  }

  // No session yet — queue for later
  pendingThinkingLevel = level;
  return true; // queued
}

export async function newSession(): Promise<void> {
  const { session } = currentSession;
  if (session) {
    // For now, just dispose and recreate
    if (currentSession.unsubscribe) currentSession.unsubscribe();
    await session.dispose();
  }
  await createPiSession(currentSession.cwd);
}

export async function compactSession(
  customInstructions?: string
): Promise<any> {
  const { session } = currentSession;
  if (!session) throw new Error("No active Pi session");
  return await session.compact(customInstructions);
}

export function getSessionInfo() {
  const { session, isStreaming, cwd } = currentSession;
  if (!session) return null;

  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    isStreaming,
    cwd,
    thinkingLevel: session.thinkingLevel,
    model: session.model
      ? {
          id: (session.model as any).id,
          name: (session.model as any).name,
          provider: (session.model as any).provider,
        }
      : null,
    messageCount: session.messages?.length || 0,
  };
}
