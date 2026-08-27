/**
 * Memory Service — store unique du système de mémoire à deux niveaux.
 *
 * Niveau global  : ~/.unipi/memory/_global_/  (préférences utilisateur, choix transverses)
 * Niveau projet  : ~/.unipi/memory/<projet>/  (décisions, patterns, résumés de compaction)
 *
 * Format de stockage : IDENTIQUE à l'extension compaction-checkpoint
 * (extensions/compaction-checkpoint/index.ts) pour cohabiter sur les mêmes
 * fichiers sans modification de l'extension :
 *   - table SQLite `memories` dans <dir>/memory.db (better-sqlite3 chargé
 *     dynamiquement en ESM, avec fallback JSON <dir>/memory.json si le module
 *     natif est indisponible).
 *
 * Lecture HYBRIDE : quand better-sqlite3 est disponible et que memory.db
 * existe, les lectures fusionnent SQLite ∪ memory.json (déduplication par id,
 * priorité à l'entrée la plus récemment `updated`). Cela évite tout
 * split-brain entre les deux formats : l'extension peut écrire dans l'un,
 * le service dans l'autre, aucune entrée n'est invisible.
 *
 * L'extension écrit des entrées de type "summary" (checkpoints de compaction) ;
 * ce service les lit mais ne les modifie jamais (les tools du LLM refusent
 * également de créer/supprimer des summaries).
 */

import path from "path";
import os from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// ─── Config ──────────────────────────────────────────────
const MEMORY_ROOT = path.join(os.homedir(), ".unipi", "memory");
const MAX_CONTENT_LENGTH = 15000;

// Budget total dur (~8000 chars) du bloc injecté dans le system prompt.
const INJECTION_BUDGET = 8000;

// Marge réservée aux marqueurs HTML ajoutés par buildMemoryContext côté
// session.ts ("\n\n<!-- PI_MEMORY_CONTEXT -->\n" + "\n<!-- /PI_MEMORY_CONTEXT -->")
// : le corps produit par buildMemoryInjection est mesuré sur le budget amputé
// de cette marge afin que le bloc COMPLET reste sous INJECTION_BUDGET.
const INJECTION_MARKER_MARGIN = 64;
const INJECTION_BODY_BUDGET = INJECTION_BUDGET - INJECTION_MARKER_MARGIN;

// Plafond d'entrées injectées par section (garde-fou anti-débordement massif).
const MAX_ENTRIES_PER_SECTION = 30;

// ─── Types ───────────────────────────────────────────────
export type MemoryType = "preference" | "decision" | "pattern" | "summary";
/** Types écrivables par le LLM (le summary est réservé à compaction-checkpoint). */
export type WritableMemoryType = Exclude<MemoryType, "summary">;

export type MemoryScope = { kind: "project"; cwd: string } | { kind: "global" };
/** Scope de recherche : un niveau précis ou "all" (fusion global + projet). */
export type SearchScope = MemoryScope | "all";

export interface SearchOptions {
  limit?: number;
  includeSummaries?: boolean;
  /** cwd du projet courant — requis pour résoudre le volet projet du scope "all". */
  cwd?: string;
}

/** Entrée mémoire normalisée (tags parsés, scope d'origine résolu). */
export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  project: string;
  type: MemoryType;
  created: string;
  updated: string;
  scope: "project" | "global";
}

export interface MemoryUpsertResult {
  ok: boolean;
  id: string;
  created: boolean;
}

export interface MemoryDeleteResult {
  ok: boolean;
  reason?: "not_found" | "summary_protected" | "storage_error";
}

interface RawMemoryRecord {
  id: string;
  title: string;
  content: string;
  tags: string; // JSON sérialisé (format disque identique à l'extension)
  project: string;
  type: MemoryType;
  created: string;
  updated: string;
  embedding?: string | null;
}

// ─── Chemins ─────────────────────────────────────────────

