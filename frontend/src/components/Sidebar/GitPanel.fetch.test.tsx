// @vitest-environment jsdom
/**
 * Vérification du DISTANT dans le panneau Git — le correctif du faux « à jour ».
 *
 * Bug rapporté : « ça me dit que le dossier est à jour ici, alors qu'il y a eu
 * une mise à jour sur GitHub ». Pi-Web ne faisait jamais de `git fetch` : le
 * statut comparait la branche locale au DERNIER `origin/main` connu, donc à une
 * photo périmée.
 *
 * Comportement attendu :
 *  - à l'ouverture du panneau : UN fetch, throttlé (60 s par dépôt), non
 *    bloquant (le statut déjà connu s'affiche immédiatement) ;
 *  - un bouton « Check for updates » qui FORCE, hors throttle, avec un état
 *    visuel pendant l'opération ;
 *  - trois états honnêtes : à jour (fetch récent) / vérifié il y a X (fetch
 *    ancien) / NON VÉRIFIÉ (aucun fetch réussi) — un échec n'affiche JAMAIS
 *    « à jour ».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { GitPanel } from "./GitPanel";
import type { Project } from "../../types";
import { GIT_FETCH_THROTTLE_MS, resetFetchThrottle } from "../../utils/git-verification";

// ── Helpers ─────────────────────────────────────────────

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    storage: "local",
    versioning: "git",
    cwd: `/projects/${name}`,
    git: { remote: `https://github.com/example/${name}.git`, branch: "main", provider: "github", lastSync: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Dépôt propre : la section reste REPLIÉE (seul le badge compact est visible). */
function cleanStatus(overrides: Record<string, unknown> = {}) {
  return {
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    deleted: [],
    created: [],
    conflict: [],
    files: [],
    isClean: true,
    ...overrides,
  };
}

/** Dépôt sale : la section s'AUTO-DÉPLIE (boutons et meta visibles). */
function dirtyStatus() {
  return cleanStatus({
    modified: ["src/a.ts"],
    files: [{ path: "src/a.ts", status: "M" }],
    isClean: false,
  });
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

type FetchAnswer =
  | { kind: "ok"; fetchedAt: string }
  | { kind: "fail"; reason: string }
  | { kind: "pending" };

let fetchMock: ReturnType<typeof vi.fn>;
let statusAnswer: () => unknown;
let fetchAnswer: () => FetchAnswer;
/** Nombre de POST /git/fetch réellement émis. */
let fetchCount: number;

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  sessionStorage.clear();
  // Le throttle d'auto-fetch est une mémoire de MODULE : purge entre les tests.
  resetFetchThrottle();
  statusAnswer = () => cleanStatus();
  fetchAnswer = () => ({ kind: "ok", fetchedAt: new Date().toISOString() });
  fetchCount = 0;
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (/^\/api\/projects\/[^/]+\/git\/fetch$/.test(url)) {
      fetchCount += 1;
      const answer = fetchAnswer();
      if (answer.kind === "pending") return new Promise<Response>(() => {});
      if (answer.kind === "fail") {
        return jsonResponse({ ok: false, reason: answer.reason, fetchedAt: null, lastFetchAt: null, status: null });
      }
      return jsonResponse({
        ok: true,
        fetchedAt: answer.fetchedAt,
        lastFetchAt: answer.fetchedAt,
        status: statusAnswer(),
      });
    }
    if (/^\/api\/projects\/[^/]+\/git\/status$/.test(url)) {
      return jsonResponse(statusAnswer());
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  // ModalDialog (useIsMobile) exige matchMedia sous jsdom.
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  resetFetchThrottle();
});

function renderPanel(project = makeProject("p1", "MainProj")) {
  const on = vi.fn(() => () => {});
  const result = render(
    <I18nProvider>
      <GitPanel project={project} linkedProjects={[]} onRefresh={vi.fn()} on={on as any} />
    </I18nProvider>
  );
  return { ...result, project };
}

// ── Auto-fetch à l'ouverture ────────────────────────────

