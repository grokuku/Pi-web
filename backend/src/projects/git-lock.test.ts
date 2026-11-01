/**
 * Stratégie : mock PARTIEL de `fs` (implémentation réelle conservée par
 * défaut), afin de pouvoir forcer un échec de `statSync` dans un seul test
 * tout en gardant un vrai système de fichiers temporaire pour les autres.
 * Les verrous sont créés dans des répertoires temporaires uniques : aucun
 * processus git réel ne peut y être actif.
 *
 * Le « processus git actif » des tests /proc est une doublure LANCÉE ET TUÉE
 * par le test (copie de /bin/sleep nommée `git`), jamais un process de
 * production : le timeout de simple-git ne peut donc pas le faire disparaître
 * sous nos pieds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, copyFileSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { cleanupGitLock, hasActiveGitProcessInRepo, LOCK_STALE_MS } from "./git.js";

const readFileSyncSafe = (p: string): string => {
  try {
    return readFileSync(p, "utf-8").trim();
  } catch {
    return "";
  }
};

const realpathSyncSafe = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

// ── Mock partiel : comportement réel par défaut, statSync/unlinkSync espionnés ──
const { statSpy, unlinkSpy } = vi.hoisted(() => ({
  statSpy: vi.fn(),
  unlinkSpy: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  statSpy.mockImplementation(((p: any, o?: any) => actual.statSync(p, o)) as any);
  unlinkSpy.mockImplementation(((p: any) => actual.unlinkSync(p)) as any);
  return { ...actual, statSync: statSpy, unlinkSync: unlinkSpy };
});

const createdDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "git-lock-test-"));
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function makeLock(dir: string): string {
  const lock = path.join(dir, ".git", "index.lock");
  writeFileSync(lock, "index.lock content");
  return lock;
}

function backdateLock(lock: string): void {
  const old = new Date(Date.now() - LOCK_STALE_MS - 60_000); // au-delà du seuil conservateur
  utimesSync(lock, old, old);
}

/** Attente synchrone (Node : Atomics.wait). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Le scan /proc est la fonctionnalité testée : sans /proc (macOS, CI minimaliste)
 * les tests correspondants n'ont AUCUN sens. On le détecte au chargement du
 * module et on les saute EXPLICITEMENT (message visible), au lieu d'échouer avec
 * une assertion trompeuse.
 */
function procAvailable(): boolean {
  try {
    return readdirSync("/proc").some((e) => /^\d+$/.test(e));
  } catch {
    return false;
  }
}
const HAS_PROC = procAvailable();
const SKIP_PROC = HAS_PROC ? false : "scan /proc indisponible sur cette plateforme — test non applicable";

/**
 * Attend qu'une condition devienne vraie, puis l'ASSERTE.
 *
 * ⚠️ L'ancienne version ne rendait rien et n'assertait rien : si le processus
 * n'était jamais détecté, le test continuait et échouait plus loin sur une
 * assertion décalée (message trompeur, cause invisible).
 */
function waitFor(procCheck: () => boolean, label: string): void {
  const deadline = Date.now() + 3000;
  while (!procCheck() && Date.now() < deadline) {
    sleepSync(50);
  }
  // `expect` plutôt qu'un `throw` : le message s'affiche comme une assertion.
  expect(procCheck(), `condition jamais atteinte en 3 s : ${label}`).toBe(true);
}

/**
 * Lance un faux processus `git` CONTRÔLÉ PAR LE TEST : une copie de /bin/sleep
 * nommée « git » (comm = nom du binaire) dont le cwd est le dépôt temporaire.
 *
 * ⚠️ Indépendant du code de production : aucun `gitInstance`/`simpleGit`, donc
 * aucun timeout ni SIGNAL de simple-git ne peut le tuer à notre place. Le test
 * le tue lui-même (voir `killChild`).
 */
function spawnFakeGit(cwd: string, seconds: number): ChildProcess {
  const fakeGit = path.join(cwd, "git");
  if (!existsSync(fakeGit)) copyFileSync("/bin/sleep", fakeGit);
  const child = spawn(fakeGit, [String(seconds)], { cwd, stdio: "ignore" });
  // Si le process ne démarre pas (binaire absent, fork refusé), `pid` est
  // undefined : on ne veut pas d'un test qui « passe » sur un process fantôme.
  expect(child.pid, "le faux processus git n'a pas démarré").toBeTypeOf("number");
  return child;
}

/** Tue le faux git et attend que le système l'ait réellement retiré de /proc. */
function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  const deadline = Date.now() + 2000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    sleepSync(25);
  }
}

