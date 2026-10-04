// ── Bandeau « Nouvelle tentative n/N » (C4) — logique PURE ─────────────────
// Le SDK Pi émet `auto_retry_start` / `auto_retry_end` (relayés tels quels par
// le backend, backend/src/pi/session.ts) :
//   start : { attempt, maxAttempts, delayMs, errorMessage }
//   end   : { success, attempt, finalError? }
// `attempt`/`maxAttempts` comptent les REPRISES (settings.retry.maxRetries) ;
// le nombre TOTAL de tentatives du tour = 1 essai initial + maxAttempts.
// D'où l'affichage « Nouvelle tentative 2/4 » pour start {attempt:1,
// maxAttempts:3} — 2e tentative sur 4 au plus.
//
// Module pur (testé) : l'état du bandeau est dérivé des événements, le modèle
// d'affichage (numéro, total, secondes restantes, phase) est calculé au rendu.

import type { PiEvent } from "../types";

export interface RetryBannerState {
  /** Numéro de REPRISE du SDK (1-based) — `attempt` de auto_retry_start. */
  attempt: number;
  /** Nombre max de REPRISES — `maxAttempts` (settings.retry.maxRetries). */
  maxAttempts: number;
  /** Backoff avant la reprise (ms) — `delayMs`. 0 si inconnu. */
  delayMs: number;
  /** Horodatage local de réception (base du compte à rebours). */
  startedAt: number;
}

/**
 * Réducteur d'état du bandeau :
 *  - `auto_retry_start` → bandeau affiché (nouvelle tentative programmée) ;
 *  - `auto_retry_end` → bandeau retiré (succès, échec définitif ou annulation) ;
 *  - `agent_settled` / `session_reloaded` → retiré aussi (filet : si l'event de
 *    fin a été perdu — coupure WS — le run terminé ne laisse pas un bandeau
 *    fantôme) ;
 *  - tout autre event → état inchangé (identité préservée : pas de re-rendu).
 */
export function retryStateFromEvent(
  prev: RetryBannerState | null,
  evt: PiEvent,
  now: number = Date.now(),
): RetryBannerState | null {
  if (evt.type === "auto_retry_start") {
    const attempt = typeof evt.attempt === "number" && evt.attempt > 0 ? Math.floor(evt.attempt) : 1;
    const maxAttempts =
      typeof evt.maxAttempts === "number" && evt.maxAttempts >= attempt
        ? Math.floor(evt.maxAttempts)
        : attempt;
    const delayMs = typeof evt.delayMs === "number" && evt.delayMs >= 0 ? evt.delayMs : 0;
    return { attempt, maxAttempts, delayMs, startedAt: now };
  }
  if (evt.type === "auto_retry_end" || evt.type === "agent_settled" || evt.type === "session_reloaded") {
    return null;
  }
  return prev;
}

export interface RetryBannerModel {
  /** `scheduled` = backoff en cours (compte à rebours) ; `running` = reprise lancée. */
  phase: "scheduled" | "running";
  /** Numéro de TENTATIVE global (essai initial inclus) : attempt + 1. */
  attempt: number;
  /** Nombre TOTAL de tentatives (essai initial inclus) : maxAttempts + 1. */
  total: number;
  /** Secondes restantes avant la reprise (0 si lancée). */
  seconds: number;
}

/** Modèle d'affichage à un instant donné (secondes restantes, phase). */
export function retryBannerModel(state: RetryBannerState, now: number): RetryBannerModel {
  const attempt = state.attempt + 1;
  const total = state.maxAttempts + 1;
  const remainingMs = state.startedAt + state.delayMs - now;
  if (remainingMs <= 0) return { phase: "running", attempt, total, seconds: 0 };
  return { phase: "scheduled", attempt, total, seconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
}
