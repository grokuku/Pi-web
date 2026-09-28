// @vitest-environment jsdom
/**
 * Tests du GitPanel — rafraîchissement TEMPS RÉEL et FIABLE du statut git :
 *  - seed : dirty → section dépliée + badge, clean → repliée ;
 *  - pi_event de fin d'activité (turn_end / agent_end / agent_settled) →
 *    refetch du projet principal ET des sous-projets LIÉS, avec dé-bounce
 *    (plusieurs événements rapprochés = UN seul refetch) ; un workspace LIÉ est
 *    une session sur le PLACEHOLDER : le filtre vise son id, pas celui des
 *    sous-projets ;
 *  - échec du seed : pas d'auto-dépliage, indicateur d'erreur visible même
 *    replié, retry au prochain événement ;
 *  - override manuel : purgé au changement de catégorie (dirty↔clean) et
 *    « replié » non persisté (ne survit pas à un F5) ;
 *  - spinner ⟳ : reflète un vrai chargement, pas une rotation permanente ;
 *  - polling 30 s du principal conservé, suspendu onglet caché.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { GitPanel } from "./GitPanel";
import type { Project } from "../../types";

// ── Helpers ─────────────────────────────────────────────

interface FullStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  deleted: string[];
  created: string[];
  conflict: string[];
  files: Array<{ path: string; status: string }>;
  isClean: boolean;
}

function makeProject(id: string, name: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name,
    storage: "local",
    versioning: "git",
    cwd: `/projects/${name}`,
    git: { remote: `https://github.com/example/${name}.git`, branch: "main", provider: "github", lastSync: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function dirtyStatus(modified: string[] = ["src/a.ts"]): FullStatus {
  return {
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: [],
    modified,
    deleted: [],
    created: [],
    conflict: [],
    files: modified.map((path) => ({ path, status: "M" })),
    isClean: false,
  };
}

function cleanStatus(): FullStatus {
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
  };
}

// parseJsonResponse exige un content-type JSON : le mock de fetch doit le fournir.
function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let fetchImpl: (input: unknown) => Promise<Response>;
// Statut renvoyé par projet ; une entrée absente fait échouer le fetch (seed KO).
let statuses: Record<string, FullStatus>;

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  sessionStorage.clear();
  statuses = {};
  fetchImpl = async (input: unknown) => {
    const url = String(input);
    const match = url.match(/^\/api\/projects\/([^/]+)\/git\/status$/);
    if (match) {
      const status = statuses[match[1]];
      if (!status) throw new Error(`fetch failed: no status for ${match[1]}`);
      return jsonResponse(status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

interface PanelOptions {
  project?: Project;
  linked?: Project[];
  onRefresh?: () => void;
}

function renderPanel(options: PanelOptions = {}) {
  const project = options.project ?? makeProject("p1", "MainProj");
  const linked = options.linked ?? [];
  const onRefresh = options.onRefresh ?? vi.fn();
  // Harnais du contrat `on(type, cb) => unsub` (identique à App/Sidebar).
  const handlers = new Map<string, (msg: any) => void>();
  const on = vi.fn((type: string, cb: (msg: any) => void) => {
    handlers.set(type, cb);
    return () => {
      handlers.delete(type);
    };
  });
  const result = render(
    <I18nProvider>
      <GitPanel project={project} linkedProjects={linked} onRefresh={onRefresh} on={on as any} />
    </I18nProvider>
  );
  return {
    ...result,
    project,
    onRefresh,
    onSubscribe: on,
    emitPiEvent: (msg: any) => handlers.get("pi_event")?.(msg),
  };
}

const statusCalls = (id?: string) =>
  fetchMock.mock.calls.filter(([input]) => {
    const url = String(input);
    if (!url.includes("/git/status")) return false;
    return id ? url.startsWith(`/api/projects/${id}/git/`) : true;
  });

// RTL ne détecte PAS les fake timers de Vitest (pas de global `jest`) : on
// flush les microtasks à la main (Promise n'est pas simulée) au lieu d'utiliser
// waitFor, qui resterait bloqué.
async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

// ── Seed / badges ───────────────────────────────────────

describe("GitPanel — seed et auto-dépliage", () => {
  it("seed dirty → section dépliée + badge des modifications", async () => {
    statuses.p1 = dirtyStatus();
    renderPanel();

    expect(await screen.findByTitle("Pending changes")).toBeTruthy();
    // Le détail n'est rendu que déplié (bouton Pull).
    expect(await screen.findByText("Pull")).toBeTruthy();
  });

  it("seed clean → section repliée (badge ✓)", async () => {
    statuses.p1 = cleanStatus();
    renderPanel();

    expect(await screen.findByTitle("Up to date")).toBeTruthy();
    expect(screen.queryByText("Pull")).toBeNull();
  });

  it("échec du seed → pas d'auto-dépliage, indicateur d'erreur visible replié, retry sur fin d'activité", async () => {
    vi.useFakeTimers();
    const { emitPiEvent } = renderPanel(); // statuses.p1 absent → fetch en échec
    await flushMicrotasks();

    // Indicateur discret sur la ligne REPLIÉE (sinon l'échec était silencieux).
    expect(screen.getByLabelText("Failed to load git status")).toBeTruthy();
    expect(screen.getByTitle("fetch failed: no status for p1")).toBeTruthy();
    expect(screen.queryByText("Pull")).toBeNull(); // pas de dépliage auto sans statut

    // Retry : le backend répond désormais dirty → l'événement refetch la section.
    statuses.p1 = dirtyStatus();
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "agent_settled" } });
    });
    await advanceTimers(1500);

    expect(screen.queryByLabelText("Failed to load git status")).toBeNull();
    expect(screen.getByText("Pull")).toBeTruthy(); // dépliée (dirty)
  });
});

// ── Rafraîchissement événementiel ───────────────────────

describe("GitPanel — rafraîchissement sur pi_event", () => {
  it("refetch le principal ET les liés, une seule fois par rafale, sans refetch de streaming", async () => {
    vi.useFakeTimers();
    const linked1 = makeProject("l1", "Sub1");
    const linked2 = makeProject("l2", "Sub2");
    statuses.p1 = dirtyStatus();
    statuses.l1 = dirtyStatus();
    statuses.l2 = cleanStatus();
    const { emitPiEvent, onRefresh, onSubscribe } = renderPanel({ linked: [linked1, linked2] });
    await flushMicrotasks();

    expect(onSubscribe).toHaveBeenCalledWith("pi_event", expect.any(Function));
    expect(statusCalls()).toHaveLength(3); // seed : p1 + l1 + l2

    // Chunks de streaming : JAMAIS de refetch.
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "message_update" } });
      emitPiEvent({ projectId: "p1", event: { type: "tool_execution_update" } });
    });
    await advanceTimers(5_000);
    expect(statusCalls()).toHaveLength(3);

    // 3 fins d'activité rapprochées = UNE rafale.
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "turn_end" } });
      emitPiEvent({ projectId: "p1", event: { type: "agent_end" } });
      emitPiEvent({ projectId: "p1", event: { type: "agent_settled" } });
    });
    expect(statusCalls()).toHaveLength(3); // dé-bounce : rien pendant la fenêtre
    await advanceTimers(1500); // > 1200 ms après le dernier événement

    expect(statusCalls("p1")).toHaveLength(2);
    expect(statusCalls("l1")).toHaveLength(2);
    expect(statusCalls("l2")).toHaveLength(2);
    expect(statusCalls()).toHaveLength(6);
    // L'événementiel ne déclenche PAS le git/sync complet du ⟳ (coût maîtrisé).
    expect(onRefresh).not.toHaveBeenCalled();

    // Un projectId de SOUS-PROJET (jamais émis en réel pour un workspace lié)
    // ne déclenche rien : le filtre vise bien le placeholder.
    act(() => {
      emitPiEvent({ projectId: "l1", event: { type: "agent_settled" } });
    });
    await advanceTimers(5_000);
    expect(statusCalls()).toHaveLength(6);
  });

  it("workspace LIÉ (placeholder sans repo) : l'événement du placeholder refetch les 2 sous-projets", async () => {
    vi.useFakeTimers();
    const placeholder = makeProject("g1", "Group", {
      storage: "linked",
      versioning: "standalone",
      cwd: "/projects/Group",
      git: undefined,
      linkedProjectIds: ["l1", "l2"],
    });
    const linked1 = makeProject("l1", "Sub1");
    const linked2 = makeProject("l2", "Sub2");
    statuses.l1 = cleanStatus();
    statuses.l2 = cleanStatus();
    const { emitPiEvent } = renderPanel({ project: placeholder, linked: [linked1, linked2] });
    await flushMicrotasks();

    // Seed des DEUX sections liées, aucune section principale (placeholder sans repo).
    expect(statusCalls()).toHaveLength(2);
    expect(statusCalls("l1")).toHaveLength(1);
    expect(statusCalls("l2")).toHaveLength(1);

    act(() => {
      emitPiEvent({ projectId: "g1", event: { type: "agent_settled" } });
    });
    await advanceTimers(1500);

    // C'EST LE BUG : les sections liées ne se rafraîchissaient jamais.
    expect(statusCalls("l1")).toHaveLength(2);
    expect(statusCalls("l2")).toHaveLength(2);
  });

  it("retour au premier plan (onglet visible) → refetch dé-bouncé (visible + focus = un seul)", async () => {
    vi.useFakeTimers();
    statuses.p1 = cleanStatus();
    renderPanel();
    await flushMicrotasks();
    expect(statusCalls("p1")).toHaveLength(1);

    // jsdom répond « prerender » par défaut : on force « visible » le temps du dispatch.
    const visibility = vi.spyOn(Document.prototype, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(statusCalls("p1")).toHaveLength(1); // dé-bounce
    await advanceTimers(1500);
    expect(statusCalls("p1")).toHaveLength(2); // UN seul refetch pour les deux signaux
    visibility.mockRestore();
  });
});

// ── Override manuel (correctif 3) ───────────────────────

describe("GitPanel — règle d'override manuel", () => {
  it("un pli manuel dirty est respecté en session mais ne survit pas à un F5", async () => {
    statuses.p1 = dirtyStatus();
    const first = renderPanel();
    await screen.findByText("Pull"); // auto-dépliée (dirty)

    fireEvent.click(screen.getByText("MainProj")); // pli manuel
    await waitFor(() => expect(screen.queryByText("Pull")).toBeNull());
    // RÈGLE : seuls les overrides « déplié » (true) sont persistés.
    expect(JSON.parse(sessionStorage.getItem("pi-web.gitpanel.expanded.v2") ?? "{}")).toEqual({});

    // Simule un F5 : nouvel arbre, sessionStorage conservé.
    first.unmount();
    renderPanel();
    expect(await screen.findByText("Pull")).toBeTruthy(); // dirty → re-dépliée
  });

  it("le pli manuel tient tant que la catégorie ne change pas, puis est purgé au retour dirty après un clean", async () => {
    vi.useFakeTimers();
    statuses.p1 = dirtyStatus();
    const { emitPiEvent } = renderPanel();
    await flushMicrotasks();
    expect(screen.getByText("Pull")).toBeTruthy(); // dirty → dépliée

    fireEvent.click(screen.getByText("MainProj")); // pli manuel
    await flushMicrotasks();
    expect(screen.queryByText("Pull")).toBeNull();

    // Toujours dirty : le pli manuel reste respecté après un refetch.
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "agent_settled" } });
    });
    await advanceTimers(1500);
    expect(statusCalls("p1")).toHaveLength(2);
    expect(screen.queryByText("Pull")).toBeNull();

    // Passe clean : l'override est purgé (la section reste repliée par l'auto).
    statuses.p1 = cleanStatus();
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "agent_settled" } });
    });
    await advanceTimers(1500);
    expect(screen.getByTitle("Up to date")).toBeTruthy();
    expect(screen.queryByText("Pull")).toBeNull();

    // Redevient dirty : l'auto reprend la main → dépliée.
    statuses.p1 = dirtyStatus();
    act(() => {
      emitPiEvent({ projectId: "p1", event: { type: "agent_settled" } });
    });
    await advanceTimers(1500);
    expect(screen.getByText("Pull")).toBeTruthy();
  });
});

// ── Spinner ⟳ et polling (correctif 4) ──────────────────

describe("GitPanel — spinner et polling", () => {
  it("spinner ⟳ : tourne pendant un chargement réel puis s'arrête (plus de rotation permanente)", async () => {
    statuses.p1 = dirtyStatus();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementationOnce(async (input: unknown) => {
      await gate;
      return fetchImpl(input);
    });
    renderPanel();

    const icon = screen.getByTitle("Refresh git status").querySelector("svg")!;
    expect(icon.classList.contains("animate-spin")).toBe(true); // seed en vol

    await act(async () => {
      release();
    });
    await waitFor(() => expect(icon.classList.contains("animate-spin")).toBe(false));
  });

  it("polling : le principal est resondé toutes les 30 s, sauf onglet caché", async () => {
    vi.useFakeTimers();
    statuses.p1 = cleanStatus();
    renderPanel();
    await flushMicrotasks();
    expect(statusCalls("p1")).toHaveLength(1);

    await advanceTimers(30_000);
    expect(statusCalls("p1")).toHaveLength(2);

    const hidden = vi.spyOn(Document.prototype, "visibilityState", "get").mockReturnValue("hidden");
    await advanceTimers(30_000);
    expect(statusCalls("p1")).toHaveLength(2); // onglet caché : pas de sondage
    hidden.mockRestore();
  });
});
