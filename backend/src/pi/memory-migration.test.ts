/**
 * memory-migration.test.ts — migration BUG-02 (nouvelle clé + bascule des données).
 *
 * Toutes les E/S se font dans un dossier temporaire : HOME est redirigé vers un
 * mkdtemp AVANT l'import des modules, donc MEMORY_ROOT ne touche JAMAIS le vrai
 * ~/.unipi (le dossier mémoire du service et la racine migrée sont sous le tmp).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let tmpHome: string;
let originalHome: string | undefined;
let caseRoot: string;
let memoryRoot: string;
let markerPath: string;
let migration: typeof import("./memory-migration.js");
let svc: typeof import("./memory-service.js");

beforeAll(async () => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "pi-memory-migration-"));
  process.env.HOME = tmpHome;
  vi.resetModules();
  migration = await import("./memory-migration.js");
  svc = await import("./memory-service.js");
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // nettoyage best-effort
  }
});

beforeEach(() => {
  caseRoot = mkdtempSync(path.join(tmpHome, "case-"));
  memoryRoot = path.join(caseRoot, "memory");
  markerPath = path.join(caseRoot, ".memory-migration-v2.json");
  mkdirSync(memoryRoot, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(caseRoot, { recursive: true, force: true });
  } catch {
    // nettoyage best-effort
  }
});

/** Crée un ancien dossier projet contenant un memory.json minimal. */
function makeLegacyDir(oldName: string, id: string): string {
  const dir = path.join(memoryRoot, oldName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "memory.json"),
    JSON.stringify(
      [
        {
          id,
          title: id,
          content: `contenu ${id}`,
          tags: "[]",
          project: oldName,
          type: "decision",
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-01T00:00:00.000Z",
        },
      ],
      null,
      2
    )
  );
  return dir;
}

const FIXED_NOW = () => new Date("2026-09-19T12:00:00.000Z");
const FIXED_STAMP = "2026-09-19T12-00-00-000Z";

describe("legacyProjectDirName / newProjectDirName", () => {
  it("reproduit EXACTEMENT l'ancienne règle", () => {
    expect(migration.legacyProjectDirName("/projects/a-b")).toBe("a_b");
    expect(migration.legacyProjectDirName("/projects/a_b")).toBe("a_b");
    expect(migration.legacyProjectDirName("/x/a/b")).toBe("b");
    expect(migration.legacyProjectDirName("/projets/_global_")).toBe("_global_");
  });

  it("la nouvelle règle est stable et identique au service", () => {
    const cwd = "/projects/monprojet";
    expect(migration.newProjectDirName(cwd)).toBe(svc.getProjectDirName(cwd));
    expect(migration.newProjectDirName(cwd)).toBe(migration.newProjectDirName(cwd));
  });
});

describe("buildMigrationPlan (pur)", () => {
  it("détecte le conflit a-b / a_b et produit deux cibles distinctes", () => {
    const plan = migration.buildMigrationPlan(
      [{ cwd: "/projects/a-b" }, { cwd: "/projects/a_b" }],
      memoryRoot
    );
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].oldName).toBe("a_b");
    expect(plan.moves).toHaveLength(2);
    expect(plan.moves.every((m) => m.conflict)).toBe(true);
    const targets = new Set(plan.moves.map((m) => m.newName));
    expect(targets.size).toBe(2);
  });

  it("marque comme réservé un projet dont l'ancien nom est _global_", () => {
    mkdirSync(path.join(memoryRoot, "_global_"));
    mkdirSync(path.join(memoryRoot, "global"));
    const plan = migration.buildMigrationPlan([{ cwd: "/projets/_global_" }], memoryRoot);
    expect(plan.moves[0].reserved).toBe(true);
    expect(plan.moves[0].newName).toMatch(/^_global_-[0-9a-f]{12}$/);
    expect(plan.legacyGlobal.sort()).toEqual(["_global_", "global"]);
    expect(plan.orphans).not.toContain("_global_");
  });

  it("classe en orphelin tout dossier non lié à un projet", () => {
    mkdirSync(path.join(memoryRoot, "orphelin"));
    const plan = migration.buildMigrationPlan([{ cwd: "/projects/x" }], memoryRoot);
    expect(plan.orphans).toContain("orphelin");
  });
});