describe("GitPanel — fetch du distant à l'ouverture (throttlé, non bloquant)", () => {
  it("un fetch est déclenché à l'ouverture du panneau (et un SEUL)", async () => {
    renderPanel();

    await waitFor(() => expect(fetchCount).toBe(1));
    // Le statut local est chargé en parallèle : les deux requêtes partent.
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/git/status"))).toBe(true);
  });

  it("un second affichage dans les 60 s ne relance PAS de fetch (throttle par dépôt)", async () => {
    const first = renderPanel();
    await waitFor(() => expect(fetchCount).toBe(1));

    // Repli/dépliage puis remontage complet (changement de projet, navigation…).
    first.unmount();
    renderPanel();

    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(fetchCount).toBe(1);
  });

  it("le statut CONNU s'affiche immédiatement, sans attendre la fin du fetch", async () => {
    // Le fetch ne répond JAMAIS : l'affichage ne doit pas en dépendre.
    statusAnswer = () => dirtyStatus();
    fetchAnswer = () => ({ kind: "pending" });
    renderPanel();

    // Détail de la section (bouton Pull) rendu alors que le fetch est en vol.
    expect(await screen.findByText("Pull")).toBeTruthy();
    expect(fetchCount).toBe(1);
  });

  it("état visuel pendant l'opération (bouton désactivé + libellé de vérification)", async () => {
    statusAnswer = () => dirtyStatus();
    fetchAnswer = () => ({ kind: "pending" });
    renderPanel();

    const button = await screen.findByTestId("git-verify-remote");
    await waitFor(() => expect(button.textContent).toContain("Checking"));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── Bouton « Vérifier les mises à jour » ────────────────

describe("GitPanel — bouton « Check for updates »", () => {
  it("force un fetch OUTRE le throttle", async () => {
    statusAnswer = () => dirtyStatus();
    renderPanel();
    await waitFor(() => expect(fetchCount).toBe(1));

    // Moins de 60 s après le fetch automatique : le throttle interdirait un
    // nouvel AUTO-fetch, mais le bouton doit passer outre.
    expect(GIT_FETCH_THROTTLE_MS).toBe(60_000);
    const button = await screen.findByTestId("git-verify-remote");
    await act(async () => {
      fireEvent.click(button);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    await waitFor(() => expect(fetchCount).toBe(2));
  });
});

// ── Honnêteté du badge : trois états ────────────────────

describe("GitPanel — badge honnête (à jour / vérifié il y a X / non vérifié)", () => {
  it("fetch réussi et récent → « à jour »", async () => {
    renderPanel();

    const badge = await screen.findByTestId("git-verify-badge");
    expect(badge.getAttribute("data-verification")).toBe("fresh");
    expect(badge.getAttribute("title")).toBe("Up to date");
    expect(screen.queryByText("Not verified")).toBeNull();
  });

  it("ÉCHEC du fetch → « non vérifié », et JAMAIS « à jour »", async () => {
    fetchAnswer = () => ({ kind: "fail", reason: "network" });

    renderPanel();

    const badge = await screen.findByTestId("git-verify-badge");
    expect(badge.getAttribute("data-verification")).toBe("unverified");
    // ⚠️ Le cœur du bug : rien ne doit prétendre « à jour ».
    expect(screen.queryByTitle("Up to date")).toBeNull();
    expect(screen.queryByText("Up to date")).toBeNull();
    // La raison est traduite, jamais un code brut.
    expect(badge.getAttribute("title")).toContain("remote unreachable");
  });

  it("fetch ancien (dernier succès il y a 30 min) → « vérifié il y a X », pas « à jour »", async () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    // Le statut porte le dernier fetch réussi : l'UI le sait AVANT de refetcher
    // (le savoir survit donc à un rechargement de page).
    statusAnswer = () => cleanStatus({ lastFetchAt: thirtyMinAgo });
    // L'auto-fetch échoue : la photo reste celle d'il y a 30 min.
    fetchAnswer = () => ({ kind: "fail", reason: "timeout" });

    renderPanel();

    const badge = await screen.findByTestId("git-verify-badge");
    expect(badge.getAttribute("data-verification")).toBe("stale");
    expect(screen.queryByTitle("Up to date")).toBeNull();
  });

  it("jamais vérifié (aucun fetch réussi) → « non vérifié » dès le premier rendu", async () => {
    fetchAnswer = () => ({ kind: "fail", reason: "no_remote" });

    renderPanel();

    const badge = await screen.findByTestId("git-verify-badge");
    expect(badge.getAttribute("data-verification")).toBe("unverified");
    expect(screen.queryByTitle("Up to date")).toBeNull();
  });

  it("un fetch réussi APRÈS un échec repasse à « à jour »", async () => {
    statusAnswer = () => dirtyStatus();
    fetchAnswer = () => ({ kind: "fail", reason: "network" });
    renderPanel();
    // Section dépliée (dirty) : l'état est porté par la ligne de vérification.
    await screen.findByTestId("git-verify-unverified");

    fetchAnswer = () => ({ kind: "ok", fetchedAt: new Date().toISOString() });
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-verify-remote"));
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    expect(await screen.findByTestId("git-verify-fresh")).toBeTruthy();
    expect(screen.queryByTestId("git-verify-unverified")).toBeNull();
  });
});
