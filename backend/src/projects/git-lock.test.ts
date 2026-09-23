/**
 * Tests unitaires de cleanupGitLock / hasActiveGitProcessInRepo — BUG-04 (Lot A).
 *
 * Stratégie : mock PARTIEL de `fs` (implémentation réelle conservée par
 * défaut), afin de pouvoir forcer un échec de `statSync` dans un seul test
 * tout en gardant un vrai système de fichiers temporaire pour les autres.
 * Les verrous sont créés dans des répertoires temporaires uniques : aucun
 * processus git ne peut y être actif, ce qui rend le scan /proc déterministe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, copyFileSync } from "fs";
import { spawn } from "child_process";
import { cleanupGitLock, hasActiveGitProcessInRepo, LOCK_STALE_MS } from "./git.js";

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

/** Attend (borné à 3 s) qu'un processus apparaisse dans /proc. */
function waitFor(procCheck: () => boolean): void {
  const deadline = Date.now() + 3000;
  while (!procCheck() && Date.now() < deadline) {
    sleepSync(50);
  }
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
  statSpy.mockClear();
  unlinkSpy.mockClear();
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
  const hasSleepBin = existsSync("/bin/sleep");

  it.skipIf(!hasSleepBin)("détecte un processus 'git' actif dans le dépôt", () => {
    const dir = makeTempRepo();
    // Astuce de test : une copie de /bin/sleep nommée "git" apparaît dans
    // /proc/<pid>/comm comme "git" (comm = nom du binaire), avec cwd = dépôt.
    const fakeGit = path.join(dir, "git");
    copyFileSync("/bin/sleep", fakeGit);
    const child = spawn(fakeGit, ["3"], { cwd: dir, stdio: "ignore" });
    try {
      waitFor(() => hasActiveGitProcessInRepo(dir));
      expect(hasActiveGitProcessInRepo(dir)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      sleepSync(100); // laisse le système libérer le processus
    }
  });

  it.skipIf(!hasSleepBin)("cleanupGitLock conserve le verrou ancien si un processus git est actif", () => {
    const dir = makeTempRepo();
    const lock = makeLock(dir);
    backdateLock(lock);
    const fakeGit = path.join(dir, "git");
    copyFileSync("/bin/sleep", fakeGit);
    const child = spawn(fakeGit, ["3"], { cwd: dir, stdio: "ignore" });
    try {
      waitFor(() => hasActiveGitProcessInRepo(dir));
      expect(cleanupGitLock(dir)).toBe(false); // verrou conservé malgré l'âge
      expect(existsSync(lock)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      sleepSync(100);
    }
  });

  it("retourne un booléen sûr pour un répertoire sans processus git", () => {
    expect(hasActiveGitProcessInRepo(os.tmpdir())).toBe(false);
  });
});