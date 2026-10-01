// ── Bloc sous-agent (toolCall `delegate`) — LOT 2 refonte chat ──────────────
// Le tool `delegate` (extensions/harness-orchestrator) est rendu comme un bloc
// INDENTÉ à en-tête. En-tête : rôle (args.function / label effectif), modèle,
// nombre d'actions, durée live puis durationMs, statut (⏳ / ✓ / ❌), tentatives.
//
// LOT 2 : le bloc s'abonne au store ISOLÉ (stores/subagentRuns.ts) — les
// événements de streaming du sous-agent NE touchent PAS `messages` : seul ce
// bloc se re-rend. Replié = une ligne + l'aperçu existant (buildProgressText
// du toolCall delegate) ; déplié = mini-fil du sous-agent (sa réflexion, ses
// messages tronqués « extrait », ses outils résumés par le LOT 1). Erreurs
// auto-dépliées ; résumé final + cause si échec.
// Repli PAR DÉFAUT (décision produit) : le journal (actions numérotées) et les
// réflexions/textes du sous-agent suivent le réglage « Déplier le détail
// d'affichage par défaut » — y compris pendant le run (l'en-tête reste le
// suivi live : statut, chrono, nombre d'actions, dernière action).
//
// `DatedSubAgentBlock` rend un run détaché À SA DATE dans le fil (il est inséré
// par `insertDatedRuns` côté ChatView) : runs ARCHIVÉS (relus depuis l'historique)
// sans toolCall `delegate` rattachable OU runs BLOQUÉS sans `subagent_end`.
// Le composant s'abonne seul au run (par id) → aucun re-rendu du fil.

import { memo, useCallback, useSyncExternalStore } from "react";
import type { SubAgentRun, ToolCallInfo } from "../../types";
import { useTranslation } from "../../i18n";
import { CollapsibleBlock } from "./CollapsibleBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallTimer } from "./ToolCallTimer";
import { computeDurationMs, formatToolDuration } from "../../utils/toolSummaries";
import { dedupeSubAgentEndTexts } from "../../utils/subagent-partial";
import {
  getRun,
  isRunConcurrent,
  isRunStuck,
  subscribeRun,
  useConcurrentRuns,
  useSubAgentControls,
  useSubAgentRun,
} from "../../stores/subagentRuns";

// Libellés des statuts de fin (subagent_end) — parité fr/en gérée par le code.
const END_STATUS_LABELS: Record<string, string> = {
  success: "succès",
  error: "erreur",
  "timeout-inactivity": "timeout (inactivité)",
  "timeout-global": "timeout (global)",
  aborted: "interrompu",
  // LOT 1 : arrêt ciblé par l'utilisateur (les autres runs continuent).
  cancelled: "annulé par l'utilisateur",
};

// ── Libellés des fonctions de routage ────────────────────────────────────────
// Miroir de FUNCTIONS (extensions/harness-orchestrator) : le frontend ne peut
// pas importer l'extension → table locale, à garder en phase.
const SUB_AGENT_FUNCTIONS: Record<string, { emoji: string; label: string }> = {
  planning: { emoji: "🗺️", label: "Planification" },
  execute: { emoji: "⚙️", label: "Exécution" },
  review: { emoji: "🔍", label: "Relecture" },
  integrate: { emoji: "🧩", label: "Intégration" },
};

/**
 * Échec d'un sous-agent : isError du toolCall OU message d'échec en tête de
 * l'aperçu (le tool delegate préfixe ses erreurs de « ❌ » — cf. timeoutError
 * et les messages d'échec de l'extension).
 */
export function isSubAgentFailed(toolCall: ToolCallInfo): boolean {
  if (toolCall.isError) return true;
  const head = (toolCall.output || "").trimStart();
  return head.startsWith("❌") || head.startsWith("⚠");
}

// ── En-tête commun (live + orphelin) ─────────────────────────────────────────

