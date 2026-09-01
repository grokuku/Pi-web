import { createAgentSession, ModelRegistry, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "url";
import path from "path";
import { unlinkSync, existsSync, mkdirSync, readdirSync, rmdirSync } from "fs";
import os from "os";
import {
  loadModelLibrary,
  getModeModel,
  getProjectModeConfig,
  getDefaultModel,
  getCommitModel,
  getModel,
  setProjectActiveMode,
  resolveModelCapability,
} from "./model-library.js";
import type { AgentMode, RegisteredModel } from "./model-library.js";
import type { Route } from "./routing-types.js";
import { recordUsage } from "../routes/usage.js";
import { concurrencyManager } from "./concurrency.js";
import { getVisionModelInfo, describeImageWithVisionModel, sanitizeErrorText } from "../routes/attachments.js";
import { createDesignTools } from "./design-tools.js";
import { createCommitDraftTool } from "./commit-draft-tool.js";
import { appendDraft } from "./commit-draft.js";
import { librarianTools } from "./librarian-tools.js";
import { memoryTools } from "./memory-tools.js";
import { buildMemoryInjection } from "./memory-service.js";
import { getProject } from "../projects/manager.js";

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
  harnessAborted: boolean;      // was harness run aborted by user
  harnessSteerMessages: string[]; // messages queued for harness while streaming
  allowWebSearch: boolean;       // allow firecrawl tools (disabled by default, librarian_search replaces them)
  lastRoute?: Route;            // dernière décision de routage (fondation routing R2)
}

// ─── Multi-project session map ──────────────────────────
// Instead of a single global session, we maintain one session per project.
// Sessions survive across WebSocket connections and can be resumed from disk.
const sessionsByProject = new Map<string, PiSessionState>();

// Shared instances - reused across sessions
// ModelRuntime is async to create, so we initialize lazily
let sharedModelRuntime: ModelRuntime | null = null;
let sharedModelRegistry: ModelRegistry | null = null;

/**
 * Ensure the shared ModelRuntime and ModelRegistry are initialized.
 * Must be called before any model lookups or session creation.
 */
async function ensureModelSystem(): Promise<void> {
  if (!sharedModelRuntime || !sharedModelRegistry) {
    sharedModelRuntime = await ModelRuntime.create();
    sharedModelRegistry = new ModelRegistry(sharedModelRuntime);
    console.log("[PiSession] ModelRuntime and ModelRegistry initialized");
  }
}

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
    isStreaming?: boolean;
    isError?: boolean;
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

export async function reloadModelRegistry(): Promise<void> {
  await ensureModelSystem();
  // Refresh existing registry (keeps dynamically registered providers like Ollama)
  // instead of creating a new empty one that would lose them.
  try {
    // reloadConfig() removed in SDK 0.82+ — refresh() on ModelRuntime reloads config & models
    await sharedModelRuntime!.refresh();
    await sharedModelRegistry!.refresh();
  } catch {
    // If refresh fails, recreate from scratch
    sharedModelRuntime = await ModelRuntime.create();
    sharedModelRegistry = new ModelRegistry(sharedModelRuntime);
  }
}

export function getModelRegistry(): ModelRegistry {
  if (!sharedModelRegistry) throw new Error("ModelRegistry not initialized. Call ensureModelSystem() first.");
  return sharedModelRegistry;
}

/** Get the shared ModelRuntime for direct API calls (completeSimple, etc.) */
export function getModelRuntime(): ModelRuntime {
  if (!sharedModelRuntime) throw new Error("ModelRuntime not initialized. Call ensureModelSystem() first.");
  return sharedModelRuntime;
}

// AuthStorage is no longer directly accessible — ModelRuntime handles auth internally.
// HarnessEngine should use getModelRuntime() instead.

// ── Session timeout helper ──
// Prevents LLM calls from hanging indefinitely. If prompt()/steer() doesn't
// resolve within SESSION_TIMEOUT_MS, abort the session and emit agent_end.
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes

