// ── Ligne d'état du composer (sous la zone de saisie) ───────────────────────
// Affiche les raccourcis clavier, la branche git et l'indicateur d'activité.
//
// L'indicateur est piloté par resolveActivityDisplay (utils/activity-label) :
// il couvre le run principal (isStreaming / activity fine) ET les délégations
// encore actives (subAgentActive, store subagentRuns). Sans cette seconde
// source, « ça travaille » restait invisible pendant un `delegate` (la session
// principale n'émet ni texte ni réflexion) et le libellé historique
// « Chargement... » était trompeur.
import { memo } from "react";
import { useTranslation } from "../../i18n";
import type { Activity } from "../../types";
import { resolveActivityDisplay } from "../../utils/activity-label";

interface Props {
  /** Branche git du projet actif (affichée en permanence, indépendamment de l'activité). */
  gitBranch?: string;
  /** Run principal en streaming (agent_start → agent_settled). */
  isStreaming: boolean;
  /** Run principal silencieux au-delà du seuil du watchdog. */
  streamingStalled?: boolean;
  /** Au moins un sous-agent (`delegate`) encore actif pour ce projet. */
  subAgentActive?: boolean;
  /** Activité fine du run principal (routage, réflexion, outil, génération). */
  activity?: Activity | null;
}

export const ChatStatusLine = memo(function ChatStatusLine({
  gitBranch,
  isStreaming,
  streamingStalled,
  subAgentActive,
  activity,
}: Props) {
  const { t } = useTranslation();
  const display = resolveActivityDisplay(
    { activity, isStreaming, streamingStalled, subAgentActive },
    t,
  );

  return (
    <div className="text-hacker-text-dim text-[0.6875rem] mb-1 flex justify-between">
      <span className="hidden md:block">{t("chat.keyboardHints")}</span>
      <span className="flex items-center gap-2 ml-auto">
        {gitBranch && <span>git:{gitBranch}</span>}
        {display.visible && display.kind === "busy" && (
          <span
            className="text-hacker-accent flex items-center gap-1"
            title={display.tooltip}
          >
            <span className="pulse-dot w-1.5 h-1.5" /> {display.label}
          </span>
        )}
        {display.visible && display.kind === "stalled" && (
          <span className="text-hacker-warn flex items-center gap-1" title={display.tooltip}>
            <span className="w-1.5 h-1.5 rounded-full bg-hacker-warn" /> {display.label}
          </span>
        )}
      </span>
    </div>
  );
});
