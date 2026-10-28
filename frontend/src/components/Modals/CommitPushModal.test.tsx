// @vitest-environment jsdom
/**
 * Tests du CommitPushModal — plus de FAUX SUCCÈS et plus de boucle d'auth :
 *  - un échec de push (GIT_PUSH_REJECTED, GIT_UNREACHABLE, ou l'ancien
 *    `pushResult: "Push failed: …"`) est AFFICHÉ et n'annonce jamais
 *    « Changes pushed successfully » ;
 *  - un push réellement effectué affiche bien le succès ;
 *  - la modale d'identifiants n'est ouverte qu'un nombre BORNÉ de fois
 *    (2) puis on rend la main (erreur + « Réessayer »), et l'enregistrement
 *    des identifiants ne relance PAS le push automatiquement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { CommitPushModal } from "./CommitPushModal";
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
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderModal() {
  return render(
    <I18nProvider>
      <CommitPushModal project={project} onClose={vi.fn()} onDone={vi.fn()} />
    </I18nProvider>
  );
}

/** Remplace la réponse de POST /git/commit-push (le preview reste mocké). */
function mockPushResponse(response: Response | (() => Response)) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/git/commit-push/preview")) return jsonResponse(PREVIEW);
    if (url.endsWith("/git/commit-push")) {
      return typeof response === "function" ? response() : response;
    }
    if (url.endsWith("/git/credentials")) return jsonResponse({ success: true });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function clickPush() {
  const push = await screen.findByText("PUSH");
  fireEvent.click(push);
}

describe("CommitPushModal — plus de faux succès", () => {
  it("push réel → succès affiché", async () => {
    mockPushResponse(
      jsonResponse({ staged: 1, commitResult: "Committed 1 change(s) as abc1234", pushResult: "Pushed 1 ref(s)" })
    );
    renderModal();
    await clickPush();

    expect(await screen.findByText(/Changes pushed successfully/)).toBeTruthy();
  });

  it("push rejeté (non-fast-forward) → message explicite, AUCUN succès annoncé", async () => {
    mockPushResponse(
      jsonResponse(
        {
          error:
            "Push rejected: the remote repository has commits you do not have, and it will not accept this push. Pull first (git pull --rebase origin main), then push again.",
          code: "GIT_PUSH_REJECTED",
        },
        false,
        409
      )
    );
    renderModal();
    await clickPush();

    expect(await screen.findByText(/git pull --rebase origin main/)).toBeTruthy();
    expect(screen.queryByText(/Changes pushed successfully/)).toBeNull();
  });

  it("200 avec `pushResult: \"Push failed: …\"` (ancien faux succès) → traité comme un échec", async () => {
    mockPushResponse(
      jsonResponse({ staged: 1, commitResult: "Committed 1 change(s) as abc1234", pushResult: "Push failed: remote rejected" })
    );
    renderModal();
    await clickPush();

    expect(await screen.findByText(/Push failed: remote rejected/)).toBeTruthy();
    expect(screen.queryByText(/Changes pushed successfully/)).toBeNull();
  });
});

describe("CommitPushModal — borne de la boucle d'identifiants", () => {
  const authRequired = () =>
    jsonResponse({ error: "Git push authentication failed: 403 Bad credentials", code: "GIT_AUTH_REQUIRED" }, false, 401);

  it("2 tentatives maximum, puis erreur + Réessayer ; pas de relance auto après SAVE", async () => {
    mockPushResponse(authRequired);
    renderModal();
    await clickPush();

    // 1re tentative → modale + cause affichée.
    expect(await screen.findByText("GIT AUTHENTICATION REQUIRED")).toBeTruthy();
    // Deux boutons CANCEL coexistent (push + modale d'identifiants) : le
    // dernier rendu est celui de la modale d'identifiants.
    fireEvent.click(screen.getAllByText("CANCEL").at(-1)!);

    // 2e tentative → modale encore ; SAVE n'entraîne AUCUN nouvel appel.
    await clickPush();
    expect(await screen.findByText("GIT AUTHENTICATION REQUIRED")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("your-github-username"), { target: { value: "octocat" } });
    fireEvent.change(screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx"), { target: { value: "fake-token" } });
    fireEvent.click(screen.getByText("SAVE"));

    expect(await screen.findByText("Credentials saved — click PUSH to retry")).toBeTruthy();
    const pushCallsAfterSave = fetchMock.mock.calls.filter(([i]) => String(i).endsWith("/git/commit-push"));
    expect(pushCallsAfterSave).toHaveLength(2);

    // 3e tentative → BLOQUÉE : plus de modale, message + « Réessayer ».
    await clickPush();
    expect(await screen.findByText(/asked 2 times without success/)).toBeTruthy();
    expect(screen.queryByText("GIT AUTHENTICATION REQUIRED")).toBeNull();
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