/**
 * Règle de nommage du dossier projet — doit rester synchronisée avec
 * getProjectName() de l'extension compaction-checkpoint :
 * path.basename(cwd).replace(/[^a-zA-Z0-9_]/g, "_").
 * Les deux composants lisent/écrivent le même dossier ~/.unipi/memory/<nom>/.
 */
function getProjectDirName(cwd: string): string {
  return path.basename(cwd).replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Dossier mémoire du projet correspondant à un cwd. */
export function getProjectMemoryDir(cwd: string): string {
  return path.join(MEMORY_ROOT, getProjectDirName(cwd));
}

/**
 * Dossier mémoire global (préférences utilisateur transverses).
 *
 * Le nom "_global_" (et non "global") est RÉSERVÉ : un projet dont
 * basename(cwd) === "global" aurait sinon exactement le même dossier que la
 * mémoire globale (collision dossier projet/global).
 * Risque résiduel ACCEPTÉ : la sanitization partagée [^a-zA-Z0-9_]→_ conserve
 * le caractère "_", donc un répertoire de projet nommé littéralement
 * "_global_" entrerait encore en collision — cas jugé improbable.
 * Aucune migration : les mémoires globales viennent d'être introduites sous
 * l'ancien nom "global", rien n'existe encore en prod.
 */
export function getGlobalMemoryDir(): string {
  return path.join(MEMORY_ROOT, "_global_");
}

function resolveScopeInfo(scope: MemoryScope): { dir: string; name: "project" | "global"; projectName: string } {
  if (scope.kind === "project") {
    const projectName = getProjectDirName(scope.cwd);
    return { dir: path.join(MEMORY_ROOT, projectName), name: "project", projectName };
  }
  return { dir: getGlobalMemoryDir(), name: "global", projectName: "global" };
}

// ─── Slug & utilitaires ──────────────────────────────────

/** Slug d'id : même règle que l'extension (id TEXT PRIMARY KEY). */
function slugifyTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** Troncature du contenu long : même forme que l'extension. */
function truncateContent(content: string): string {
  if (content.length > MAX_CONTENT_LENGTH) {
    return content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[... truncated]`;
  }
  return content;
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function normalizeEntry(row: RawMemoryRecord, scope: "project" | "global"): MemoryEntry {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? "",
    tags: parseTags(row.tags),
    project: row.project ?? "",
    type: row.type,
    created: row.created ?? "",
    updated: row.updated ?? "",
    scope,
  };
}

function sortByUpdatedDesc(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}

// ─── Chargement better-sqlite3 (une seule fois, comme l'extension) ───

// Cache du constructeur better-sqlite3 : chargé UNE fois (promesse partagée
// pour dédupliquer les appels concurrents).
let DatabaseCtor: any | undefined;
let databaseUnavailable = false;
let databaseLoadPromise: Promise<any | null> | null = null;

function loadBetterSqlite3(): Promise<any | null> {
  if (DatabaseCtor) return Promise.resolve(DatabaseCtor);
  if (databaseUnavailable) return Promise.resolve(null);
  if (!databaseLoadPromise) {
    databaseLoadPromise = (async () => {
      try {
        // Import dynamique ESM : ne fait pas planter le backend si la dépendance
        // native n'est pas disponible dans le runtime. Le spécificateur passe par
        // une variable pour ne pas être résolu statiquement par TypeScript
        // (better-sqlite3 n'est pas une dépendance directe du backend).
        const specifier = "better-sqlite3";
        const mod = await import(specifier);
        DatabaseCtor = (mod as any).default ?? mod;
        return DatabaseCtor;
      } catch (err) {
        databaseUnavailable = true;
        // Erreur VISIBLE au boot (une seule fois grâce au cache de promesse) :
        // sans better-sqlite3 le service ne peut PAS lire memory.db — les
        // entrées présentes uniquement en SQLite (ex. checkpoints écrits par
        // compaction-checkpoint) deviennent invisibles (split-brain).
        console.error(
          `[memory-service] ERREUR : better-sqlite3 indisponible (${(err as Error).message}).\n` +
            `[memory-service] Le service bascule sur le stockage JSON seul : les entrées présentes uniquement dans memory.db seront INVISIBLES.\n` +
            `[memory-service] Correctif : installer better-sqlite3 (optionalDependencies du backend) puis reconstruire/relancer.`
        );
        return null;
      }
    })();
  }
  return databaseLoadPromise;
}

// DDL partagé — identique à celui de l'extension compaction-checkpoint.
const MEMORIES_DDL = `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        project TEXT,
        type TEXT,
        created TEXT,
        updated TEXT,
        embedding TEXT
      );
`;

/**
 * Ouvre (et crée au besoin) la base SQLite d'un dossier mémoire.
 * Retourne null si better-sqlite3 est indisponible ou la base inutilisable
 * → l'appelant bascule alors sur le fallback JSON.
 */
async function openDb(dbPath: string): Promise<any | null> {
  const Database = await loadBetterSqlite3();
  if (!Database) return null;
  return openDbWith(Database, dbPath);
}

/**
 * Ouverture synchrone (après préchauffage du cache module).
 * Réservée aux chemins LECTURE/purge : ne crée JAMAIS le fichier de base — si
 * memory.db n'existe pas encore, retourne null immédiatement pour éviter
 * qu'une simple lecture ne crée des fichiers par effet de bord. L'appelant
 * bascule alors sur le JSON (lui aussi lu sans création de fichier).
 */
function openDbSync(dbPath: string): any | null {
  if (!DatabaseCtor) return null;
  if (!existsSync(dbPath)) return null;
  return openDbWith(DatabaseCtor, dbPath);
}

function openDbWith(Database: any, dbPath: string): any | null {
  let db: any = null;
  try {
    // Crée le dossier parent si nécessaire ; better-sqlite3 crée le fichier
    // de base lorsqu'il n'existe pas encore.
    mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);

    // DDL identique à l'extension compaction-checkpoint (cohabitation).
    db.exec(MEMORIES_DDL);

    // Évite les erreurs SQLITE_BUSY quand l'extension écrit simultanément.
    db.pragma("busy_timeout = 3000");

    return db;
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {
        // On ignore l'erreur de fermeture pour ne pas masquer l'erreur d'ouverture.
      }
    }
    console.warn(`[memory-service] Impossible d'ouvrir/créer ${dbPath} : ${(err as Error).message}`);
    return null;
  }
}

