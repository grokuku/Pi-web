/**
 * memory-migration.ts — migration BUG-02 des dossiers mémoire projet.
 *
 * Contexte : l'ancienne clé de dossier `path.basename(cwd)` nettoyée faisait
 * collisionner deux projets distincts (`/projects/a-b` et `/projects/a_b`) sur
 * le MÊME dossier, et un projet nommé `_global_` sur la mémoire globale. La
 * nouvelle clé (memory-service.getProjectDirName) suffixe le nom d'une empreinte
 * sha256 du chemin absolu, ce qui rend toute collision impossible.
 *
 * Ce module déplace les données existantes de l'ancien dossier vers le nouveau,
 * SANS JAMAIS RIEN PERDRE :
 *   1. sauvegarde COMPLÈTE de `~/.unipi/memory` → `~/.unipi/memory-backup-<ISO>`
 *      avec vérification stricte (recomptage fichiers + somme des tailles) ;
 *      toute divergence ⇒ ABANDON TOTAL (rien n'est modifié) ;
 *   2. copie de chaque ancien dossier vers le(s) nouveau(x) ;
 *   3. l'ancien dossier est RENOMMÉ `<ancien>.migrated-<ts>` (jamais supprimé) :
 *      la migration est RÉVERSIBLE par simple renommage inverse ;
 *   4. les dossiers ne correspondant à aucun projet (orphelins) sont LAISSÉS
 *      INTACTS, ainsi que la mémoire globale (`_global_`, `global`).
 *
 * Cas indécidable : plusieurs projets partageant le même ancien nom (ex.
 * `a-b`/`a_b`). Le contenu commun est copié vers CHAQUE nouveau dossier
 * (attribution possiblement imparfaite, mais ZÉRO PERTE) et un WARNING est émis.
 *
 * Idempotence : marqueur `~/.unipi/.memory-migration-v2.json` — une fois écrit,
 * les exécutions suivantes ne font plus rien.
 */

import path from "path";
import os from "os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  renameSync,
  cpSync,
  writeFileSync,
} from "fs";
import { getProjectDirName } from "./memory-service.js";

// Noms de dossier réservés à la mémoire globale : JAMAIS déplacés ni comptés
// comme orphelins. "global" = ancien nom legacy, "_global_" = nom actuel.
const RESERVED_GLOBAL_NAMES = ["global", "_global_"];

// ─── Types ───────────────────────────────────────────────

/** Entrée minimale attendue : un projet dispose au moins de son cwd absolu. */
export interface MigrationProject {
  cwd: string;
}

export interface MigrationMove {
  cwd: string;
  /** Ancien dossier (règle historique). */
  oldName: string;
  /** Nouveau dossier (règle hybride slug-empreinte). */
  newName: string;
  /** Ancien dossier partagé par ≥2 projets → attribution indécidable. */
  conflict: boolean;
  /** Ancien nom réservé à la mémoire globale → JAMAIS déplacé. */
  reserved: boolean;
}

export interface MigrationConflict {
  oldName: string;
  cwds: string[];
}

export interface MigrationPlan {
  /** Tous les déplacements projet → nouveau dossier (conflits inclus). */
  moves: MigrationMove[];
  /** Anciens dossiers partagés par plusieurs projets (indémêlables). */
  conflicts: MigrationConflict[];
  /** Dossiers présents dans memoryRoot mais liés à aucun projet (intacts). */
  orphans: string[];
  /** Dossiers de mémoire globale présents (intacts). */
  legacyGlobal: string[];
}

export interface BackupResult {
  ok: boolean;
  backupPath: string | null;
  files: number;
  bytes: number;
  sourceFiles: number;
  sourceBytes: number;
  reason?: string;
}

export interface MemoryMigrationOptions {
  /** Racine mémoire (défaut : ~/.unipi/memory). */
  memoryRootDir?: string;
  /** Projets à migrer (défaut : getAllProjects()). */
  projects?: MigrationProject[];
  /** Fichier marqueur d'idempotence. */
  markerPath?: string;
  /** Dossier parent des sauvegardes (défaut : parent de memoryRootDir). */
  backupRoot?: string;
  /** Horloge injectable (tests). */
  now?: () => Date;
}

