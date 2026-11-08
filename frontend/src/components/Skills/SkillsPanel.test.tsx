// @vitest-environment jsdom
/**
 * F19 — `setTimeout` sans `clearTimeout` au démontage.
 * SkillsPanel et SettingsModal armaient un timer de 3 s (retour à l'état initial
 * du statut « rechargé ») sans jamais le nettoyer : au démontage de la modale /
 * du panneau, le timer firait sur un composant disparu.
 * Le timer doit être stocké dans un ref et nettoyé à l'unmount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { SkillsPanel } from "./SkillsPanel";

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === "/api/pi/reload") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ success: true }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

describe("SkillsPanel — timer de statut nettoyé au démontage (F19)", () => {
  it("le setTimeout de retour à « idle » est annulé à l'unmount (aucun timer en attente)", async () => {
    const { unmount } = render(
      <I18nProvider>
        <SkillsPanel activeProjectId="p1" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId("skills-reload-session"));
    await flush();

    // Le rechargement a réussi : un timer de 3 s est armé (retour à « idle »).
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    // Sans le clearTimeout, le timer survivrait au démontage.
    expect(vi.getTimerCount()).toBe(0);
  });
});