// ─── Fallback JSON (mêmes règles que l'extension) ────────

function getJsonPath(dir: string): string {
  return path.join(dir, "memory.json");
}

function loadJsonMemories(dir: string): RawMemoryRecord[] {
  const jsonPath = getJsonPath(dir);
  if (!existsSync(jsonPath)) return [];

  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    return Array.isArray(parsed) ? (parsed as RawMemoryRecord[]) : [];
  } catch (err) {
    console.warn(`[memory-service] Fichier mémoire illisible ${jsonPath} : ${(err as Error).message}`);
    return [];
  }
}

function saveJsonMemories(dir: string, memories: RawMemoryRecord[]): boolean {
  const jsonPath = getJsonPath(dir);
  try {
    mkdirSync(path.dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(memories, null, 2), "utf8");
    return true;
  } catch (err) {
    console.warn(`[memory-service] Impossible d'écrire ${jsonPath} : ${(err as Error).message}`);
    return false;
  }
}

function upsertJsonMemory(
  dir: string,
  projectName: string,
  title: string,
  content: string,
  type: MemoryType,
  tags: string[]
): boolean {
  const id = slugifyTitle(title);
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(tags);

  const memories = loadJsonMemories(dir);
  const existing = memories.find((m) => m.id === id);

  if (existing) {
    existing.title = title;
    existing.content = content;
    existing.tags = tagsJson;
    existing.type = type;
    existing.updated = now;
    existing.embedding = null;
  } else {
    memories.push({
      id,
      title,
      content,
      tags: tagsJson,
      project: projectName,
      type,
      created: now,
      updated: now,
      embedding: null,
    });
  }

  return saveJsonMemories(dir, memories);
}

