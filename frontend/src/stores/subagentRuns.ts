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

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
  /**
   * ÉTANCHÉITÉ inter-projets : projet d'appartenance du sous-agent (porté par
   * l'enveloppe backend — miroir de harness-stream.buildSubagentEnvelope).
   * Permet de vérifier la cohérence avec le projectId de la frame WS et de
   * n'exposer un run QUE dans la conversation de son projet.
   */
  projectId?: string;
  /** Événement SDK brut (ou clone tronqué) du sous-agent. */
  event: any;
}

// ── Helpers purs ─────────────────────────────────────────────────────────────

const noopUnsub = () => {};

/**
 * Normalise un horodatage en epoch ms. Le backend (buildFullUiHistory) sérialise
 * les timestamps des ENTRÉES de session au format ISO 8601 (`entry.timestamp`),
 * alors que les événements LIVE utilisent `Date.now()` (numérique). Sans cette
 * normalisation, l'arithmétique `now - durationMs` donne `NaN` → l'ancrage des
 * runs datés était non fini (`NaN <= x` toujours faux) et TOUS les runs détachés
 * finissaient en fin de fil (après la réponse finale) ; les groupes de messages,
 * eux, voyaient `typeof timestamp === "number"` faux → date 0 pour tous. D'où le
 * bug « sous-agent affiché après la réponse finale ».
 */
export function toEpochMs(value: unknown, fallback: number = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

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
    lastEventAt: now,
    isError: false,
    attempt: env.attempt ?? 1,
    actions: [],
    messages: [],
    // Étanchéité : le run est marqué du projet de son enveloppe (l'enveloppe
    // est la source d'autorité — sinon assignation par l'appelant, cf.
    // routeSubagentEnvelope).
    ...(typeof env.projectId === "string" && env.projectId ? { projectId: env.projectId } : {}),
  };
}