export interface MemoryMigrationResult {
  ok: boolean;
  aborted: boolean;
  skipped: boolean;
  reason?: string;
  backupPath: string | null;
  moved: number;
  skippedMoves: number;
  conflicts: number;
  orphans: number;
  durationMs: number;
  plan: MigrationPlan;
}

// ─── Règles de nommage ───────────────────────────────────

/**
 * ANCIENNE règle de nommage — conservée à l'identique pour retrouver les
 * dossiers historiques lors de la migration. Ne JAMAIS l'utiliser pour de
 * nouvelles écritures.
 */
export function legacyProjectDirName(cwd: string): string {
  return path.basename(cwd).replace(/[^a-zA-Z0-9_]/g, "_");
}

/** NOUVELLE règle — déléguée à memory-service pour garantir la synchronisation. */
export function newProjectDirName(cwd: string): string {
  return getProjectDirName(cwd);
}

function isReservedGlobalName(name: string): boolean {
  return RESERVED_GLOBAL_NAMES.includes(name);
}

// ─── Plan de migration (pur : aucune écriture) ────────────

/**
 * Construit le plan de migration à partir des projets et du contenu actuel de
 * la racine mémoire. Fonction PURE au sens où elle ne modifie rien sur le
 * disque (elle lit seulement la liste des dossiers existants).
 */
export function buildMigrationPlan(projects: MigrationProject[], memoryRootDir: string): MigrationPlan {
  // Regroupement par ancien nom : détecte les collisions historiques.
  const byOldName = new Map<string, string[]>();
  for (const project of projects) {
    if (!project?.cwd) continue;
    const oldName = legacyProjectDirName(project.cwd);
    const cwds = byOldName.get(oldName);
    if (cwds) cwds.push(project.cwd);
    else byOldName.set(oldName, [project.cwd]);
  }

  const moves: MigrationMove[] = [];
  const conflicts: MigrationConflict[] = [];
  const referencedOldNames = new Set<string>();

  for (const [oldName, cwds] of byOldName) {
    const conflict = cwds.length > 1;
    const reserved = isReservedGlobalName(oldName);
    for (const cwd of cwds) {
      moves.push({ cwd, oldName, newName: newProjectDirName(cwd), conflict, reserved });
      if (!reserved) referencedOldNames.add(oldName);
    }
    if (conflict) conflicts.push({ oldName, cwds });
  }

  const existingDirs = existsSync(memoryRootDir)
    ? readdirSync(memoryRootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

  const orphans = existingDirs.filter(
    (name) => !referencedOldNames.has(name) && !isReservedGlobalName(name)
  );
  const legacyGlobal = existingDirs.filter((name) => isReservedGlobalName(name));

  return { moves, conflicts, orphans, legacyGlobal };
}

// ─── Sauvegarde vérifiée ─────────────────────────────────

/** Recompte récursivement fichiers et octets d'un dossier (lecture seule). */
function measureDir(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = measureDir(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      try {
        bytes += statSync(full).size;
      } catch {
        // Fichier disparu entre-temps : compté tout de même, taille ignorée.
      }
    }
  }
  return { files, bytes };
}

/**
 * Sauvegarde COMPLÈTE de la racine mémoire, avec vérification stricte :
 * la copie est acceptée uniquement si le nombre de fichiers ET la somme des
 * tailles coïncident exactement avec la source. Toute divergence ⇒ ok=false et
 * l'appelant DOIT abandonner la migration sans rien modifier.
 *
 * Si la racine mémoire n'existe pas (installation neuve), retourne ok=true avec
 * backupPath=null : il n'y a rien à sauvegarder.
 */
