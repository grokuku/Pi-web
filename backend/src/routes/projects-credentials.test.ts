/**
 * B1 + B7 (intégrité) — route des identifiants git d'un projet.
 *
 *   POST   /api/projects/:id/git/credentials
 *   DELETE /api/projects/:id/git/credentials
 *
 * Avant :
 *  - la route ne validait NI le type NI le format (« {username:{}, password:[]} »
 *    partait vers le store) et répondait `{success:true}` quoi qu'il arrive ;
 *  - quand l'hôte du remote était indéterminable, `getRemoteHost()` renvoyait
 *    « github.com » : un jeton GitLab était écrit sous la clé GitHub (écrasement
 *    du vrai jeton), et le DELETE effaçait le jeton d'un AUTRE dépôt.
 *
 * Aucun accès disque/réseau : manager, git et credentialStore sont mockés.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, gitMock, storeMock } = vi.hoisted(() => {
  const state = {
    project: { id: "p1", name: "demo", cwd: "/tmp/demo" } as any,
    // Valeur renvoyée par getRemoteHost (null = hôte indéterminable).
    remoteHost: "github.com" as string | null,
    creds: new Map<string, { username: string; password: string }>(),
    setCalls: [] as Array<{ cwd: string; username: string; password: string }>,
  };

  class GitRemoteHostUnknownError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GitRemoteHostUnknownError";
    }
  }
  class GitAuthError extends Error {}
  class GitRemoteSchemeError extends Error {}
  class GitUnreachableError extends Error {}
  class GitPushRejectedError extends Error {}
  class GitTimeoutError extends Error {}
  class GitIdentityError extends Error {}

  const gitMock = {
    GitRemoteHostUnknownError,
    GitAuthError,
    GitRemoteSchemeError,
    GitUnreachableError,
    GitPushRejectedError,
    GitTimeoutError,
    GitIdentityError,
    hostFromRemoteUrl: () => state.remoteHost,
    getRemoteHost: async () => state.remoteHost,
    // Reproduit le comportement du vrai setGitCredentials : refuse un hôte nul.
    setGitCredentials: async (cwd: string, username: string, password: string) => {
      state.setCalls.push({ cwd, username, password });
      if (!state.remoteHost) {
        throw new GitRemoteHostUnknownError(
          "Cannot determine the remote host: the 'origin' remote is missing.",
        );
      }
      state.creds.set(state.remoteHost, { username, password });
      return state.remoteHost;
    },
    detectGit: async () => null,
    getGitHistory: async () => [],
    gitPull: async () => "",
    gitPush: async () => "",
    gitCheckout: async () => "",
    syncGitInfo: async () => ({}),
    getGitStatus: async () => ({}),
    gitClone: async () => "",
    gitInit: async () => "",
    gitCommitAndPush: async () => ({}),
    gitCommitPushPreview: async () => ({}),
    getGitIdentity: async () => null,
    setGitIdentity: async () => ({}),
    getGitDiff: async () => "",
  };

  const storeMock = {
    has: (host: string) => state.creds.has(host),
    get: (host: string) => state.creds.get(host),
    listHosts: () => [...state.creds.keys()],
    delete: vi.fn((host: string) => {
      state.creds.delete(host);
    }),
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
  state.remoteHost = "github.com";
  state.creds.clear();
  state.setCalls.length = 0;
  storeMock.delete.mockClear();
});

describe("POST /:id/git/credentials — validation réelle", () => {
  it("username/password absents ou non-string → 400 GIT_CREDENTIALS_INVALID, rien n'est écrit", async () => {
    const bad = [
      {},
      { username: "u" },
      { password: "t" },
      { username: { evil: true }, password: "t" },
      { username: "u", password: ["t"] },
      { username: 42, password: 42 },
      { username: "   ", password: "t" },
      { username: "u", password: "" },
      { username: "u".repeat(513), password: "t" },
      { username: "u", password: "t".repeat(513) },
      null,
    ];

    for (const body of bad) {
      const res = await request("POST", "/p1/git/credentials", body as any);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("GIT_CREDENTIALS_INVALID");
    }

    expect(state.setCalls).toHaveLength(0);
    expect(state.creds.size).toBe(0);
  });

  it("identifiants valides → succès HONNÊTE (host réel renvoyé)", async () => {
    const res = await request("POST", "/p1/git/credentials", { username: "u", password: "token" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, host: "github.com" });
    expect(state.creds.get("github.com")).toEqual({ username: "u", password: "token" });
  });

  it("hôte du remote indéterminable → 409 GIT_REMOTE_HOST_UNKNOWN (aucun jeton écrit)", async () => {
    state.remoteHost = null;
    state.creds.set("github.com", { username: "existing", password: "github-token" });

    const res = await request("POST", "/p1/git/credentials", { username: "u", password: "gitlab-token" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GIT_REMOTE_HOST_UNKNOWN");
    expect(res.body.error).toContain("Cannot determine the remote host");
    // Le jeton de github.com n'a PAS été écrasé.
    expect(state.creds.get("github.com")!.password).toBe("github-token");
    expect(state.creds.size).toBe(1);
  });
});

describe("DELETE /:id/git/credentials — jamais sur une clé inventée", () => {
  it("hôte indéterminable → 409, AUCUN effacement", async () => {
    state.remoteHost = null;
    state.creds.set("github.com", { username: "u", password: "github-token" });

    const res = await request("DELETE", "/p1/git/credentials");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GIT_REMOTE_HOST_UNKNOWN");
    expect(storeMock.delete).not.toHaveBeenCalled();
    expect(state.creds.has("github.com")).toBe(true);
  });

  it("hôte connu → efface cet hôte et le dit (removed)", async () => {
    state.creds.set("github.com", { username: "u", password: "t" });

    const res = await request("DELETE", "/p1/git/credentials");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, host: "github.com", removed: true });
    expect(state.creds.has("github.com")).toBe(false);
  });
});
