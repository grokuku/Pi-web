// ── Honnêteté du badge git : « à jour » n'est vrai que si on a VÉRIFIÉ ───────
// Contexte (bug rapporté) : le panneau annonçait « à jour » alors que le dossier
// avait bougé sur GitHub. `git status` compare la branche locale au DERNIER
// `origin/main` CONNU (refs distantes), qui ne bouge qu'à un `git fetch` — que
// Pi-Web ne faisait jamais. « À jour » signifiait donc « rien à récupérer selon
// une photo périmée ».
//
// Correctif : on déclenche un fetch à l'ouverture (throttlé, non bloquant) et on
// n'affiche « à jour » que si ce fetch est RÉCENT. Sinon : « vérifié il y a X »
// (photo datée, honnête) ou « non vérifié » (aucun fetch réussi — l'échec ne
// doit JAMAIS se traduire par « à jour »).

/** Fenêtre anti-rafale de l'auto-fetch : un fetch au plus toutes les 60 s par dépôt. */
export const GIT_FETCH_THROTTLE_MS = 60_000;

/**
 * Durée pendant laquelle un fetch compte comme « récent » (badge « à jour »).
 * Au-delà, on n'affirme plus rien sur le présent : le badge date la photo
 * (« vérifié il y a X »). Le fetch automatique reprend à la prochaine ouverture.
 */
export const GIT_VERIFICATION_FRESH_MS = 5 * 60_000;

/**
 * Dernière TENTATIVE d'auto-fetch, par dépôt (projectId).
 *
 * Mémoire de MODULE, pas d'état de composant : le throttle doit tenir même si
 * la section est démontée/remontée (repli/dépliage, changement de projet), et
 * il est enregistré pour une tentative comme pour un échec — sinon un dépôt
 * hors ligne serait re-testé à chaque rendu.
 */
const lastAttemptByKey = new Map<string, number>();

/** true si l'auto-fetch peut se déclencher maintenant pour ce dépôt. */
export function shouldAutoFetch(key: string, now: number = Date.now()): boolean {
  const last = lastAttemptByKey.get(key);
  if (last === undefined) return true;
  return now - last >= GIT_FETCH_THROTTLE_MS;
}

/** Enregistre une tentative d'auto-fetch (succès OU échec : le throttle tient). */
export function markFetchAttempt(key: string, now: number = Date.now()): void {
  lastAttemptByKey.set(key, now);
}

/** Purge le throttle (tests uniquement — jamais appelé par l'UI). */
export function resetFetchThrottle(): void {
  lastAttemptByKey.clear();
}

/**
 * État de VÉRIFICATION affichable, jamais déduit d'autre chose :
 *  - `unverified` : aucun fetch réussi connu → on n'affirme RIEN ;
 *  - `fresh`      : fetch réussi récent → « à jour » est une affirmation valide ;
 *  - `stale`      : fetch réussi mais ancien → « vérifié il y a X ».
 */
export type VerificationState = "unverified" | "fresh" | "stale";

export function verificationState(
  lastFetchAt: string | null | undefined,
  now: number = Date.now()
): VerificationState {
  if (!lastFetchAt) return "unverified";
  const ts = new Date(lastFetchAt).getTime();
  // Horodatage illisible / dans le futur : on ne prétend pas avoir vérifié.
  if (!Number.isFinite(ts) || ts > now + GIT_FETCH_THROTTLE_MS) return "unverified";
  return now - ts < GIT_VERIFICATION_FRESH_MS ? "fresh" : "stale";
}

/**
 * État affiché en tenant compte de la DERNIÈRE TENTATIVE :
 * un fetch qui vient d'échouer ne permet JAMAIS de dire « à jour » (c'était le
 * mensonge d'origine). S'il existe un succès antérieur, on date la photo
 * (« vérifié il y a X ») ; sinon on dit « non vérifié ».
 */
export function badgeState(
  lastFetchAt: string | null | undefined,
  lastAttemptFailed: boolean,
  now: number = Date.now()
): VerificationState {
  if (lastAttemptFailed) return lastFetchAt ? "stale" : "unverified";
  return verificationState(lastFetchAt, now);
}

/** Raisons d'échec renvoyées par `POST /api/projects/:id/git/fetch`. */
export type FetchFailureReason = "no_remote" | "auth" | "network" | "timeout" | "error";

/** Résultat structuré de la route de fetch (`ok:false` n'est pas une erreur HTTP). */
export interface GitFetchResponse {
  ok: boolean;
  reason?: FetchFailureReason;
  message?: string;
  fetchedAt: string | null;
  lastFetchAt: string | null;
  status?: unknown;
  host?: string | null;
  hasCredentials?: boolean;
}

/** true si la réponse est exploitable comme un fetch RÉUSSI daté. */
export function isSuccessfulFetch(data: unknown): data is GitFetchResponse & { fetchedAt: string } {
  const d = data as GitFetchResponse | null | undefined;
  return !!d && d.ok === true && typeof d.fetchedAt === "string" && d.fetchedAt.length > 0;
}