async function withSessionTimeout(
  promise: Promise<void>,
  session: AgentSession,
  projectId: string,
  label: string,
): Promise<void> {
  // BUG-59 : slotKey unique par appel pour éviter la réentrance par projectId
  const slotKey = `${projectId}::${label}`;
  // Acquire LLM slot (respects max parallel LLM calls)
  await concurrencyManager.acquireLLMSlot(slotKey, label);

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timer = setTimeout(async () => {
      try {
        await session.abort();
      } catch {}
      emitToSubscribers({ type: "agent_end" } as any, projectId);
      emitSessionUpdate(projectId);
      stopStreamingHeartbeat(projectId);
      reject(new Error(`[${label}] Session request timed out after ${SESSION_TIMEOUT_MS/1000}s`));
    }, SESSION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
    concurrencyManager.releaseLLMSlot(slotKey);
  }
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

// ── Heartbeat applicatif (BUG-72) ──────────────────────────
// Pendant qu'un run est actif, le SDK peut rester silencieux longtemps
// (bash silencieux, thinking long, compaction, retry, harness).
// Sans heartbeat, le watchdog frontend détecte un faux "stalled" dès 60s
// de silence. On émet donc périodiquement un heartbeat vers les subscribers
// tant que le flag effectif de streaming (state.isStreaming) est true.
const STREAMING_HEARTBEAT_MS = 10 * 1000; // toutes les 10s (< 60s du watchdog)
const streamingHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

function startStreamingHeartbeat(projectId: string): void {
  stopStreamingHeartbeat(projectId); // idempotent
  const timer = setInterval(() => {
    const state = sessionsByProject.get(projectId);
    // Arrêter dès que le flag effectif de streaming passe à false. On utilise
    // state.isStreaming (maintenu par agent_start/agent_settled et l'auto-review)
    // plutôt que session.isStreaming pour couvrir aussi le batch harness (sessions
    // de fonctions dont la session principale n'est pas en streaming).
    if (!state?.isStreaming) {
      stopStreamingHeartbeat(projectId);
      return;
    }
    emitToSubscribers({ type: "heartbeat", projectId, timestamp: Date.now() } as any, projectId);
  }, STREAMING_HEARTBEAT_MS);
  // Ne pas maintenir le process en vie à cause d'un timer orphelin.
  timer.unref?.();
  streamingHeartbeats.set(projectId, timer);
}

function stopStreamingHeartbeat(projectId: string): void {
  const timer = streamingHeartbeats.get(projectId);
  if (timer) {
    clearInterval(timer);
    streamingHeartbeats.delete(projectId);
  }
}

function stopAllStreamingHeartbeats(): void {
  for (const [pid, timer] of streamingHeartbeats) {
    clearInterval(timer);
    streamingHeartbeats.delete(pid);
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
  options?: { resume?: boolean; sessionId?: string; projectName?: string }
): Promise<PiSessionState> {
  // ── Reuse existing in-memory session ──
  const existing = sessionsByProject.get(projectId);
  if (existing?.session) {
    console.log(`[PiSession] Reusing existing session for project ${projectId}`);
    return existing;
  }

  // ── Ensure model system is initialized ──
  await ensureModelSystem();

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
      modelRuntime: sharedModelRuntime!,
      customTools: [...createDesignTools(projectId), ...librarianTools, ...memoryTools, createCommitDraftTool(projectId)],
    });

    // Inject project context into system prompt
    if (options?.projectName) {
      let projectContext = `\n\n<!-- PI_PROJECT_CONTEXT -->\nYou are working on project "${options.projectName}" (ID: ${projectId}).\nWorking directory: ${cwd}\n`;
      // Projet LIÉ : décrire la structure (chacun des sous-dossiers pointe vers
      // un projet indépendant avec son PROPRE repo git). Le LLM doit savoir que
      // `pi-web/` et `ai-helper/` ne partagent rien (ni git ni historique).
      try {
        const proj = getProject(projectId);
        if (proj?.storage === "linked" && Array.isArray(proj.linkedProjectIds)) {
          const subs = proj.linkedProjectIds
            .map((id) => getProject(id))
            .filter((p): p is NonNullable<typeof p> => !!p)
            .map((p) => `- <${proj.cwd}>/${p.name}/ : sous-projet "${p.name}" (dépôt git indépendant, commiter/pousser séparément)`);
          if (subs.length > 0) {
            projectContext += `This is a LINKED (composite) project gathering ${subs.length} independent sub-projects:
${subs.join("\n")}
When editing, respect each sub-project's folder. Each sub-project has its OWN git repository — never cross-commit between them.
`;
          }
        }
      } catch (e: any) {
        console.warn(`[PiSession] Linked context skipped (${projectId}): ${e?.message || e}`);
      }
      projectContext += `<!-- /PI_PROJECT_CONTEXT -->`;
      (session as any)._baseSystemPrompt = (session as any)._baseSystemPrompt + projectContext;
      (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;
    }

    // ── Injection mémoire (après PI_PROJECT_CONTEXT) ──
    // Bloc reconstruit depuis le store disque à chaque création de session ;
    // applyModeToSession/restoreCodeMode le préservent lors des rebuilds de prompt.
    try {
      const memoryContext = await buildMemoryContext(cwd);
      if (memoryContext) {
        (session as any)._baseSystemPrompt += memoryContext;
        (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;
        console.log(`[PiSession] Memory context injected for project ${projectId}`);
      }
    } catch (e: any) {
      // L'échec du store mémoire ne doit jamais empêcher la création de session.
      console.warn(`[PiSession] Memory context injection skipped (${projectId}) : ${e?.message || e}`);
    }

    // Wrap prompt() : réinjecte la bannière de mode avant chaque interaction LLM.
    // Le SDK reconstruit _baseSystemPrompt à chaque setActiveToolsByName, donc on
    // garantit que le mode est toujours visible au moment de l'appel.
    const origPrompt = (session as any).prompt.bind(session);
    (session as any).prompt = (message: any, options?: any) => {
      reapplyModeBanner(session, projectId);
      return origPrompt(message, options);
    };
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
          existing.isStreaming = false;
          existing.isError = event.isError;
        }
        // NOTE: ne PAS mettre isStreaming = true ici (BUG-08).
        // Le streaming global est géré uniquement par agent_start/agent_end.
        // tool_execution_end marque la fin d'un outil, pas du stream global.

        // ── Commit draft incrémental : capture auto des fichiers modifiés ──
        // Après chaque édition/écriture, on accumule le fichier dans le draft
        // pour construire le message de commit (source : les outils du LLM).
        // bash est ignoré pour l'instant : les fichiers touchés via bash ne sont
        // pas déductibles de façon fiable ici (ils le seront via le diff git).
        // NB : l'événement tool_execution_end n'expose pas les args — on les lit
        // depuis l'entrée activeToolCalls enregistrée au tool_execution_start.
        if (event.toolName === "edit" || event.toolName === "write") {
          const file =
            typeof existing?.args?.file === "string"
              ? existing.args.file
              : typeof existing?.args?.path === "string"
                ? existing.args.path
                : null;
          if (file) {
            appendDraft(projectId, `[auto] ${event.toolName}: ${file}`);
          }
        }

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
      } else if (event.type === "agent_start") {
        // BUG-72 : branche manquante — le flag backend n'était JAMAIS mis à true
        // en mode normal. Le guard `if (state.isStreaming)` de sendPrompt était
        // donc du code mort → session.prompt() direct → erreur SDK "Agent is
        // already processing..." quand le SDK était occupé.
        const state = sessionsByProject.get(projectId);
        if (state) state.isStreaming = true;
        startStreamingHeartbeat(projectId);
        emitSessionUpdate(projectId);
      } else if (event.type === "agent_settled") {
        // BUG-72 : agent_settled est la VRAIE fin du run (retry/compaction/drain
        // terminés). agent_end n'est pas la fin réelle — le SDK poursuit après.
        const state = sessionsByProject.get(projectId);
        if (state) state.isStreaming = false;
        stopStreamingHeartbeat(projectId);
        // Clean up tool calls for this project
        for (const [id, tc] of activeToolCalls) {
          if (tc.projectId === projectId) activeToolCalls.delete(id);
        }
        emitSessionUpdate(projectId);
      } else if (event.type === "agent_end") {
        // BUG-72 : NE PAS mettre isStreaming=false ici — le SDK poursuit avec
        // retry/compaction/drain après agent_end (la vraie fin est agent_settled).
        // On nettoie seulement les tool calls pour que l'UI ne garde pas de tool
        // "en cours" pendant la phase post-run.
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
      harnessAborted: false,
      harnessSteerMessages: [],
      allowWebSearch: false,
    };

    sessionsByProject.set(projectId, newSession);

    // Apply pending model/thinking if queued before session existed
    const pendingModel = pendingModelByProject.get(projectId);
    if (pendingModel) {
      try {
        const model = sharedModelRegistry!.find(pendingModel.provider, pendingModel.modelId);
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

    // Applique le mode actif persisté sur disque (survit au redémarrage / upgrade
    // du conteneur). La session doit déjà exister dans sessionsByProject pour que
    // applyModeToSession puisse la retrouver.
    //
    // BUG mode-sync : on applique TOUJOURS le mode persisté — y compris "code".
    // Avant ce fix, quand pm.activeMode === "code" on ne faisait RIEN : la session
    // SDK fraîche gardait alors ses outils par défaut, qui incluent TOUS les tools
    // d'extension (dont `delegate` de harness-orchestrator). Le backend tournait
    // donc « en réalité » en ROUTING (delegate actif) alors que state.activeMode
    // restait "code" → l'UI affichait CODE. En appliquant le mode persisté (code OU
    // harness), les outils, le state et la bannière de prompt sont toujours alignés.
    try {
      const library = loadModelLibrary();
      const pm = getProjectModeConfig(library, projectId);
      const persistedMode: AgentMode = pm.activeMode === "harness" ? "harness" : "code";
      await applyModeToSession(persistedMode, projectId);
    } catch (e: any) {
      console.error(`[PiSession] Failed to apply persisted activeMode for ${projectId}:`, e?.message || e);
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
 * Get the session state for a project (or null if no session).
 * Alias of getSession, used by design-bridge.ts.
 */
export function getProjectSession(projectId: string): PiSessionState | undefined {
  return sessionsByProject.get(projectId);
}

/**
 * État de streaming RÉEL d'un projet : la source de vérité est le SDK
 * (session.isStreaming reflète run + retry + compaction + drain, jusqu'à
 * agent_settled). Le flag backend state.isStreaming n'est qu'un fallback
 * (sessions sans SDK ou desync après reload).
 *
 * Optional chaining sur state.session pour ne JAMAIS créer de session
 * en lisant l'état (un getter ne doit pas avoir d'effet de bord).
 */
export function isSessionStreaming(projectId: string): boolean {
  const state = sessionsByProject.get(projectId);
  if (!state) return false;
  return state.session?.isStreaming ?? state.isStreaming;
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

  // ── Harness mode ──
  // Le mode HARNESS est géré par l'extension harness-orchestrator.
  // L'orchestrator reçoit les messages normalement via session.prompt() et
  // délègue l'exécution aux fonctions de routage via le tool delegate.

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
          stopStreamingHeartbeat(projectId);
          sessionsByProject.delete(projectId);
          activeToolCalls.forEach((_, key) => {
            if (key.endsWith(`:${projectId}`)) activeToolCalls.delete(key);
          });
        }
        await createPiSession(state.cwd, projectId, { resume: false, projectName: getProject(projectId)?.name });
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
        } catch (err: any) {
          const msg = err?.message || String(err || "Unknown error");
          console.error(`[compact] Failed: ${msg}`);
          return { command: "compact", result: `Compaction failed: ${msg}` };
        }
      }
      case "/model": {
        // /model — list available, /model <name> — switch
        if (!args) {
          const available = getModelRegistry().getAvailable();
          const lines = available.map((m: any) => {
            const isActive = session.model?.provider === m.provider && session.model?.id === m.id;
            return `${isActive ? "→ " : "  "}${m.provider}/${m.id}`;
          });
          return { command: "model", result: `Available models:\n${lines.join("\n")}` };
        }
        // Try to find and set the model
        const available = getModelRegistry().getAvailable();
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
          result: `Available commands:\n  /new       — Start a new session\n  /compact   — Compact conversation context\n  /reload    — Reload extensions, skills, and settings\n  /clear     — Clear screen (keep session)\n  /quit      — Return to home screen\n  /help      — Show this help`,
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

  // ── Gestion des images : fallback vers le modèle vision si nécessaire ──
  // Si le modèle de session courant ne supporte pas la vision, on utilise
  // le modèle vision configuré (Settings → Analysis Models) pour décrire
  // chaque image, puis on injecte les descriptions comme texte dans le prompt.
  let imageAttachments = images?.map((img) => ({
    type: "image" as const,
    data: img.data,
    mimeType: img.mimeType,
  }));

  if (imageAttachments && imageAttachments.length > 0) {
    // Vérifier si le modèle courant supporte la vision
    const currentModel = state.session?.model as any;
    let supportsVision = currentModel?.input?.includes("image") || currentModel?.vision === true;

    // Override manuel de la Model Library (Settings → Models → éditer un modèle) :
    // l'utilisateur peut forcer vision=oui/non quand l'inférence du nom échoue (ex. GLM5.3 flash).
    // On utilise la capacité RÉSOLUE (resolveModelCapability) : l'override PRIME sur
    // la détection SDK (input image) et l'inférence. Sans cela, un modèle avec
    // visionOverride="yes" mais vision détecté à false (ex. GLM-5.3-flash) verrait
    // son image omise par le SDK ("image omitted: model does not support images").
    try {
      const library = loadModelLibrary();
      const entry = library.models.find(
        (m) => m.providerId === currentModel?.provider && m.modelId === currentModel?.id
      );
      if (entry) {
        supportsVision = resolveModelCapability(entry, "vision");
      }
    } catch { /* library indisponible → comportement de détection standard */ }

    if (!supportsVision) {
      // Le modèle courant n'a pas la vision — utiliser le modèle vision configuré
      const visionModelInfo = getVisionModelInfo();
      if (visionModelInfo) {
        console.log(`[prompt] Modèle courant (${currentModel?.id || "unknown"}) sans vision — utilisation du modèle vision (${visionModelInfo.modelId}) pour ${imageAttachments.length} image(s)`);
        const descriptions: string[] = [];
        for (let i = 0; i < imageAttachments.length; i++) {
          const img = imageAttachments[i];
          try {
            const desc = await describeImageWithVisionModel(
              img.data,
              img.mimeType,
              `Analyse cette image en détail. Décris ce que tu vois, y compris tout texte visible, éléments d'interface, erreurs, indicateurs de statut, etc.`,
              visionModelInfo,
            );
            descriptions.push(`\n\n---\n**🖼️ Image ${i + 1}** (analysée avec le modèle vision)\n\n${desc}\n---`);
            console.log(`[prompt] Image ${i + 1} décrite (${desc.length} chars)`);
          } catch (e: any) {
            console.error(`[prompt] Erreur vision modèle image ${i + 1}:`, e.message);
            // BUG-1 : ne pas injecter le message d'erreur brut (peut contenir une
            // apiKey) dans le prompt — on le sanitise (tronqué, sans Authorization).
            descriptions.push(`\n\n---\n**🖼️ Image ${i + 1}** (analyse échouée: ${sanitizeErrorText(e?.message || String(e))})\n---`);
          }
        }
        // Injecter les descriptions dans le message et ne pas passer les images au session.prompt
        message = message + descriptions.join("");
        imageAttachments = undefined; // Ne pas passer les images brutes au modèle sans vision
      } else {
        console.warn(`[prompt] Modèle courant sans vision et aucun modèle vision configuré — les images seront ignorées`);
      }
    }
  }

  if (isSessionStreaming(projectId)) {
    // Mode HARNESS (v3) : l'orchestrator est la session principale et peut être
    // en train de déléguer à une fonction de routage (tool delegate).
    // ABORT ICI TUERAIT LA FONCTION EN COURS — le travail est perdu (BUG-67).
    // À la place, on met le message en file via steer() : il sera injecté
    // par le SDK après la fin de la délégation en cours.
    // BUG-69 : options partagées entre les branches (images).
    const options: any = {};
    if (imageAttachments && imageAttachments.length > 0) {
      options.images = imageAttachments;
    }
    if (state.activeMode === "harness") {
      // BUG-72 : `isSessionStreaming` lit l'état RÉEL du SDK (session.isStreaming),
      // pas le flag backend qui peut rester stale après reload/desync. Si l'agent
      // est réellement idle côté SDK, steer() perdrait le message silencieusement
      // → on fait un prompt complet. withSessionTimeout (5 min) est acceptable ici
      // car l'agent n'est PAS en délégation longue (idle).
      if (!isSessionStreaming(projectId)) {
        console.log("[prompt] Harness: isStreaming flag stale — traitement comme nouveau prompt");
        await withSessionTimeout(
          state.session.prompt(message, options),
          state.session,
          projectId,
          "prompt(harness)",
        );
        return;
      }
      console.log("[prompt] Harness mode streaming — steering message (no abort, function in progress)");
      try { await state.session.steer(message); } catch (e: any) {
        console.error("[prompt] steer() failed:", e.message);
      }
      return;
    }
    // Modes normaux : abort + re-prompt (comportement historique)
    // steer() can hang if the previous LLM call is stuck, and the user
    // needs a way to unblock without restarting the backend.
    try { await state.session.abort(); } catch {}
    console.log("[prompt] Aborted previous stream, calling session.prompt()...");
    // Option A : pas de timeout global en mode code (un tour d'agent peut
    // légitimement durer > 5 min, ex. refactor multi-fichiers). L'utilisateur
    // garde le bouton ABORT pour interrompre manuellement.
    await state.session.prompt(message, options);
    console.log("[prompt] session.prompt() returned!");
  } else {
    const options: any = {};
    if (imageAttachments && imageAttachments.length > 0) {
      options.images = imageAttachments;
    }
    console.log("[prompt] Calling session.prompt()...");
    // En mode harness, l'orchestrator peut déléguer à plusieurs fonctions de routage successivement.
    // Chaque fonction a son propre timeout (300s dans l'extension), mais le total peut dépasser 5 min.
    // On désactive le timeout global en harness pour ne pas tuer l'orchestrator en pleine délégation.
    if (state.activeMode === "harness") {
      console.log("[prompt] Harness mode — no session timeout (functions have their own)");
      await state.session.prompt(message, options);
    } else {
      // Option A : pas de timeout global en mode code non plus (cf. harness).
      // L'utilisateur garde le bouton ABORT pour le contrôle manuel.
      await state.session.prompt(message, options);
    }
    console.log("[prompt] session.prompt() returned!");
  }
}

export async function steerPrompt(
  message: string,
  projectId: string,
  images?: { data: string; mimeType: string }[]
): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) {
    throw new Error("No active Pi session for this project");
  }
  // BUG-6 : le SDK supporte steer(text, images?) — on convertit les images au
  // format ImageContent ({ type: "image", data, mimeType }) pour ne pas les
  // perdre silencieusement pendant le streaming.
  const imageContent = images?.map((img) => ({
    type: "image" as const,
    data: img.data,
    mimeType: img.mimeType,
  }));
  // Mode HARNESS (v3) : l'orchestrator délègue à une fonction de routage (tool delegate).
  // Un steer est injecté par le SDK après la délégation en cours — PAS de timeout
  // abortif ici, sinon on tue la fonction en cours (BUG-67). Les fonctions ont leur propre timeout.
  if (state.activeMode === "harness") {
    // BUG-69/72 : même garde qu'en sendPrompt — si l'agent est idle côté SDK,
    // steer() perdrait le message silencieusement. On fait un prompt complet.
    // Le timeout 5 min est OK ici (l'agent n'est pas en délégation, il est idle).
    if (!isSessionStreaming(projectId)) {
      console.log("[steer] Harness: agent idle — steer perdu, on fait un prompt complet");
      const options: any = {};
      if (imageContent && imageContent.length > 0) options.images = imageContent;
      await withSessionTimeout(
        state.session.prompt(message, options),
        state.session,
        projectId,
        "steer(harness)",
      );
      return;
    }
    console.log("[steer] Harness mode — no abort timeout (function in progress)");
    await state.session.steer(message, imageContent);
    return;
  }
  // Option A : pas de timeout global en mode code (cf. sendPrompt).
  await state.session.steer(message, imageContent);
}

