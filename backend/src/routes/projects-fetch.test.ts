/**
 * Route `POST /api/projects/:id/git/fetch` — rafraîchir le distant sans mentir.
 *
 * Exigences testées ici :
 *  - un fetch RÉUSSI renvoie un horodatage (`fetchedAt`) + le statut relu ;
 *  - un fetch qui ÉCHOUE n'est PAS une erreur bloquante : 200 + résultat
 *    structuré `{ ok:false, reason }` (l'UI affichera « non vérifié ») ;
 *  - `GET /git/status` expose `lastFetchAt` (mémoire du backend) pour que l'UI
 *    distingue « à jour » (fetch récent) de « vérifié il y a X » ;
 *  - projet inconnu → 404.
 *
 * Aucun réseau, aucun disque : manager, git et credentialStore sont mockés.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, gitMock, storeMock } = vi.hoisted(() => {
  const state = {
    project: { id: "p1", name: "demo", cwd: "/tmp/demo", git: { remote: "https://github.com/o/r.git" } } as any,
    fetchResult: {
      ok: true,
      fetchedAt: "2026-11-08T10:00:00.000Z",
      lastFetchAt: "2026-11-08T10:00:00.000Z",
    } as any,
    lastFetchAt: "2026-11-08T10:00:00.000Z" as string | null,
    gitStatus: { branch: "main", ahead: 0, behind: 0, isClean: true } as any,
    fetchCalls: [] as string[],
    /** Échec de pull/push simulé (message git, éventuellement porteur d'un jeton). */
    pullError: null as unknown,
  };

  class GitTimeoutError extends Error {}
  class GitIdentityError extends Error {}
  class GitAuthError extends Error {}
  class GitRemoteSchemeError extends Error {}
  class GitUnreachableError extends Error {}
  class GitPushRejectedError extends Error {}
  class GitRemoteHostUnknownError extends Error {}

  const gitMock = {
    GitTimeoutError,
    GitIdentityError,
    GitAuthError,
    GitRemoteSchemeError,
    GitUnreachableError,
    GitPushRejectedError,
    GitRemoteHostUnknownError,
    hostFromRemoteUrl: () => "github.com",
    getRemoteHost: async () => "github.com",
    setGitCredentials: async () => "github.com",
    detectGit: async () => ({ hasGit: true, remote: "", branch: "main" }),
    getGitHistory: async () => [],
    gitPull: async () => {
      if (state.pullError) throw state.pullError;
      return "";
    },
    gitPush: async () => "",
    gitCheckout: async () => "",
    syncGitInfo: async (p: any) => p,
    getGitStatus: async () => state.gitStatus,
    gitClone: async () => "",
    gitInit: async () => "",
    gitCommitAndPush: async () => ({}),
    gitCommitPushPreview: async () => ({}),
    getGitIdentity: async () => null,
    setGitIdentity: async () => ({}),
    getGitDiff: async () => "",
    gitFetch: async (cwd: string) => {
      state.fetchCalls.push(cwd);
      return state.fetchResult;
    },
    getLastFetchAt: () => state.lastFetchAt,
  };

  const storeMock = {
    has: () => true,
    get: () => undefined,
    listHosts: () => [],
    delete: () => {},
    set: () => {},
  };

  return { state, gitMock, storeMock };
});

vi.mock("../projects/manager.js", () => ({
  getAllProjects: () => [],
  getProject: (id: string) => (id === state.project.id ? state.project : undefined),
  createProject: () => state.project,
  updateProject: () => state.project,
  deleteProject: () => {},
  reorderProjects: () => {},
  addLinkedProject: () => state.project,
  removeLinkedProject: () => state.project,
  resolvePushRepos: () => [],
}));
vi.mock("../projects/git.js", () => gitMock);
vi.mock("../projects/credential-store.js", () => ({ credentialStore: storeMock }));
vi.mock("../pi/session.js", () => ({
  generateAiCommitMessage: async () => "",
  generateCleanCommitMessage: async () => "",
  getCommitModelInfo: () => null,
  injectSessionNotification: () => {},
  listSessions: () => [],
}));
vi.mock("../pi/session-history.js", () => ({
  readSessionHistoryFile: () => [],
  selectSessionFile: () => null,
}));
vi.mock("../pi/commit-draft.js", () => ({
  getDraft: () => null,
  getCleanedCommit: () => null,
  saveCleanedCommit: () => {},
  clearDraft: () => {},
}));
vi.mock("../projects/push-notification.js", () => ({ buildPushNotification: () => "" }));
vi.mock("../projects/smb.js", () => ({
  mountSmb: async () => ({ ok: true }),
  unmountSmb: async () => ({ ok: true }),
  getMountPoint: () => "/mnt/smb/p1",
  isMounted: async () => false,
}));

const router = (await import("./projects.js")).default;

