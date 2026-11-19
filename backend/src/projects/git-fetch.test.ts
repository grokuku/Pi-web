/**
 * Tests de `gitFetch` — rafraîchissement des RÉFÉRENCES DISTANTES.
 *
 * Bug d'origine (rapporté par l'utilisateur) : « ça me dit que le dossier est à
 * jour ici, alors qu'il y a eu une mise à jour sur GitHub ». Pi-Web ne faisait
 * JAMAIS de `git fetch` : `git status` comparait donc au dernier `origin/main`
 * connu, c'est-à-dire à une photo périmée. Ce module doit :
 *  - rafraîchir réellement les refs distantes (`git fetch origin`) ;
 *  - ne JAMAIS lever quand le fetch échoue (pas de réseau, pas de jeton, pas de
 *    remote) : renvoyer une raison DISTINCTE, pour que l'UI dise « non vérifié »
 *    au lieu d'un « à jour » mensonger ;
 *  - exposer l'horodatage du fetch RÉUSSI (seule base d'un « à jour » honnête) ;
 *  - passer par `gitInstance()` (GIT_TERMINAL_PROMPT=0 + timeout natif borné) ;
 *  - passer par le MUTEX du dépôt (un fetch écrit dans `.git`).
 *
 * Aucun réseau, aucun binaire git, aucun disque : `simple-git` et le
 * `credentialStore` sont mockés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";

// ── État partagé avec les mocks (hoisted : lisible dans vi.mock) ────────────
const state = vi.hoisted(() => ({
  remoteUrl: "https://github.com/owner/repo.git",
  calls: [] as string[][],
  noRemotes: false,
  fetchError: null as unknown,
  fetchDelayMs: 0,
  active: 0,
  maxActive: 0,
  creds: new Map<string, { username: string; password: string }>(),
  instances: [] as Array<{ options: any; env: Record<string, string> | undefined }>,
}));

vi.mock("simple-git", () => {
  const fakeGit = (options: any) => {
    const api: any = {
      raw: async (args: string[]) => {
        state.calls.push(args);
        if (args[0] === "remote" && args[1] === "get-url") {
          if (state.noRemotes) throw new Error("error: No such remote 'origin'");
          return `${state.remoteUrl}\n`;
        }
        if (args[0] === "remote" && args[1] === "set-url") {
          state.remoteUrl = args[3];
          return "";
        }
        return "";
      },
      fetch: async (args: string[]) => {
        state.calls.push(["fetch", ...args]);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          if (state.fetchDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, state.fetchDelayMs));
          }
          if (state.fetchError) throw state.fetchError;
          return {};
        } finally {
          state.active -= 1;
        }
      },
    };
    // `.env()` est l'API utilisée par `gitInstance()` pour propager
    // GIT_TERMINAL_PROMPT — on enregistre les options + l'environnement reçus.
    api.env = (env: Record<string, string>) => {
      state.instances.push({ options, env });
      return api;
    };
    return api;
  };
  return { simpleGit: fakeGit, default: fakeGit };
});

vi.mock("./credential-store.js", () => ({
  credentialStore: {
    has: (host: string) => state.creds.has(host),
    get: (host: string) => state.creds.get(host),
    set: (host: string, username: string, password: string) =>
      state.creds.set(host, { username, password }),
    delete: (host: string) => state.creds.delete(host),
    listHosts: () => [...state.creds.keys()],
  },
}));

const { gitFetch, getLastFetchAt } = await import("./git.js");

let repoDir: string;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.calls.length = 0;
  state.instances.length = 0;
  state.remoteUrl = "https://github.com/owner/repo.git";
  state.noRemotes = false;
  state.fetchError = null;
  state.fetchDelayMs = 0;
  state.active = 0;
  state.maxActive = 0;
  state.creds.clear();
  repoDir = mkdtempSync(path.join(os.tmpdir(), "git-fetch-test-"));
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoDir, { recursive: true, force: true });
});

const fetchCalls = () => state.calls.filter((c) => c[0] === "fetch");

describe("A — succès : refs rafraîchies + horodatage exploitable", () => {
  it("fetch réussi → ok, horodatage ISO, mémorisé pour ce dépôt", async () => {
    const before = Date.now();
    const result = await gitFetch(repoDir);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(typeof result.fetchedAt).toBe("string");
    // Horodatage RÉEL (et non une valeur figée) : l'UI doit pouvoir dater la photo.
    const ts = new Date(result.fetchedAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
    // Mémorisé côté backend : /git/status peut dire « vérifié il y a X » même
    // après un rechargement de page.
    expect(result.lastFetchAt).toBe(result.fetchedAt);
    expect(getLastFetchAt(repoDir)).toBe(result.fetchedAt);
    // C'est bien l'origin qui est interrogé (pas tous les remotes).
    expect(fetchCalls()).toEqual([["fetch", "origin"]]);
  });

  it("identifiants en store → URL temporaire puis remote RESTAURÉ (aucun jeton laissé)", async () => {
    state.creds.set("github.com", { username: "octocat", password: "fake-token-for-tests" });

    const result = await gitFetch(repoDir);

    expect(result.ok).toBe(true);
    // L'URL a bien été portée par le jeton pendant l'opération…
    const injected = state.instances.length > 0;
    expect(injected).toBe(true);
    expect(state.calls.some((c) => c[0] === "remote" && c[1] === "set-url")).toBe(true);
    // …et elle est revenue propre : aucun identifiant persisté dans `.git/config`.
    expect(state.remoteUrl).toBe("https://github.com/owner/repo.git");
  });
});

describe("B — échecs : jamais d'exception, une raison DISTINCTE", () => {
  it("aucun remote → ok:false reason=no_remote (cas NORMAL, pas une erreur)", async () => {
    state.noRemotes = true;

    const result = await gitFetch(repoDir);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_remote");
    expect(result.fetchedAt).toBeNull();
    // Rien à interroger : aucun fetch n'a été tenté (et surtout aucune exception).
    expect(fetchCalls()).toHaveLength(0);
  });

  it("timeout (plugin timeout de simple-git) → reason=timeout, aucun horodatage inventé", async () => {
    const timeoutError = Object.assign(new Error("block timeout reached"), { plugin: "timeout" });
    state.fetchError = timeoutError;

    const result = await gitFetch(repoDir);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.fetchedAt).toBeNull();
    // Le timeout ne doit PAS compter comme une vérification.
    expect(getLastFetchAt(repoDir)).toBeNull();
    // Message honnête : identifiants probables, pas « réseau injoignable ».
    expect(result.message).toContain("credentials");
  });

  it("distant injoignable → reason=network", async () => {
    state.fetchError = new Error(
      "fatal: unable to access 'https://github.com/owner/repo.git/': Could not resolve host: github.com"
    );

    const result = await gitFetch(repoDir);

    expect(result.reason).toBe("network");
    expect(result.ok).toBe(false);
  });

  it("identifiants absents (prompts désactivés) → reason=auth", async () => {
    state.fetchError = new Error(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    );

    const result = await gitFetch(repoDir);

    expect(result.reason).toBe("auth");
    expect(result.ok).toBe(false);
  });

  it("un échec APRÈS un succès conserve l'ancien horodatage mais ne le rafraîchit pas", async () => {
    const first = await gitFetch(repoDir);
    expect(first.ok).toBe(true);

    state.fetchError = new Error("fatal: unable to access 'https://github.com/owner/repo.git/': Failed to connect");
    const second = await gitFetch(repoDir);

    expect(second.ok).toBe(false);
    expect(second.reason).toBe("network");
    // « Vérifié il y a X » reste vrai (X = le dernier succès) ; « à jour » non.
    expect(second.fetchedAt).toBeNull();
    expect(second.lastFetchAt).toBe(first.fetchedAt);
  });
});

describe("D — aucun secret dans les messages renvoyés", () => {
  it("un message git contenant l'URL authentifiée est EXPURGÉ (jamais le jeton)", async () => {
    state.creds.set("github.com", { username: "octocat", password: "fake-token-for-tests" });
    // Message typique d'un échec réseau sur une URL porteuse du jeton.
    state.fetchError = new Error(
      "fatal: unable to access 'https://x-access-token:fake-token-for-tests@github.com/owner/repo.git/': " +
        "Could not resolve host: github.com"
    );

    const result = await gitFetch(repoDir);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("network");
    expect(result.message).not.toContain("fake-token-for-tests");
    expect(result.message).toContain("//****@github.com");
  });
});

describe("C — garde-fous : mutex du dépôt et usine gitInstance", () => {
  it("deux fetchs concurrents sur le MÊME dépôt ne se chevauchent pas (mutex)", async () => {
    state.fetchDelayMs = 15;

    const [a, b] = await Promise.all([gitFetch(repoDir), gitFetch(repoDir)]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Sans mutex, les deux `git fetch` tourneraient en parallèle sur `.git`.
    expect(state.maxActive).toBe(1);
    expect(fetchCalls()).toHaveLength(2);
  });

  it("toute instance créée porte GIT_TERMINAL_PROMPT=0 (sinon attente d'un mot de passe)", async () => {
    state.creds.set("github.com", { username: "octocat", password: "fake-token-for-tests" });

    await gitFetch(repoDir);

    expect(state.instances.length).toBeGreaterThan(0);
    for (const instance of state.instances) {
      expect(instance.options.allowEnvironment).toContain("GIT_TERMINAL_PROMPT");
      expect(instance.env?.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });

  it("le fetch est BORNÉ plus court qu'un push/clone (budget dédié, timeout natif)", async () => {
    await gitFetch(repoDir);

    const blocks = state.instances
      .map((i) => i.options?.timeout?.block)
      .filter((b): b is number => typeof b === "number");
    // Le budget du fetch lui-même est présent et strictement inférieur aux 30 s
    // des opérations réseau lourdes.
    expect(blocks).toContain(20_000);
    expect(Math.min(...blocks)).toBeLessThan(30_000);
  });
});