export function backupMemoryRoot(
  memoryRootDir: string,
  opts?: { backupRoot?: string; timestamp?: string }
): BackupResult {
  if (!existsSync(memoryRootDir)) {
    return { ok: true, backupPath: null, files: 0, bytes: 0, sourceFiles: 0, sourceBytes: 0 };
  }

  const parent = opts?.backupRoot ?? path.dirname(memoryRootDir);
  const stamp = (opts?.timestamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const backupPath = path.join(parent, `memory-backup-${stamp}`);

  const source = measureDir(memoryRootDir);
  try {
    mkdirSync(backupPath, { recursive: true });
    cpSync(memoryRootDir, backupPath, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      backupPath,
      files: 0,
      bytes: 0,
      sourceFiles: source.files,
      sourceBytes: source.bytes,
      reason: `copie de sauvegarde impossible : ${(err as Error).message}`,
    };
  }

  const copy = measureDir(backupPath);
  if (copy.files !== source.files || copy.bytes !== source.bytes) {
    return {
      ok: false,
      backupPath,
      files: copy.files,
      bytes: copy.bytes,
      sourceFiles: source.files,
      sourceBytes: source.bytes,
      reason:
        `vérification de sauvegarde en échec (source ${source.files} fichier(s)/${source.bytes} o, ` +
        `copie ${copy.files} fichier(s)/${copy.bytes} o)`,
    };
  }

  return {
    ok: true,
    backupPath,
    files: copy.files,
    bytes: copy.bytes,
    sourceFiles: source.files,
    sourceBytes: source.bytes,
  };
}

// ─── Exécution best-effort idempotente ───────────────────

function writeMarker(markerPath: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.warn(`[memory-migration] Impossible d'écrire le marqueur ${markerPath} : ${(err as Error).message}`);
  }
}

const EMPTY_PLAN: MigrationPlan = { moves: [], conflicts: [], orphans: [], legacyGlobal: [] };

/**
 * Exécute la migration des dossiers mémoire. Best-effort : ne jette jamais.
 *
 * Ordre STRICT :
 *   1. marqueur présent → no-op (idempotence) ;
 *   2. racine absente → no-op ;
 *   3. SAUVEGARDE VÉRIFIÉE → en cas d'échec, ABANDON TOTAL (aucune modif) ;
 *   4. plan → copie vers le(s) nouveau(x) dossier(s) → renommage des anciens
 *      en `<ancien>.migrated-<ts>` (jamais supprimés) → marqueur.
 */
