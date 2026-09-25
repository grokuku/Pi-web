/**
 * harness-abort.ts — Distinction ABORT UTILISATEUR vs ABORT INTERNE, et
 * neutralisation des rejets de promesses perdantes d'une course (P2/P3).
 *
 * Contexte (bug « délégations coupées ») :
 * - P2 — un abort INTERNE (timeout de session, shutdown/disposeAllSessions,
 *   switchMode, reloadModelRegistry) était étiqueté « abort-utilisateur »
 *   parce que le message d'erreur contenait le mot « abort ». Cette étiquette
 *   ne doit être posée que sur PREUVE d'un abandon utilisateur explicite
 *   (marqueur backend `harnessAborted`, cf. session.ts/abortPi).
 * - P3 — les promesses PERDANTES de `Promise.race` (timeout d'inactivité,
 *   timeout global, abort signal) pouvaient rejeter hors course et remonter en
 *   `unhandledRejection` → le handler de backend/src/index.ts tuait alors le
 *   process (`process.exit(1)`). Aucun rejet attendu ne doit plus l'atteindre.
 *
 * Module PUR (aucun effet de bord hors helpers de course, testés dans
 * harness-abort.test.ts). Il vit dans backend/src/pi/ (comme harness-archive)
 * pour rester scanné par vitest et être importé par l'extension
 * harness-orchestrator via jiti (chemin relatif résolu au chargement).
 */

/** Causes d'abandon d'une délégation. */
export type HarnessAbortCause = "abort-utilisateur" | "abort-session";

/** Message d'une interruption par action utilisateur explicite. */
export const ABORT_USER_MESSAGE =
  "Délégation interrompue par l'utilisateur (abort de l'orchestrator)";

/** Message d'une interruption interne (timeout de session, shutdown…). */
export const ABORT_SESSION_MESSAGE = "Délégation interrompue (abort de session)";

/**
 * Préfixe STABLE commun à toutes les interruptions de délégation. Sert à
 * reconnaître une interruption quel que soit son motif (l'ancien code testait
 * la sous-chaîne « abort de l'orchestrator », ce qui ratait / confondait les
 * motifs).
 */
export const ABORT_MESSAGE_MARKER = "Délégation interrompue";

/** Le message décrit-il une interruption de délégation ? */
export function isAbortInterruption(message: string): boolean {
  return String(message || "").includes(ABORT_MESSAGE_MARKER);
}

/**
 * Étiquette une interruption : « abort-utilisateur » UNIQUEMENT si l'appelant
 * a prouvé un abandon utilisateur ; sinon « abort-session » (abort interne).
 * Prudence par défaut : jamais de faux « abort-utilisateur ».
 */
export function resolveAbortCause(userInitiated: boolean): HarnessAbortCause {
  return userInitiated ? "abort-utilisateur" : "abort-session";
}

/** Message associé à la cause d'abandon. */
export function abortMessageFor(cause: HarnessAbortCause): string {
  return cause === "abort-utilisateur" ? ABORT_USER_MESSAGE : ABORT_SESSION_MESSAGE;
}

/**
 * Neutralise le rejet d'une promesse PERDANTE de `Promise.race`.
 *
 * La promesse d'origine reste dans la course (ce `.catch` séparé ne consomme
 * pas son rejet du point de vue de `race`) ; un rejet tardif — après la fin de
 * la course — ne peut donc plus remonter en `unhandledRejection`, ce qui tuait
 * le backend (handler `unhandledRejection` → `process.exit(1)`).
 */
export function swallowRejection(promise: Promise<unknown>): void {
  promise.catch(() => {});
}

/**
 * Garde de course : les callbacks de timer ne doivent JAMAIS rejeter après la
 * fin de la course. `guard(fn)` n'exécute `fn` que tant que `finish()` n'a pas
 * été appelé ; `finish()` marque la course terminée (à appeler en `finally`,
 * AVANT le `clearTimeout`).
 */
export interface RaceGuard {
  readonly finished: boolean;
  guard(fn: () => void): void;
  finish(): void;
}

export function createRaceGuard(): RaceGuard {
  let finished = false;
  return {
    get finished() {
      return finished;
    },
    guard(fn: () => void) {
      if (!finished) fn();
    },
    finish() {
      finished = true;
    },
  };
}
