// ── Tests : état + modèle du bandeau de reprise (C4) ───────────────────────
import { describe, expect, it } from "vitest";
import { retryBannerModel, retryStateFromEvent, type RetryBannerState } from "./retry-banner";

const T0 = 1_000_000;

describe("retryStateFromEvent", () => {
  it("auto_retry_start → bandeau affiché (essai conservé tel quel)", () => {
    const state = retryStateFromEvent(null, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "500: boom",
    }, T0);
    expect(state).toEqual({ attempt: 1, maxAttempts: 3, delayMs: 2000, startedAt: T0 });
  });

  it("auto_retry_end → bandeau retiré (succès comme échec définitif)", () => {
    const shown: RetryBannerState = { attempt: 2, maxAttempts: 3, delayMs: 4000, startedAt: T0 };
    expect(retryStateFromEvent(shown, { type: "auto_retry_end", success: true, attempt: 2 }, T0 + 4000)).toBeNull();
    expect(retryStateFromEvent(shown, { type: "auto_retry_end", success: false, attempt: 3, finalError: "boom" }, T0 + 4000)).toBeNull();
  });

  it("agent_settled / session_reloaded → filet anti-bandeau fantôme", () => {
    const shown: RetryBannerState = { attempt: 1, maxAttempts: 3, delayMs: 2000, startedAt: T0 };
    expect(retryStateFromEvent(shown, { type: "agent_settled" })).toBeNull();
    expect(retryStateFromEvent(shown, { type: "session_reloaded" })).toBeNull();
  });

  it("autres événements → état inchangé (identité préservée)", () => {
    const shown: RetryBannerState = { attempt: 1, maxAttempts: 3, delayMs: 2000, startedAt: T0 };
    expect(retryStateFromEvent(shown, { type: "message_update" })).toBe(shown);
    expect(retryStateFromEvent(null, { type: "message_update" })).toBeNull();
  });

  it("champs manquants ou incohérents → valeurs de repli sûres", () => {
    expect(retryStateFromEvent(null, { type: "auto_retry_start" }, T0)).toEqual({
      attempt: 1, maxAttempts: 1, delayMs: 0, startedAt: T0,
    });
    expect(retryStateFromEvent(null, { type: "auto_retry_start", attempt: 2, maxAttempts: 1, delayMs: -5 }, T0))
      .toEqual({ attempt: 2, maxAttempts: 2, delayMs: 0, startedAt: T0 });
  });
});

describe("retryBannerModel", () => {
  const state: RetryBannerState = { attempt: 1, maxAttempts: 3, delayMs: 4000, startedAt: T0 };

  it("numérote la TENTATIVE globale (essai initial inclus) : 2/4, pas 1/3", () => {
    const m = retryBannerModel(state, T0);
    expect(m.attempt).toBe(2);
    expect(m.total).toBe(4);
  });

  it("compte à rebours par secondes (arrondi supérieur, jamais 0 en attente)", () => {
    expect(retryBannerModel(state, T0).seconds).toBe(4);
    expect(retryBannerModel(state, T0 + 1000).seconds).toBe(3);
    expect(retryBannerModel(state, T0 + 3999).seconds).toBe(1);
  });

  it("backoff écoulé → phase running, 0 seconde", () => {
    expect(retryBannerModel(state, T0 + 4000)).toEqual({ phase: "running", attempt: 2, total: 4, seconds: 0 });
    expect(retryBannerModel(state, T0 + 10_000).phase).toBe("running");
  });

  it("delayMs 0 (inconnu) → directement running « en cours »", () => {
    const m = retryBannerModel({ ...state, delayMs: 0 }, T0);
    expect(m).toEqual({ phase: "running", attempt: 2, total: 4, seconds: 0 });
  });
});
