// ── Vue EN COLONNES des sous-agents simultanés (LOT 4 refonte chat) ─────────
// VISION : quand deux (ou plus) sous-agents tournent EN MÊME TEMPS, on ne les
// empile plus dans le fil — on SPLITTE horizontalement l'espace des messages
// pour les afficher CÔTE À CÔTE, une colonne par run.
//
// CHOIX D'EMPLACEMENT (documenté) : la vue parallèle est un « mur » dédié
// monté UNE fois en fin de fil (juste avant les runs datés insérés inline), et
// non à l'endroit exact de chaque bloc `delegate`. Raisons :
//   1. le fil de messages ne doit JAMAIS re-rendre sur les events de
//      sous-agents (spéc. §2.1) — or ce composant s'abonne seul au store ISOLÉ
//      (stores/subagentRuns) : il peut apparaître/disparaître sans toucher
//      `messages` ;
//   2. l'emplacement est STABLE et unique quel que soit le moment où chaque
//      run est rattaché à son toolCall (pas de trou si le 1er run n'est pas
//      encore rattaché) ;
//   3. l'activité live est en bas du fil (là où l'utilisateur regarde) et le
//      scroll auto (ResizeObserver → pin bas) suit naturellement.
// En contrepartie, le bloc `delegate` d'un run concurrent est MASQUÉ dans le
// fil (cf. SubAgentBlock) et réapparaît À SA PLACE dès que le run se termine ou
// qu'il ne reste plus qu'un seul run actif → réversibilité propre.
//
// PLAFOND D'AFFICHAGE : les colonnes sont à largeurs égales. Au-delà de
// MAX_PARALLEL_COLUMNS (3), chaque colonne garde une largeur minimale lisible
// et le conteneur passe en DÉFILEMENT HORIZONTAL. Sur petit écran (< sm), les
// colonnes s'empilent VERTICALEMENT.
//
// COHÉRENCE : chaque colonne est un CollapsibleBlock → elle suit le réglage
// displayDetailExpanded et l'override utilisateur (blockId `parallel:<id>`),
// l'auto-dépli d'erreur et l'auto-dépli d'un run en cours (isRunning). Son
// corps (la sortie du sous-agent) défile INDÉPENDAMMENT.

import { memo } from "react";
import type { SubAgentRun } from "../../types";
import { useTranslation } from "../../i18n";
import { CollapsibleBlock } from "./CollapsibleBlock";
import { SubAgentHeader, SubAgentRunBody } from "./SubAgentBlock";
import { useConcurrentRuns } from "../../stores/subagentRuns";

/** Colonnes max affichées côte à côte avant défilement horizontal. */
export const MAX_PARALLEL_COLUMNS = 3;

/** Une colonne = un run actif (en-tête rôle/modèle/statut/durée + sortie).
 *  `fixedWidth` : au-delà du plafond, largeur fixe (défilement horizontal). */
const ParallelColumn = memo(function ParallelColumn({ run, fixedWidth }: { run: SubAgentRun; fixedWidth: boolean }) {
  const running = run.status === "running";
  const blockId = `parallel:${run.id}`;
  // ≤ plafond : largeurs ÉGALES (flex-1, base 0) ; au-delà : largeur FIXE pour
  // forcer le défilement horizontal plutôt que des colonnes illisibles.
  const sizing = fixedWidth
    ? "sm:flex-none sm:w-[260px]"
    : "sm:flex-1 sm:basis-0 sm:min-w-[220px]";
  return (
    <CollapsibleBlock
      blockId={blockId}
      isRunning={running}
      isError={run.isError}
      className={`flex flex-col min-w-0 w-full ${sizing} border border-hacker-border/60 rounded bg-hacker-surface/20 overflow-hidden`}
      headerClassName="inline-flex items-center gap-1.5 px-2 py-1 text-[0.6875rem] font-mono leading-tight text-left min-w-0 flex-wrap bg-hacker-bg/40 border-b border-hacker-border/30 cursor-pointer"
      contentClassName="min-w-0"
      header={
        <SubAgentHeader
          run={run}
          running={running}
          failed={run.isError}
          liveStartedAt={run.startedAt}
        />
      }
    >
      {/* Sortie du sous-agent : scroll INDÉPENDANT par colonne. */}
      <div className="max-h-[45vh] overflow-y-auto px-2 py-1.5">
        <SubAgentRunBody run={run} blockId={blockId} />
      </div>
    </CollapsibleBlock>
  );
});

/**
 * Mur des sous-agents simultanés. S'abonne au store isolé (useConcurrentRuns) :
 * son re-rendu ne provoque PAS celui du fil de messages. N'affiche rien tant
 * qu'il n'y a pas ≥2 runs actifs concurrents (sinon comportement fil normal).
 *
 * ÉTANCHÉITÉ inter-projets : `projectId` (projet affiché) borne la sélection —
 * le mur ne compte QUE les sous-agents du projet courant, même si d'autres
 * projets délèguent en parallèle et émettent sur le même socket WS.
 */
export const ParallelSubAgents = memo(function ParallelSubAgents({ projectId }: { projectId?: string }) {
  const { t } = useTranslation();
  const groups = useConcurrentRuns(projectId);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 my-2">
      {groups.map((group) => (
        <section
          key={group.map((r) => r.id).join("|")}
          aria-label={t("chat.parallelSubAgents", group.length)}
          className="rounded border border-hacker-accent/30 bg-hacker-bg/20 overflow-hidden animate-fade-in-up"
        >
          <header className="flex items-center gap-2 px-2 py-1 border-b border-hacker-border/40 bg-hacker-bg/40 text-[0.6875rem] font-mono text-hacker-accent">
            <span aria-hidden>⑂</span>
            <span>{t("chat.parallelSubAgents", group.length)}</span>
            {group.length > MAX_PARALLEL_COLUMNS && (
              <span className="text-hacker-text-dim/60">
                · {t("chat.parallelSubAgentsOverflow", MAX_PARALLEL_COLUMNS)}
              </span>
            )}
          </header>
          {/* Largeurs égales ; défilement horizontal au-delà du plafond ;
              empilement vertical sur petit écran. */}
          <div className="flex flex-col sm:flex-row items-stretch gap-2 p-2 sm:overflow-x-auto">
            {group.map((run) => (
              <ParallelColumn key={run.id} run={run} fixedWidth={group.length > MAX_PARALLEL_COLUMNS} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});