/** Champs d'en-tête rafraîchis à CHAQUE event (relance : tentatives/modèle). */
function envelopeMeta(env: SubagentEnvelope, base: SubAgentRun, now: number) {
  return {
    function: env.delegateFunction || base.function,
    label: env.delegateLabel || base.label,
    modelId: env.model && env.model !== "?" ? env.model : base.modelId,
    attempt: env.attempt ?? base.attempt,
    task: env.taskExcerpt || base.task,
    // Liveness : tout événement reçu prouve que le run vit (détection de
    // blocage par SILENCE, pas par durée).
    lastEventAt: now,
    // Le projet d'appartenance NE CHANGE JAMAIS en cours de run : préservé si
    // l'enveloppe ne le porte pas (frames antérieurs au correctif).
    projectId: env.projectId || base.projectId,
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
  const meta = envelopeMeta(env, base, now);
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
export function runFromActivity(activity: any, now: number | string = Date.now()): SubAgentRun | null {
  if (!activity || typeof activity.delegateRunId !== "string") return null;
  // `now` peut être ISO (entrée de session) ou numérique (appel direct) :
  // normalisé pour que `startedAt`/`endedAt` soient TOUJOURS finis (jamais NaN).
  const ts = toEpochMs(now);
  const durationMs =
    typeof activity.durationMs === "number" && Number.isFinite(activity.durationMs)
      ? Math.max(0, activity.durationMs)
      : 0;
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
    // Horodatage : la fin (timestamp de l'activité) − la durée. `startedAt` est
    // TOUJOURS posé (même durée absente → = fin) pour garantir un ancrage
    // numérique : un run dont l'enregistrement d'activité survient APRÈS la
    // réponse finale reste ainsi daté AVANT elle (le sous-agent a tourné avant).
    endedAt: ts,
    startedAt: ts - durationMs,
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

/**
 * Remet le store à zéro. Sans argument : purge TOTALE (comportement historique).
 * Avec `projectId` : purge CIBLÉE du projet quitté (changement de projet) —
 *  - les runs TERMINÉS du projet sont supprimés (nettoyage ; les versions
 *    archivées seront ré-enregistrées par la resync pi_history) ;
 *  - les runs ENCORE ACTIFS sont PRÉSERVÉS : le projet peut continuer à
 *    déléguer en arrière-plan (deux projets émettant en parallèle), et à son
 *    retour l'utilisateur retrouve son sous-agent en cours dans SA conversation ;
 *  - les runs des AUTRES projets ne sont jamais touchés (étanchéité).
 */
export function resetSubagentRuns(projectId?: string): void {
  for (const timer of pendingNotify.values()) clearTimeout(timer);
  pendingNotify.clear();
  if (projectId) {
    const removed = new Set<string>();
    for (const [id, r] of runs) {
      if (r.projectId === projectId && !isRunActive(r)) {
        removed.add(id);
        runs.delete(id);
      }
    }
    if (removed.size > 0) {
      for (const [tcId, runId] of attachment) {
        if (removed.has(runId)) attachment.delete(tcId);
      }
      bumpAttachment();
    }
  } else {
    runs.clear();
    attachment.clear();
    bumpAttachment();
  }
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
    // `toolResult` ORPHELIN (toolCall absent de l'historique — pagination,
    // compaction) : c'est le SEUL ancrage "delegate" encore présent. On l'accepte
    // comme cible de rattachement ET de rendu (ChatView y monte un SubAgentBlock)
    // pour qu'un run ne soit jamais détaché s'il reste une trace de son appel.
    if (m.kind === "toolResult" && m.toolResult?.name === "delegate") {
      const tr = m.toolResult;
      const runId =
        typeof tr.details?.delegateRunId === "string" ? tr.details.delegateRunId : undefined;
      calls.push({
        id: tr.id,
        fn: typeof tr.details?.delegateFunction === "string" ? tr.details.delegateFunction : "",
        ...(runId ? { runId } : {}),
      });
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
 *
 * ÉTANCHÉITÉ : `messagesProjectId` est le projet des messages fournis. Un run
 * appartenant à un AUTRE projet n'est JAMAIS rattaché à ces toolCalls (le FIFO
 * de secours, aveugle par nature, accrocherait sinon un run étranger à un
 * message local). Si le run n'a pas encore de projectId (frame héritée), il
 * adopte celui des messages — les deux listes appartiennent à la même
 * conversation par construction.
 */
function attachRun(
  runId: string,
  fn: string,
  messages: DisplayMessage[],
  messagesProjectId?: string,
): void {
  const run = runs.get(runId);
  if (!run) return;
  // Garde-fou d'étanchéité : run et messages doivent être du même projet.
  if (
    messagesProjectId &&
    run.projectId &&
    run.projectId !== messagesProjectId
  ) {
    return; // run étranger → jamais rattaché ici (il se rattachera dans SON projet)
  }
  // Le run hérite du projet des messages tant qu'il n'en a pas (frames
  // antérieurs au champ enveloppe.projectId) — cohérent : on ne rattache un
  // run qu'aux toolCalls de la conversation qui l'a émis.
  if (messagesProjectId && !run.projectId) {
    runs.set(runId, { ...run, projectId: messagesProjectId });
  }

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
 *
 * ÉTANCHÉITÉ inter-projets : `projectId` est le projet de la frame WS reçue
 * (msg.projectId) — et du fil de messages fourni (l'appelant, ChatView, passe
 * déjà les messages du projet `pid`).
 *  - incohérence enveloppe ↔ frame (env.projectId défini et différent) → event
 *    IGNORÉ : il appartient à un autre projet, quel que soit l'affichage ;
 *  - le run est marqué de ce projet et n'est rattaché qu'aux toolCalls du même
 *    projet (cf. attachRun) ; les API de sélection (getAllRuns, getOrphanRuns,
 *    useConcurrentRuns) filtrent ensuite par projet.
 */
export function routeSubagentEnvelope(
  env: SubagentEnvelope,
  messages: DisplayMessage[],
  now: number = Date.now(),
  projectId?: string,
): SubAgentRun | undefined {
  if (!env || typeof env.delegateRunId !== "string" || !env.delegateRunId) return undefined;
  // Incohérence enveloppe ↔ frame = événement d'un AUTRE projet : ignorer.
  // (Le backend inclut désormais projectId DANS l'enveloppe ; les frames
  // antérieurs ne le portent pas → aucune rejection dans ce cas.)
  if (typeof env.projectId === "string" && env.projectId && projectId && env.projectId !== projectId) {
    return undefined;
  }
  const prev = runs.get(env.delegateRunId);
  const next = applySubagentEvent(prev, env, now);
  runs.set(env.delegateRunId, next);
  // Tant que le run n'est pas rattaché, on retente (le toolCall `delegate` peut
  // être commité un render après le premier event). Le rattachement est borné
  // au projet du run (cf. attachRun) — jamais inter-projets.
  if (![...attachment.values()].includes(env.delegateRunId)) {
    attachRun(env.delegateRunId, next.function, messages, projectId ?? env.projectId);
  }
  scheduleRunNotify(env.delegateRunId);
  return runs.get(env.delegateRunId);
}

/**
 * Enregistre des runs « archivés » (relecture historique) puis les rattache
 * aux tool calls `delegate` de la liste convertie. Idempotent (dédup par id).
 * ÉTANCHÉITÉ : `projectId` (conversation qui relit ces runs) est marqué sur
 * chaque run avant stockage et borne le rattachement — un run archivé ne peut
 * jamais apparaître ni s'accrocher dans une conversation d'un autre projet.
 *
 * (fix orphelins) Le rattachement est RETENTÉ à CHAQUE appel, y compris pour
 * des runs déjà enregistrés : un run resté orphelin (aucun toolCall `delegate`
 * disponible lors de l'enregistrement) redevient inline dès que la pagination
 * d'historique apporte enfin son `delegate`. L'ancien `if (!added) return`
 * abandonnait définitivement le run en fin de fil.
 */
export function registerArchivedRuns(
  list: SubAgentRun[],
  messages: DisplayMessage[],
  projectId?: string,
): void {
  let added = false;
  for (const r of list) {
    if (!r || runs.has(r.id)) continue;
    // Marque le projet d'appartenance (relecture = conversation courante).
    runs.set(r.id, projectId && !r.projectId ? { ...r, projectId } : r);
    added = true;
  }
  // Rattachement (re)tenté pour TOUS les runs fournis — pas seulement les
  // nouveaux (cf. commentaire ci-dessus).
  let attached = false;
  for (const r of list) {
    if (!r || [...attachment.values()].includes(r.id)) continue;
    const before = attachment.size;
    attachRun(r.id, r.function, messages, projectId);
    if (attachment.size > before) attached = true;
  }
  if (!added && !attached) return;
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

/** Runs ARCHIVÉS non rattachés à un toolCall (rendus en fin de fil, dégradé).
 * ÉTANCHÉITÉ : sans `projectId` → tous les orphelins (compat) ; avec
 * `projectId` → uniquement les orphelins DE CE projet (une conversation ne
 * montre jamais les orphelins d'un autre projet). */
export function getOrphanRuns(projectId?: string): SubAgentRun[] {
  const attached = new Set(attachment.values());
  return [...runs.values()].filter(
    (r) =>
      r.archived &&
      !attached.has(r.id) &&
      (!projectId || r.projectId === projectId),
  );
}

// ── Détection de CONCURRENCE (LOT 4 : vue en colonnes) ───────────────────────
// Objectif : repérer les sous-agents qui tournent EN MÊME TEMPS pour les
// afficher côte à côte (split horizontal) au lieu de les empiler dans le fil.
// Tout est PUR ici (aucun accès React/store) → testable unitairement ; le
// composant ne fait que consommer le résultat via `useConcurrentRuns`.

/**
 * Vrai si le run est ENCORE ACTIF (n'a pas émis subagent_end). Seuls les runs
 * actifs peuvent figurer dans une vue parallèle : un run terminé « rejoint le
 * fil » (cf. spéc. §4).
 */
export function isRunActive(run: SubAgentRun): boolean {
  return run.status === "running";
}

/**
 * Seuil de SILENCE au-delà duquel un run ENCORE `running` sans nouvel
 * événement est considéré BLOQUÉ (abort/timeout dont l'événement de fin s'est
 * perdu, coupure WS…). On mesure le silence depuis le DERNIER événement (et non
 * la durée depuis le démarrage) : un long run qui streame encore n'est jamais
 * marqué bloqué. Valeur cohérente avec le détecteur backend (silence 15 min).
 */
export const STUCK_RUN_TIMEOUT_MS = 20 * 60_000;

/**
 * Vrai si le run est ENCORE `running` et silencieux depuis plus de
 * STUCK_RUN_TIMEOUT_MS. Fonction PURE (now injectable). Un run sans date
 * d'activité connue n'est jamais considéré bloqué.
 */
export function isRunStuck(run: SubAgentRun, now: number = Date.now()): boolean {
  if (!isRunActive(run)) return false;
  const last = typeof run.lastEventAt === "number" ? run.lastEventAt : run.startedAt;
  if (typeof last !== "number") return false;
  return now - last > STUCK_RUN_TIMEOUT_MS;
}

/**
 * Intervalle temporel d'un run : [startedAt, endedAt ?? now]. Un run actif est
 * ouvert jusqu'à `now` (il grandit à chaque rendu) ; un run terminé sans
 * `endedAt` est réduit à un point (startedAt). `startedAt` absent → `now`.
 */
export function runTimeInterval(run: SubAgentRun, now: number): { start: number; end: number } {
  const rawStart = typeof run.startedAt === "number" ? run.startedAt : now;
  const end =
    typeof run.endedAt === "number" ? run.endedAt : isRunActive(run) ? now : rawStart;
  return { start: Math.min(rawStart, end), end: Math.max(rawStart, end) };
}

/**
 * Sélectionne les GROUPES de runs dont les intervalles [startedAt, endedAt ??
 * now] se CHEVAUCHENT et qui comptent ≥2 runs ENCORE ACTIFS à l'instant `now`.
 * Ces groupes sont ceux à afficher en colonnes côte à côte.
 *
 * Algorithme (balayage glouton, O(n log n)) :
 *  1. intervalle temporel de chaque run non archivé ;
 *  2. tri par date de début + regroupement des intervalles qui se chevauchent
 *     (composantes connexes — un run terminé peut faire le lien entre deux
 *     actifs, d'où le balayage et non un simple « tous actifs ») ;
 *  3. dans chaque composante, on ne CONSERVE que les runs actifs ; le groupe
 *     n'est retenu que s'il reste ≥2 actifs (sinon comportement normal : un run
 *     seul reste dans le fil). Tri chronologique dans le groupe.
 *
 * NB volontaire : deux runs actifs se chevauchent TOUJOURS (leurs deux
 * intervalles contiennent `now`), donc en pratique il n'y a qu'un seul groupe =
 * l'ensemble des runs actifs. La logique d'intervalles rend malgré tout la
 * détection exacte pour tout mélange terminés/actifs (ex. : un run terminé qui
 * n'était pas contemporain d'un run actif ne doit pas créer de colonne).
 */
export function selectConcurrentRuns(runs: SubAgentRun[], now: number = Date.now()): SubAgentRun[][] {
  const items = runs
    .filter((r): r is SubAgentRun => !!r && !r.archived && typeof r.id === "string")
    .map((run) => ({ run, ...runTimeInterval(run, now) }))
    .sort(
      (a, b) =>
        a.start - b.start || (a.run.id < b.run.id ? -1 : a.run.id > b.run.id ? 1 : 0),
    );

  const groups: SubAgentRun[][] = [];
  let current: SubAgentRun[] = [];
  let currentMaxEnd = -Infinity;

  const flush = () => {
    if (current.length > 0) {
      // Les runs BLOQUÉS (sans subagent_end au-delà du seuil) sortent du mur :
      // ils rejoignent le fil à leur date (cf. isRunStuck / insertDatedRuns)
      // au lieu de rester indéfiniment en colonnes.
      const active = current
        .filter((r) => isRunActive(r) && !isRunStuck(r, now))
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.id < b.id ? -1 : 1));
      if (active.length >= 2) groups.push(active);
    }
    current = [];
  };

  for (const item of items) {
    if (current.length === 0) {
      current = [item.run];
      currentMaxEnd = item.end;
      continue;
    }
    // Chevauchement (bornes incluses) : le prochain début reste ≤ à la fin
    // courante maximale → même composante.
    if (item.start <= currentMaxEnd) {
      current.push(item.run);
      if (item.end > currentMaxEnd) currentMaxEnd = item.end;
    } else {
      flush();
      current = [item.run];
      currentMaxEnd = item.end;
    }
  }
  flush();
  return groups;
}

/** Tous les runs connus (actifs + archivés), dans l'ordre d'insertion.
 * ÉTANCHÉITÉ : sans `projectId` → tous les runs (compat) ; avec `projectId`
 * → uniquement les runs DE CE projet (deux projets émettant en parallèle ne
 * se mélangent jamais dans la vue de l'un ou de l'autre). */
export function getAllRuns(projectId?: string): SubAgentRun[] {
  const all = [...runs.values()];
  return projectId ? all.filter((r) => r.projectId === projectId) : all;
}

/**
 * Hook : groupes de runs simultanés ACTIFS à afficher côte à côte. S'abonne au
 * store ISOLÉ (version globale) → son re-rendu ne touche PAS le tableau
 * `messages` (aucun re-render du fil).
 * ÉTANCHÉITÉ : `projectId` (projet affiché) borne la sélection — le mur des
 * colonnes ne compte QUE les sous-agents du projet courant, même si d'autres
 * projets émettent des runs en parallèle sur le même socket.
 */
export function useConcurrentRuns(projectId?: string): SubAgentRun[][] {
  const version = useSyncExternalStore(subscribeRuns, getRunsVersion, getRunsVersion);
  // Horloge : réévalue le seuil de blocage même sans nouvel événement (un run
  // bloqué doit sortir du mur et rejoindre le fil à sa date).
  const tick = useActiveRunsClock();
  // `version` change à chaque notification → recalcul (getAllRuns renvoie un
  // nouveau tableau à chaque appel).
  return useMemo(
    () => selectConcurrentRuns(getAllRuns(projectId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, projectId, tick],
  );
}

/** Vrai si le run appartient à un groupe concurrent (donc affiché en colonne). */
export function isRunConcurrent(runId: string | undefined, groups: SubAgentRun[][]): boolean {
  if (!runId) return false;
  return groups.some((g) => g.some((r) => r.id === runId));
}

/**
 * Date d'ancrage du MUR des sous-agents simultanés = date du PREMIER appel
 * `delegate` du lot (approximée par le plus ancien `startedAt` des runs du
 * premier groupe — le sous-agent démarre au moment de sa délégation). Fonction
 * PURE (testable) ; renvoie `null` sans groupe concurrent, ou si aucun run n'a
 * de date exploitable (l'appelant retombe alors sur un mur en fin de fil).
 */
export function concurrentWallAnchor(runs: SubAgentRun[], now: number = Date.now()): number | null {
  const groups = selectConcurrentRuns(runs, now);
  if (groups.length === 0) return null;
  let min = Infinity;
  for (const run of groups[0]) {
    if (typeof run.startedAt === "number" && Number.isFinite(run.startedAt)) {
      min = Math.min(min, run.startedAt);
    }
  }
  return Number.isFinite(min) ? min : null;
}

// Snapshot STABLE du mur (ids de groupe) : le fil ne re-rend PAS à chaque event
// de sous-agent, seulement quand l'appartenance du groupe concurrent change.
let wallSnapVersion = -1;
let wallSnapProject: string | undefined;
let wallSnapIds = "";
let wallSnapAnchor: number | null = null;

export function getConcurrentWallSnapshot(projectId?: string): number | null {
  if (wallSnapVersion === version && wallSnapProject === projectId) return wallSnapAnchor;
  const runs = getAllRuns(projectId);
  const groups = selectConcurrentRuns(runs);
  wallSnapVersion = version;
  wallSnapProject = projectId;
  const first = groups[0];
  const ids = first ? first.map((r) => r.id).sort().join("+") : "";
  if (ids !== wallSnapIds) {
    wallSnapIds = ids;
    // Date d'ancrage = plus ancien début du groupe concurrent (premier delegate).
    wallSnapAnchor = concurrentWallAnchor(runs);
  }
  return wallSnapAnchor;
}

/**
 * Hook : date d'ancrage du mur de colonnes (stable). S'abonne au store ISOLÉ
 * via un snapshot qui ne change QUE si l'appartenance du groupe concurrent
 * change → aucun re-rendu du fil sur les events LIVE des sous-agents.
 */
export function useConcurrentWallAnchor(projectId?: string): number | null {
  return useSyncExternalStore(
    subscribeRuns,
    () => getConcurrentWallSnapshot(projectId),
    () => getConcurrentWallSnapshot(projectId),
  );
}

// ── Insertion À LEUR DATE des runs détachés (fix « sous-agents après la
// réponse finale ») ───────────────────────────────────────────────────────────
// Les runs de sous-agents NON rattachables à un toolCall `delegate` (orphelins
// archivés de l'historique, ou runs BLOQUÉS sans `subagent_end`) ne sont plus
// rendus systématiquement EN FIN DE FIL — c'est-à-dire APRÈS la réponse finale
// de l'assistant. Ils rejoignent le fil À LEUR DATE. L'ordre EXISTANT des
// groupes n'est jamais modifié (le fil reste piloté par l'ordre d'arrivée) :
// chaque run est inséré avant le premier groupe dont le timestamp le dépasse.

/** Date d'ancrage d'un run dans le fil : début, sinon fin, sinon 0.
 * On refuse les valeurs non finies (NaN/Infinity) : un ancrage non fini rendait
 * le tri instable et poussait le run en fin de fil. */
export function runAnchorTimestamp(run: SubAgentRun): number {
  if (typeof run.startedAt === "number" && Number.isFinite(run.startedAt)) return run.startedAt;
  if (typeof run.endedAt === "number" && Number.isFinite(run.endedAt)) return run.endedAt;
  return 0;
}

/**
 * Date d'ancrage d'un run = date du message portant son toolCall `delegate`
 * (position RÉELLE de l'appel dans le fil), sinon sa date propre. Permet de
 * placer un bloc à l'endroit de son appel même si son enregistrement d'activité
 * est plus tardif. PURE et testable ; `messages` doit être la fenêtre affichée.
 */
export function delegateAnchorTimestamp(run: SubAgentRun, groups: DisplayMessage[][]): number {
  if (run.toolCallId) {
    for (const group of groups) {
      for (const m of group) {
        for (const tc of m.toolCalls || []) {
          if (tc.id === run.toolCallId) {
            return typeof m.timestamp === "number" ? m.timestamp : runAnchorTimestamp(run);
          }
        }
      }
    }
  }
  return runAnchorTimestamp(run);
}

/** Entrée ordonnée du fil : soit un groupe de messages, soit un run daté, soit
 * le mur des sous-agents simultanés (placé À SA DATE, jamais systématiquement en
 * fin de fil). */
export type DatedThreadEntry<T> =
  | { kind: "group"; ts: number; group: T }
  | { kind: "run"; ts: number; run: SubAgentRun }
  | { kind: "wall"; ts: number; id: string };

/**
 * Insère des runs datés ET des marqueurs (mur de colonnes) dans une liste de
 * groupes SANS réordonner les groupes. Stratégie : parcours linéaire des
 * groupes (ordre existant préservé) ; chaque marqueur est inséré AVANT le
 * premier groupe dont le timestamp est ≥ à sa date (un run de même date passe
 * donc AVANT le groupe, jamais après la réponse). Tri STABLE entre marqueurs
 * par date, tie-break par clé (run avant mur) puis par id (déterministe).
 *
 * Fonction PURE (testable) : `groupTimestamp` extrait la date d'un groupe
 * (typiquement le timestamp de son premier message).
 */
export function insertDatedRuns<T>(
  groups: T[],
  runs: SubAgentRun[],
  groupTimestamp: (group: T) => number,
  walls: { ts: number; id?: string }[] = [],
  anchorOf: (run: SubAgentRun) => number = runAnchorTimestamp,
): DatedThreadEntry<T>[] {
  // Marqueurs unifiés (runs + murs) triés par date, tie-break stable.
  const markers: { ts: number; key: string; make: () => DatedThreadEntry<T> }[] = [];
  for (const run of runs) {
    const ts = anchorOf(run);
    markers.push({ ts, key: `run:${run.id}`, make: () => ({ kind: "run", ts, run }) });
  }
  for (const wall of walls) {
    const id = wall.id ?? "parallel";
    markers.push({ ts: wall.ts, key: `wall:${id}`, make: () => ({ kind: "wall", ts: wall.ts, id }) });
  }
  markers.sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const out: DatedThreadEntry<T>[] = [];
  let mi = 0;
  for (const group of groups) {
    const gts = groupTimestamp(group);
    while (mi < markers.length && markers[mi].ts <= gts) {
      out.push(markers[mi].make());
      mi++;
    }
    out.push({ kind: "group", ts: gts, group });
  }
  while (mi < markers.length) {
    out.push(markers[mi].make());
    mi++;
  }
  return out;
}

/**
 * Sélection PURE des runs à insérer dans le fil À LEUR DATE :
 *  - ARCHIVÉS (historique) SANS toolCall `delegate` rattachable, OU
 *  - BLOQUÉS (`running` au-delà de STUCK_RUN_TIMEOUT_MS sans fin) non
 *    rattachables (les runs rattachés sont, eux, rendus inline par leur bloc).
 * ÉTANCHÉITÉ : borné au projet affiché.
 */
export function getDatedDetachedRuns(projectId?: string, now: number = Date.now()): SubAgentRun[] {
  const attached = new Set(attachment.values());
  return [...runs.values()].filter(
    (r) =>
      !attached.has(r.id) &&
      (!projectId || r.projectId === projectId) &&
      (r.archived === true || isRunStuck(r, now)),
  );
}

const EMPTY_DATED_RUNS: SubAgentRun[] = [];
let datedSnapshotVersion = -1;
let datedSnapshotProject: string | undefined;
let datedSnapshotBucket = -1;
let datedSnapshot: SubAgentRun[] = EMPTY_DATED_RUNS;

/**
 * Snapshot STABLE pour `useSyncExternalStore` : renvoie la MÊME référence tant
 * que la liste des ids et le « bucket » temporel (30 s) ne changent pas — les
 * notifications du store (events LIVE des sous-agents) ne re-rendent donc PAS
 * le fil. Le bucket force la réévaluation périodique du seuil de blocage.
 */
export function getDatedDetachedSnapshot(projectId?: string): SubAgentRun[] {
  const bucket = Math.floor(Date.now() / 30_000);
  if (
    datedSnapshotVersion === version &&
    datedSnapshotProject === projectId &&
    datedSnapshotBucket === bucket
  ) {
    return datedSnapshot;
  }
  const list = getDatedDetachedRuns(projectId);
  datedSnapshotVersion = version;
  datedSnapshotProject = projectId;
  datedSnapshotBucket = bucket;
  const sameIds =
    list.length === datedSnapshot.length && list.every((r, i) => r.id === datedSnapshot[i].id);
  if (!sameIds) datedSnapshot = list.length > 0 ? list : EMPTY_DATED_RUNS;
  return datedSnapshot;
}

/**
 * Force un re-rendu périodique TANT QU'IL RESTE des runs actifs : sans nouvel
 * événement, le seuil de blocage (isRunStuck) doit quand même être réévalué
 * pour libérer le mur de colonnes. Retourne le nombre de ticks (à inclure dans
 * les deps des `useMemo` qui datent les runs).
 */
export function useActiveRunsClock(intervalMs = 30_000): number {
  const [hasActive, setHasActive] = useState(false);
  useEffect(() => {
    const check = () => setHasActive([...runs.values()].some(isRunActive));
    check();
    return subscribeRuns(check);
  }, []);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [hasActive, intervalMs]);
  return tick;
}

/**
 * Hook : runs détachés à insérer À LEUR DATE dans le fil. S'abonne au store
 * isolé via un snapshot STABLE (aucun re-rendu du fil sur les events live) et
 * déclenche une horloge tant que des runs actifs existent (libération des runs
 * bloqués au-delà du seuil).
 */
export function useDatedDetachedRuns(projectId?: string): SubAgentRun[] {
  useActiveRunsClock();
  return useSyncExternalStore(
    subscribeRuns,
    () => getDatedDetachedSnapshot(projectId),
    () => getDatedDetachedSnapshot(projectId),
  );
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