describe("runMemoryMigration", () => {
  it("migre les données vers le nouveau dossier, sauvegarde et archive l'ancien", async () => {
    const cwd = "/projects/monprojet";
    const oldName = migration.legacyProjectDirName(cwd);
    makeLegacyDir(oldName, "memo_migree");

    const res = await migration.runMemoryMigration({
      memoryRootDir: memoryRoot,
      markerPath,
      projects: [{ cwd }],
      now: FIXED_NOW,
    });

    expect(res.ok).toBe(true);
    expect(res.moved).toBe(1);
    expect(res.aborted).toBe(false);

    // Données présentes dans le NOUVEAU dossier.
    const newDir = path.join(memoryRoot, migration.newProjectDirName(cwd));
    expect(existsSync(path.join(newDir, "memory.json"))).toBe(true);

    // Ancien dossier RENOMMÉ (jamais supprimé) → réversible.
    expect(existsSync(path.join(memoryRoot, oldName))).toBe(false);
    expect(existsSync(path.join(memoryRoot, `${oldName}.migrated-${FIXED_STAMP}`))).toBe(true);

    // Sauvegarde complète et vérifiée.
    const backups = readdirSync(caseRoot).filter((n) => n.startsWith("memory-backup-"));
    expect(backups).toHaveLength(1);
    expect(existsSync(path.join(caseRoot, backups[0], oldName, "memory.json"))).toBe(true);

    // Marqueur d'idempotence.
    expect(existsSync(markerPath)).toBe(true);
  });

  it("est idempotent (2e exécution = 0 move, marqueur présent)", async () => {
    const cwd = "/projects/monprojet";
    makeLegacyDir(migration.legacyProjectDirName(cwd), "memo_migree");

    const first = await migration.runMemoryMigration({
      memoryRootDir: memoryRoot,
      markerPath,
      projects: [{ cwd }],
      now: FIXED_NOW,
    });
    expect(first.moved).toBe(1);

    const second = await migration.runMemoryMigration({
      memoryRootDir: memoryRoot,
      markerPath,
      projects: [{ cwd }],
      now: FIXED_NOW,
    });
    expect(second.skipped).toBe(true);
    expect(second.moved).toBe(0);
  });

  it("en cas de conflit, duplique l'ancien contenu vers les DEUX nouveaux dossiers", async () => {
    const cwdA = "/projects/a-b";
    const cwdB = "/projects/a_b";
    makeLegacyDir("a_b", "commun");

    const res = await migration.runMemoryMigration({
      memoryRootDir: memoryRoot,
      markerPath,
      projects: [{ cwd: cwdA }, { cwd: cwdB }],
      now: FIXED_NOW,
    });

    expect(res.conflicts).toBe(1);
    const newA = path.join(memoryRoot, migration.newProjectDirName(cwdA));
    const newB = path.join(memoryRoot, migration.newProjectDirName(cwdB));
    expect(existsSync(path.join(newA, "memory.json"))).toBe(true);
    expect(existsSync(path.join(newB, "memory.json"))).toBe(true);
  });

  it("laisse les orphelins et la mémoire globale INTACTS", async () => {
    const cwd = "/projects/monprojet";
    makeLegacyDir(migration.legacyProjectDirName(cwd), "memo_migree");
    mkdirSync(path.join(memoryRoot, "orphelin"));
    writeFileSync(path.join(memoryRoot, "orphelin", "data.json"), "{}");
    mkdirSync(path.join(memoryRoot, "_global_"));
    writeFileSync(path.join(memoryRoot, "_global_", "memory.json"), "[]");

    await migration.runMemoryMigration({
      memoryRootDir: memoryRoot,
      markerPath,
      projects: [{ cwd }],
      now: FIXED_NOW,
    });

    expect(existsSync(path.join(memoryRoot, "orphelin", "data.json"))).toBe(true);
    expect(existsSync(path.join(memoryRoot, "_global_", "memory.json"))).toBe(true);
  });

  it("ABANDONNE sans rien modifier si la sauvegarde ne peut pas être vérifiée", async () => {
    const cwd = "/projects/monprojet";
    const oldName = migration.legacyProjectDirName(cwd);
    const oldDir = makeLegacyDir(oldName, "memo_migree");

    // backupRoot pointant sous un FICHIER → mkdir/copie impossible.
    const blocker = path.join(caseRoot, "blocker");
    writeFileSync(blocker, "x");

    const res = await migration.runMemoryMigration({
      memoryRootDir: memoryRoot,
      markerPath,
      projects: [{ cwd }],
      backupRoot: blocker,
      now: FIXED_NOW,
    });

    expect(res.aborted).toBe(true);
    expect(res.ok).toBe(false);
    // Rien n'a bougé : ancien dossier intact, pas de nouveau dossier, pas d'archive.
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(path.join(memoryRoot, migration.newProjectDirName(cwd)))).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("lecture/écriture via le service APRÈS migration (nouveau dossier)", async () => {
    // Ici la racine migrée est EXACTEMENT MEMORY_ROOT du service (tmp redirigé).
    const homeMemory = path.join(tmpHome, ".unipi", "memory");
    const cwd = "/projects/lisible";
    mkdirSync(homeMemory, { recursive: true });
    const legacy = path.join(homeMemory, migration.legacyProjectDirName(cwd));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      path.join(legacy, "memory.json"),
      JSON.stringify([
        {
          id: "memo_migree",
          title: "memo migrée",
          content: "contenu migré",
          tags: "[]",
          project: migration.legacyProjectDirName(cwd),
          type: "decision",
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-01T00:00:00.000Z",
        },
      ])
    );

    const res = await migration.runMemoryMigration({ memoryRootDir: homeMemory, projects: [{ cwd }] });
    expect(res.moved).toBe(1);

    // LECTURE : l'entrée migrée est visible via le service.
    const migrated = await svc.listMemories({ kind: "project", cwd });
    expect(migrated.map((e) => e.id)).toContain("memo_migree");

    // ÉCRITURE : une nouvelle entrée atterrit dans le même dossier.
    const up = await svc.upsertMemory(
      { kind: "project", cwd },
      { title: "Nouvelle decision", content: "contenu", type: "decision" }
    );
    expect(up.ok).toBe(true);

    const after = await svc.listMemories({ kind: "project", cwd });
    expect(after.map((e) => e.id)).toContain("nouvelle_decision");

    // Nettoyage : le marqueur par défaut vit sous tmpHome/.unipi.
    rmSync(path.join(tmpHome, ".unipi"), { recursive: true, force: true });
  });
});
