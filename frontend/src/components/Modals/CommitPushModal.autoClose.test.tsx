// @vitest-environment jsdom
/**
 * Fermeture NATURELLE de la modale de commit/push après un succès.
 *
 * Avant : `GitPanel` fermait la fenêtre au bout de 1,2 s fixes
 * (`setTimeout(..., 1200)`), sans laisser le temps de lire la confirmation et
 * sans possibilité de l'empêcher.
 *
 * Désormais (CommitPushModal + hooks/useAutoClose) :
 *  - après un succès CONFIRMÉ, la modale reste affichée pendant
 *    COMMIT_PUSH_CLOSE_DELAY_MS puis se ferme en fondu ;
 *  - un survol / déplacement de souris pendant le compte à rebours ANNULE la
 *    fermeture (la modale reste ouverte, bouton « Fermer » à disposition) ;
 *  - Échap ferme immédiatement ;
 *  - en cas d'échec, RIEN ne se ferme (non-régression).
 *
 * Aucun réseau : `fetch` est entièrement moqué. Horloge simulée (`vi.useFakeTimers`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import {
  CommitPushModal,
  COMMIT_PUSH_CLOSE_DELAY_MS,
  COMMIT_PUSH_CLOSE_FADE_MS,
} from "./CommitPushModal";
import type { Project } from "../../types";

const project = {
  id: "p1",
  name: "MainProj",
  storage: "local",
  versioning: "git",
  cwd: "/projects/MainProj",
  git: { remote: "https://github.com/example/MainProj.git", branch: "main", provider: "github", lastSync: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Project;

const PREVIEW = {
  status: {
    staged: [],
    modified: ["src/a.ts"],
    deleted: [],
    created: [],
    files: [{ path: "src/a.ts", status: "M" }],
    isClean: false,
    ahead: 0,
    behind: 0,
  },
  proposedMessage: { subject: "Update src: a.ts", body: "" },
};

const PUSH_OK = { staged: 1, commitResult: "Committed 1 change(s) as abc1234", pushResult: "Pushed 1 ref(s)" };

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/git/commit-push/preview")) return jsonResponse(PREVIEW);
    if (url.endsWith("/git/commit-push")) return jsonResponse(PUSH_OK);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderModal(onClose = vi.fn(), onDone = vi.fn()) {
  const utils = render(
    <I18nProvider>
      <CommitPushModal project={project} onClose={onClose} onDone={onDone} />
    </I18nProvider>
  );
  return { ...utils, onClose, onDone };
}

/**
 * Active l'horloge simulée en laissant le temps réel s'écouler
 * (`shouldAdvanceTime`) : les utilitaires `findBy*` de Testing Library
 * continuent de fonctionner, et les `setTimeout` ARMÉS DANS LA FOULÉE sont bien
 * simulés, donc pilotables par `advanceTimersByTime`.
 */
function useControllableTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}

/** Clique PUSH et attend la confirmation de succès. */
async function clickPush() {
  fireEvent.click(await screen.findByText("PUSH"));
  await screen.findByText(/Changes pushed successfully/);
}

describe("CommitPushModal — fermeture naturelle après succès", () => {
  it("reste visible pendant le délai, puis se ferme", async () => {
    useControllableTimers();
    const { onClose, onDone } = renderModal();
    await clickPush();

    // Le message de succès est affiché ET onDone (rafraîchissement git) est parti.
    expect(screen.getByText(/Changes pushed successfully/)).toBeTruthy();
    expect(onDone).toHaveBeenCalledTimes(1);

    // Après le délai, la modale entre en fondu — mais elle est ENCORE montée.
    act(() => {
      vi.advanceTimersByTime(COMMIT_PUSH_CLOSE_DELAY_MS + 40);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Changes pushed successfully/)).toBeTruthy();
    expect(document.querySelector(".modal-closing")).not.toBeNull();

    // Fondu de sortie écoulé : fermeture, une seule fois.
    act(() => {
      vi.advanceTimersByTime(COMMIT_PUSH_CLOSE_FADE_MS + 100);
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Aucune fermeture supplémentaire ensuite (minuterie désarmée).
    act(() => {
      vi.advanceTimersByTime(COMMIT_PUSH_CLOSE_DELAY_MS * 2);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("un survol pendant le compte à rebours ANNULE la fermeture", async () => {
    useControllableTimers();
    const { onClose } = renderModal();
    await clickPush();

    // Mouvement de souris sur la fenêtre pendant le compte à rebours.
    act(() => {
      fireEvent.mouseMove(screen.getByRole("dialog"), { clientX: 10, clientY: 10 });
    });

    // Même bien après le délai, la modale est TOUJOURS ouverte.
    act(() => {
      vi.advanceTimersByTime(COMMIT_PUSH_CLOSE_DELAY_MS + 3000);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Changes pushed successfully/)).toBeTruthy();
    // L'utilisateur garde la main : bouton « Fermer » disponible.
    expect(screen.getByText("Close")).toBeTruthy();
  });

  it("Échap ferme immédiatement", async () => {
    useControllableTimers();
    const { onClose } = renderModal();
    await clickPush();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Un seul appel : le compte à rebours a bien été désarmé.
    act(() => {
      vi.advanceTimersByTime(COMMIT_PUSH_CLOSE_DELAY_MS + 3000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("le bouton « Fermer » du message de succès ferme la fenêtre", async () => {
    useControllableTimers();
    const { onClose } = renderModal();
    await clickPush();

    act(() => {
      fireEvent.click(screen.getByText("Close"));
    });
    // Fermeture après le fondu de sortie.
    act(() => {
      vi.advanceTimersByTime(COMMIT_PUSH_CLOSE_FADE_MS + 100);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ÉCHEC du push (non-fast-forward) → la modale RESTE ouverte", async () => {
    useControllableTimers();
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/git/commit-push/preview")) return jsonResponse(PREVIEW);
      if (url.endsWith("/git/commit-push")) {
        return jsonResponse(
          { error: "Push rejected: the remote has commits you do not have", code: "GIT_PUSH_REJECTED" },
          false,
          409
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { onClose, onDone } = renderModal();
    fireEvent.click(await screen.findByText("PUSH"));
    expect(await screen.findByText(/Push rejected/)).toBeTruthy();

    // Même après trois fois le délai d'auto-fermeture : rien ne se ferme.
    act(() => {
      vi.advanceTimersByTime(COMMIT_PUSH_CLOSE_DELAY_MS * 3);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByText(/Changes pushed successfully/)).toBeNull();
  });
});
