/**
 * cbm-stats.ts — persistance CUMULÉE des compteurs d'observabilité CBM.
 *
 * PROBLÈME : les compteurs `usage` et `failures` de l'extension
 * extensions/codebase-memory vivent dans globalThis et sont remis à zéro à
 * chaque redémarrage → impossible de suivre l'adoption de CBM dans le temps.
 *
 * SOLUTION : un instantané CUMULÉ (tous les process confondus) est persisté
 * best-effort dans <racine>/.data/cbm-stats.json — même racine que les autres
 * données applicatives (model-library.json, providers.json, harness-notes/…).
 *
 * ROBUSTESSE / RÉTENTION :
 *  - fichier UNIQUE écrasé à chaque flush : aucune rotation nécessaire car un
 *    instantané « depuis toujours » reste minuscule (< 5 Ko) — il ne contient
 *    que des compteurs agrégés et des maps bornées par le nombre de tools /
 *    motifs d'échec (pas les entrées `recent`, volontairement non cumulées) ;
 *  - écriture ATOMIQUE (fichier temporaire + rename) : un kill en plein flush
 *    ne laisse jamais un JSON tronqué ;
 *  - fichier absent ou corrompu → repart proprement de ZÉRO (jamais
 *    d'exception, jamais de blocage du démarrage).
 *
 * Module de logique PURE (normalisation/agrégation) + I/O best-effort isolée.
 * Testé dans cbm-stats.test.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Convention DATA_DIR du backend (cf. utils/logger.ts, pi/harness-archive.ts) :
// <racine projet>/.data — 3 niveaux depuis pi/ (identique en src/dev via tsx et
// en dist/prod via node : src/pi ≡ dist/pi).
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");

/** Chemin de l'instantané cumulé (surchargeable par les tests). */
export const CBM_STATS_FILE = path.join(DATA_DIR, "cbm-stats.json");
/** Version du format persisté (pour une éventuelle migration). */
export const CBM_STATS_VERSION = 1;

/** Compteurs ok/fail d'un tool CBM (forme de `usage.byTool`). */
export interface CbmToolCounts {
  ok: number;
  fail: number;
}

/** Compteurs d'usage cumulés (hors jauge `indexedProjects` et `since`). */
export interface CbmUsageCounters {
  totalCalls: number;
  totalErrors: number;
  byTool: Record<string, CbmToolCounts>;
  byMode: Record<string, number>;
}

/** Compteurs d'échecs cumulés (hors anneau `recent`). */
export interface CbmFailureCounters {
  total: number;
  byTool: Record<string, number>;
  byReason: Record<string, number>;
  repoMap: { served: number; empty: number };
}

/** Instantané cumulé persisté dans .data/cbm-stats.json. */
export interface CbmCumulativeStats {
  version: number;
  /** Premier démarrage du cumul (ISO). */
  since: string;
  /** Dernière écriture (ISO). */
  updatedAt: string;
  usage: CbmUsageCounters;
  failures: CbmFailureCounters;
}

// ── Helpers PURS ────────────────────────────────────────

/** Coerce une valeur en entier ≥ 0 fini (robustesse fichier corrompu). */
function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Compteurs d'usage vides. */
export function emptyUsageCounters(): CbmUsageCounters {
  return { totalCalls: 0, totalErrors: 0, byTool: {}, byMode: {} };
}

/** Compteurs d'échecs vides. */
export function emptyFailureCounters(): CbmFailureCounters {
  return { total: 0, byTool: {}, byReason: {}, repoMap: { served: 0, empty: 0 } };
}

/** Instantané cumulé vide (nouveau départ). */
export function emptyCumulativeStats(nowIso: string): CbmCumulativeStats {
  return {
    version: CBM_STATS_VERSION,
    since: nowIso,
    updatedAt: nowIso,
    usage: emptyUsageCounters(),
    failures: emptyFailureCounters(),
  };
}

/** Additionne deux maps de compteurs simples (clés absentes = 0). */
function addNumberMap(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(a)) out[k] = num(a[k]);
  for (const k of Object.keys(b)) out[k] = num(out[k]) + num(b[k]);
  return out;
}

/** Additionne des compteurs ok/fail par tool. */
function addToolCounts(
  a: Record<string, CbmToolCounts>,
  b: Record<string, CbmToolCounts>,
): Record<string, CbmToolCounts> {
  const out: Record<string, CbmToolCounts> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = { ok: num(a[k]?.ok) + num(b[k]?.ok), fail: num(a[k]?.fail) + num(b[k]?.fail) };
  }
  return out;
}

/** Additionne deux jeux de compteurs d'usage (pure, sans mutation). */
export function addUsageCounters(a: CbmUsageCounters, b: CbmUsageCounters): CbmUsageCounters {
  return {
    totalCalls: num(a.totalCalls) + num(b.totalCalls),
    totalErrors: num(a.totalErrors) + num(b.totalErrors),
    byTool: addToolCounts(a.byTool ?? {}, b.byTool ?? {}),
    byMode: addNumberMap(a.byMode ?? {}, b.byMode ?? {}),
  };
}

