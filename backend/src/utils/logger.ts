/**
 * logger.ts — Logger FICHIER backend (P0 Observabilité, volet 2/2).
 *
 * Problème : avant ce module, toutes les erreurs/crashes partaient en stdout
 * Docker = volatile (perdu au restart, invisible depuis l'UI).
 *
 * Solution : chaque entrée est dupliquée dans `<racine>/.data/logs/` :
 *   - backend-YYYYMMDD.log    → une ligne par événement (info/warn/error)
 *   - crash-<ISO>-<pid>.json  → dump complet de crash, écrit SYNCHRONEMENT
 *                               pour survivre au process.exit(1) des handlers
 *
 * La sortie console (stdout) est CONSERVÉE pour `docker logs`.
 * Purge : les fichiers de plus de 14 jours sont supprimés à l'initialisation
 * (pas de cron — cf. purgeOldLogs, appelé paresseusement au 1er write).
 *
 * Anti-boucle console→fichier→console : le module capture sa référence
 * PRISTINE de console.error à l'import ; le miroir console passe par cette
 * référence, jamais par le wrapper installé par installConsoleCapture().
 *
 * Détails d'usage et lecture des logs : docs/logs-backend.md.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Même convention que utils/origins.ts : <racine projet>/.data — 3 niveaux
// depuis backend/dist/utils (prod node) comme depuis backend/src/utils (dev tsx).
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");

export type LogLevel = "info" | "warn" | "error";
export type CrashType = "uncaughtException" | "unhandledRejection";

/** Durée de rétention des fichiers de log (jours) — purge à l'init. */
const RETENTION_DAYS = 14;
/** Ring buffer des dernières lignes, inclus dans les dumps de crash. */
const MAX_RECENT_EVENTS = 50;
/** Garde-fou anti-lignes monstres dans le fichier. */
const MAX_LINE_LENGTH = 8000;

// ── Références console PRISTINES (capturées avant tout wrapping) ──
const rawConsoleError = console.error.bind(console);
const rawConsoleWarn = console.warn.bind(console);
const rawConsoleLog = console.log.bind(console);

// ── Helpers purs (testés dans logger.test.ts) ─────────────────

/** backend-20250108.log — date LOCALE (rollover à minuit local). */
export function logFileNameFor(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `backend-${y}${m}${d}.log`;
}

/** crash-2025-01-08T12-00-00-000Z-1234.json — `:` et `.` remplacés (FS Windows). */
export function crashFileNameFor(date: Date, pid: number): string {
  const iso = date.toISOString().replace(/[:.]/g, "-");
  return `crash-${iso}-${pid}.json`;
}

/** JSON compact tolérant aux échecs (références circulaires, BigInt, ...). */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

/** Une ligne de log : `<ISO> [NIVEAU] [categorie] message | details-JSON`. */
export function formatLine(
  level: LogLevel,
  category: string,
  message: string,
  details?: unknown
): string {
  const base = `${new Date().toISOString()} [${level.toUpperCase()}] [${category}] ${message}`;
  return details === undefined ? base : `${base} | ${safeStringify(details)}`;
}

// ── État module ───────────────────────────────────────────────

let initDone = false;
let fileDisabled = false; // bascule console-seul si le FS devient indisponible
let inCapture = false; // garde anti-réentrance du wrapper console.error
let captureInstalled = false;

const recentEvents: string[] = [];

/** Répertoire des logs : `<racine>/.data/logs`, surchargeable pour les tests. */
export function getLogsDir(): string {
  return process.env.PI_WEB_LOGS_DIR || path.join(DATA_DIR, "logs");
}

function truncate(line: string, max: number = MAX_LINE_LENGTH): string {
  return line.length > max ? `${line.slice(0, max)}…[tronqué]` : line;
}

/**
 * Purge simple : supprime backend-*.log et crash-*.json de plus de
 * RETENTION_DAYS jours (mtime). Sans cron — appelée une fois à l'init.
 */
export function purgeOldLogs(dir: string = getLogsDir(), now: Date = new Date()): void {
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // répertoire absent : rien à purger
  }
  for (const name of entries) {
    if (!/^(backend-\d{8}\.log|crash-.*\.json)$/.test(name)) continue;
    try {
      const full = path.join(dir, name);
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      // fichier verrouillé ou disparu : on passe au suivant
    }
  }
}

function ensureInit(): void {
  if (initDone) return;
  initDone = true;
  try {
    const dir = getLogsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    purgeOldLogs(dir);
  } catch (e) {
    rawConsoleWarn("[logger] init impossible (logs fichier désactivés):", e);
    fileDisabled = true;
  }
}

