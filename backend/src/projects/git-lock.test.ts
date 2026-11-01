/**
 * Stratégie : mock PARTIEL de `fs` (implémentation réelle conservée par
 * défaut), afin de pouvoir forcer un échec de `statSync` dans un seul test
 * tout en gardant un vrai système de fichiers temporaire pour les autres.
 * Les verrous sont créés dans des répertoires temporaires uniques : aucun
 * processus git réel ne peut y être actif.
 *
 * Le « processus git actif » des tests /proc est une doublure LANCÉE ET TUÉE
 * par le test (copie de l'exécutable Node nommée `git`), jamais un process de
 * production : le timeout de simple-git ne peut donc pas le faire disparaître
 * sous nos pieds.
 *
 * ⚠️ Pourquoi Node et non /bin/sleep (cause d'un échec intermittent MESURÉ) :
 * avec `sleep <durée>`, le process sort au bout de la durée demandée. Or les
 * attentes de ce fichier sont SYNCHRONES (`Atomics.wait`) : tant qu'elles
 * tournent, la boucle d'événements Node est bloquée et `child.exitCode` n'est
 * JAMAIS mis à jour. Le process mort devient un ZOMBIE : `/proc/<pid>/comm`
 * vaut encore « git » mais `/proc/<pid>/cwd` renvoie ENOENT — la détection le
 * voit pendant sa vie puis ne le voit plus. D'où `waitFor` vert suivi de
 * `expect(...).toBe(false)` à la ligne suivante. Une copie de Node lancée avec
 * `-e "setTimeout(...)"` ne dépend d'AUCUNE durée murale ni d'un binaire
 * optionnel (/bin/sleep absent ou busybox sur certaines images).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, copyFileSync, chmodSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "fs";
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
 * État réel du processus d'après /proc : "R"/"S"/… vivant, "Z" zombie (mort,
 * non encore rechargé par Node), null si entrée absente (/proc indisponible
 * ou pid déjà libéré).
 *
 * ⚠️ `child.exitCode` n'est PAS utilisable comme preuve de vie : il ne se met
 * à jour que quand la boucle d'événements tourne, alors que les attentes de ce
 * fichier sont synchrones. Un process mort peut donc avoir `exitCode === null`.
 */
function procState(pid: number): string | null {
  const stat = readFileSyncSafe(`/proc/${pid}/stat`);
  if (!stat) return null;
  // Format : "<pid> (<comm>) <state> …" — le comm peut contenir des espaces,
  // donc on se repère sur la DERNIÈRE parenthèse fermante.
  const close = stat.lastIndexOf(")");
  return close < 0 ? null : stat.slice(close + 2, close + 3);
}

/**
 * Attend qu'une condition devienne vraie, puis l'ASSERTE — sans bloquer la
 * boucle d'événements.
 *
 * ⚠️ Version précédente : boucle SYNCHRONE (`Atomics.wait`). Elle gelait la
 * boucle d'événements, donc Node ne pouvait pas constater la mort du faux git
 * (`exitCode` figé à `null`) et laissait un zombie invisible pour la détection
 * (`/proc/<pid>/cwd` → ENOENT). Une attente async laisse Node recharger
 * l'enfant : l'état observé redevient fidèle.
 */
async function waitFor(
  procCheck: () => boolean,
  label: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!procCheck() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  // `expect` plutôt qu'un `throw` : le message s'affiche comme une assertion.
  expect(procCheck(), `condition jamais atteinte en ${timeoutMs} ms : ${label}`).toBe(true);
}

/** Durée du faux git : très au-delà de tout test possible — c'est le test qui le tue. */
const FAKE_GIT_DURATION_MS = 300_000;

/**
 * Lance un faux processus `git` CONTRÔLÉ PAR LE TEST : une copie de
 * l'exécutable Node nommée « git » (comm = nom du binaire exécuté) dont le cwd
 * est le dépôt temporaire.
 *
 * ⚠️ Indépendant du code de production : aucun `gitInstance`/`simpleGit`, donc
 * aucun timeout ni SIGNAL de simple-git ne peut le tuer à notre place.
 * ⚠️ Node plutôt que /bin/sleep : Node est forcément présent (c'est le runtime
 * des tests) et `setTimeout` ne dépend d'aucune durée murale courte ni d'un
 * `/bin/sleep` absent/busybox.
 */
