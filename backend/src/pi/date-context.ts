// ── Contexte temporel pour le MODÈLE (date + heure de l'UTILISATEUR) ────────
// Objectif : que le LLM sache QUAND chaque message utilisateur a été envoyé, afin
// qu'il ne confonde pas « aujourd'hui » avec la date réelle (les échanges peuvent
// s'étaler sur plusieurs jours). L'utilisateur, lui, ne voit jamais ce repère :
// il est transporté par un CustomMessage `display:false` (filtré partout côté UI).
//
// Module PUR (aucune I/O) : formatage et construction du message testables sans
// session SDK.
//
// Format retenu : `YYYY-MM-DD HH:mm` en HEURE LOCALE DE L'UTILISATEUR.
// Non ambigu (ordre ISO année-mois-jour, donc triable lexicographiquement) et
// « compact » : l'agent peut comparer la partie date de deux messages pour
// détecter un changement de jour.
//
// ⚠️ Fuseau : l'heure rendue doit être celle que l'utilisateur voit dans son fil
// de discussion, c'est-à-dire l'heure locale de SON NAVIGATEUR
// (`frontend/src/components/Chat/ChatView.tsx` → `toLocaleTimeString([], …)`),
// et non celle du process backend (conteneur en UTC en production). Le client
// transmet donc sa zone IANA avec chaque message (`pi_prompt`/`pi_steer`) et le
// serveur formate dans cette zone via `Intl.DateTimeFormat` : aucun décalage en
// dur, aucun calcul d'offset, les changements d'heure (DST) sont gérés par la
// base de fuseaux d'ICU.
//
// Repli : sans zone fournie (client ancien, appel HTTP sans en-tête, zone
// invalide), on retombe sur le fuseau du process (comportement historique) —
// jamais d'exception : un repère manquant ne doit pas casser un tour.

export const DATE_CONTEXT_CUSTOM_TYPE = "date_context";

/** Zéro-padding à 2 chiffres. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Cache des formateurs par zone : `new Intl.DateTimeFormat` est coûteux et le
// repère est produit à chaque message. Bornage naturel : une zone par client.
const formattersByZone = new Map<string, Intl.DateTimeFormat>();

function getZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formattersByZone.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // `h23` : minuit = 00 (et surtout PAS 24, que produisent certains cycles
    // horaires par défaut selon la locale/version d'ICU).
    hourCycle: "h23",
  });
  formattersByZone.set(timeZone, formatter);
  return formatter;
}

/**
 * Vrai si `value` est une zone IANA utilisable par `Intl` (ex. `Europe/Paris`).
 * Sert de garde : une zone inconnue doit dégrader le formatage, jamais le faire
 * échouer (un tour utilisateur ne doit pas être perdu pour un fuseau exotique).
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const zone = value.trim();
  if (!zone) return false;
  try {
    getZoneFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Date + heure formatées compact `YYYY-MM-DD HH:mm` dans `timeZone`
 * (zone IANA du navigateur de l'utilisateur). Ex. `2026-10-04 14:32`.
 * Sans `timeZone` valide : repli sur le fuseau du process backend.
 */
export function formatCompactDateTime(date: Date, timeZone?: string | null): string {
  if (!isValidTimeZone(timeZone)) {
    // Repli historique : getters LOCAUX du process (ex. UTC en conteneur).
    return (
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
      ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    );
  }
  const parts = getZoneFormatter(timeZone.trim()).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

/**
 * Contenu texte du message de contexte temporel. Le préfixe entre crochets
 * signale au modèle qu'il s'agit de MÉTADONNÉES (heure locale du message
 * utilisateur qui suit) et non d'une saisie utilisateur à interpréter.
 */
export function buildDateContextContent(date: Date, timeZone?: string | null): string {
  return `[horodatage] ${formatCompactDateTime(date, timeZone)} (heure locale)`;
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
export function buildDateContextMessage(
  date: Date,
  timeZone?: string | null,
): DateContextMessage {
  return {
    customType: DATE_CONTEXT_CUSTOM_TYPE,
    content: buildDateContextContent(date, timeZone),
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
