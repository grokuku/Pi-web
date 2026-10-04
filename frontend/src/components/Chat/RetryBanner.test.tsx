// @vitest-environment jsdom
// ── Bandeau « Nouvelle tentative n/N » (C4) : apparition / disparition ─────
// Le backend relaie déjà auto_retry_start/auto_retry_end (session.ts) ; le
// bandeau est rendu par ChatView pendant le backoff, avec compte à rebours.
// Ces tests couvrent le texte affiché, la transition compte à rebours → en
// cours, et la disparition quand l'état repasse à null (auto_retry_end).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { RetryBanner } from "./RetryBanner";
import type { RetryBannerState } from "../../utils/retry-banner";

function renderBanner(state: RetryBannerState | null) {
  return render(
    <I18nProvider>
      {state ? <RetryBanner state={state} /> : <div data-testid="no-banner" />}
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RetryBanner", () => {
  it("apparaît avec « Retrying 2/4 in 4s… » (attempt SDK 1 → tentative 2/4)", () => {
    renderBanner({ attempt: 1, maxAttempts: 3, delayMs: 4000, startedAt: Date.now() });
    expect(screen.getByText("Retrying 2/4 in 4s…")).toBeTruthy();
  });

  it("le compte à rebours décroît puis bascule en « Attempt 2/4 in progress… »", () => {
    const startedAt = Date.now();
    renderBanner({ attempt: 1, maxAttempts: 3, delayMs: 4000, startedAt });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText("Retrying 2/4 in 2s…")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2500); });
    expect(screen.getByText("Attempt 2/4 in progress…")).toBeTruthy();
    expect(screen.queryByText(/Retrying/)).toBeNull();
  });

  it("délai indisponible (0) → « Attempt 2/4 in progress… » immédiatement", () => {
    renderBanner({ attempt: 1, maxAttempts: 3, delayMs: 0, startedAt: Date.now() });
    expect(screen.getByText("Attempt 2/4 in progress…")).toBeTruthy();
  });

  it("disparaît quand l'état repasse à null (auto_retry_end)", () => {
    const view = renderBanner({ attempt: 2, maxAttempts: 3, delayMs: 4000, startedAt: Date.now() });
    expect(screen.getByText("Retrying 3/4 in 4s…")).toBeTruthy();
    view.rerender(
      <I18nProvider>
        <div data-testid="no-banner" />
      </I18nProvider>,
    );
    expect(screen.queryByText(/Retrying|in progress/)).toBeNull();
    expect(screen.getByTestId("no-banner")).toBeTruthy();
  });
});