// ─── Lecture générique d'un dossier (hybride SQLite ∪ JSON) ──

interface ScopeTarget {
  dir: string;
  name: "project" | "global";
}

/**
 * Fusionne deux listes d'entrées en dédupliquant par id, avec priorité à
 * l'entrée la plus récemment mise à jour (`updated`) — à égalité, l'entrée de
 * la première liste gagne (SQLite = source primaire).
 */
function mergeEntriesById(primary: MemoryEntry[], secondary: MemoryEntry[]): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>();
  for (const e of primary) byId.set(e.id, e);
  for (const e of secondary) {
    const current = byId.get(e.id);
    if (!current || e.updated > current.updated) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/**
 * Lit TOUTES les entrées d'un dossier en mode HYBRIDE :
 *   - si better-sqlite3 est disponible ET que memory.db existe → lecture SQLite ;
 *   - PUIS fusion avec memory.json s'il existe aussi (déduplication par id,
 *     priorité à l'entrée la plus récemment `updated`) ;
 *   - si better-sqlite3 est indisponible → lecture JSON seule (fallback).
 *
 * Lecture pure : aucun fichier n'est créé par effet de bord — si memory.db et
 * memory.json sont absents, retourne [] sans toucher au disque.
 */
async function readAllFromDir(target: ScopeTarget): Promise<MemoryEntry[]> {
  await loadBetterSqlite3();

  const dbPath = path.join(target.dir, "memory.db");
  const jsonPath = getJsonPath(target.dir);
  const hasDb = !!DatabaseCtor && existsSync(dbPath); // jamais de création en lecture
  const hasJson = existsSync(jsonPath);

  if (!hasDb && !hasJson) return [];

  // 1) Lecture SQLite (si disponible).
  const sqliteEntries: MemoryEntry[] = [];
  if (hasDb) {
    let db: any = null;
    try {
      db = openDbSync(dbPath);
      if (db) {
        const rows = db
          .prepare("SELECT id, title, content, tags, project, type, created, updated FROM memories")
          .all() as RawMemoryRecord[];
        sqliteEntries.push(...rows.map((r) => normalizeEntry(r, target.name)));
      }
    } catch (err) {
      // La lecture SQLite échoue, mais memory.json reste lisible : on continue
      // avec les entrées JSON pour ne rien perdre.
      console.warn(`[memory-service] Erreur de lecture (${dbPath}) : ${(err as Error).message}`);
    } finally {
      if (db) db.close();
    }
  }

  // 2) Lecture JSON puis fusion dédupliquée (SQLite ∪ JSON).
  const jsonEntries = hasJson
    ? loadJsonMemories(target.dir).map((r) => normalizeEntry(r, target.name))
    : [];

  if (sqliteEntries.length > 0 && jsonEntries.length > 0) {
    return mergeEntriesById(sqliteEntries, jsonEntries);
  }
  return sqliteEntries.length > 0 ? sqliteEntries : jsonEntries;
}

// ─── API publique : écriture ─────────────────────────────

/**
 * Neutralise les marqueurs de commentaire HTML dans le titre et le contenu :
 * `<!--` → `‹--` et `-->` → `--›`. Sans cela, une mémoire contenant ces
 * séquences fermerait prématurément le bloc `<!-- PI_MEMORY_CONTEXT -->`
 * injecté dans le system prompt (session.ts) : le reste du bloc « fuirait »
 * hors du commentaire, ouvrirait la porte à une injection via ce canal.
 * Les caractères de remplacement ‹ › n'appartiennent pas au jeu < > : la
 * neutralisation est idempotente et ne peut pas recréer de marqueur.
 */
function neutralizeHtmlCommentMarkers(text: string): string {
  return text.replace(/<!--/g, "‹--").replace(/-->/g, "--›");
}

/**
 * Crée ou met à jour une mémoire (upsert par id = slug du titre).
 * - Le titre est normalisé (whitespace aplati, trim, max 120 chars) et les
 *   marqueurs de commentaire HTML sont neutralisés dans titre ET contenu
 *   (protection du bloc system prompt, voir neutralizeHtmlCommentMarkers).
 * - Le contenu est tronqué à MAX_CONTENT_LENGTH (comme l'extension).
 * - En cas de mise à jour : `created` est conservé, `embedding` repart à NULL.
 */
export async function upsertMemory(
  scope: MemoryScope,
  data: { title: string; content: string; type: WritableMemoryType; tags?: string[] }
): Promise<MemoryUpsertResult> {
  // Titre borné : whitespace aplati, trim, puis troncature à 120 caractères.
  const title = neutralizeHtmlCommentMarkers(
    (data.title || "").replace(/\s+/g, " ").trim().slice(0, 120)
  );
  // Contenu tronqué, puis marqueurs HTML neutralisés (même raison que le titre).
  const content = neutralizeHtmlCommentMarkers(truncateContent(data.content || ""));
  const type = data.type;
  const tags = Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === "string") : [];
  const id = slugifyTitle(title);
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(tags);

  if (!id || id === "_") return { ok: false, id: "", created: false };

  const info = resolveScopeInfo(scope);

  let db: any = null;
  try {
    db = await openDb(path.join(info.dir, "memory.db"));
    if (!db) {
      // better-sqlite3 absent ou base inutilisable : on écrit au format JSON
      // pour ne rien perdre (même dégradation que l'extension).
      const existedBefore = loadJsonMemories(info.dir).some((m) => m.id === id);
      const ok = upsertJsonMemory(info.dir, info.projectName, title, content, type, tags);
      return { ok, id, created: ok && !existedBefore };
    }

    const existing = db.prepare("SELECT id FROM memories WHERE id = ?").get(id) as { id: string } | undefined;

    if (existing) {
      // UPDATE conserve `created` (création initiale) et reset l'embedding.
      db.prepare(
        `
        UPDATE memories SET title = ?, content = ?, tags = ?, type = ?, updated = ?, embedding = NULL
        WHERE id = ?
      `
      ).run(title, content, tagsJson, type, now, id);
      return { ok: true, id, created: false };
    }

    db.prepare(
      `
      INSERT INTO memories (id, title, content, tags, project, type, created, updated, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `
    ).run(id, title, content, tagsJson, info.projectName, type, now, now);
    return { ok: true, id, created: true };
  } catch (err) {
    console.warn(`[memory-service] Erreur d'écriture mémoire : ${(err as Error).message}`);
    return { ok: false, id, created: false };
  } finally {
    if (db) db.close();
  }
}

