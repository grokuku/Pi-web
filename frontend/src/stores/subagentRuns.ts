// ── Store ISOLÉ des runs de sous-agents (LOT 2b refonte chat) ────────────────
// Objectif clé (spécification §2.1/§2.3) : les événements de streaming des
// sous-agents (canal WS pi_event, enveloppes {type:"subagent", …}) NE DOIVENT
// JAMAIS toucher le tableau `messages` de ChatView — sinon le fil re-rend à
// chaque update de tool (20 events/s). Ils vivent ici, dans une Map
// Map<delegateRunId, SubAgentRun> observée via useSyncExternalStore : seul le
// bloc concerné (SubAgentBlock) se re-rend.
//
// - `applySubagentEvent` est PUR (run précédent + enveloppe → nouveau run) :
//   testable unitairement, sans React ni timer.
// - `routeSubagentEnvelope` applique l'event au store + rattache le run au
//   toolCall `delegate` correspondant (EXACT via details.delegateRunId, sinon
//   FIFO + args.function en secours) puis notifie.
// - Coalescing ~100 ms PAR RUN : les events arrivent en rafale (tool deltas
//   forwardés), l'état interne est mis à jour immédiatement mais les abonnés ne
//   sont réveillés qu'au plus toutes les 100 ms.
// - `runFromActivity` reconstruit un run « archivé » depuis l'entrée custom
//   `subagent_activity` persistée (relecture après rechargement).

import { useCallback, useSyncExternalStore } from "react";
import type {
  DisplayMessage,
  SubAgentAction,
  SubAgentEndInfo,
  SubAgentEndStatus,
  SubAgentRun,
  SubAgentRunMessage,
} from "../types";
import { buildToolSummary } from "../utils/toolSummaries";

/** Fenêtre de coalescing par run (ms) — cf. spécification §2.3. */
export const SUBAGENT_COALESCE_MS = 100;

// ── Enveloppe WS (miroir de harness-stream.buildSubagentEnvelope) ────────────
// Le frontend ne peut pas importer l'extension → type local, à garder en phase.

export interface SubagentEnvelope {
  type: "subagent";
  source?: string;
  delegateRunId: string;
  attempt?: number;
  delegateFunction?: string;
  delegateLabel?: string;
  model?: string;
  taskExcerpt?: string;
  /** Événement SDK brut (ou clone tronqué) du sous-agent. */
  event: any;
}

// ── Helpers purs ─────────────────────────────────────────────────────────────

const noopUnsub = () => {};

/** Snapshot serveur stable (pas de SSR ici, mais évite le warning React). */
const getUndefinedRun = () => undefined;

/** Concatène le texte d'un content[] (result / partialResult). */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof (block as any).text === "string") out += (block as any).text;
  }
  return out;
}

/** Premier argument string « cible » (chemin/commande/pattern…) tronqué. */
export function summarizeArgs(toolName: string, args: any): string {
  try {
    const a = args || {};
    const target =
      (typeof a.path === "string" && a.path) ||
      (typeof a.filePath === "string" && a.filePath) ||
      (typeof a.file_path === "string" && a.file_path) ||
      (typeof a.file === "string" && a.file) ||
      (typeof a.command === "string" && a.command) ||
      (typeof a.pattern === "string" && a.pattern) ||
      (typeof a.query === "string" && a.query) ||
      "";
    const line = `${toolName || "outil"} ${target}`.trim();
    return line.length > 120 ? line.slice(0, 120) : line;
  } catch {
    return toolName || "outil";
  }
}

/** Run vide initialisé depuis l'enveloppe (premier event d'un delegateRunId). */
function createRun(env: SubagentEnvelope, now: number): SubAgentRun {
  const fn = env.delegateFunction || "sous-agent";
  return {
    id: env.delegateRunId,
    function: fn,
    label: env.delegateLabel || fn,
    task: env.taskExcerpt || "",
    modelId: env.model && env.model !== "?" ? env.model : undefined,
    status: "running",
    startedAt: now,
    isError: false,
    attempt: env.attempt ?? 1,
    actions: [],
    messages: [],
  };
}