export async function runMemoryMigration(opts: MemoryMigrationOptions = {}): Promise<MemoryMigrationResult> {
  const started = Date.now();
  const memoryRootDir = opts.memoryRootDir ?? path.join(os.homedir(), ".unipi", "memory");
  const markerPath =
    opts.markerPath ?? path.join(path.dirname(memoryRootDir), ".memory-migration-v2.json");

  // 1) Idempotence : marqueur déjà écrit → aucun travail.
  if (existsSync(markerPath)) {
    return {
      ok: true,
      aborted: false,
      skipped: true,
      reason: "marqueur de migration déjà présent",
      backupPath: null,
      moved: 0,
      skippedMoves: 0,
      conflicts: 0,
      orphans: 0,
      durationMs: Date.now() - started,
      plan: EMPTY_PLAN,
    };
  }

  // 2) Rien à migrer sur une installation neuve (pas de marqueur : on re-vérifie
  //    au prochain boot, un volume peut être monté plus tard).
  if (!existsSync(memoryRootDir)) {
    return {
      ok: true,
      aborted: false,
      skipped: true,
      reason: "aucune racine mémoire à migrer",
      backupPath: null,
      moved: 0,
      skippedMoves: 0,
      conflicts: 0,
      orphans: 0,
      durationMs: Date.now() - started,
      plan: EMPTY_PLAN,
    };
  }

  let projects = opts.projects;
  if (!projects) {
    // Import paresseux : évite de charger tout le graphe projet (manager, routes)
    // quand l'appelant fournit déjà la liste (tests, CLI avancée).
    const { getAllProjects } = await import("../projects/manager.js");
    projects = getAllProjects().map((p) => ({ cwd: p.cwd }));
  }

  // 3) SAUVEGARDE AVANT TOUTE MODIFICATION. Un échec ⇒ abandon total : la copie
  //    est en lecture seule, la source n'a donc pas été touchée. On nettoie la
  //    sauvegarde partielle et on laisse le marqueur absent (nouvel essai possible).
  const now = opts.now?.() ?? new Date();
  const backup = backupMemoryRoot(memoryRootDir, {
    backupRoot: opts.backupRoot,
    timestamp: now.toISOString(),
  });
  if (!backup.ok) {
    if (backup.backupPath) {
      try {
        rmSync(backup.backupPath, { recursive: true, force: true });
      } catch {
        // nettoyage best-effort
      }
    }
    console.warn(`[memory-migration] ABANDON : ${backup.reason}`);
    return {
      ok: false,
      aborted: true,
      skipped: false,
      reason: backup.reason,
      backupPath: backup.backupPath,
      moved: 0,
      skippedMoves: 0,
      conflicts: 0,
      orphans: 0,
      durationMs: Date.now() - started,
      plan: EMPTY_PLAN,
    };
  }

  const plan = buildMigrationPlan(projects, memoryRootDir);
  const stamp = now.toISOString().replace(/[:.]/g, "-");

  // 4) Déplacements : regroupe par ancien dossier (un seul traitement par dossier,
  //    avec 1..N cibles en cas de conflit). La mémoire globale (reserved) est ignorée.
  const byOldName = new Map<string, MigrationMove[]>();
  for (const move of plan.moves) {
    if (move.reserved) continue;
    const group = byOldName.get(move.oldName);
    if (group) group.push(move);
    else byOldName.set(move.oldName, [move]);
  }

  let moved = 0;
  let skippedMoves = 0;

  for (const [oldName, group] of byOldName) {
    const sourceDir = path.join(memoryRootDir, oldName);
    if (!existsSync(sourceDir)) {
      // Déjà migré (ou jamais eu de données) : rien à faire.
      skippedMoves += 1;
      continue;
    }

    const targets = [...new Set(group.map((m) => m.newName))];
    let allCopied = true;
    for (const target of targets) {
      const targetDir = path.join(memoryRootDir, target);
      try {
        mkdirSync(targetDir, { recursive: true });
        // Copie entrée par entrée : fusion déterministe même si le dossier cible
        // existe déjà (ré-exécution partielle, conflit).
        for (const entry of readdirSync(sourceDir)) {
          cpSync(path.join(sourceDir, entry), path.join(targetDir, entry), { recursive: true });
        }
      } catch (err) {
        allCopied = false;
        console.warn(
          `[memory-migration] copie ${oldName} → ${target} impossible : ${(err as Error).message}`
        );
      }
    }

    if (!allCopied) {
      // Ancien dossier conservé tel quel : les données restent récupérables et la
      // prochaine exécution réessaiera (le marqueur n'est pas encore écrit).
      console.warn(`[memory-migration] archivage de ${oldName} reporté (copie incomplète)`);
      continue;
    }

    const archiveName = `${oldName}.migrated-${stamp}`;
    try {
      renameSync(sourceDir, path.join(memoryRootDir, archiveName));
      moved += 1;
    } catch (err) {
      console.warn(
        `[memory-migration] renommage de ${oldName} → ${archiveName} impossible : ${(err as Error).message}`
      );
    }
  }

  const reservedCollisions = plan.moves.filter((m) => m.reserved).length;
  if (reservedCollisions > 0) {
    console.warn(
      `[memory-migration] ${reservedCollisions} projet(s) dont l'ancien nom est réservé à la mémoire ` +
        `globale : dossier NON déplacé (données globales préservées).`
    );
  }
  for (const conflict of plan.conflicts) {
    if (conflict.cwds.length > 1 && !isReservedGlobalName(conflict.oldName)) {
      console.warn(
        `[memory-migration] CONFLIT : ${conflict.cwds.length} projets partagent l'ancien dossier ` +
          `"${conflict.oldName}" (${conflict.cwds.join(", ")}) → contenu dupliqué vers chaque nouveau dossier.`
      );
    }
  }

  const result: MemoryMigrationResult = {
    ok: true,
    aborted: false,
    skipped: false,
    backupPath: backup.backupPath,
    moved,
    skippedMoves,
    conflicts: plan.conflicts.length,
    orphans: plan.orphans.length,
    durationMs: Date.now() - started,
    plan,
  };

  // Marqueur écrit APRÈS une passe complète : garantit l'idempotence (2e run = 0).
  writeMarker(markerPath, {
    version: 2,
    completedAt: new Date().toISOString(),
    backupPath: backup.backupPath,
    moved,
    skippedMoves,
    conflicts: plan.conflicts.length,
    orphans: plan.orphans.length,
  });

  console.log(
    `[memory-migration] terminé en ${result.durationMs} ms — moved=${moved} skipped=${skippedMoves} ` +
      `conflicts=${result.conflicts} orphans=${result.orphans} backup=${backup.backupPath ?? "(aucune donnée)"}`
  );

  return result;
}