function computeHeaderInfo(run: SubAgentRun | undefined, toolCall?: ToolCallInfo) {
  const fn = run?.function || (typeof toolCall?.args?.function === "string" ? toolCall.args.function : "");
  const meta = SUB_AGENT_FUNCTIONS[fn] ?? null;
  const roleLabel = run?.label || meta?.label || fn || "";
  const model =
    run?.modelId ||
    (typeof toolCall?.args?.model === "string" && toolCall.args.model) ||
    (typeof toolCall?.details?.model === "string" && toolCall.details.model) ||
    null;
  const task = run?.task || (typeof toolCall?.args?.task === "string" ? toolCall.args.task : "");
  return { meta, roleLabel, model, task };
}

interface HeaderProps {
  run?: SubAgentRun;
  toolCall?: ToolCallInfo;
  running: boolean;
  failed: boolean;
  /** Run bloqué (running sans fin au-delà du seuil) → marqueur discret. */
  stuck?: boolean;
  durationMs?: number;
  liveStartedAt?: number;
}

/** En-tête commun d'un run (live, colonne parallèle, orphelin). Exporté pour
 *  être réutilisé tel quel par la vue en colonnes (LOT 4). */
export function SubAgentHeader({ run, toolCall, running, failed, stuck, durationMs, liveStartedAt }: HeaderProps) {
  const { t } = useTranslation();
  const controls = useSubAgentControls();
  const { meta, roleLabel, model, task } = computeHeaderInfo(run, toolCall);
  const status = stuck ? "⏱" : running ? "⟳" : failed ? "❌" : "✓";
  const actionCount = run?.actions.length ?? 0;
  const attempt = run?.attempt ?? 1;
  // LOT 1 : runId pour l'arrêt CIBLÉ — priorité au run (store) puis aux details
  // du toolCall `delegate` (retour du tool). Le bouton Stop n'apparaît que pour
  // un run ENCORE actif (running ou bloqué).
  const runId =
    (typeof run?.id === "string" && run.id) ||
    (typeof toolCall?.details?.delegateRunId === "string" && toolCall.details.delegateRunId) ||
    (typeof toolCall?.args?.delegateRunId === "string" && toolCall.args.delegateRunId) ||
    undefined;
  const canStop = !!runId && (running || !!stuck);
  // Aperçu replié : dernier résumé d'action, sinon dernier output connu — du
  // run (events structurés) OU du toolCall delegate (aperçu buildProgressText,
  // filet de secours si les events sous-agent n'arrivent pas). Toujours visible
  // (même replié), pour ne jamais laisser un run muet.
  const lastAction = run?.actions.length ? run.actions[run.actions.length - 1] : undefined;
  const lastLine = (s: string | undefined) => (s || "").split("\n").filter(Boolean).slice(-1)[0] || "";
  const preview = lastAction?.summary || lastLine(run?.currentOutput) || lastLine(toolCall?.output) || "";
  return (
    <>
      <span>{status}</span>
      <span className="font-bold text-hacker-accent">
        {meta?.emoji ? `${meta.emoji} ` : ""}{t("chat.subAgent")} {roleLabel}
      </span>
      {model && <span className="text-hacker-text-dim/70 truncate max-w-[160px]">{model}</span>}
      {run && actionCount > 0 && (
        <span className="text-hacker-text-dim/60">{t("chat.subAgentActions", actionCount)}</span>
      )}
      {attempt > 1 && <span className="text-amber-400/80">{t("chat.subAgentAttempt", attempt)}</span>}
      {task && <span className="text-hacker-text-dim/60 truncate max-w-[300px]">— {task}</span>}
      {stuck && (
        <span className="text-amber-400/70" title={t("chat.subAgentStuck")}>
          ⏱ {t("chat.subAgentStuck")}
        </span>
      )}
      {run?.queued && (
        <span className="text-hacker-text-dim/70" title={t("chat.subAgentQueuedTitle")}>
          ⏳ {t("chat.subAgentQueued")}
        </span>
      )}
      {canStop && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); controls.stop(runId); }}
          title={t("chat.subAgentStopTitle")}
          aria-label={t("chat.subAgentStopTitle")}
          className="shrink-0 px-1.5 py-0.5 rounded border border-red-500/50 text-red-400 hover:bg-red-500/10 hover:border-red-400 transition-colors text-[0.625rem]"
        >
          ■ {t("chat.subAgentStop")}
        </button>
      )}
      {running ? (
        <ToolCallTimer startedAt={liveStartedAt} />
      ) : durationMs !== undefined ? (
        <span className="text-hacker-text-dim/60 tabular-nums">{formatToolDuration(durationMs)}</span>
      ) : null}
      {/* Indicateur d'activité TOUJOURS visible (même replié) : dernière action
          résumée ou dernier output — évite le « silence total » pendant un run. */}
      {preview && (
        <span className={`truncate max-w-[220px] ${running ? "text-hacker-accent/70" : "text-hacker-text-dim/50"}`} title={preview}>
          {running ? "· " : ""}{preview}
        </span>
      )}
    </>
  );
}