/** Champs d'en-tête rafraîchis à CHAQUE event (relance : tentatives/modèle). */
function envelopeMeta(env: SubagentEnvelope, base: SubAgentRun) {
  return {
    function: env.delegateFunction || base.function,
    label: env.delegateLabel || base.label,
    modelId: env.model && env.model !== "?" ? env.model : base.modelId,
    attempt: env.attempt ?? base.attempt,
    task: env.taskExcerpt || base.task,
  };
}

// ── Application PURE d'un événement (testable unitairement) ──────────────────

/**
 * Applique un événement enveloppé au run précédent (immutable : renvoie un
 * nouvel objet ; renvoie `prev` inchangé si rien ne change). `now` injectable.
 */
export function applySubagentEvent(
  prev: SubAgentRun | undefined,
  env: SubagentEnvelope,
  now: number = Date.now(),
): SubAgentRun {
  const base = prev ?? createRun(env, now);
  const meta = envelopeMeta(env, base);
  const ev = env.event || {};

  switch (ev.type) {
    case "subagent_start":
      return { ...base, ...meta, status: "running", startedAt: base.startedAt ?? now };

    case "tool_execution_start": {
      const toolCallId = ev.toolCallId;
      // Idempotent : rejoue un start déjà vu (reconnexion) sans doublon.
      if (toolCallId && base.actions.some((a) => a.toolCallId === toolCallId)) {
        return { ...base, ...meta, status: "running" };
      }
      const action: SubAgentAction = {
        seq: base.actions.length + 1,
        toolCallId,
        toolName: ev.toolName || "outil",
        argSummary: summarizeArgs(ev.toolName, ev.args),
        summary: "",
        isError: false,
        startedAt: now,
        output: "",
        args: ev.args,
      };
      return { ...base, ...meta, status: "running", currentOutput: "", actions: [...base.actions, action] };
    }

    case "tool_execution_update": {
      const text = extractText(ev.partialResult?.content);
      const actions = base.actions.map((a) =>
        a.toolCallId === ev.toolCallId ? { ...a, output: text } : a,
      );
      return { ...base, ...meta, status: "running", currentOutput: text, actions };
    }

    case "tool_execution_end": {
      const text = extractText(ev.result?.content);
      const outputChars = typeof ev.outputChars === "number" ? ev.outputChars : text.length;
      const actions = base.actions.map((a) => {
        if (a.toolCallId !== ev.toolCallId) return a;
        // Résumé d'outil du LOT 1 (mêmes règles : read → N lignes, bash → exit
        // N, edit → +A/−B via details.diff, erreur → ⚠ 1re ligne…).
        const summary = buildToolSummary({
          name: a.toolName,
          args: a.args,
          output: text,
          details: ev.details,
          isError: !!ev.isError,
        }).text;
        return {
          ...a,
          output: text,
          outputChars,
          truncated: !!ev.outputTruncated,
          isError: !!ev.isError,
          endedAt: now,
          durationMs: a.startedAt !== undefined ? now - a.startedAt : undefined,
          summary,
        };
      });
      return { ...base, ...meta, status: "running", currentOutput: text, actions };
    }

    case "message_end": {
      const m = ev.message || {};
      let text = "";
      let thinking = "";
      for (const block of m.content || []) {
        if (block?.type === "text" && typeof block.text === "string") text += block.text;
        else if (block?.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
      }
      // Message vide (ni texte ni réflexion) → ignoré (évite le bruit).
      if (!text && !thinking) return { ...base, ...meta };
      const message: SubAgentRunMessage = {
        id: m.id,
        text: text || undefined,
        thinking: thinking || undefined,
        textTruncated: !!ev.textTruncated,
        thinkingTruncated: !!ev.thinkingTruncated,
        usage: m.usage
          ? {
              input: m.usage.input || 0,
              output: m.usage.output || 0,
              cost: { total: m.usage.cost?.total || 0 },
            }
          : undefined,
        timestamp: now,
      };
      return { ...base, ...meta, messages: [...base.messages, message] };
    }

    case "subagent_end": {
      const status: SubAgentEndStatus = ev.status || "success";
      const end: SubAgentEndInfo = {
        status,
        attemptsMade: typeof ev.attemptsMade === "number" ? ev.attemptsMade : base.attempt,
        durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
        actionCount: typeof ev.actionCount === "number" ? ev.actionCount : base.actions.length,
        eventCount: typeof ev.eventCount === "number" ? ev.eventCount : 0,
        thinkingChars: typeof ev.thinkingChars === "number" ? ev.thinkingChars : 0,
        model: typeof ev.model === "string" ? ev.model : base.modelId || "?",
        cause: typeof ev.cause === "string" ? ev.cause : null,
        errorMessage: typeof ev.errorMessage === "string" ? ev.errorMessage : null,
        responsePreview: typeof ev.responsePreview === "string" ? ev.responsePreview : "",
        droppedEvents: typeof ev.droppedEvents === "number" ? ev.droppedEvents : 0,
      };
      const failed = status !== "success";
      return {
        ...base,
        ...meta,
        end,
        status: failed ? "failed" : "done",
        isError: failed,
        endedAt: now,
        attempt: end.attemptsMade || base.attempt,
        modelId: end.model && end.model !== "?" ? end.model : base.modelId,
      };
    }

    default:
      // Events non gérés (deltas, internes…) : on rafraîchit seulement l'en-tête.
      return { ...base, ...meta };
  }
}

// ── Reconstruction d'un run « archivé » (entrée persistée) ───────────────────

/** Convertit le détail d'une entrée custom `subagent_activity` en SubAgentRun. */
export function runFromActivity(activity: any, now: number = Date.now()): SubAgentRun | null {
  if (!activity || typeof activity.delegateRunId !== "string") return null;
  const endStatus: SubAgentEndStatus =
    typeof activity.status === "string" ? activity.status : "success";
  const failed = endStatus !== "success";
  const actions: SubAgentAction[] = Array.isArray(activity.actions)
    ? activity.actions.slice(0, 50).map((a: any, i: number) => ({
        seq: typeof a?.seq === "number" ? a.seq : i + 1,
        toolName: typeof a?.toolName === "string" ? a.toolName : "outil",
        argSummary: typeof a?.argSummary === "string" ? a.argSummary : "",
        summary: typeof a?.summary === "string" ? a.summary : "",
        durationMs: typeof a?.durationMs === "number" ? a.durationMs : undefined,
        isError: !!a?.isError,
        outputChars: typeof a?.outputChars === "number" ? a.outputChars : undefined,
        truncated: !!a?.truncated,
      }))
    : [];
  const fn = typeof activity.function === "string" ? activity.function : "sous-agent";
  return {
    id: activity.delegateRunId,
    function: fn,
    label: typeof activity.label === "string" && activity.label ? activity.label : fn,
    task: "",
    modelId: activity.model && activity.model !== "?" ? activity.model : undefined,
    status: failed ? "failed" : "done",
    isError: failed,
    attempt: typeof activity.attempts === "number" ? activity.attempts : 1,
    actions,
    messages: [],
    end: {
      status: endStatus,
      attemptsMade: typeof activity.attempts === "number" ? activity.attempts : 0,
      durationMs: typeof activity.durationMs === "number" ? activity.durationMs : 0,
      actionCount: typeof activity.actionCount === "number" ? activity.actionCount : actions.length,
      eventCount: typeof activity.eventCount === "number" ? activity.eventCount : 0,
      thinkingChars: typeof activity.thinkingChars === "number" ? activity.thinkingChars : 0,
      model: typeof activity.model === "string" ? activity.model : "?",
      cause: typeof activity.cause === "string" ? activity.cause : null,
      errorMessage: typeof activity.errorMessage === "string" ? activity.errorMessage : null,
      responsePreview: typeof activity.responsePreview === "string" ? activity.responsePreview : "",
      droppedEvents: 0,
    },
    archived: true,
    // Horodatage : la fin − durée si connue (le store trie par startedAt).
    endedAt: now,
    ...(typeof activity.durationMs === "number" && activity.durationMs > 0
      ? { startedAt: now - activity.durationMs }
      : {}),
  };
}

// ── État interne du store ────────────────────────────────────────────────────

const runs = new Map<string, SubAgentRun>();
/** toolCallId `delegate` → delegateRunId (rattachement résolu). */
const attachment = new Map<string, string>();
const runListeners = new Map<string, Set<() => void>>();
const pendingNotify = new Map<string, ReturnType<typeof setTimeout>>();
const globalListeners = new Set<() => void>();

let version = 0; // incrémenté à chaque notification (snapshot global stable)
let attachmentSnapshot: ReadonlyMap<string, string> = new Map();
const attachmentListeners = new Set<() => void>();

// ── Notifications (coalescing ~100 ms PAR RUN) ───────────────────────────────

function notifyRun(id: string): void {
  const set = runListeners.get(id);
  if (set) for (const cb of set) cb();
  version++;
  for (const cb of globalListeners) cb();
}

function scheduleRunNotify(id: string): void {
  if (pendingNotify.has(id)) return;
  const timer = setTimeout(() => {
    pendingNotify.delete(id);
    notifyRun(id);
  }, SUBAGENT_COALESCE_MS);
  // Timer non bloquant côté node (tests / SSR).
  (timer as any).unref?.();
  pendingNotify.set(id, timer);
}

/** Force la notification immédiate des runs en attente (tests / fin de rafale). */
export function flushSubagentNotifications(): void {
  for (const [id, timer] of pendingNotify) {
    clearTimeout(timer);
    notifyRun(id);
  }
  pendingNotify.clear();
}

/** Remet le store à zéro (changement de projet / nouvelle conversation). */
export function resetSubagentRuns(): void {
  for (const timer of pendingNotify.values()) clearTimeout(timer);
  pendingNotify.clear();
  runs.clear();
  attachment.clear();
  bumpAttachment();
  version++;
  for (const cb of globalListeners) cb();
}

// ── Rattachement run ↔ toolCall `delegate` ───────────────────────────────────

function bumpAttachment(): void {
  attachmentSnapshot = new Map(attachment);
  for (const cb of attachmentListeners) cb();
}

/**
 * Extrait les tool calls `delegate` (ordre chronologique) d'une liste de
 * messages. `runId` = delegateRunId porté par le RETOUR du tool (details du
 * toolCall — priorité — ou, à défaut, args) : sert au rattachement EXACT.
 */
export function extractDelegateCalls(
  messages: DisplayMessage[],
): { id: string; fn: string; runId?: string }[] {
  const calls: { id: string; fn: string; runId?: string }[] = [];
  for (const m of messages) {
    for (const tc of m.toolCalls || []) {
      if (tc.name === "delegate") {
        const runId =
          (typeof tc.details?.delegateRunId === "string" && tc.details.delegateRunId) ||
          (typeof tc.args?.delegateRunId === "string" && tc.args.delegateRunId) ||
          undefined;
        calls.push({
          id: tc.id,
          fn: typeof tc.args?.function === "string" ? tc.args.function : "",
          ...(runId ? { runId } : {}),
        });
      }
    }
  }
  return calls;
}

/**
 * Rattache un run à un toolCall `delegate` NON encore rattaché :
 *  1. EXACT — un toolCall porte `details.delegateRunId` (retour du tool, LOT 2a) :
 *     rattachement fiable même si deux délégations tournent en parallèle ;
 *  2. FIFO + args.function (match exact) ;
 *  3. sinon premier toolCall `delegate` libre (fonction re-classée par le
 *     routeur backend → l'args.function demandé peut différer de l'effective).
 * Le FIFO ne sert que de SECOURS quand `details` n'est pas encore disponible
 * (live : le tool_execution_end du delegate le porte) ou pour l'historique
 * ancien sans details. Le rendu de SubAgentBlock, lui, lit directement
 * toolCall.details.delegateRunId (useSubAgentRun) → il est EXACT dès que le
 * toolCall commité porte le retour du tool, sans dépendre de cette table.
 */
function attachRun(runId: string, fn: string, messages: DisplayMessage[]): void {
  const calls = extractDelegateCalls(messages);

  // 1) Rattachement EXACT par details.delegateRunId (autoritaire).
  const exact = calls.find((c) => c.runId === runId);
  if (exact) {
    attachment.set(exact.id, runId);
    const r = runs.get(runId);
    if (r && r.toolCallId !== exact.id) runs.set(runId, { ...r, toolCallId: exact.id });
    bumpAttachment();
    return;
  }

  // 2) FIFO + args.function (secours).
  const claimed = (id: string) => attachment.has(id);
  const chosen =
    calls.find((c) => !claimed(c.id) && c.fn === fn) || calls.find((c) => !claimed(c.id));
  if (!chosen) return;
  attachment.set(chosen.id, runId);
  const r = runs.get(runId);
  if (r && r.toolCallId !== chosen.id) runs.set(runId, { ...r, toolCallId: chosen.id });
  bumpAttachment();
}

// ── API publique du store ────────────────────────────────────────────────────

/**
 * Applique un événement sous-agent et rattache le run (au premier event) au
 * toolCall `delegate` visé. Retourne le run à jour. Ne touche JAMAIS `messages`.
 * Le rattachement privilégie details.delegateRunId (LOT 2a) ; le FIFO par
 * args.function reste le secours tant que le retour du tool n'est pas commité.
 */
export function routeSubagentEnvelope(
  env: SubagentEnvelope,
  messages: DisplayMessage[],
  now: number = Date.now(),
): SubAgentRun | undefined {
  if (!env || typeof env.delegateRunId !== "string" || !env.delegateRunId) return undefined;
  const prev = runs.get(env.delegateRunId);
  const next = applySubagentEvent(prev, env, now);
  runs.set(env.delegateRunId, next);
  // Tant que le run n'est pas rattaché, on retente (le toolCall `delegate` peut
  // être commité un render après le premier event).
  if (![...attachment.values()].includes(env.delegateRunId)) {
    attachRun(env.delegateRunId, next.function, messages);
  }
  scheduleRunNotify(env.delegateRunId);
  return runs.get(env.delegateRunId);
}

/**
 * Enregistre des runs « archivés » (relecture historique) puis les rattache
 * aux tool calls `delegate` de la liste convertie. Idempotent (dédup par id).
 */
export function registerArchivedRuns(list: SubAgentRun[], messages: DisplayMessage[]): void {
  let added = false;
  for (const r of list) {
    if (!r || runs.has(r.id)) continue;
    runs.set(r.id, r);
    added = true;
  }
  if (!added) return;
  for (const r of list) {
    if (![...attachment.values()].includes(r.id)) attachRun(r.id, r.function, messages);
  }
  version++;
  for (const cb of globalListeners) cb();
}

// ── Souscriptions (useSyncExternalStore) ─────────────────────────────────────

export function getRun(id: string): SubAgentRun | undefined {
  return runs.get(id);
}

export function subscribeRun(id: string, cb: () => void): () => void {
  let set = runListeners.get(id);
  if (!set) {
    set = new Set();
    runListeners.set(id, set);
  }
  set.add(cb);
  return () => {
    const s = runListeners.get(id);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) runListeners.delete(id);
  };
}