// ─── API publique : lecture ──────────────────────────────

/**
 * Recherche par sous-chaîne insensible à la casse (title+content+tags).
 * Cherche dans l'UNION des enregistrements des cibles (SQLite ∪ JSON,
 * dédupliqués par dossier via readAllFromDir), puis filtre, trie par updated
 * DESC et limite. Un seul chemin de code pour les deux formats de stockage :
 * aucune divergence possible entre les moteurs SQLite et JSON.
 * - Exclut les entrées de type "summary" sauf includeSummaries=true.
 * - scope "all" fusionne global + projet (cwd requis via opts.cwd).
 */
export async function searchMemories(
  scope: SearchScope,
  query: string,
  opts?: SearchOptions
): Promise<MemoryEntry[]> {
  // Limite : entier borné [1..50]. Le paramètre provient du LLM et peut être
  // fractionnaire ou invalide (NaN exclu explicitement avant Math.floor).
  const rawLimit =
    typeof opts?.limit === "number" && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 8;
  const limit = Math.max(1, Math.min(rawLimit, 50));
  const includeSummaries = opts?.includeSummaries === true;
  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  const needleLower = trimmed.toLowerCase();

  // Résolution des cibles selon le scope.
  const targets: ScopeTarget[] = [];
  if (scope === "all") {
    targets.push({ dir: getGlobalMemoryDir(), name: "global" });
    if (opts?.cwd) targets.push({ dir: getProjectMemoryDir(opts.cwd), name: "project" });
  } else {
    const info = resolveScopeInfo(scope);
    targets.push({ dir: info.dir, name: info.name });
  }

  await loadBetterSqlite3();

  // Union des enregistrements de toutes les cibles (hybride SQLite ∪ JSON),
  // puis filtre / tri / limite en mémoire.
  const all: MemoryEntry[] = [];
  for (const target of targets) {
    all.push(...(await readAllFromDir(target)));
  }

  const matches = all
    .filter((e) => (includeSummaries ? true : e.type !== "summary"))
    .filter((e) => `${e.title}\n${e.content}\n${e.tags.join(",")}`.toLowerCase().includes(needleLower));

  return sortByUpdatedDesc(matches).slice(0, limit);
}

