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
//
// `OrphanSubAgentRuns` rend en fin de fil les runs ARCHIVÉS (relus depuis
// l'historique) qui n'ont pas de toolCall `delegate` rattachable — dégradé
// propre, sans toucher le fil (le composant s'abonne seul au store).

import { memo, useMemo, useSyncExternalStore } from "react";
import type { SubAgentRun, ToolCallInfo } from "../../types";
import { useTranslation } from "../../i18n";
import { CollapsibleBlock } from "./CollapsibleBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallTimer } from "./ToolCallTimer";
import { computeDurationMs, formatToolDuration } from "../../utils/toolSummaries";
import {
  getOrphanRuns,
  getRunsVersion,
  isRunConcurrent,
  subscribeRuns,
  useConcurrentRuns,
  useSubAgentRun,
} from "../../stores/subagentRuns";

// Libellés des statuts de fin (subagent_end) — parité fr/en gérée par le code.
const END_STATUS_LABELS: Record<string, string> = {
  success: "succès",
  error: "erreur",
  "timeout-inactivity": "timeout (inactivité)",
  "timeout-global": "timeout (global)",
  aborted: "interrompu",
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
  durationMs?: number;
  liveStartedAt?: number;
}

/** En-tête commun d'un run (live, colonne parallèle, orphelin). Exporté pour
 *  être réutilisé tel quel par la vue en colonnes (LOT 4). */
export function SubAgentHeader({ run, toolCall, running, failed, durationMs, liveStartedAt }: HeaderProps) {
  const { t } = useTranslation();
  const { meta, roleLabel, model, task } = computeHeaderInfo(run, toolCall);
  const status = running ? "⟳" : failed ? "❌" : "✓";
  const actionCount = run?.actions.length ?? 0;
  const attempt = run?.attempt ?? 1;
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

// ── Contenu commun (mini-fil du sous-agent) ──────────────────────────────────

/** Contenu commun du mini-fil d'un run (messages, actions, résumé final).
 *  Exporté pour être réutilisé par la vue en colonnes (LOT 4). */
export function SubAgentRunBody({ run, blockId, fallback }: { run?: SubAgentRun; blockId: string; fallback?: string }) {
  const { t } = useTranslation();
  const hasStructured = !!run && (run.messages.length > 0 || run.actions.length > 0 || !!run.end);
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
          {run.actions.map((a) => (
            <div key={a.seq} className={`text-[11px] font-mono flex flex-wrap items-center gap-1 ${a.isError ? "text-red-400" : "text-hacker-text-dim"}`}>
              <span className="text-hacker-text-dim/50">{a.seq}.</span>
              <span className="text-hacker-text-bright/80">{a.toolName}</span>
              {a.argSummary && a.argSummary !== a.toolName && (
                <span className="truncate max-w-[220px] text-hacker-text-dim/70">{a.argSummary.replace(a.toolName, "").trim()}</span>
              )}
              {a.summary && <span>· {a.summary}</span>}
              {a.durationMs !== undefined && (
                <span className="text-hacker-text-dim/50 tabular-nums">· {formatToolDuration(a.durationMs)}</span>
              )}
              {a.truncated && <span className="text-hacker-text-dim/50">· tronqué</span>}
            </div>
          ))}
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
          {run.end.errorMessage && (
            <div className="text-red-400/90 whitespace-pre-wrap break-words max-h-40 overflow-y-auto mt-0.5">{run.end.errorMessage}</div>
          )}
          {run.end.responsePreview && (
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
  // Statut : le run (store) prime une fois connu ; sinon dérivé du toolCall.
  const running = run ? run.status === "running" : toolCall.isStreaming;
  const failed = run ? run.isError : isSubAgentFailed(toolCall);
  // AUTO-DÉPLI : un sous-agent EN COURS est DÉPLIÉ par défaut pour montrer son
  // activité (exigence « plus de silence »). Contrairement aux outils simples,
  // on n'exige NI « dernier actif » NI output présent : une délégation
  // long-running est l'activité principale du tour. TRANSITOIRE : une fois
  // terminé, la règle normale (réglage global / erreur) reprend, sauf override.
  // NB : l'en-tête porte aussi un indicateur d'activité visible même replié
  // (cf. SubAgentHeader.preview).
  const autoRunning = running;

  // Durée : live pendant le run (chrono) ; figée (end.durationMs ou
  // startedAt→endedAt du toolCall) une fois terminé ; absente en historique.
  const finishedDurationMs = run?.end?.durationMs ??
    computeDurationMs({ startedAt: toolCall.startedAt, endedAt: toolCall.endedAt, isStreaming: false });
  const liveStartedAt = run?.startedAt ?? toolCall.startedAt;

  return (
    <CollapsibleBlock
      blockId={blockId}
      isError={failed}
      isRunning={autoRunning}
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
          durationMs={finishedDurationMs}
          liveStartedAt={liveStartedAt}
        />
      }
    >
      <SubAgentRunBody run={run} blockId={blockId} fallback={toolCall.output} />
    </CollapsibleBlock>
  );
});

// ── Runs archivés orphelins (fin de fil, dégradé propre) ─────────────────────

const OrphanSubAgentBlock = memo(function OrphanSubAgentBlock({ run }: { run: SubAgentRun }) {
  return (
    <CollapsibleBlock
      blockId={`orphan:${run.id}`}
      isError={run.isError}
      className="ml-4 pl-2 border-l border-hacker-border/60 min-w-0"
      headerClassName={`inline-flex items-center gap-1.5 text-[0.6875rem] font-mono leading-tight text-left min-w-0 flex-wrap ${
        run.isError ? "text-red-400" : "text-hacker-text-dim"
      }`}
      contentClassName="mt-1"
      header={
        <SubAgentHeader
          run={run}
          running={false}
          failed={run.isError}
          durationMs={run.end?.durationMs}
        />
      }
    >
      <SubAgentRunBody run={run} blockId={`orphan:${run.id}`} />
    </CollapsibleBlock>
  );
});

/**
 * Rend les runs de sous-agents ARCHIVÉS sans toolCall `delegate` rattachable.
 * Composant ISOLÉ : il s'abonne seul au store (version globale) → son re-rendu
 * ne provoque PAS celui du fil de messages.
 * ÉTANCHÉITÉ inter-projets : `projectId` (projet affiché) borne la sélection —
 * un run archivé d'un autre projet (persisté dans SA session) n'apparaît jamais
 * ici.
 */
export const OrphanSubAgentRuns = memo(function OrphanSubAgentRuns({ projectId }: { projectId?: string }) {
  const version = useSyncExternalStore(subscribeRuns, getRunsVersion, getRunsVersion);
  // useMemo sur la version : getOrphanRuns(projectId) reconstruit un tableau.
  const orphans = useMemo(
    () => getOrphanRuns(projectId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, projectId],
  );
  if (orphans.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 mt-1">
      {orphans.map((r) => (
        <OrphanSubAgentBlock key={r.id} run={r} />
      ))}
    </div>
  );
});
