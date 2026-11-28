// ── Taille du contexte affichée (jauge + compteur de la StatusBar) ───────────
// SOURCE DE VÉRITÉ : `session.contextUsage`, produit par le SDK côté backend
// (`getContextUsage()`, cf. backend/src/pi/session.ts → getSessionInfo) et
// poussé au frontend par l'évènement WS `session_update` (ou relu via
// `GET /api/settings/session`).
//
// ⚠️ Après une compaction, le SDK renvoie VOLONTAIREMENT `tokens: null` :
// « Estimated context tokens, or null if unknown (e.g. right after compaction,
// before next LLM response) » (@earendil-works/pi-coding-agent,
// ContextUsage). La taille réelle n'est donc connue qu'à la réponse LLM
// suivante (le provider renvoie alors `promptTokens`).
//
// Règle appliquée ici : cet état INCONNU est propagé tel quel. On ne conserve
// JAMAIS l'ancien nombre (il serait périmé et présenté comme vrai) et on
// n'invente aucune estimation. `tokens: null` → la StatusBar affiche
// « compacté — taille exacte au prochain message ».
//
// NB : `compact()` renvoie bien un `estimatedTokensAfter` (estimateur du SDK),
// mais ce n'est PAS la taille réelle (le SDK la juge inconnue : cet estimateur
// compte ~1200 tokens par image, il peut être très faux). On ne l'affiche donc
// pas : c'est exactement ce que la règle ci-dessus interdit.
//
// Helpers purs (vitest frontend = environnement node, pas de jsdom).

/** Compteurs de contexte affichés par la StatusBar pour un projet. */
export interface ContextStats {
  /** Tokens du contexte au dernier relevé ; `null` = taille inconnue (post-compaction). */
  tokens: number | null;
  /** Occupation de la fenêtre en % ; `null` = inconnue (post-compaction). */
  contextPercent: number | null;
  /** Cumul des tokens facturés sur la session (jamais remis à zéro par une compaction). */
  totalTokens: number;
}

/** Valeur d'amorçage quand aucune mesure n'a encore été reçue. */
export const EMPTY_CONTEXT_STATS: ContextStats = {
  tokens: 0,
  contextPercent: 0,
  totalTokens: 0,
};

/** Sous-ensemble de `ContextUsage` du SDK que l'on consomme. */
interface ContextUsageLike {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Replie un `contextUsage` (payload backend/SDK) dans les stats affichées.
 *
 * - `tokens` numérique et `contextWindow > 0` → nouvelle mesure (cas normal,
 *   mise à jour à chaque tour) ;
 * - `tokens: null` (compaction) → `{ tokens: null, contextPercent: null }` :
 *   l'UI doit dire « inconnu » au lieu de garder l'ancienne valeur ;
 * - payload absent/malformé → `prev` inchangé (jamais d'écrasement par du vide).
 *
 * Renvoie `prev` (même référence) quand rien ne change : l'appelant s'en sert
 * pour éviter des re-rendus inutiles.
 */
export function applyContextUsage(
  prev: ContextStats | null | undefined,
  usage: unknown,
): ContextStats | null {
  const current = prev ?? null;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return current;

  const cu = usage as ContextUsageLike;
  const totalTokens = current?.totalTokens ?? 0;

  // Compaction : la taille est INCONNUE jusqu'à la réponse LLM suivante.
  if (cu.tokens === null) {
    if (current && current.tokens === null && current.contextPercent === null) return current;
    return { tokens: null, contextPercent: null, totalTokens };
  }

  // Mesure réelle : on exige une fenêtre exploitable pour le pourcentage.
  if (!isFiniteNumber(cu.tokens) || cu.tokens < 0) return current;
  if (!isFiniteNumber(cu.contextWindow) || cu.contextWindow <= 0) return current;

  const percent = isFiniteNumber(cu.percent)
    ? Math.round(cu.percent)
    : Math.round((cu.tokens / cu.contextWindow) * 100);

  if (current && current.tokens === cu.tokens && current.contextPercent === percent) return current;

  return { tokens: cu.tokens, contextPercent: percent, totalTokens };
}

/** Vrai quand la taille du contexte est connue (mesure réelle disponible). */
export function hasKnownContextSize(stats: ContextStats | null | undefined): stats is ContextStats & { tokens: number; contextPercent: number } {
  return !!stats && isFiniteNumber(stats.tokens) && isFiniteNumber(stats.contextPercent);
}