export async function abortPi(projectId?: string): Promise<void> {
  if (projectId) {
    const state = sessionsByProject.get(projectId);
    if (state?.session) {
      // Abort la session quelle que soit le mode (y compris harness orchestrator).
      // L'abort signal se propage au tool delegate via l'extension.
      state.harnessAborted = true;
      await state.session.abort();
    }
  } else {
    // Abort all sessions
    for (const [, state] of sessionsByProject) {
      state.harnessAborted = true;
      if (state?.session) {
        await state.session.abort();
      }
    }
  }
}

export async function setModel(
  provider: string,
  modelId: string,
  projectId?: string
): Promise<boolean> {
  await reloadModelRegistry();

  const model = sharedModelRegistry!.find(provider, modelId);
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
    stopStreamingHeartbeat(projectId);
    if (state.unsubscribe) state.unsubscribe();
    await state.session.dispose();
    sessionsByProject.delete(projectId);
  }

  // Create brand new session (no resume)
  await createPiSession(cwd, projectId, { resume: false, projectName: getProject(projectId)?.name });
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
 * Liste toutes les sessions d'un projet, dans son répertoire de sessions
 * dédié (le même que celui utilisé par createPiSession).
 */
export async function listSessions(cwd: string, projectId: string): Promise<any[]> {
  try {
    return await SessionManager.list(cwd, getProjectSessionDir(projectId));
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

/**
 * Inject a message carrying attachment references (miniatures) into the
 * session's chat UI — used by the web_screenshot extension to surface a
 * captured PNG as a clickable thumbnail in the chat thread.
 *
 * Same mechanism as injectSessionNotification (sendCustomMessage,
 * triggerTurn:false) : le message est ajouté à la session (persisté via une
 * CustomMessageEntry), émis au frontend via message_start/message_end, et
 * sera inclus au prochain turn LLM sans en déclencher un.
 *
 * Le champ `details` du CustomMessage est free-form : on y place
 * `attachmentRefs` ([{ id, name, category, size }]). Le frontend
 * (ChatView/UserBubble) rend chaque ref de catégorie "image" comme une
 * miniature cliquable pointant vers /api/attachments/<id>/file (viewer
 * plein écran). `details` n'est PAS envoyé au LLM (seul `content` l'est).
 *
 * NB customType "screenshot" (≠ "git_notification") : le UserBubble rend
 * alors la bulle standard utilisateur avec les chips attachmentRefs, au
 * lieu du bandeau centré texte seul des notifications git.
 */
export async function injectAttachmentToChat(
  projectId: string,
  attachmentRefs: { id: string; name: string; category: string; size: number }[],
  caption?: string
): Promise<boolean> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) {
    console.warn(`[injectAttachment] No session for project ${projectId}`);
    return false;
  }
  if (!Array.isArray(attachmentRefs) || attachmentRefs.length === 0) {
    console.warn(`[injectAttachment] No attachmentRefs provided for ${projectId}`);
    return false;
  }

  try {
    const content = caption?.trim() || `📸 ${attachmentRefs.map(a => a.name).join(", ")}`;
    await state.session.sendCustomMessage(
      {
        customType: "screenshot",
        content,
        display: true,
        details: { attachmentRefs },
      },
      { triggerTurn: false }
    );
    console.log(`[injectAttachment] Injected ${attachmentRefs.length} attachment ref(s) for ${projectId}`);
    return true;
  } catch (e: any) {
    console.error(`[injectAttachment] Failed for ${projectId}:`, e.message);
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
    // BUG-72 : exposer l'état RÉEL du SDK (source de vérité), pas le flag backend.
    isStreaming: state.session?.isStreaming ?? state.isStreaming,
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
    // On n'inclut volontairement pas les messages complets ici : le payload
    // `connected`/`session_update` serait trop lourd (risque de blocage sur
    // JSON.stringify). Le frontend récupère l'historique via pi_history.
    // BUG mode-sync : on expose le mode EFFECTIF (dérivé des outils réellement
    // appliqués à la session SDK), pas le flag in-memory qui peut être resté
    // "code" alors que la session route déjà (desync legacy).
    activeMode: getEffectiveActiveMode(state.projectId),
    contextUsage: (state.session as any).getContextUsage?.() || null,
    lastRoute: state.lastRoute ?? null,
  };
}

