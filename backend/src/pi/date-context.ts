// ── Contexte temporel pour le MODÈLE (date + heure locales) ──────────────────
// Objectif : que le LLM sache QUAND chaque message utilisateur a été envoyé, afin
// qu'il ne confonde pas « aujourd'hui » avec la date réelle (les échanges peuvent
// s'étaler sur plusieurs jours). L'utilisateur, lui, ne voit jamais ce repère :
// il est transporté par un CustomMessage `display:false` (filtré partout côté UI).
//
// Module PUR (aucune I/O) : formatage et construction du message testables sans
// session SDK.
//
// Format retenu : `YYYY-MM-DD HH:mm` en HEURE LOCALE (fuseau du process backend,
// cohérent avec l'affichage des heures du fil côté frontend).
// Non ambigu (ordre ISO année-mois-jour, donc triable lexicographiquement) et
// « compact » : l'agent peut comparer la partie date de deux messages pour
// détecter un changement de jour.

export const DATE_CONTEXT_CUSTOM_TYPE = "date_context";

/** Zéro-padding à 2 chiffres. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Date + heure LOCALES au format compact `YYYY-MM-DD HH:mm`.
 * Ex. `2026-10-04 14:32`.
 */
export function formatCompactDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/**
 * Contenu texte du message de contexte temporel. Le préfixe entre crochets
 * signale au modèle qu'il s'agit de MÉTADONNÉES (heure locale du message
 * utilisateur qui suit) et non d'une saisie utilisateur à interpréter.
 */
export function buildDateContextContent(date: Date): string {
  return `[horodatage] ${formatCompactDateTime(date)} (heure locale)`;
}

/** Forme d'un message custom de contexte temporel (display:false → jamais affiché). */
export interface DateContextMessage {
  customType: typeof DATE_CONTEXT_CUSTOM_TYPE;
  content: string;
  display: false;
}

/**
 * Construit le CustomMessage portant le repère temporel. Le couple
 * `customType`/`display:false` est la garantie de non-fuite visuelle : les
 * points de rendu UI (ChatView live, relecture d'historique, conversations
 * passées) n'affichent JAMAIS un custom `display:false`.
 */
export function buildDateContextMessage(date: Date): DateContextMessage {
  return {
    customType: DATE_CONTEXT_CUSTOM_TYPE,
    content: buildDateContextContent(date),
    display: false,
  };
}

/** Options d'envoi de `sendCustomMessage` (sous-ensemble du contrat SDK). */
export interface DateContextDeliveryOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

/**
 * Options de livraison selon l'état RÉEL de la session :
 * - streaming → `deliverAs:"steer"` : le repère rejoint la file de steer et est
 *   injecté juste avant le message utilisateur parti en steer au même moment ;
 * - idle → `triggerTurn:false` : le repère est ajouté à la suite du transcript,
 *   AVANT le message utilisateur que le `prompt()` suivant va apposer.
 *
 * Dans les deux cas, aucune livraison ne déclenche de tour à elle seule.
 */
export function dateContextDeliveryOptions(isStreaming: boolean): DateContextDeliveryOptions {
  return isStreaming ? { deliverAs: "steer" } : { triggerTurn: false };
}