/**
 * Liste toutes les entrées d'un scope (lecture hybride SQLite ∪ JSON),
 * triées par updated DESC. Les summaries sont exclus sauf includeSummaries.
 */
export async function listMemories(
  scope: MemoryScope,
  opts?: { includeSummaries?: boolean }
): Promise<MemoryEntry[]> {
  const includeSummaries = opts?.includeSummaries === true;
  const info = resolveScopeInfo(scope);
  const entries = await readAllFromDir({ dir: info.dir, name: info.name });
  const filtered = includeSummaries ? entries : entries.filter((e) => e.type !== "summary");
  return sortByUpdatedDesc(filtered);
}

// ─── API publique : suppression ──────────────────────────

/**
 * Supprime une mémoire par id (slug) OU par titre exact.
 * REFUSE les entrées de type "summary" (réservées aux checkpoints de
 * compaction écrits par l'extension).
 */
export async function deleteMemory(scope: MemoryScope, idOrTitle: string): Promise<MemoryDeleteResult> {
  const input = (idOrTitle || "").trim();
  if (!input) return { ok: false, reason: "not_found" };

  const candidateId = slugifyTitle(input);
  const info = resolveScopeInfo(scope);

  await loadBetterSqlite3();

  if (DatabaseCtor) {
    const dbPath = path.join(info.dir, "memory.db");
    let db: any = null;
    try {
      db = openDbSync(dbPath);
      if (!db) return deleteJsonMemory(info.dir, input, candidateId);

      const row = db
        .prepare("SELECT id, title, type FROM memories WHERE id = ? OR title = ?")
        .get(candidateId, input) as { id: string; title: string; type: MemoryType } | undefined;

      if (!row) {
        // Cohérence avec la lecture HYBRIDE : l'entrée peut n'exister que dans
        // memory.json (format legacy/hybride co-écrit par l'extension) — on
        // tente la suppression JSON avant de conclure à not_found.
        return deleteJsonMemory(info.dir, input, candidateId);
      }
      if (row.type === "summary") return { ok: false, reason: "summary_protected" };

      db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
      return { ok: true };
    } catch (err) {
      console.warn(`[memory-service] Erreur de suppression (${dbPath}) : ${(err as Error).message}`);
      return { ok: false, reason: "storage_error" };
    } finally {
      if (db) db.close();
    }
  }

  return deleteJsonMemory(info.dir, input, candidateId);
}

function deleteJsonMemory(dir: string, input: string, candidateId: string): MemoryDeleteResult {
  const memories = loadJsonMemories(dir);
  const row = memories.find((m) => m.id === candidateId || m.title === input);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.type === "summary") return { ok: false, reason: "summary_protected" };

  const remaining = memories.filter((m) => m !== row);
  const ok = saveJsonMemories(dir, remaining);
  return ok ? { ok: true } : { ok: false, reason: "storage_error" };
}

// ─── Injection system prompt ─────────────────────────────