/**
 * Dispose a specific project session (but keep session file on disk for resume).
 */
export async function disposeSession(projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (state) {
    stopStreamingHeartbeat(projectId);
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
  stopAllStreamingHeartbeats();
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
  await reloadModelRegistry();
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

const BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
// Firecrawl tools removed — librarian_search replaces them.
const FIRECRAWL_TOOLS: string[] = [];
// Harness orchestrator : aucun tool de base — uniquement delegate (via extension)
// L'orchestrator ne lit pas le code, il délègue. Les cbm_* restent accessibles via les extensions.
const HARNESS_TOOLS: string[] = [];
// Tools d'orchestration à EXCLURE des modes non-harness (BUG-71).
// En mode CODE/REVIEW, le LLM doit travailler directement,
// pas déléguer via delegate.
const HARNESS_EXCLUDE = ["delegate"];

/** Get extension tool names registered in the session */
function getExtensionToolNames(session: any, exclude: string[] = []): string[] {
  try {
    const allTools = session.getAllTools?.() ?? [];
    return allTools
      .map((t: any) => t.name)
      .filter((name: string) => !BASE_TOOLS.includes(name))
      .filter((name: string) => !exclude.includes(name));
  } catch { return []; }
}

/** Merge base tools + extension tools for a given mode */
function toolsForMode(session: any, baseTools: string[], exclude: string[] = []): string[] {
  return [...baseTools, ...getExtensionToolNames(session, exclude)];
}

// Mode-specific instructions (hardcoded defaults; no longer stored in model-library)
/**
 * Strip any previously injected mode blocks and identity overrides from the prompt.
 * This prevents accumulation when switching modes.
 */
const MODE_IDENTITY_MARKER = "<!-- PI_IDENTITY -->";
const MODE_BLOCK_MARKER_START = "<!-- PI_MODE:" ;
const MODE_BLOCK_MARKER_END = "-->";
// Bannière de mode proéminente (marqueurs DÉDIÉS, distincts des instructions de mode)
const MODE_BANNER_START = "<!-- PI_MODE_BANNER -->";
const MODE_BANNER_END = "<!-- /PI_MODE_BANNER -->";

/** Renvoie les noms des outils actifs de la session (pour la bannière de mode). */
function getActiveToolNamesForBanner(session: any): string[] {
  try {
    return (session as any).getActiveToolNames?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * Construit le bloc d'injection mémoire (<!-- PI_MEMORY_CONTEXT -->) à partir
 * du store disque (niveau global + niveau projet, voir memory-service.ts).
 * Retourne une chaîne vide s'il n'y a aucune mémoire à injecter.
 */
async function buildMemoryContext(cwd: string): Promise<string> {
  const body = await buildMemoryInjection(cwd);
  if (!body) return "";
  return `\n\n<!-- PI_MEMORY_CONTEXT -->\n${body}\n<!-- /PI_MEMORY_CONTEXT -->`;
}

/** Blocs de contexte injectés à préserver lors des rebuilds de prompt SDK. */
interface PreservedContextBlocks {
  projectContextBlock: string;
  memoryContextBlock: string;
}

/**
 * Extrait les blocs de contexte (projet + mémoire) d'un prompt avant un
 * setActiveToolsByName (qui reconstruit _baseSystemPrompt et les efface).
 */
function extractPreservedContextBlocks(prompt: string | undefined | null): PreservedContextBlocks {
  const src = prompt || "";
  return {
    projectContextBlock:
      src.match(/<!-- PI_PROJECT_CONTEXT -->[\s\S]*?<!-- \/PI_PROJECT_CONTEXT -->/)?.[0] || "",
    memoryContextBlock:
      src.match(/<!-- PI_MEMORY_CONTEXT -->[\s\S]*?<!-- \/PI_MEMORY_CONTEXT -->/)?.[0] || "",
  };
}

/** Réinjecte les blocs de contexte préservés en fin de prompt. */
function appendPreservedContextBlocks(prompt: string, blocks: PreservedContextBlocks): string {
  let out = prompt;
  if (blocks.projectContextBlock) out += `\n\n${blocks.projectContextBlock}`;
  if (blocks.memoryContextBlock) out += `\n\n${blocks.memoryContextBlock}`;
  return out;
}

/**
 * Réinjecte une bannière de mode PROÉMINENTE en tête du prompt système.
 * Pourquoi : le SDK Pi reconstruit `_baseSystemPrompt` à chaque setActiveToolsByName
 * (agent-session.js), ce qui efface le marqueur de mode injecté par applyModeToSession.
 * Sans cette bannière, l'agent ne sait pas s'il est en mode code (travail direct)
 * ou routing (orchestrateur qui délègue) — et essaie les outils de l'autre mode.
 */
function reapplyModeBanner(session: any, projectId: string): void {
  const state = sessionsByProject.get(projectId);
  const mode = state?.activeMode || "code";
  const tools = getActiveToolNamesForBanner(session);
  const toolsList = tools.length > 0 ? tools.join(", ") : "(aucun)";

  const banner = mode === "harness"
    ? `${MODE_BANNER_START}\n## ⚠️ MODE ACTUEL : ROUTING — VOUS ÊTES L'ORCHESTRATEUR\n\nRÈGLE ABSOLUE : déléguez TOUTE tâche d'exécution via le tool \`delegate\` (fonctions : planning, execute, review, integrate). Ne codez JAMAIS vous-même, ne faites JAMAIS de recherche/exploration vous-même — déléguez. Vos outils : ${toolsList}.\n${MODE_BANNER_END}\n\n`
    : `${MODE_BANNER_START}\n## MODE ACTUEL : CODE — travail direct\n\nVous travaillez directement avec vos outils. Le tool \`delegate\` n'est PAS disponible dans ce mode. Vos outils : ${toolsList}.\n${MODE_BANNER_END}\n\n`;

  // Nettoyer une éventuelle bannière précédente, puis préfixer la nouvelle en tête de prompt
  let prompt = (session as any)._baseSystemPrompt || "";
  prompt = prompt.replace(/\n*<!-- PI_MODE_BANNER -->[\s\S]*?<!-- \/PI_MODE_BANNER -->\n*/g, "\n");
  (session as any)._baseSystemPrompt = banner + prompt.trimStart();
  (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;
}


function cleanPromptForModeChange(rawPrompt: string): string {
  // Remove existing mode blocks (e.g. <!-- PI_MODE:REVIEW -->...<!-- /PI_MODE:REVIEW -->)
  let prompt = rawPrompt.replace(/\n*<!-- PI_MODE:\w+ -->[\s\S]*?<!-- \/PI_MODE:\w+ -->\n*/g, "\n");
  // Remove identity override block
  prompt = prompt.replace(/\n*<!-- PI_IDENTITY -->[\s\S]*?<!-- \/PI_IDENTITY -->\n*/g, "\n");
  // Remove project context block
  prompt = prompt.replace(/\n*<!-- PI_PROJECT_CONTEXT -->[\s\S]*?<!-- \/PI_PROJECT_CONTEXT -->\n*/g, "\n");
  // Remove memory context block (réinjecté ensuite via appendPreservedContextBlocks)
  prompt = prompt.replace(/\n*<!-- PI_MEMORY_CONTEXT -->[\s\S]*?<!-- \/PI_MEMORY_CONTEXT -->\n*/g, "\n");
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
  harness: "Tu es le chef de projet de Pi-Web. Ton rôle est d'orchestrer les fonctions de routage et d'être l'interface entre l'utilisateur et l'équipe.",
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
- Après chaque modification logique de fichiers, appelle le tool log_commit_note avec un résumé concis (1 ligne) de ce que tu as modifié et pourquoi. Cela construit incrémentalement le message de commit.

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
  harness: `## Mode HARNESS — Chef de Projet

Tu es le chef de projet. Tu discutes avec l'utilisateur et délègue l'exécution aux fonctions de routage.

### Tes responsabilités
- Comprendre la demande de l'utilisateur
- Évaluer la complexité de la tâche
- Choisir la bonne fonction de routage et lui déléguer
- Présenter les résultats à l'utilisateur de façon claire
- Coordonner plusieurs fonctions de routage si nécessaire

### Règles ABSOLUES
- Tu ne codes JAMAIS. Tu ne débugges JAMAIS. Tu ne fais JAMAIS de plan détaillé.
- Tu ne lis JAMAIS le code pour investiguer un bug. L'investigation est le job des fonctions de routage.
- Tu délègues TOUJOURS l'exécution via le tool delegate.
- Tu peux répondre directement aux questions simples (conseils, explications, clarifications).
- Quand l'utilisateur signale un bug, délègue IMMÉDIATEMENT à la fonction appropriée (review pour investiguer, execute pour fixer). Ne fais pas de recherche toi-même.
- Quand tu n'es pas sûr, demande à l'utilisateur.

### Quand déléguer vs répondre directement
- **Réponds directement** : questions simples, conseils, explications, clarifications, synthèse de résultats
- **Délègue** : toute tâche d'exécution (code, debug, review, test, doc, plan)
- **Tâche complexe** : délègue d'abord à la fonction planning pour un plan, puis à la fonction execute
- **Tâche simple** : délègue directement à la fonction execute
- **Relecture / audit** : délègue à la fonction review
- **Synthèse / rapport final** : délègue à la fonction integrate

### Fonctions de routage disponibles
| Fonction | Rôle |
|----------|------|
| planning | Planification, exploration, architecture |
| execute | Implémentation : code, debug, tests, documentation |
| review | Relecture, audit, qualité, sécurité |
| integrate | Synthèse, rapport final, intégration |

### Comment déléguer
Utilise le tool delegate avec :
- function : la fonction à appeler, parmi planning, execute, review, integrate
- task : la tâche précise et auto-contenue
- context : résumé concis et actionnable du contexte pertinent (2-5 phrases) : décisions clés, contraintes, fichiers concernés, ce qui a déjà été fait. Obligatoire dès que la conversation contient du contexte utile.

⚠ La fonction déléguée ne voit PAS la conversation — elle ne lit QUE task + context (+ le code du projet). Rédige TOUJOURS un résumé du contexte dans \`context\` avant de déléguer, même bref (2-3 phrases). Sans cela, la fonction travaille à l'aveugle sur ce qui s'est dit.

### Après une délégation
- Analyse le résultat retourné par la fonction
- Si la fonction signale un problème ou un besoin de clarification -> demande à l'utilisateur
- Si la tâche est terminée -> résume le résultat pour l'utilisateur
- Si tu as besoin d'une autre fonction -> délègue à nouveau`,
};

// Default thinking levels per mode
const DEFAULT_THINKING: Record<string, string> = {
  code: "medium",
  harness: "medium",
};

/**
 * Applique un RegisteredModel + thinking level à la session active.
 * Factorisé depuis applyModeToSession pour être réutilisé par applyRouteToSession
 * sans dupliquer la logique de surcharge des capacités (reasoning/contextWindow).
 */
async function applyModelAndThinking(
  model: RegisteredModel | null | undefined,
  projectId: string,
  thinkingFallback: string,
): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) return;
  const session = state.session;

  if (!model) return;

  try {
    await reloadModelRegistry();
    const piModel = sharedModelRegistry!.find(model.providerId, model.modelId);

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
        const existingAuth = await sharedModelRuntime!.getAuth(piModel);
        const existingApiKey = existingAuth?.auth?.apiKey;
        const providerApi = (piModel as any).api || "openai-completions";
        const providerBaseUrl = (piModel as any).baseUrl || "";

        // Get ALL models from this provider in the registry
        const allProviderModels = sharedModelRegistry!.getAvailable()
          .filter((m: any) => m.provider === model.providerId);

        const models = allProviderModels.map((m: any) => {
          // Override our target model's capabilities
          if (m.id === model.modelId || m.id === piModel.id) {
            return {
              id: m.id,
              name: m.name || m.id,
              api: m.api || providerApi,
              reasoning: model.reasoning ?? m.reasoning ?? false,
              input: m.input || (resolveModelCapability(model, "vision") ? ["text", "image"] : ["text"]),
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
            input: (piModel as any).input || (resolveModelCapability(model, "vision") ? ["text", "image"] : ["text"]),
            contextWindow: model.contextWindow ?? piModel.contextWindow ?? 128000,
            maxTokens: model.maxTokens ?? piModel.maxTokens ?? 16384,
            cost: (piModel as any).cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          });
        }

        console.log(`[session] Re-registering provider ${model.providerId} with ${models.length} models (override: ${model.modelId})`);
        sharedModelRegistry!.registerProvider(model.providerId, {
          baseUrl: providerBaseUrl,
          api: providerApi,
          apiKey: existingApiKey || "ollama",
          models,
        });

        // Re-find after re-registration
        const updatedModel = sharedModelRegistry!.find(model.providerId, model.modelId);
        if (updatedModel) {
          await session.setModel(updatedModel);
          console.log("[session] Model set to (updated):", (session as any).model?.id);
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

    await setThinkingLevel(model.thinkingLevel || thinkingFallback || "medium", projectId);
  } catch (e: any) {
    console.error(`[session] Failed to apply model for ${model.providerId}/${model.modelId}:`, e.message);
    console.log("[session] Model switch FAILED, session model is now:", (session as any).model?.id || "unknown");
  }
}

/**
 * Apply a mode's configuration to the Pi session:
 * - Switch model (from project-specific mode config or default)
 * - Set thinking level
 * - Filter tools (read-only for review)
 * - Inject mode instructions into system prompt
 */
export async function applyModeToSession(mode: AgentMode, projectId: string): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state?.session) throw new Error("No active Pi session");

  const library = loadModelLibrary();
  const session = state.session;
  const model = getModeModel(library, projectId, mode);

  // ── Apply model + thinking level ──
  await applyModelAndThinking(model, projectId, DEFAULT_THINKING[mode] || "medium");

  // Sauvegarder les contextes projet + mémoire avant setActiveToolsByName (qui rebuild le prompt)
  const preservedBlocks = extractPreservedContextBlocks((session as any)._baseSystemPrompt);

  // ── Apply tool filtering ──
  // Include extension tools alongside base mode tools.
  if (mode === "harness") {
    // Harness orchestrator: read-only + delegate (l'extension l'enregistre)
    // Pas d'exclusion : l'orchestrator DOIT garder delegate (BUG-71).
    (session as any).setActiveToolsByName(toolsForMode(session, HARNESS_TOOLS));
  } else {
    // Code mode: all base tools + extension tools (hors tools d'orchestration BUG-71)
    (session as any).setActiveToolsByName(toolsForMode(session, BASE_TOOLS, HARNESS_EXCLUDE));
  }

  // ── Inject mode instructions into system prompt ──
  const instructions = MODE_INSTRUCTIONS[mode] || "";
  const identityOverride = MODE_IDENTITIES[mode] || "";

  // Clean any previously injected mode blocks and identity overrides
  const rawPrompt = (session as any)._baseSystemPrompt || "";
  let prompt = cleanPromptForModeChange(rawPrompt);

  // Pour les modes avec identité spécifique, remplace l'identité par défaut.
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

  // Réinjecter les contextes préservés (écrasés par setActiveToolsByName)
  prompt = appendPreservedContextBlocks(prompt, preservedBlocks);

  (session as any)._baseSystemPrompt = prompt;
  (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;

  // ── Update state ──
  state.activeMode = mode;

  // Persiste le mode actif sur disque (survit au redémarrage / reboot).
  // On n'écrit que si la valeur persistée diffère, pour éviter des écritures
  // inutiles (applyModeToSession est aussi appelé pour re-appliquer le mode courant).
  try {
    const persistedMode = getProjectModeConfig(library, projectId).activeMode || "code";
    if (persistedMode !== mode) {
      setProjectActiveMode(projectId, mode);
    }
  } catch (e: any) {
    console.warn(`[mode] Failed to persist activeMode for ${projectId}:`, e?.message || e);
  }

  // Bannière de mode proéminente (réinjectée aussi avant chaque prompt via le wrapper)
  reapplyModeBanner(session, projectId);

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
    const modeCfg = pm[mode];
    if (!modeCfg?.enabled) {
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
      const piModel = sharedModelRegistry!.find(model.providerId, model.modelId);
      if (piModel) {
        await session.setModel(piModel);
      }
      await setThinkingLevel(model.thinkingLevel || "medium", projectId);
    } catch (e: any) {
      console.error("[mode] Failed to restore code model:", e.message);
    }
  }

  // Sauvegarder les contextes projet + mémoire avant setActiveToolsByName (qui rebuild le prompt)
  const preservedBlocks = extractPreservedContextBlocks((session as any)._baseSystemPrompt);

  // Restore all tools (base + extension), hors tools d'orchestration (BUG-71)
  (session as any).setActiveToolsByName(toolsForMode(session, BASE_TOOLS, HARNESS_EXCLUDE));

  // Restore clean prompt: strip mode blocks and identity overrides, then apply CODE mode
  let prompt = cleanPromptForModeChange((session as any)._baseSystemPrompt || "");
  // Restore default identity if it was stripped
  const { identity } = stripDefaultIdentity(prompt);
  if (!identity) {
    // Default identity was stripped by a mode with a custom identity — we can't restore it perfectly,
    // but the rest of the prompt (tools, guidelines, context) is still there.
    // The Pi framework will have set it originally, so we just need to make sure
    // the "Available tools" and other sections remain intact.
  }
  prompt = prompt.trim() + "\n";
  prompt += `\n${MODE_BLOCK_MARKER_START}CODE ${MODE_BLOCK_MARKER_END}\n## Current Mode: CODE\n\n${MODE_INSTRUCTIONS.code}\n${MODE_BLOCK_MARKER_START.replace("\u003c!-- PI", "\u003c!-- /PI")}CODE ${MODE_BLOCK_MARKER_END}\n`;

  // Réinjecter les contextes préservés (écrasés par setActiveToolsByName)
  prompt = appendPreservedContextBlocks(prompt, preservedBlocks);

  (session as any)._baseSystemPrompt = prompt;
  (session as any).agent.state.systemPrompt = (session as any)._baseSystemPrompt;

  state.activeMode = "code";

  // Persiste le retour au mode code sur disque.
  try {
    const persistedMode = getProjectModeConfig(library, projectId).activeMode || "code";
    if (persistedMode !== "code") {
      setProjectActiveMode(projectId, "code");
    }
  } catch (e: any) {
    console.warn(`[mode] Failed to persist activeMode for ${projectId}:`, e?.message || e);
  }

  reapplyModeBanner(session, projectId);
  emitModeChange(projectId, "code", false);
  emitSessionUpdate(projectId);
}

/**
 * Mode EFFECTIF d'une session — source de vérité = les outils RÉELLEMENT
 * appliqués à la session SDK, pas le flag in-memory `state.activeMode` qui peut
 * être désynchronisé (session créée avant la persistance du mode, reprise d'une
 * session legacy, migration, etc.).
 *
 * Le tool `delegate` est enregistré par l'extension harness-orchestrator et n'est
 * actif que lorsque la session est configurée en mode ROUTING (en mode CODE,
 * applyModeToSession l'exclut via HARNESS_EXCLUDE). Sa présence dans les outils
 * actifs est donc la signature fiable que le routage est réellement actif.
 */
export function getEffectiveActiveMode(projectId: string): AgentMode {
  const state = sessionsByProject.get(projectId);
  // Pas de session active (ex: post-restart, sessions créées lazily) : la source
  // de vérité est la CONFIG PERSISTÉE du projet — JAMAIS "code" par défaut,
  // sinon reconcileActiveMode écrasait un mode harness persisté au simple
  // affichage de l'UI (INFRA-02).
  if (!state?.session) {
    try {
      const pm = getProjectModeConfig(loadModelLibrary(), projectId);
      return (pm.activeMode as AgentMode) || "code";
    } catch {
      return "code";
    }
  }
  try {
    const activeTools = state.session.getActiveToolNames?.() ?? [];
    if (activeTools.includes("delegate")) return "harness";
  } catch {}
  return state.activeMode || "code";
}

/**
 * Réconcilie le flag in-memory `state.activeMode` (et la persistance disque) avec
 * le mode EFFECTIF dérivé des outils de la session, puis renvoie ce mode.
 *
 * Utilisé par GET /mode (source de vérité du frontend) : quand une session legacy
 * tourne en ROUTING (delegate actif) avec un flag resté à "code", cette réconciliation
 * met à jour le flag ET persiste le mode sur disque → l'UI affiche ROUTING et le mode
 * survit au restart. N'écrit sur disque que si la valeur persistée diffère (idempotent).
 */
export function reconcileActiveMode(projectId: string): AgentMode {
  const effective = getEffectiveActiveMode(projectId);
  const state = sessionsByProject.get(projectId);
  if (state && state.activeMode !== effective) {
    state.activeMode = effective;
  }
  try {
    const library = loadModelLibrary();
    const persisted = getProjectModeConfig(library, projectId).activeMode || "code";
    // Écrire SUR DISQUE seulement quand une session existe : sans session, il
    // n'y a rien à réconcilier — et écrire "code" (state par défaut absent)
    // écrasait un mode harness persisté au simple chargement de l'UI (INFRA-02).
    if (state && persisted !== effective) {
      setProjectActiveMode(projectId, effective);
    }
  } catch (e: any) {
    console.warn(`[mode] Failed to persist reconciled activeMode for ${projectId}:`, e?.message || e);
  }
  return effective;
}

/** Get the current active mode for a project (réconcilié avec l'état réel de la session) */
export function getActiveMode(projectId: string): AgentMode {
  return reconcileActiveMode(projectId);
}

/** Enable or disable firecrawl web search tools for a project session */
export async function setAllowWebSearch(projectId: string, allowed: boolean): Promise<void> {
  const state = sessionsByProject.get(projectId);
  if (!state) return;
  state.allowWebSearch = allowed;
  // Re-apply current mode to update the active tool list
  if (state.session) {
    try {
      await applyModeToSession(state.activeMode || "code", projectId);
    } catch (e: any) {
      console.warn(`[setAllowWebSearch] Failed to re-apply mode:`, e.message);
    }
  }
}

/** Get the current allowWebSearch setting for a project */
export function getAllowWebSearch(projectId: string): boolean {
  const state = sessionsByProject.get(projectId);
  return state?.allowWebSearch ?? false;
}

function emitModeChange(projectId: string, mode: AgentMode, auto: boolean): void {
  emitToSubscribers({ type: "mode_change", mode, auto } as any, projectId);
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
export async function getCommitModelInfo(): Promise<{
  provider: string;
  modelId: string;
  source: "default-model" | "session" | "registry" | "none";
  thinkingLevel?: string;
}> {
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
  await reloadModelRegistry();
  const availableModels = sharedModelRegistry!.getAvailable();
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
 * Uses the shared ModelRuntime for LLM calls (handles auth internally).
 *
 * Returns { subject, body } or null if no model is available.
 */
export async function generateAiCommitMessage(
  diff: string,
  projectId: string
): Promise<{ subject: string; body: string } | null> {
  console.log(`[commit] === Starting commit message generation ===`);

  const library = loadModelLibrary();

  let model: any = null;

  // Ensure registry is loaded
  await reloadModelRegistry();

  // 1. Use the commit model (or default) from the library
  const commitModel = getCommitModel(library);
  if (commitModel) {
    model = sharedModelRegistry!.find(commitModel.providerId, commitModel.modelId);
  }

  // 2. Fallback: use the session model (if available)
  if (!model?.id) {
    const state = sessionsByProject.get(projectId);
    if (state?.session?.model) {
      model = state.session.model;
    }
  }

  // 3. Last resort: first available model from the registry
  if (!model?.id) {
    const availableModels = sharedModelRegistry!.getAvailable();
    if (availableModels.length > 0) {
      model = availableModels[0];
    }
  }

  // 4. Absolute last resort: scan all library models
  if (!model?.id) {
    for (const m of library.models) {
      model = sharedModelRegistry!.find(m.providerId, m.modelId);
      if (model) break;
    }
  }

  if (!model?.id) {
    console.warn("[commit] === No model available at all ===");
    return null;
  }

  console.log(`[commit] === Using model: ${model.provider}/${model.modelId || model.id} ===`);

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

    // Acquire LLM slot for the provider call
    await concurrencyManager.acquireLLMSlot(`${projectId}::commit`, "commit");

    let commitResult: { subject: string; body: string } | null = null;
    try {
      const response = await sharedModelRuntime!.completeSimple(model, context, {
        temperature: 0.2,
        maxTokens: 400,
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
        commitResult = null;
      } else {
        const lines = text.split("\n");
        const subject = lines[0].trim();
        const body = lines.slice(1).join("\n").trim();
        commitResult = { subject: subject || text, body };
      }
    } finally {
      concurrencyManager.releaseLLMSlot(`${projectId}::commit`);
    }
    return commitResult;
  } catch (error: any) {
    console.error("[commit] === completeSimple FAILED ===", error?.message || error);
    return null;
  }
}

// ── Commit draft incrémental : nettoyage LLM du draft ───────────────
// Prompt spécifique : on donne au modèle le draft de travail accumulé
// (intention réelle du LLM) ET le diff git courant, pour produire un
// message conventionnel propre (fusion des entrées du même fichier,
// suppression des fichiers absents du diff, structure conventional commits).
const CLEAN_COMMIT_INSTRUCTIONS = `You clean up an incremental work draft into a conventional commit message.

You receive:
1. A work draft accumulated during the coding session (lines prefixed with timestamps and [intent]/[auto] tags) — this reflects the real intent.
2. The current git diff.

Rules:
- Merge entries about the same file into a single coherent point
- Remove entries for files that are absent from the git diff
- Structure the result as a conventional commit message
- First line: type(scope): short description (max 72 chars)
- Types: feat, fix, refactor, chore, docs, style, test, perf, ci, build
- Body: 2-4 bullet points explaining WHAT changed and WHY
- Describe the INTENT of the change, not just list file names
- Use verb infinitive ("add", "fix", "refactor") not gerundive ("adding", "fixing")
- No markdown, no code blocks, plain text only
- Return ONLY a JSON object with keys "subject" and "body" (e.g. {"subject":"feat: ...","body":"- ..."})`;

/**
 * Parse la réponse JSON {"subject","body"} du LLM.
 * Tolère les code fences markdown autour du JSON, et retombe sur
 * "première ligne = subject, reste = body" si le JSON est invalide.
 */
function parseCleanCommitJson(text: string): { subject: string; body: string } | null {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.subject === "string" && obj.subject.trim()) {
      return {
        subject: obj.subject.trim(),
        body: typeof obj.body === "string" ? obj.body.trim() : "",
      };
    }
  } catch {}
  // Fallback : première ligne non vide = subject, reste = body
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return { subject: lines[0].slice(0, 72), body: lines.slice(1).join("\n") };
}

/**
 * Nettoie le draft de travail incrémental en message de commit conventionnel.
 *
 * Même résolution de modèle que generateAiCommitMessage (commit model →
 * registry → session model), mais le prompt intègre à la fois le draft
 * (intention réelle du LLM) et le diff git courant pour vérifier la cohérence
 * (fusion des entrées du même fichier, suppression des fichiers absents).
 *
 * Returns { subject, body } or null if no model is available or the call fails.
 */
export async function generateCleanCommitMessage(
  projectId: string,
  draft: string,
  diff: string
): Promise<{ subject: string; body: string } | null> {
  console.log(`[commit] === Starting clean commit message generation (draft) ===`);

  const library = loadModelLibrary();

  let model: any = null;

  // Ensure registry is loaded
  await reloadModelRegistry();

  // 1. Use the commit model (or default) from the library
  const commitModel = getCommitModel(library);
  if (commitModel) {
    model = sharedModelRegistry!.find(commitModel.providerId, commitModel.modelId);
  }

  // 2. Fallback: use the session model (if available)
  if (!model?.id) {
    const state = sessionsByProject.get(projectId);
    if (state?.session?.model) {
      model = state.session.model;
    }
  }

  // 3. Last resort: first available model from the registry
  if (!model?.id) {
    const availableModels = sharedModelRegistry!.getAvailable();
    if (availableModels.length > 0) {
      model = availableModels[0];
    }
  }

  // 4. Absolute last resort: scan all library models
  if (!model?.id) {
    for (const m of library.models) {
      model = sharedModelRegistry!.find(m.providerId, m.modelId);
      if (model) break;
    }
  }

  if (!model?.id) {
    console.warn("[commit] === No model available at all ===");
    return null;
  }

  console.log(`[commit] === Using model: ${model.provider}/${model.modelId || model.id} ===`);

  const context = {
    systemPrompt: CLEAN_COMMIT_INSTRUCTIONS,
    messages: [
      {
        role: "user" as const,
        content: `Work draft (real intent):\n\n${draft.slice(0, 6000) || "(empty)"}\n\n---\n\nCurrent git diff:\n\n${diff.slice(0, 8000)}`,
        timestamp: Date.now(),
      },
    ],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    // Acquire LLM slot for the provider call
    await concurrencyManager.acquireLLMSlot(`${projectId}::commit-clean`, "commit-clean");

    let commitResult: { subject: string; body: string } | null = null;
    try {
      const response = await sharedModelRuntime!.completeSimple(model, context, {
        temperature: 0.2,
        maxTokens: 400,
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
        commitResult = null;
      } else {
        commitResult = parseCleanCommitJson(text);
      }
    } finally {
      concurrencyManager.releaseLLMSlot(`${projectId}::commit-clean`);
    }
    return commitResult;
  } catch (error: any) {
    console.error("[commit] === completeSimple FAILED ===", error?.message || error);
    return null;
  }
}