/** PIDs encore vivants d'un faux `git` pointant sur un dépôt de test. */
function leftoverFakeGitPids(): string[] {
  if (!HAS_PROC) return [];
  const roots = createdDirs.map((d) => realpathSyncSafe(d)).filter(Boolean) as string[];
  if (roots.length === 0) return [];
  const alive: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSyncSafe(`/proc/${entry}/comm`) !== "git") continue;
      const procCwd = realpathSyncSafe(readlinkSync(`/proc/${entry}/cwd`));
      if (procCwd && roots.includes(procCwd)) alive.push(entry);
    } catch {
      continue;
    }
  }
  return alive;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
  statSpy.mockClear();
  unlinkSpy.mockClear();
  // Témoin de propreté : un faux `git` survivant d'un test précédent fausserait
  // le scan /proc du suivant (verrou « conservé » pour la mauvaise raison).
  expect(leftoverFakeGitPids().length, "des faux processus git ont survécu").toBe(0);
});

describe("cleanupGitLock (BUG-04 — suppression du verrou sur preuve d'orphelinat)", () => {
  it("conserve un verrou RÉCENT (un processus git pourrait l'utiliser)", () => {
    const dir = makeTempRepo();
    const lock = makeLock(dir);
    const now = new Date();
    utimesSync(lock, now, now);
    expect(cleanupGitLock(dir)).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("supprime un verrou ANCIEN lorsqu'aucun processus git n'est actif sur le dépôt", () => {
    const dir = makeTempRepo();
    const lock = makeLock(dir);
    backdateLock(lock);
    expect(hasActiveGitProcessInRepo(dir)).toBe(false);
    expect(cleanupGitLock(dir)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("échec de stat → ERREUR EXPLICITE, jamais de suppression silencieuse", () => {
    const dir = makeTempRepo();
    const lock = makeLock(dir);
    statSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    expect(() => cleanupGitLock(dir)).toThrow(/verrou conservé/i);
    expect(existsSync(lock)).toBe(true); // le verrou n'a pas été supprimé
    expect(unlinkSpy).not.toHaveBeenCalled();
  });
});

describe("hasActiveGitProcessInRepo (scan /proc)", () => {
  // /bin/sleep est la doublure de `git` : sans lui, le procédé de test n'existe
  // pas et le test ne vérifie plus rien (skip explicite, jamais un faux échec).
  const skipReason = !existsSync("/bin/sleep")
    ? "doublure /bin/sleep indisponible"
    : SKIP_PROC;

  it.skipIf(skipReason !== false)(
    `détecte un processus 'git' actif dans le dépôt${skipReason ? ` (${skipReason})` : ""}`,
    () => {
      const dir = makeTempRepo();
      // Une copie de /bin/sleep nommée « git » apparaît dans /proc/<pid>/comm
      // comme « git » (comm = nom du binaire), avec cwd = dépôt.
      const child = spawnFakeGit(dir, 60); // longue durée : c'est le test qui le tue
      try {
        waitFor(() => hasActiveGitProcessInRepo(dir), "le faux git doit être visible dans /proc");
        expect(hasActiveGitProcessInRepo(dir)).toBe(true);
      } finally {
        killChild(child);
      }
    }
  );

  it.skipIf(skipReason !== false)(
    `cleanupGitLock conserve le verrou ancien si un processus git est actif${skipReason ? ` (${skipReason})` : ""}`,
    () => {
      const dir = makeTempRepo();
      const lock = makeLock(dir);
      backdateLock(lock);
      const child = spawnFakeGit(dir, 60);
      try {
        // Pré-condition ASSERTÉE : sans processus actif détectable, l'assertion
        // suivante ne testerait pas la conservation du verrou mais l'absence de
        // détection (c'était le défaut d'origine).
        waitFor(() => hasActiveGitProcessInRepo(dir), "le faux git doit être visible dans /proc");
        expect(cleanupGitLock(dir)).toBe(false); // verrou conservé malgré l'âge
        expect(existsSync(lock)).toBe(true);
        expect(unlinkSpy).not.toHaveBeenCalled();
      } finally {
        killChild(child);
      }
    }
  );

  it.skipIf(!HAS_PROC)(
    `retourne un booléen sûr pour un répertoire sans processus git${SKIP_PROC ? ` (${SKIP_PROC})` : ""}`,
    () => {
      expect(hasActiveGitProcessInRepo(os.tmpdir())).toBe(false);
    }
  );
});