/** Additionne deux jeux de compteurs d'échecs (pure, sans mutation). */
export function addFailureCounters(a: CbmFailureCounters, b: CbmFailureCounters): CbmFailureCounters {
  return {
    total: num(a.total) + num(b.total),
    byTool: addNumberMap(a.byTool ?? {}, b.byTool ?? {}),
    byReason: addNumberMap(a.byReason ?? {}, b.byReason ?? {}),
    repoMap: {
      served: num(a.repoMap?.served) + num(b.repoMap?.served),
      empty: num(a.repoMap?.empty) + num(b.repoMap?.empty),
    },
  };
}

/**
 * Normalise un instantané brut (issu d'un fichier potentiellement partiel ou
 * corrompu) en un instantané valide. Ne jette jamais ; les champs manquants ou
 * invalides retombent à zéro.
 */
export function normalizeCumulativeStats(raw: unknown, nowIso: string): CbmCumulativeStats {
  const base = emptyCumulativeStats(nowIso);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<CbmCumulativeStats>;
  const usage = (r.usage ?? {}) as Partial<CbmUsageCounters>;
  const failures = (r.failures ?? {}) as Partial<CbmFailureCounters>;

  const byToolUsage: Record<string, CbmToolCounts> = {};
  for (const k of Object.keys(usage.byTool ?? {})) {
    byToolUsage[k] = { ok: num(usage.byTool![k]?.ok), fail: num(usage.byTool![k]?.fail) };
  }

  return {
    version: CBM_STATS_VERSION,
    since: typeof r.since === "string" && r.since ? r.since : nowIso,
    updatedAt: typeof r.updatedAt === "string" && r.updatedAt ? r.updatedAt : nowIso,
    usage: {
      totalCalls: num(usage.totalCalls),
      totalErrors: num(usage.totalErrors),
      byTool: byToolUsage,
      byMode: { ...(usage.byMode ?? {}) },
    },
    failures: {
      total: num(failures.total),
      byTool: { ...(failures.byTool ?? {}) },
      byReason: { ...(failures.byReason ?? {}) },
      repoMap: {
        served: num(failures.repoMap?.served),
        empty: num(failures.repoMap?.empty),
      },
    },
  };
}

/**
 * Construit la vue CUMULÉE = base persistée + compteurs de la session courante.
 *
 * `indexedProjects` (jauge, non cumulable) et `recent` (anneau glissant de
 * session) sont volontairement EXCLUS de la vue cumulée : les additionner
 * n'aurait pas de sens d'un redémarrage à l'autre.
 */
export function accumulateCumulativeStats(
  base: CbmCumulativeStats,
  sessionUsage: Partial<CbmUsageCounters> | null | undefined,
  sessionFailures: Partial<CbmFailureCounters> | null | undefined,
  nowIso: string,
): CbmCumulativeStats {
  const deltaUsage: CbmUsageCounters = {
    totalCalls: num(sessionUsage?.totalCalls),
    totalErrors: num(sessionUsage?.totalErrors),
    byTool: sessionUsage?.byTool ?? {},
    byMode: sessionUsage?.byMode ?? {},
  };
  const deltaFailures: CbmFailureCounters = {
    total: num(sessionFailures?.total),
    byTool: sessionFailures?.byTool ?? {},
    byReason: sessionFailures?.byReason ?? {},
    repoMap: {
      served: num(sessionFailures?.repoMap?.served),
      empty: num(sessionFailures?.repoMap?.empty),
    },
  };
  return {
    version: CBM_STATS_VERSION,
    since: base.since,
    updatedAt: nowIso,
    usage: addUsageCounters(base.usage, deltaUsage),
    failures: addFailureCounters(base.failures, deltaFailures),
  };
}

// ── I/O best-effort (jamais bloquante) ──────────────────

/**
 * Charge l'instantané persisté, ou null si absent/corrompu. Ne jette JAMAIS :
 * un fichier illisible signifie simplement « repartir de zéro ».
 */
export function loadCbmStats(file: string = CBM_STATS_FILE): CbmCumulativeStats | null {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf-8");
    return normalizeCumulativeStats(JSON.parse(raw), new Date().toISOString());
  } catch {
    return null;
  }
}

/**
 * Écrit l'instantané de façon ATOMIQUE et best-effort. Renvoie true en cas de
 * succès, false sinon — n'expose JAMAIS d'exception à l'appelant (une panne de
 * persistance ne doit pas casser un appel outil CBM).
 */
export function persistCbmStats(stats: CbmCumulativeStats, file: string = CBM_STATS_FILE): boolean {
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(stats, null, 2), "utf-8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