// Ordre de priorité des types dans la section « Profil utilisateur ».
const GLOBAL_TYPE_ORDER: Record<WritableMemoryType, number> = {
  preference: 0,
  decision: 1,
  pattern: 2,
};

/** Troncature compacte d'une entrée pour l'injection (whitespace aplati). */
function truncateForInjection(content: string, max: number): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + " […]";
}

function renderMemorySection(title: string, entries: MemoryEntry[], maxPerEntry: number): string {
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e) => `- **${e.title}** [${e.type}] : ${truncateForInjection(e.content, maxPerEntry)}`
  );
  return `## ${title}\n\n${lines.join("\n")}`;
}

function renderInjection(globalEntries: MemoryEntry[], projectEntries: MemoryEntry[], limits: { global: number; project: number }): string {
  const parts: string[] = [];
  const globalSection = renderMemorySection("Profil utilisateur (mémoire globale)", globalEntries, limits.global);
  if (globalSection) parts.push(globalSection);
  const projectSection = renderMemorySection("Mémoire projet", projectEntries, limits.project);
  if (projectSection) parts.push(projectSection);
  return parts.join("\n\n");
}

/**
 * Construit le corps du bloc mémoire injectable dans le system prompt :
 *   1. « Profil utilisateur (mémoire globale) » — toutes les entrées globales
 *      sauf summary, ordre preference→decision→pattern, troncature ~400 chars.
 *   2. « Mémoire projet » — toutes les entrées projet sauf summary, tri
 *      updated DESC, troncature ~500 chars.
 *   Chaque section est plafonnée à MAX_ENTRIES_PER_SECTION entrées.
 *
 * Budget total dur ~8000 chars : le corps est mesuré sur INJECTION_BODY_BUDGET
 * (= INJECTION_BUDGET - 64, marge des marqueurs ajoutés par buildMemoryContext
 * côté session.ts). En cas de dépassement, les troncatures par entrée sont
 * resserrées progressivement, puis slicing final de sécurité.
 * Retourne une chaîne VIDE s'il n'y a aucune mémoire à injecter.
 */
export async function buildMemoryInjection(cwd: string): Promise<string> {
  const [globalEntries, projectEntries] = await Promise.all([
    listMemories({ kind: "global" }),
    listMemories({ kind: "project", cwd }),
  ]);

  if (globalEntries.length === 0 && projectEntries.length === 0) return "";

  // Tri global : preference → decision → pattern, puis updated DESC à type égal,
  // plafonné au nombre max d'entrées par section.
  const orderedGlobal = [...globalEntries]
    .sort((a, b) => {
      const ra = GLOBAL_TYPE_ORDER[a.type as WritableMemoryType] ?? 99;
      const rb = GLOBAL_TYPE_ORDER[b.type as WritableMemoryType] ?? 99;
      if (ra !== rb) return ra - rb;
      return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0;
    })
    .slice(0, MAX_ENTRIES_PER_SECTION);

  // listMemories tri déjà par updated DESC — on garantit l'invariant localement.
  const orderedProject = sortByUpdatedDesc(projectEntries).slice(0, MAX_ENTRIES_PER_SECTION);

  // Paliers de troncature (global/projet) appliqués tant que le budget déborde.
  const tiers = [
    { global: 400, project: 500 },
    { global: 200, project: 250 },
    { global: 100, project: 120 },
  ];

  let body = "";
  for (const tier of tiers) {
    body = renderInjection(orderedGlobal, orderedProject, tier);
    if (body.length <= INJECTION_BODY_BUDGET) return body;
  }

  // Garde-fou dur : slice final si même le dernier palier déborde (le suffixe
  // est compté dans le budget pour garantir corps ≤ INJECTION_BODY_BUDGET).
  const overflowSuffix = "\n\n[…]";
  return body.slice(0, Math.max(0, INJECTION_BODY_BUDGET - overflowSuffix.length)) + overflowSuffix;
}
