// ── Séparateur de journée du fil de conversation (repère de date) ──────────
// Helpers PURS (testables en environnement node), consommés par GroupedMessages
// (ChatView) via le composant DaySeparator — le fil live ET le lecteur de
// conversation passée partagent ce rendu, donc ce comportement.
//
// Contrat :
//  - la journée d'une entrée est celle de son `ts` (pour un groupe, le timestamp
//    de son PREMIER message — fourni par insertDatedRuns, 0 si absent) ;
//  - une entrée SANS horodatage exploitable (0, NaN, négatif) ne reçoit jamais
//    de séparateur et ne déplace pas le repère de jour ;
//  - la PREMIÈRE entrée datée de la liste RENDUE ouvre un séparateur (repère en
//    haut de fil à l'ouverture, et à chaque lot d'historique chargé — le calcul
//    est refait sur la liste rendue, donc réconcilié quel que soit le lot) ;
//  - un séparateur n'apparaît qu'au CHANGEMENT de jour local (jamais entre deux
//    messages du même jour).
//
// Format du libellé : TOUJOURS la date complète — jour de la semaine, numéro
// du jour, mois en toutes lettres, année — dans le fuseau LOCAL, p. ex.
// « Dimanche 4 Février 2024 » (fr) / « Sunday 4 February 2024 » (en).
// Aucun libellé relatif (« Aujourd'hui » / « Hier ») : même un message du jour
// affiche la date complète (choix explicite de l'utilisateur).
// Casse : jour de la semaine ET mois capitalisés, sans virgule (fr comme en),
// structure identique dans les deux langues. Choix : plus lisible que le format
// numérique jj/mm/aaaa de la liste des conversations passées
// (pastSessions.formatSessionDate), où l'espace est contraint.
import type { Language } from "../i18n";

/** Marqueur de jour inséré dans la timeline (cf. `withDaySeparators`). */
export interface DaySeparatorEntry {
  kind: "day";
  ts: number;
}

/**
 * Clé de jour LOCAL (YYYY-MM-DD) d'un timestamp ms, ou null si absent/illisible.
 * `ts <= 0` = sentinelle « pas d'horodatage » du fil (cf. insertDatedRuns).
 * Le format est purement interne (comparaison) : insensible au fuseau tant
 * qu'on reste dans le fuseau local de l'utilisateur.
 */
export function dayKey(timestamp: number | null | undefined): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Indices (dans la liste ORDONNÉE fournie) des entrées qui OUVRENT un jour :
 * la première entrée datée, puis chaque entrée dont le jour local diffère de la
 * dernière entrée datée. Les entrées non datées sont ignorées (ni séparateur,
 * ni mise à jour du repère).
 */
export function daySeparatorIndices(timestamps: ReadonlyArray<number | null | undefined>): number[] {
  const out: number[] = [];
  let last: string | null = null;
  for (let i = 0; i < timestamps.length; i++) {
    const key = dayKey(timestamps[i]);
    if (key === null || key === last) continue;
    out.push(i);
    last = key;
  }
  return out;
}

/**
 * Décore une liste ORDONNÉE d'entrées datées (`ts`) avec un marqueur `day`
 * inséré AVANT la première entrée de chaque journée (voir daySeparatorIndices).
 * Renvoie une NOUVELLE liste, mais réutilise les entrées TELLES QUELLES →
 * l'identité des groupes mémoïsés (perf streaming) est préservée.
 */
export function withDaySeparators<T extends { ts: number }>(
  entries: ReadonlyArray<T>,
): (T | DaySeparatorEntry)[] {
  const separators = new Set(daySeparatorIndices(entries.map((e) => e.ts)));
  const out: (T | DaySeparatorEntry)[] = [];
  entries.forEach((entry, i) => {
    if (separators.has(i)) out.push({ kind: "day", ts: entry.ts });
    out.push(entry);
  });
  return out;
}

/** Première lettre en majuscule, le reste inchangé (« dimanche » → « Dimanche »). */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toLocaleUpperCase() + s.slice(1);
}

/**
 * Libellé d'un séparateur de journée : TOUJOURS la date complète localisée
 * (`Dimanche 4 Février 2024` en fr / `Sunday 4 February 2024` en en), calculée
 * dans le fuseau LOCAL. Jour de la semaine et mois capitalisés, sans virgule,
 * structure identique fr/en. Timestamp illisible → "".
 */
export function formatDayLabel(timestamp: number, lang: Language): string {
  if (dayKey(timestamp) === null) return "";
  const locale = lang === "fr" ? "fr-FR" : "en-US";
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${capitalize(part("weekday"))} ${part("day")} ${capitalize(part("month"))} ${part("year")}`;
}