export function getAttachmentSnapshot(): ReadonlyMap<string, string> {
  return attachmentSnapshot;
}

export function subscribeAttachments(cb: () => void): () => void {
  attachmentListeners.add(cb);
  return () => { attachmentListeners.delete(cb); };
}

export function getRunsVersion(): number {
  return version;
}

export function subscribeRuns(cb: () => void): () => void {
  globalListeners.add(cb);
  return () => { globalListeners.delete(cb); };
}

/** Runs ARCHIVÉS non rattachés à un toolCall (rendus en fin de fil, dégradé). */
export function getOrphanRuns(): SubAgentRun[] {
  const attached = new Set(attachment.values());
  return [...runs.values()].filter((r) => r.archived && !attached.has(r.id));
}

// ── Hooks React ──────────────────────────────────────────────────────────────

/**
 * Run rattaché à un toolCall `delegate`. PRIORITÉ au delegateRunId porté par
 * le RETOUR du tool (details.delegateRunId — rattachement EXACT, y compris
 * pour des délégations parallèles) ; repli sur le FIFO de la table de
 * rattachement si le toolCall ne porte pas encore details.
 */
export function useSubAgentRun(toolCall: {
  id: string;
  args?: any;
  details?: any;
}): SubAgentRun | undefined {
  const direct =
    (typeof toolCall.details?.delegateRunId === "string" && toolCall.details.delegateRunId) ||
    (typeof toolCall.args?.delegateRunId === "string" && toolCall.args.delegateRunId) ||
    undefined;
  const snap = useSyncExternalStore(subscribeAttachments, getAttachmentSnapshot, getAttachmentSnapshot);
  const runId = direct ?? snap.get(toolCall.id);
  const subscribe = useCallback(
    (cb: () => void) => (runId ? subscribeRun(runId, cb) : noopUnsub),
    [runId],
  );
  const getSnapshot = useCallback(() => (runId ? getRun(runId) : undefined), [runId]);
  return useSyncExternalStore(subscribe, getSnapshot, getUndefinedRun);
}
