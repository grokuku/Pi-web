/**
 * Tests unitaires : classification des échecs git et refus des remotes SSH.
 *
 * Contexte (correctif « boucle de re-prompt du token ») :
 *  - un origin en SSH (`git@host:owner/repo.git`) ne peut PAS recevoir de token
 *    HTTPS → refus explicite et actionnable (GitRemoteSchemeError), jamais une
 *    réécriture silencieuse du remote ;
 *  - `Permission denied (publickey)` et `timed out` ne sont PLUS des erreurs
 *    d'authentification (GIT_AUTH_REQUIRED) mais GIT_REMOTE_SCHEME /
 *    GIT_UNREACHABLE ;
 *  - un échec de push n'est plus avalé par `gitCommitAndPush` (faux succès).
 *
 * Aucun réseau, aucun binaire git : `simple-git` et le `credentialStore` sont
 * mockés (le temp file d'identifiants n'est donc jamais écrit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs";
import { fileURLToPath } from "url";

// ── État partagé avec les mocks (hoisted : lisible dans vi.mock) ────────────
const state = vi.hoisted(() => ({
  remoteUrl: "https://github.com/owner/repo.git",
  calls: [] as string[][],
  pushError: null as unknown,
  status: null as any,
  creds: new Map<string, { username: string; password: string }>(),
  // Chaque instance simple-git créée par le module : options + env reçus.
  instances: [] as Array<{ options: any; env: Record<string, string> | undefined }>,
}));

vi.mock("simple-git", () => {
  const fakeGit = (options: any) => {
    const api: any = {
      raw: async (args: string[]) => {
        state.calls.push(args);
        if (args[0] === "remote" && args[1] === "get-url") return `${state.remoteUrl}\n`;
        if (args[0] === "remote" && args[1] === "set-url") {
          state.remoteUrl = args[3];
          return "";
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
        if (args[0] === "rev-parse" && args[1] === "--short") return "abc1234\n";
        return "";
      },
      push: async () => {
        state.calls.push(["push"]);
        if (state.pushError) throw state.pushError;
        return { pushed: [{ local: "main", remote: "main" }] };
      },
      pull: async () => {
        state.calls.push(["pull"]);
        return { summary: { changes: 0, insertions: 0, deletions: 0 } };
      },
      getRemotes: async () => [
        { name: "origin", refs: { fetch: state.remoteUrl, push: state.remoteUrl } },
      ],
      status: async () => state.status,
      add: async () => {},
      commit: async () => ({ commit: "abc1234def", summary: { changes: 1 } }),
    };
    // `.env()` est l'API utilisée par le module pour propager GIT_TERMINAL_PROMPT.
    api.env = (env: Record<string, string>) => {
      state.instances.push({ options, env });
      return api;
    };
    return api;
  };
  return { simpleGit: fakeGit, default: fakeGit };
});

// Credential store mocké : aucune écriture disque (le vrai store persiste dans
// .data/credentials.enc — hors périmètre d'un test unitaire).
vi.mock("./credential-store.js", () => ({
  credentialStore: {
    has: (host: string) => state.creds.has(host),
    get: (host: string) => state.creds.get(host),
    set: (host: string, username: string, password: string) =>
      state.creds.set(host, { username, password }),
    delete: (host: string) => state.creds.delete(host),
    listHosts: () => [...state.creds.keys()],
    withTempFile: (_h: string, _u: string, _p: string, fn: () => Promise<unknown>) => fn(),
  },
}));

const {
  gitPush,
  gitCommitAndPush,
  setGitCredentials,
  GitAuthError,
  GitRemoteSchemeError,
  GitUnreachableError,
  GitPushRejectedError,
  GitTimeoutError,
  isHttpsRemoteUrl,
  sshRemoteToHttps,
} = await import("./git.js");

const FAKE_USER = "octocat";
const FAKE_TOKEN = "fake-token-for-tests";

let repoDir: string;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.calls.length = 0;
  state.instances.length = 0;
  state.pushError = null;
  state.remoteUrl = "https://github.com/owner/repo.git";
  state.creds.clear();
  // Un vrai répertoire avec .git : getGitStatus/cleanupGitLock le lisent sur disque.
  repoDir = mkdtempSync(path.join(os.tmpdir(), "git-auth-test-"));
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoDir, { recursive: true, force: true });
});

const setUrlCalls = () =>
  state.calls.filter((c) => c[0] === "remote" && c[1] === "set-url");

describe("A — remote SSH : refus explicite (jamais de réécriture silencieuse)", () => {
  it("origin SSH + identifiants connus → GitRemoteSchemeError actionnable, sans push", async () => {
    state.remoteUrl = "git@github.com:owner/repo.git";
    state.creds.set("github.com", { username: FAKE_USER, password: FAKE_TOKEN });

    await expect(gitPush(repoDir)).rejects.toBeInstanceOf(GitRemoteSchemeError);

    const err = (await gitPush(repoDir).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("GitRemoteSchemeError");
    // Message actionnable : la commande exacte est donnée.
    expect(err.message).toContain("git remote set-url origin https://github.com/owner/repo.git");
    // Le remote n'a pas été modifié et aucun push n'a été tenté.
    expect(setUrlCalls()).toHaveLength(0);
    expect(state.calls.filter((c) => c[0] === "push")).toHaveLength(0);
  });

  it("remote HTTPS + identifiants → identifiants injectés puis remote restauré", async () => {
    state.creds.set("github.com", { username: FAKE_USER, password: FAKE_TOKEN });

    await expect(gitPush(repoDir)).resolves.toContain("Pushed");

    // Injection observée (URL temporaire avec utilisateur/token)…
    const injected = setUrlCalls().map((c) => c[3]);
    expect(injected[0]).toMatch(/^https:\/\/[^@]+@github\.com\/owner\/repo\.git$/);
    // …puis restauration : l'URL finale ne contient plus d'identifiants.
    expect(state.remoteUrl).toBe("https://github.com/owner/repo.git");
  });

  it("sshRemoteToHttps / isHttpsRemoteUrl : conversions", () => {
    expect(sshRemoteToHttps("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo.git");
    expect(sshRemoteToHttps("ssh://git@gitlab.com/owner/repo.git")).toBe("https://gitlab.com/owner/repo.git");
    expect(sshRemoteToHttps("https://github.com/owner/repo.git")).toBeNull();
    expect(isHttpsRemoteUrl("https://github.com/owner/repo.git")).toBe(true);
    expect(isHttpsRemoteUrl("http://gitea.local/owner/repo.git")).toBe(true);
    expect(isHttpsRemoteUrl("git@github.com:owner/repo.git")).toBe(false);
  });
});

describe("B — plus de GIT_AUTH_REQUIRED pour Permission denied / timed out", () => {
  it("`Permission denied (publickey)` → GitRemoteSchemeError", async () => {
    state.pushError = new Error("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");

    const err = (await gitPush(repoDir).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitRemoteSchemeError);
    expect(err).not.toBeInstanceOf(GitAuthError);
  });

  it("`timed out` → GitUnreachableError", async () => {
    state.pushError = new Error("git push timed out after 30s — the remote did not answer");

    const err = (await gitPush(repoDir).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitUnreachableError);
    expect(err).not.toBeInstanceOf(GitAuthError);
  });

  it("`unable to access … 403` reste GitAuthError (le serveur a répondu)", async () => {
    state.pushError = new Error(
      "fatal: unable to access 'https://github.com/owner/repo.git/': The requested URL returned error: 403"
    );

    await expect(gitPush(repoDir)).rejects.toBeInstanceOf(GitAuthError);
  });

  it("une vraie erreur de token reste GitAuthError", async () => {
    state.pushError = new Error("remote: Authentication failed for 'https://github.com/owner/repo.git/'");

    await expect(gitPush(repoDir)).rejects.toBeInstanceOf(GitAuthError);
  });
});

describe("D — un échec de push n'est plus avalé (plus de faux succès)", () => {
  beforeEach(() => {
    // Dépôt propre avec 1 commit d'avance : gitCommitAndPush pousse directement.
    state.status = {
      current: "main",
      ahead: 1,
      behind: 0,
      files: [],
      isClean: () => true,
    };
  });

  it("push en échec → gitCommitAndPush LÈVE (pas de 200 trompeur)", async () => {
    state.pushError = new Error("fatal: unable to access 'https://github.com/owner/repo.git/': Could not resolve host: github.com");

    await expect(gitCommitAndPush(repoDir)).rejects.toBeInstanceOf(GitUnreachableError);
  });

  it("non-fast-forward → message explicite avec la commande de correction", async () => {
    state.pushError = new Error("! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs");

    const err = (await gitCommitAndPush(repoDir).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitPushRejectedError);
    expect(err.message).toContain("git pull --rebase origin main");
  });

  it("push réussi → pushResult présent (l'UI peut afficher un vrai succès)", async () => {
    const result = await gitCommitAndPush(repoDir);
    expect(result.pushResult).toContain("Pushed");
  });
});

describe("E — hygiène : aucun log ne divulgue le token (ni sa longueur)", () => {
  it("setGitCredentials ne logge pas password.length", async () => {
    state.remoteUrl = "https://github.com/owner/repo.git";
    const logged: string[] = [];
    (console.log as any).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await setGitCredentials(repoDir, FAKE_USER, FAKE_TOKEN);

    const joined = logged.join("\n");
    expect(joined).not.toContain(String(FAKE_TOKEN.length));
    expect(joined).not.toContain(FAKE_TOKEN);
    expect(joined).toContain("github.com");
  });
});

// ── F — cause racine du faux timeout : l'instance simple-git doit interdire
//      tout prompt interactif. simple-git retire les variables GIT_* ambiantes,
//      SAUF si elles sont nommées dans `allowEnvironment` : sans cette option,
//      `process.env.GIT_TERMINAL_PROMPT = "0"` n'atteignait jamais git.
describe("F — instance simple-git : allowEnvironment + GIT_TERMINAL_PROMPT=0", () => {
  it("toute instance créée autorise la variable ET la fixe à \"0\", avec le timeout officiel", async () => {
    await gitPush(repoDir);

    expect(state.instances.length).toBeGreaterThan(0);
    for (const { options, env } of state.instances) {
      expect(options.allowEnvironment).toContain("GIT_TERMINAL_PROMPT");
      expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
      // L'environnement complet est conservé (PATH, HOME…) : pas de spawn cassé.
      expect(Object.keys(env ?? {})).toEqual(expect.arrayContaining(["PATH"]));
      // Timeout OFFICIEL simple-git : c'est lui qui tue réellement le process.
      expect(options.timeout?.block).toBe(30_000);
      expect(typeof options.baseDir).toBe("string");
    }
  });

  it("aucune création de simple-git ne contourne la fabrique (source)", () => {
    const src = readFileSync(fileURLToPath(new URL("./git.ts", import.meta.url)), "utf-8");
    // Commentaires retirés : on ne compte que le CODE.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/?\*)/.test(line))
      .join("\n");
    // Une seule création brute : celle de `gitInstance()`.
    expect(code.match(/\bsimpleGit\(/g) ?? []).toHaveLength(1);
    // …et elle porte bien l'autorisation de la variable (sinon le garde-fou de
    // simple-git la retire de l'enfant).
    expect(code).toContain("allowEnvironment");
  });
});

// ── G — échec d'authentification IMMÉDIAT → modale (GIT_AUTH_REQUIRED), pas un
//      faux « réseau injoignable ».
describe("G — « could not read Username » : authentification, pas réseau", () => {
  it("échec immédiat des prompts désactivés → GitAuthError", async () => {
    state.pushError = new Error(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    );

    const err = (await gitPush(repoDir).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitAuthError);
    expect(err).not.toBeInstanceOf(GitUnreachableError);
    expect(err).not.toBeInstanceOf(GitTimeoutError);
  });
});

// ── H — un vrai timeout (process tué) doit être typé et dire la VÉRITÉ.
describe("H — timeout réel : erreur typée, message sans « réseau »", () => {
  it("marqueur `plugin: timeout` → GitTimeoutError", async () => {
    state.pushError = Object.assign(new Error("block timeout reached"), { plugin: "timeout" });

    const err = (await gitPush(repoDir).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitTimeoutError);
    expect(err).not.toBeInstanceOf(GitUnreachableError);
    expect(err).not.toBeInstanceOf(GitAuthError);
    expect(err.name).toBe("GitTimeoutError");
  });

  it("le message parle d'identifiants, plus jamais de réseau ni de port bloqué", async () => {
    state.pushError = Object.assign(new Error("block timeout reached"), { plugin: "timeout" });

    const err = (await gitPush(repoDir).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/network|unreachable|port blocked/i);
    expect(err.message).toMatch(/credentials/i);
    expect(err.message).toMatch(/30s/);
  });

  it("même détection sans le marqueur (message seul)", async () => {
    state.pushError = new Error("block timeout reached");

    const err = (await gitPush(repoDir).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitTimeoutError);
  });
});

// ── I — cohérence de la clé d'hôte (fuite silencieuse corrigée)
describe("I — clé d'hôte : même fonction pour écrire et lire, sinon avertissement", () => {
  const warnLog = () =>
    (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.map(String).join(" "))
      .join("\n");

  it("identifiants pour un AUTRE hôte → avertissement journalisé (jamais le token)", async () => {
    state.creds.set("gitlab.com", { username: FAKE_USER, password: FAKE_TOKEN });

    await gitPush(repoDir).catch(() => {});

    const logged = warnLog();
    expect(logged).toContain("WARNING");
    expect(logged).toContain("gitlab.com");
    expect(logged).toContain("github.com");
    expect(logged).toContain("WITHOUT a token");
    expect(logged).not.toContain(FAKE_TOKEN);
  });

  it("aucun avertissement quand l'hôte correspond", async () => {
    state.creds.set("github.com", { username: FAKE_USER, password: FAKE_TOKEN });

    await gitPush(repoDir);

    expect(warnLog()).not.toContain("WARNING");
  });

  it("remote portant déjà un jeton → les identifiants sont quand même injectés", async () => {
    // Avant : extractHost renvoyait `${user}:${token}@github.com` → hasCreds=false
    // → push SANS jeton, en silence. La clé est désormais le hostname nu.
    state.remoteUrl = `https://${FAKE_USER}:${FAKE_TOKEN}@github.com/owner/repo.git`;
    state.creds.set("github.com", { username: FAKE_USER, password: FAKE_TOKEN });

    await gitPush(repoDir);

    const injected = setUrlCalls().map((c) => c[3]);
    // 1) injection (avec identifiants) puis 2) restauration (URL nettoyée).
    expect(injected).toHaveLength(2);
    expect(injected[0]).toContain("@github.com/owner/repo.git");
    expect(injected[1]).not.toContain(FAKE_TOKEN);
    // Remote restauré sans identifiants après l'opération.
    expect(state.remoteUrl).toBe("https://github.com/owner/repo.git");
  });
});
