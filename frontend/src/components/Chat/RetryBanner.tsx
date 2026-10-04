// ── Bandeau « Nouvelle tentative n/N » (C4) ────────────────────────────────
// Discret, en haut du composer : le SDK Pi relance automatiquement un tour sur
// erreur transitoire (5xx/overloaded/rate-limit). Sans cet indicateur, l'écran
// restait muet pendant le backoff (2 s → 4 s → 8 s) et l'utilisateur croyait à
// un blocage. Le bandeau disparaît dès `auto_retry_end` (succès, échec définitif
// ou annulation) — l'état est piloté par ChatView (retryStateFromEvent), ce
// composant ne fait qu'afficher le compte à rebours.
//
// Forme des événements (SDK 0.87.1, vérifiée dans agent-session.d.ts) :
//   auto_retry_start : { attempt, maxAttempts, delayMs, errorMessage }
// `attempt`/`maxAttempts` = numéro de REPRISE ; le total TENTATIVES = +1 (essai
// initial), d'où « Nouvelle tentative 2/4 » pour { attempt: 1, maxAttempts: 3 }.

import { memo, useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import { retryBannerModel, type RetryBannerState } from "../../utils/retry-banner";

export const RetryBanner = memo(function RetryBanner({ state }: { state: RetryBannerState }) {
  const { t } = useTranslation();
  // Tick local pour le compte à rebours (500 ms : affichage en secondes).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const model = retryBannerModel(state, now);
  const text =
    model.phase === "scheduled"
      ? t("chat.retryScheduled", model.attempt, model.total, model.seconds)
      : t("chat.retryInProgress", model.attempt, model.total);

  return (
    <div className="shrink-0 mx-4 mb-2 flex items-center gap-2 text-xs text-hacker-warn border border-hacker-warn/30 bg-hacker-warn/5 rounded px-2 py-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-hacker-warn animate-pulse shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
});