/** Invocation directe du Router Express (aucun serveur HTTP). */
function request(method: string, url: string, body: unknown = {}) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req: any = { method, url, body, headers: {}, query: {}, params: {} };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    (router as any)(req, res, () => resolve({ status: 404, body: { error: "no matching route" } }));
  });
}

beforeEach(() => {
  state.fetchCalls.length = 0;
  state.pullError = null;
  state.lastFetchAt = "2026-11-08T10:00:00.000Z";
  state.fetchResult = {
    ok: true,
    fetchedAt: "2026-11-08T10:00:00.000Z",
    lastFetchAt: "2026-11-08T10:00:00.000Z",
  };
});

describe("POST /:id/git/fetch", () => {
  it("fetch réussi → 200, horodatage + statut relu (ahead/behind frais)", async () => {
    const res = await request("POST", "/p1/git/fetch");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fetchedAt).toBe("2026-11-08T10:00:00.000Z");
    expect(res.body.lastFetchAt).toBe("2026-11-08T10:00:00.000Z");
    // Statut RELECTURE après le fetch : l'UI met à jour son badge sans attendre.
    // Il porte les MÊMES champs que /git/status (sinon le panneau perdrait
    // `host`/`hasCredentials` en le fusionnant).
    expect(res.body.status).toMatchObject(state.gitStatus);
    expect(res.body.status.host).toBe("github.com");
    expect(res.body.status.lastFetchAt).toBe("2026-11-08T10:00:00.000Z");
    expect(res.body.host).toBe("github.com");
    expect(typeof res.body.hasCredentials).toBe("boolean");
    expect(state.fetchCalls).toEqual(["/tmp/demo"]);
  });

  it("aucun remote → 200 avec ok:false reason=no_remote (erreur NON bloquante)", async () => {
    state.fetchResult = {
      ok: false,
      reason: "no_remote",
      message: "This repository has no 'origin' remote — there is nothing to fetch.",
      fetchedAt: null,
      lastFetchAt: state.lastFetchAt,
    };

    const res = await request("POST", "/p1/git/fetch");

    // Surtout PAS 4xx/5xx : ce n'est pas une erreur, juste rien à vérifier.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe("no_remote");
    expect(res.body.fetchedAt).toBeNull();
    // Aucun statut relu (le fetch n'a rien rafraîchi).
    expect(res.body.status).toBeNull();
  });

  it("échec réseau / auth / timeout → 200 + raison transportée telle quelle", async () => {
    for (const reason of ["network", "auth", "timeout", "error"] as const) {
      state.fetchResult = { ok: false, reason, message: `boom (${reason})`, fetchedAt: null, lastFetchAt: null };

      const res = await request("POST", "/p1/git/fetch");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.reason).toBe(reason);
      expect(res.body.fetchedAt).toBeNull();
    }
  });

  it("projet inconnu → 404", async () => {
    const res = await request("POST", "/nope/git/fetch");

    expect(res.status).toBe(404);
    expect(state.fetchCalls).toEqual([]);
  });
});

describe("GET /:id/git/status — lastFetchAt exposé", () => {
  it("renvoie le dernier fetch réussi (base du badge honnête)", async () => {
    const res = await request("GET", "/p1/git/status");

    expect(res.status).toBe(200);
    expect(res.body.lastFetchAt).toBe("2026-11-08T10:00:00.000Z");
    // Les champs historiques ne bougent pas.
    expect(res.body.host).toBe("github.com");
    expect(res.body.branch).toBe("main");
  });

  it("jamais vérifié → lastFetchAt null (l'UI dira « non vérifié »)", async () => {
    state.lastFetchAt = null;

    const res = await request("GET", "/p1/git/status");

    expect(res.status).toBe(200);
    expect(res.body.lastFetchAt).toBeNull();
  });
});

// ── Barrière de sortie : `sendGitErrorResponse` ─────────────────────────────
//
// Les messages d'échec git remontent JUSQU'À L'ÉCRAN (et peuvent finir dans un
// rapport de bug). Un échec peut recopier l'URL temporaire d'authentification
// (`https://user:token@host/…`) injectée le temps de l'opération.
describe("POST /:id/git/pull — aucun jeton dans la réponse HTTP", () => {
  it("message porteur du jeton → corps expurgé, code GIT_AUTH_REQUIRED inchangé", async () => {
    const SECRET = "ghp_SECRET"; // faux jeton
    // Expurgation RÉELLE (importée du module pur `remote-url.js`, non mocké) :
    // c'est bien la barrière de la route qui est exercée ici.
    state.pullError = new gitMock.GitAuthError(
      `Git pull authentication failed: fatal: unable to access ` +
        `'https://x-access-token:${SECRET}@github.com/owner/repo.git/': The requested URL returned error: 403`
    );

    const res = await request("POST", "/p1/git/pull");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("GIT_AUTH_REQUIRED");
    expect(res.body.error).not.toContain(SECRET);
    expect(res.body.error).toContain("https://****@github.com");
  });
});