function spawnFakeGit(cwd: string): ChildProcess {
  const fakeGit = path.join(cwd, "git");
  if (!existsSync(fakeGit)) {
    copyFileSync(process.execPath, fakeGit);
    chmodSync(fakeGit, 0o755); // selon l'umask, la copie peut perdre le +x
  }
  const child = spawn(fakeGit, ["-e", `setTimeout(() => {}, ${FAKE_GIT_DURATION_MS})`], {
    cwd,
    stdio: "ignore",
    // Détaché : le test le tue lui-même, il ne doit pas dépendre du groupe de
    // processus du lanceur.
    detached: true,
  });
  // Si le process ne démarre pas (binaire absent, fork refusé), `pid` est
  // undefined : on ne veut pas d'un test qui « passe » sur un process fantôme.
  expect(child.pid, "le faux processus git n'a pas démarré").toBeTypeOf("number");
  child.unref(); // sa vie ne doit pas retenir la boucle d'événements
  return child;
}

/**
 * Garantit que le faux git est VIVANT (état /proc R/S, cwd toujours le dépôt)
 * au moment exact de l'assertion métier — indépendamment de `child.exitCode`.
 */
function expectFakeGitAlive(child: ChildProcess, cwd: string): void {
  const pid = child.pid!;
  const state = procState(pid);
  // Message autoportant : au prochain run, l'état réel est dans le rapport.
  const diag = `pid=${pid} procState=${state ?? "absent"} exitCode=${child.exitCode} signalCode=${child.signalCode} cwd=${realpathSyncSafe(`/proc/${pid}/cwd`) ?? "<illisible>"}`;
  expect(state, `le faux git n'est plus vivant (${diag})`).not.toBe("Z");
  expect(state, `le faux git a disparu de /proc (${diag})`).not.toBeNull();
  expect(realpathSyncSafe(`/proc/${pid}/cwd`), `cwd du faux git inattendu (${diag})`).toBe(
    realpathSyncSafe(cwd)
  );
}

/** Tue le faux git et attend que le système l'ait réellement retiré de /proc. */
async function killChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (procState(pid) === null || procState(pid) === "Z") return; // déjà mort
  try {
    child.kill("SIGKILL");
  } catch {
    return; // ESRCH : déjà terminé
  }
  const deadline = Date.now() + 3000;
  // Attente ASYNC : c'est ce qui permet à Node de recharger l'enfant (zombie → absent).
  while (procState(pid) !== null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(procState(pid), `le faux git (pid ${pid}) n'a pas disparu de /proc après SIGKILL`).toBeNull();
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
  // Le faux git est une copie de l'exécutable Node : sans lui, le procédé de
  // test n'existe pas et le test ne vérifierait plus rien (skip explicite,
  // jamais un faux échec). Aucun /bin/sleep requis.
  const skipReason = !existsSync(process.execPath)
    ? `exécutable Node introuvable (${process.execPath})`
    : SKIP_PROC;

  it.skipIf(skipReason !== false)(
    `détecte un processus 'git' actif dans le dépôt${skipReason ? ` (${skipReason})` : ""}`,
    async () => {
      const dir = makeTempRepo();
      // Une copie de l'exécutable Node nommée « git » apparaît dans
      // /proc/<pid>/comm comme « git » (comm = nom du binaire), avec cwd = dépôt.
      const child = spawnFakeGit(dir);
      try {
        await waitFor(() => hasActiveGitProcessInRepo(dir), "le faux git doit être visible dans /proc");
        // Preuve de vie au moment EXACT de l'assertion métier : l'état vient de
        // /proc (R/S), pas de `child.exitCode` qui reste `null` tant que la
        // boucle d'événements n'a pas rechargé l'enfant.
        expectFakeGitAlive(child, dir);
        expect(hasActiveGitProcessInRepo(dir)).toBe(true);
      } finally {
        await killChild(child);
      }
    }
  );

  it.skipIf(skipReason !== false)(
    `cleanupGitLock conserve le verrou ancien si un processus git est actif${skipReason ? ` (${skipReason})` : ""}`,
    async () => {
      const dir = makeTempRepo();
      const lock = makeLock(dir);
      backdateLock(lock);
      const child = spawnFakeGit(dir);
      try {
        // Pré-condition ASSERTÉE : sans processus actif détectable, l'assertion
        // suivante ne testerait pas la conservation du verrou mais l'absence de
        // détection (c'était le défaut d'origine).
        await waitFor(() => hasActiveGitProcessInRepo(dir), "le faux git doit être visible dans /proc");
        expectFakeGitAlive(child, dir);
        expect(cleanupGitLock(dir)).toBe(false); // verrou conservé malgré l'âge
        expect(existsSync(lock)).toBe(true);
        expect(unlinkSpy).not.toHaveBeenCalled();
      } finally {
        await killChild(child);
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