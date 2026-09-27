// ── Libellés d'activité (ligne d'état du composer + StatusBar) ─────────────
// Fonctions PURES : la décision « quoi afficher » est centralisée ici pour que
// la ligne d'état du composer (ChatStatusLine) et la barre du bas (StatusBar)
// restent alignées, et testable sans DOM.
//
// Chaîne d'état couverte :
//  - `isStreaming`    : run principal en cours (agent_start → agent_settled) ;
//  - `activity`       : phase fine issue des événements pi_event (routage,
//                       réflexion, outil, génération) — MUETTE pendant une
//                       délégation (la session principale est bloquée sur le
//                       tool `delegate`, aucun texte/réflexion) ;
//  - `subAgentActive` : au moins un run de sous-agent encore actif pour ce
//                       projet (store isolé subagentRuns) — c'est LA source
//                       qui rend l'indicateur honnête pendant une délégation,
//                       y compris quand la session principale n'est pas en
//                       streaming (batch harness).
import type { Activity } from "../types";

/** Signature minimale du traducteur i18n (compatible `TFunction`). */
export type ActivityTranslate = (key: string) => string;

/** Libellé de la phase courante du run principal. */
export function activityPhaseLabel(
  activity: Activity | null | undefined,
  t: ActivityTranslate,
): string {
  if (!activity) return t("activity.inProgress");
  switch (activity.type) {
    case "routing": {
      const fnLabel = activity.routingFunction
        ? t(`activity.${activity.routingFunction}`)
        : t("activity.inProgress");
      return `${t("activity.routingPrefix")}${fnLabel}`;
    }
    case "thinking":
      return t("activity.thinking");
    case "tool":
      return t("activity.tool");
    case "generating":
      return t("activity.generating");
    default:
      return t("activity.inProgress");
  }
}

export interface ActivityInput {
  /** Activité fine du run principal (remontée par App.tsx depuis pi_event). */
  activity?: Activity | null;
  /** Run principal en streaming (agent_start → agent_settled). */
  isStreaming: boolean;
  /** Run principal silencieux au-delà du seuil du watchdog (App.tsx). */
  streamingStalled?: boolean;
  /** Au moins un sous-agent (`delegate`) encore actif pour ce projet. */
  subAgentActive?: boolean;
}

export interface ActivityDisplay {
  /** false → aucun indicateur ne doit être affiché (session au repos). */
  visible: boolean;
  kind: "busy" | "stalled";
  label: string;
  tooltip: string;
}

/**
 * Décide de l'indicateur d'activité à afficher.
 *
 * Règles :
 *  - rien à afficher si NI le run principal NI un sous-agent ne travaille ;
 *  - un sous-agent ACTIF = du travail réel → libellé « Délégation en cours… »
 *    (jamais « stalled » : la pastille ne parle que du silence du run
 *    PRINCIPAL, qui est normal et attendu pendant un `delegate`) ;
 *  - sinon, libellé de la phase (réflexion/outil/génération/routage) ou
 *    « En cours… » par défaut ;
 *  - « stalled » uniquement quand le run principal est en streaming, silencieux
 *    au-delà du seuil, et qu'aucun sous-agent ne tourne.
 */
export function resolveActivityDisplay(
  input: ActivityInput,
  t: ActivityTranslate,
): ActivityDisplay {
  const busy = input.isStreaming || input.subAgentActive === true;
  if (!busy) return { visible: false, kind: "busy", label: "", tooltip: "" };

  const stalled =
    input.isStreaming && input.streamingStalled === true && input.subAgentActive !== true;
  if (stalled) {
    return {
      visible: true,
      kind: "stalled",
      label: t("activity.stalled"),
      tooltip: t("activity.stalledTooltip"),
    };
  }

  const label =
    input.subAgentActive === true
      ? t("activity.delegating")
      : activityPhaseLabel(input.activity, t);
  return { visible: true, kind: "busy", label, tooltip: t("activity.tooltip") };
}