function appendLine(line: string): boolean {
  if (fileDisabled) return false;
  try {
    // mkdirSync à chaque écriture : négligeable (logs peu fréquents) et rend
    // le module robuste si le dossier est recréé/supprimé à chaud.
    mkdirSync(getLogsDir(), { recursive: true });
    appendFileSync(path.join(getLogsDir(), logFileNameFor(new Date())), line + "\n");
    return true;
  } catch (e) {
    // On désactive définitivement l'écriture fichier (pas de spam d'erreurs)
    // mais la sortie console reste fonctionnelle : dégradation propre.
    fileDisabled = true;
    rawConsoleWarn("[logger] écriture fichier impossible (bascule console-seul):", e);
    return false;
  }
}

function remember(line: string): void {
  recentEvents.push(truncate(line, 500));
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
}

function write(level: LogLevel, category: string, message: string, details?: unknown): void {
  const line = truncate(formatLine(level, category, message, details));
  // Miroir console (stdout docker) via les références pristine → hors wrapper.
  if (level === "error") rawConsoleError(line);
  else if (level === "warn") rawConsoleWarn(line);
  else rawConsoleLog(line);
  remember(line);
  ensureInit();
  appendLine(line);
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  return safeStringify(arg);
}

// ── API publique ──────────────────────────────────────────────

export const logger = {
  info(category: string, message: string, details?: unknown): void {
    write("info", category, message, details);
  },
  warn(category: string, message: string, details?: unknown): void {
    write("warn", category, message, details);
  },
  error(category: string, message: string, details?: unknown): void {
    write("error", category, message, details);
  },

  /** Copie des dernières lignes loggées (incluse dans les dumps de crash). */
  recentEventsSnapshot(): string[] {
    return [...recentEvents];
  },

  /**
   * Dump de crash SYNCHRONE (`writeFileSync`) — DOIT survivre au
   * process.exit(1) déclenché ~1s plus tard par les handlers de index.ts.
   * Ne lève JAMAIS : un échec de log ne doit pas masquer l'erreur d'origine.
   * Retourne le chemin du fichier écrit, ou null en cas d'échec.
   */
  crash(
    error: unknown,
    type: CrashType,
    context?: Record<string, unknown>
  ): string | null {
    const now = new Date();
    const err = error as { name?: string; message?: string; stack?: string } | null;
    const mem = process.memoryUsage();
    const mb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
    const payload = {
      timestamp: now.toISOString(),
      type,
      name: err?.name ?? typeof error,
      // Raison non-Error : string brute si possible, sinon JSON compact.
      message: err?.message ?? (typeof error === "string" ? error : safeStringify(error)),
      stack: err?.stack ?? null,
      context: context ?? null,
      process: {
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        memory_mb: {
          rss: mb(mem.rss),
          heapUsed: mb(mem.heapUsed),
          heapTotal: mb(mem.heapTotal),
          external: mb(mem.external),
        },
      },
      recentEvents: [...recentEvents],
    };
    try {
      const dir = getLogsDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = path.join(dir, crashFileNameFor(now, process.pid));
      // writeFileSync (pas append) : un dump = un fichier autonome JSON valide.
      writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
      // Trace résumée dans le journal du jour aussi (grep facile), sans miroir
      // console : le handler de index.ts affiche déjà le bloc lisible.
      appendLine(truncate(formatLine("error", "crash", payload.message as string, { file })));
      return file;
    } catch (e) {
      rawConsoleError("[logger] écriture du dump de crash impossible:", e);
      return null;
    }
  },
};

/**
 * Duplique tout `console.error` « extérieur » (modules, SDK, startup...) vers
 * le fichier du jour. Idempotent. Anti-boucle double :
 *  1. le logger écrit via rawConsoleError (référence pristine) → hors wrapper ;
 *  2. le wrapper se ré-entoure jamais (flag inCapture).
 */
export function installConsoleCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;
  const original = rawConsoleError;
  console.error = (...args: unknown[]) => {
    original(...args); // stdout docker préservé à l'identique
    if (inCapture || fileDisabled) return;
    inCapture = true;
    try {
      const line = truncate(formatLine("error", "console", args.map(stringifyArg).join(" ")));
      remember(line);
      appendLine(line);
    } catch {
      // La capture ne doit jamais faire planter l'app.
    } finally {
      inCapture = false;
    }
  };
}