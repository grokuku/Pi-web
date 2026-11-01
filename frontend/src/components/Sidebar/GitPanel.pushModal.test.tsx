// @vitest-environment jsdom
/**
 * La fenêtre « PUSH TO REMOTE » ne doit JAMAIS s'ouvrir sans action explicite.
 *
 * Bug observé : la fenêtre de commit/push réapparaissait « toute seule », de
 * temps en temps. Mécanisme (aucun clic en cause) :
 *  1. l'utilisateur ouvre la modale (clic « Push ») et la laisse ouverte
 *     (échec affiché, ou fermeture douce annulée au survol) ;
 *  2. le contenu de la section n'est rendu que DÉPLIÉ (`if (!isOpen) return
 *     <>{header}</>`) — un rafraîchissement de fond (polling 30 s, pi_event de
 *     fin d'activité, retour au premier plan) fait passer le statut de dirty à
 *     clean → la section se REPLIE → la modale est démontée, mais son état
 *     `showPushModal` restait à `true` ;
 *  3. un rafraîchissement ultérieur repasse dirty → AUTO-DÉPLOIEMENT → la
 *     modale était rendue de nouveau, sans le moindre geste utilisateur.
 *
 * Ces tests verrouillent les deux invariants :
 *  - un changement de statut de fond n'ouvre jamais la modale ;
 *  - aucun état d'ouverture ne survit au repli de la section.
 *
 * Aucun réseau : `fetch` est entièrement moqué.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { GitPanel } from "./GitPanel";
import type { Project } from "../../types";

// ── Fixtures ────────────────────────────────────────────

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    storage: "local",
    versioning: "git",
    cwd: `/projects/${name}`,
    git: {
      remote: `https://github.com/example/${name}.git`,
      branch: "main",
      provider: "github",
      lastSync: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Project;
}

function statusWith(clean: boolean) {
  return {
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: [],
    modified: clean ? [] : ["src/a.ts"],
    deleted: [],
    created: [],
    conflict: [],
    files: clean ? [] : [{ path: "src/a.ts", status: "M" }],
    isClean: clean,
  };
}

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

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

// ── Harnais ─────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
/** Statut renvoyé par /git/status pour le projet p1. */
let currentStatus: ReturnType<typeof statusWith>;

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  sessionStorage.clear();
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

  currentStatus = statusWith(false); // dirty → section dépliée d'office

  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/git/status")) return jsonResponse(currentStatus);
    if (url.endsWith("/git/commit-push/preview")) return jsonResponse(PREVIEW);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function renderPanel() {
  const handlers = new Map<string, (msg: any) => void>();
  const on = vi.fn((type: string, cb: (msg: any) => void) => {
    handlers.set(type, cb);
    return () => {
      handlers.delete(type);
    };
  });
  render(
    <I18nProvider>
      <GitPanel project={makeProject("p1", "MainProj")} linkedProjects={[]} onRefresh={vi.fn()} on={on as any} />
    </I18nProvider>
  );
  return { emitPiEvent: (msg: any) => handlers.get("pi_event")?.(msg) };
}

// RTL ne détecte pas les fake timers de Vitest : on flush les microtasks à la main.
async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

/** Laisse passer le dé-bounce des rafales de pi_event (REFRESH_COALESCE_MS). */
async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

const modalIsOpen = () => screen.queryByText("PUSH TO REMOTE") !== null;

/**
 * Ouvre la modale par le SEUL chemin légitime : le clic sur « Push ».
 * ⚠️ Sous fake timers, les helpers `findBy*`/`waitFor` de RTL ne se résolvent
 * pas (aucun `jest` global à détecter) : on flushe les microtasks à la main.
 */
async function openPushModalByClick() {
  await flushMicrotasks(); // seed /git/status → auto-dépliage (dirty)
  fireEvent.click(screen.getByTitle("Stage all → commit → push"));
  await flushMicrotasks(); // fetch /git/commit-push/preview + état de la modale
  expect(screen.getByText("PUSH TO REMOTE")).toBeTruthy();
}

// ── Tests ───────────────────────────────────────────────

describe("GitPanel — la modale push ne s'ouvre jamais sans action utilisateur", () => {
  it("un changement de statut de fond (dirty → clean → dirty) n'ouvre PAS la modale", async () => {
    vi.useFakeTimers();
    const { emitPiEvent } = renderPanel();
    await flushMicrotasks();
    // Section dépliée d'office (dirty) : le bouton Push est là, modale fermée.
    expect(screen.getByTitle("Stage all → commit → push")).toBeTruthy();
    expect(modalIsOpen()).toBe(false);

    // Rafraîchissements de fond successifs, AUCUN clic.
    currentStatus = statusWith(true);
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "agent_settled" } });
    });
    await advanceTimers(1500);

    currentStatus = statusWith(false);
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "turn_end" } });
    });
    await advanceTimers(1500);

    expect(modalIsOpen()).toBe(false);
  });

  it("aucun état d'ouverture ne survit au repli : la modale ne RÉAPPARAÎT pas à l'auto-dépliage suivant", async () => {
    vi.useFakeTimers();
    const { emitPiEvent } = renderPanel();
    await openPushModalByClick();

    // 1) Le statut devient CLEAN en arrière-plan → la section se replie toute
    //    seule (auto-dépliage = !isClean) et la modale est démontée.
    currentStatus = statusWith(true);
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "agent_settled" } });
    });
    await advanceTimers(1500);
    expect(screen.queryByText("PUSH TO REMOTE")).toBeNull();

    // 2) Le statut redevient DIRTY en arrière-plan → AUTO-DÉPLOIEMENT.
    currentStatus = statusWith(false);
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "turn_end" } });
    });
    await advanceTimers(1500);

    // La section est bien de nouveau dépliée…
    expect(screen.getByTitle("Stage all → commit → push")).toBeTruthy();
    // …mais la modale, elle, ne doit PAS revenir : aucun clic n'a eu lieu.
    expect(modalIsOpen()).toBe(false);
  });

  it("le clic sur « Push » ouvre toujours la modale (chemin explicite intact)", async () => {
    vi.useFakeTimers();
    renderPanel();
    await openPushModalByClick();
    expect(modalIsOpen()).toBe(true);
  });

  it("la modale reste fermée quand la section est repliée par l'utilisateur", async () => {
    vi.useFakeTimers();
    renderPanel();
    await flushMicrotasks();
    expect(screen.getByTitle("Stage all → commit → push")).toBeTruthy();

    // Repli manuel puis dépli manuel : toujours aucune modale.
    fireEvent.click(screen.getByTitle("Collapse section"));
    await flushMicrotasks();
    expect(screen.queryByText("Pull")).toBeNull();
    fireEvent.click(screen.getByTitle("Expand section"));
    await flushMicrotasks();

    expect(modalIsOpen()).toBe(false);
  });
});