/**
 * Résumé d'action SANS la tête « verbe + cible » déjà rendue à gauche.
 * Runs LIVE : le résumé vient de buildToolSummary et vaut « bash <cmd> · exit 0
 * · 59 lignes » — la tête serait affichée DEUX FOIS (toolName + argSummary).
 * Runs ARCHIVÉS : le résumé persisté (backend summarizeToolAction) contient
 * déjà les SEULS segments (« 59 lignes ») → renvoyé tel quel.
 */
function actionSummaryTail(summary: string, argSummary: string): string {
  if (!summary) return "";
  if (argSummary && summary.startsWith(argSummary)) {
    return summary.slice(argSummary.length).replace(/^\s*·\s*/, "");
  }
  return summary;
}

// ── Contenu commun (mini-fil du sous-agent) ──────────────────────────────────

/** Contenu commun du mini-fil d'un run (messages, actions, résumé final).
 *  Exporté pour être réutilisé par la vue en colonnes (LOT 4). */
export function SubAgentRunBody({ run, blockId, fallback }: { run?: SubAgentRun; blockId: string; fallback?: string }) {
  const { t } = useTranslation();
  const hasStructured = !!run && (run.messages.length > 0 || run.actions.length > 0 || !!run.end);
  // P5 : le partiel ne doit apparaître qu'UNE fois. On masque une source de
  // fin (errorMessage / responsePreview) déjà contenue dans le mini-fil.
  const endVisibility = dedupeSubAgentEndTexts(run);
  return (
    <div className="flex flex-col gap-1.5">
      {/* Messages du sous-agent : réflexion (ThinkingBlock) + texte tronqué. */}
      {run?.messages.map((m, i) => (
        <div key={`m-${i}`} className="flex flex-col gap-1">
          {m.thinking && (
            <div className="ml-3">
              <ThinkingBlock thinking={m.thinking} blockId={`${blockId}:think:${i}`} />
            </div>
          )}
          {m.text && (
            <div className="ml-3 border-l border-hacker-border/40 pl-2">
              <div className="text-[11px] whitespace-pre-wrap break-words text-hacker-text-bright/90 max-h-40 overflow-y-auto font-mono">
                {m.text}
              </div>
              {m.textTruncated && (
                <span className="text-[10px] text-hacker-text-dim/60 italic">{t("chat.subAgentExtract")}</span>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Actions d'outils (résumés du LOT 1). */}
      {run && run.actions.length > 0 && (
        <div className="ml-3 flex flex-col gap-0.5 border-l border-hacker-border/40 pl-2">
          {run.actions.map((a) => {
            const tail = actionSummaryTail(a.summary, a.argSummary || a.toolName);
            return (
              <div key={a.seq} className={`text-[11px] font-mono flex flex-wrap items-center gap-1 ${a.isError ? "text-red-400" : "text-hacker-text-dim"}`}>
                <span className="text-hacker-text-dim/50">{a.seq}.</span>
                <span className="text-hacker-text-bright/80">{a.toolName}</span>
                {a.argSummary && a.argSummary !== a.toolName && (
                  <span className="truncate max-w-[220px] text-hacker-text-dim/70">{a.argSummary.replace(a.toolName, "").trim()}</span>
                )}
                {tail && <span>· {tail}</span>}
                {a.durationMs !== undefined && (
                  <span className="text-hacker-text-dim/50 tabular-nums">· {formatToolDuration(a.durationMs)}</span>
                )}
                {a.truncated && <span className="text-hacker-text-dim/50">· tronqué</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Résumé final + cause si échec. */}
      {run?.end && (
        <div className={`ml-3 text-[11px] ${run.isError ? "text-red-400" : "text-hacker-text-dim"}`}>
          <span>
            {run.isError ? "❌" : "✓"} {END_STATUS_LABELS[run.end.status] || run.end.status}
            {run.end.actionCount > 0 ? ` · ${t("chat.subAgentActions", run.end.actionCount)}` : ""}
            {run.end.durationMs > 0 ? ` · ${formatToolDuration(run.end.durationMs)}` : ""}
          </span>
          {run.end.cause && <div className="text-hacker-text-dim/80">{t("chat.subAgentCause")} : {run.end.cause}</div>}
          {run.end.errorMessage && endVisibility.showErrorMessage && (
            <div className="text-red-400/90 whitespace-pre-wrap break-words max-h-40 overflow-y-auto mt-0.5">{run.end.errorMessage}</div>
          )}
          {run.end.responsePreview && endVisibility.showResponsePreview && (
            <div className="mt-0.5 whitespace-pre-wrap break-words text-hacker-text-dim/70 max-h-32 overflow-y-auto">
              {run.end.responsePreview}
              {run.end.responsePreview.length >= 500 && <span className="italic"> {t("chat.subAgentExtract")}</span>}
            </div>
          )}
        </div>
      )}

      {/* Aperçu brut existant (buildProgressText) : fallback sans données live. */}
      {!hasStructured && fallback && (
        <pre className="font-mono text-xs max-h-40 overflow-y-auto whitespace-pre-wrap break-words border border-hacker-border/40 rounded bg-hacker-bg/40 p-2 text-hacker-text-bright/90">
          {fallback}
        </pre>
      )}
    </div>
  );
}

// ── Bloc live (rattaché à un toolCall `delegate`) ────────────────────────────

interface Props {
  toolCall: ToolCallInfo;
  /** Clé d'override par bloc (CollapsibleBlock). */
  blockId: string;
}

export const SubAgentBlock = memo(function SubAgentBlock({ toolCall, blockId }: Props) {
  const run = useSubAgentRun(toolCall);
  // LOT 4 : si ce run fait partie d'un groupe de sous-agents SIMULTANÉS, il est
  // affiché dans la vue EN COLONNES (ParallelSubAgents) et non ici — sinon on
  // le verrait deux fois. Abonnement au store ISOLÉ : ce re-rendu ne touche PAS
  // le fil de messages. Dès que le groupe retombe à <2 actifs, `isRunConcurrent`
  // redevient faux et le bloc reprend sa place dans le fil (réversibilité).
  // ÉTANCHÉITÉ : la détection est bornée au PROJET du run (porté par le store,
  // cf. subagentRuns) — un run d'un autre projet émettant en parallèle ne doit
  // ni masquer ce bloc, ni apparaître dans le mur de cette conversation.
  const concurrentGroups = useConcurrentRuns(run?.projectId);
  if (run && isRunConcurrent(run.id, concurrentGroups)) return null;
  // Run BLOQUÉ (running sans fin au-delà du seuil) : il n'est plus une colonne
  // (selectConcurrentRuns l'exclut) → rendu inline à sa place avec un marqueur.
  const stuck = run ? isRunStuck(run) : false;
  // Statut d'affichage : le run (store) prime une fois connu ; sinon dérivé du
  // toolCall. Un run TERMINÉ ne `running` plus, et un run resté `running` mais
  // BLOQUÉ (`stuck`) non plus.
  const running = run ? run.status === "running" && !stuck : toolCall.isStreaming;
  const failed = run ? run.isError : isSubAgentFailed(toolCall);
  // PAS D'AUTO-DÉPLI pour un run EN COURS (décision produit) : le réglage
  // « Déplier le détail d'affichage par défaut » INACTIF doit replier le
  // journal du sous-agent MÊME pendant le run — sinon des dizaines de lignes
  // d'actions défilent et le réglage paraît inopérant (plainte sur le volume).
  // Le suivi live reste assuré SANS déplier : l'en-tête (toujours visible)
  // porte statut, chrono, nombre d'actions et dernière action résumée
  // (cf. SubAgentHeader.preview) ; un clic déplie le mini-fil.
  // Précédence conservée : override utilisateur > erreur (auto-dépli) >
  // réglage global (ACTIF → déplié, INACTIF → replié).

  // Durée : live pendant le run (chrono) ; figée (end.durationMs ou
  // startedAt→endedAt du toolCall) une fois terminé ; absente en historique.
  const finishedDurationMs = run?.end?.durationMs ??
    computeDurationMs({ startedAt: toolCall.startedAt, endedAt: toolCall.endedAt, isStreaming: false });
  const liveStartedAt = run?.startedAt ?? toolCall.startedAt;

  return (
    <CollapsibleBlock
      blockId={blockId}
      isError={failed}
      className={`ml-4 pl-2 border-l border-hacker-border/60 min-w-0 ${running ? "animate-pulse" : ""}`}
      headerClassName={`inline-flex items-center gap-1.5 text-[0.6875rem] font-mono leading-tight text-left min-w-0 flex-wrap ${
        failed ? "text-red-400" : "text-hacker-text-dim"
      }`}
      contentClassName="mt-1"
      title={run?.task || undefined}
      header={
        <SubAgentHeader
          run={run}
          toolCall={toolCall}
          running={running}
          failed={failed}
          stuck={stuck}
          durationMs={finishedDurationMs}
          liveStartedAt={liveStartedAt}
        />
      }
    >
      <SubAgentRunBody run={run} blockId={blockId} fallback={toolCall.output} />
    </CollapsibleBlock>
  );
});

// ── Run détaché daté (orphelin archivé OU run bloqué) ────────────────────────
// Rendu À SA DATE dans le fil (inséré par `insertDatedRuns` côté ChatView).
// S'abonne au run PAR ID : un run bloqué encore vivant se rafraîchit seul, sans
// que le snapshot global des runs datés (stable) ne re-rende le fil.

export const DatedSubAgentBlock = memo(function DatedSubAgentBlock({ run }: { run: SubAgentRun }) {
  const live = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeRun(run.id, cb), [run.id]),
    useCallback(() => getRun(run.id) ?? run, [run.id, run]),
    () => run,
  );
  const stuck = isRunStuck(live);
  const running = live.status === "running" && !stuck;
  const blockId = `dated:${live.id}`;
  return (
    <CollapsibleBlock
      blockId={blockId}
      isError={live.isError}
      className="ml-4 my-1 pl-2 border-l border-hacker-border/60 min-w-0"
      headerClassName={`inline-flex items-center gap-1.5 text-[0.6875rem] font-mono leading-tight text-left min-w-0 flex-wrap ${
        live.isError ? "text-red-400" : "text-hacker-text-dim"
      }`}
      contentClassName="mt-1"
      header={
        <SubAgentHeader
          run={live}
          running={running}
          failed={live.isError}
          stuck={stuck}
          durationMs={live.end?.durationMs}
          liveStartedAt={running ? live.startedAt : undefined}
        />
      }
    >
      <SubAgentRunBody run={live} blockId={blockId} />
    </CollapsibleBlock>
  );
});
