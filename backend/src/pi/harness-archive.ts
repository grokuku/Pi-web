/**
 * harness-archive.ts — Archivage « boîte noire » des délégués en échec
 * (P0 OBSERVABILITÉ, volet 1/2).
 *
 * Problème : le harness (extensions/harness-orchestrator/index.ts) détruisait
 * le fichier de session JSONL du délégué dans le `finally` quel que soit
 * l'issue (unlinkSync) →
 * aucun diagnostic post-mortem possible (timeout, erreur modèle, réponse vide…).
 *
 * Solution : en cas d'ÉCHEC uniquement, le fichier de session est ARCHIVÉ
 * dans `.data/logs/harness/` :
 *   <YYYYMMDD-HHMMSS>-<fonction>-<cause-courte>.jsonl   (copie de la session)
 *   <même-nom>.meta.json                                (contexte de l'échec)
 * En cas de SUCCÈS, le fichier est supprimé comme avant (pas de pollution).
 *
 * Rétention : purge simple des archives de plus de 7 jours (mtime), effectuée
 * paresseusement à chaque écriture — pas de cron.
 *
 * Les helpers de nommage/classification sont PURS (testés dans
 * harness-archive.test.ts) ; seules purgeExpiredArchives / archiveFailedSession /
 * logHarnessEvent ont des effets de bord, tous best-effort : un échec
 * d'archivage ne doit JAMAIS masquer l'erreur du délégué lui-même.
 *
 * NOTE rollback harness+cbm (étape A) : ce module reste dans BACKEND/src/pi/
 * (pas dans extensions/) car il dépend du logger backend (utils/logger.ts) et
 * de la racine projet (.data). Il est importé par l'extension
 * harness-orchestrator via un chemin relatif résolu par jiti ; conserver le
 * test ici garantit qu'il reste scanné par vitest (backend/vitest.config.ts).
 */

import {
  appendFileSync,
  copyFileSync,
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
// Convention DATA_DIR du backend (cf. utils/logger.ts, pi/providers.ts) :
// <racine projet>/.data — 3 niveaux depuis pi/ (même profondeur en src/dev via
// tsx et en dist/prod via node : src/pi ≡ dist/pi).
// NOTE rollback : ce module vit dans backend/src/pi/ (et non plus dans
// l'extension) car il dépend du logger backend ET de la racine projet ; il est
// importé par l'extension harness-orchestrator via jiti (chemin relatif).
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
/** Dossier d'archivage des sessions déléguées en échec. */
export const HARNESS_ARCHIVE_DIR = path.join(DATA_DIR, "logs", "harness");
/** Rétention des archives : 7 jours — purge au moment d'écrire, pas de cron. */
export const ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// ── Causes d'échec (classification) ──────────────────────

export type HarnessFailureCause =
  | "timeout-inactivite"
  | "timeout-global"
  | "abort-utilisateur"
  | "abort-session"
  | "erreur-modele"
  | "reponse-vide"
  | "erreur-sdk"
  | "erreur-exception";

/**
 * Classe un message d'erreur en cause courte. FILET de sécurité : les points
 * d'échec du harness annotent explicitement la cause (archiveCause) ; ce
 * classifieur ne sert que pour les exceptions non annotées (remontées au
 * catch interne/externe). Le défaut est "erreur-exception" : une cause
 * inconnue reste un ÉCHEC → archivage quand même (on ne perd jamais la boîte
 * noire par défaut).
 */
export function classifyFailure(message: string): HarnessFailureCause {
  const msg = String(message || "").toLowerCase();
  // P2 : « abort-utilisateur » exige une PREUVE d'abandon utilisateur (le
  // message doit mentionner l'utilisateur). Tout autre abort est INTERNE
  // (timeout de session, shutdown, switchMode, reloadModelRegistry) : on
  // l'étiquette « abort-session », jamais « abort-utilisateur ».
  if (msg.includes("utilisateur")) return "abort-utilisateur";
  if (msg.includes("abort")) return "abort-session";
  if (msg.includes("timeout global")) return "timeout-global";
  // "inact" couvre "inactivité" (fr) et "inactivity" (en) — mêmes messages.
  if (msg.includes("inact")) return "timeout-inactivite";
  // Erreurs LLM/provider courantes (setModel, appels API) — BUG-68 : le SDK
  // les transforme aussi en messages assistant vides, mais en cas d'exception
  // explicite (setModel, fetch) on veut la cause dans la meta.
  if (
    msg.includes("api key") ||
    msg.includes("unauthorized") ||
    msg.includes("rate limit") ||
    msg.includes("overloaded") ||
    msg.includes("401") ||
    msg.includes("429")
  ) {
    return "erreur-modele";
  }
  return "erreur-exception";
}

// ── Helpers purs : nommage de l'archive ──────────────────

/** <YYYYMMDD>-<HHMMSS> en heure LOCALE (lisibilité opérateur, cf. logger.ts). */
export function formatArchiveTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * Slug FS-safe : minuscules, accents retirés, tout hors [a-z0-9] → "-",
 * borné à 40 chars. Défaut "cause" pour une entrée vide.
 */
export function slugifyCause(raw: string): string {
  const slug = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "cause";
}

/**
 * Nom d'archive (sans extension) : <YYYYMMDD-HHMMSS>-<fonction>-<cause>.
 * Le fichier JSONL est <nom>.jsonl et ses métadonnées <nom>.meta.json.
 */
export function buildArchiveBaseName(now: Date, functionName: string, cause: string): string {
  return `${formatArchiveTimestamp(now)}-${slugifyCause(functionName)}-${slugifyCause(cause)}`;
}

// ── Métadonnées ──────────────────────────────────────────

/** Contexte d'échec fourni par le harness (harness.ts). */
export interface HarnessArchiveInfo {
  /** Fonction déléguée : planning / execute / review / integrate. */
  functionName: string;
  /** Cause courte (HarnessFailureCause annoté explicitement, ou filet). */
  cause: string;
  /** Tentatives de prompt réellement jouées (1 retry max sur inactivité). */
  attempts: number;
  /** Nombre d'events reçus du sous-agent (0 = mort avant tout événement). */
  eventCount: number;
  /** Epoch ms du dernier event reçu, null si aucun. */
  lastEventAt: number | null;
  /** "provider/model" effectifs (diagnostic) — "?" si inconnu. */
  model: string;
  /** Durée totale de la délégation (ms). */
  durationMs: number;
  /** Extrait court du dernier événement. */
  lastEventExcerpt: string;
  /** Message d'erreur s'il existe. */
  errorMessage?: string;
}

/** Métadonnées JSON écrites à côté de l'archive (<nom>.meta.json). */
export function buildArchiveMeta(
  info: HarnessArchiveInfo,
  archivedAt: Date,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    archivedAt: archivedAt.toISOString(),
    function: info.functionName,
    cause: info.cause,
    attempts: info.attempts,
    eventCount: info.eventCount,
    lastEventAtMs: info.lastEventAt,
    lastEventAt: info.lastEventAt === null ? null : new Date(info.lastEventAt).toISOString(),
    model: info.model,
    durationMs: info.durationMs,
    lastEventExcerpt: info.lastEventExcerpt,
  };
  if (info.errorMessage) meta.errorMessage = info.errorMessage;
  return meta;
}

// ── Effets de bord (best-effort, jamais d'exception vers l'appelant) ──

/**
 * Purge les fichiers d'archive (*.jsonl et *.meta.json) de plus de
 * retentionMs (mtime). Retourne le nombre de fichiers supprimés.
 */
export function purgeExpiredArchives(
  dir: string,
  nowMs: number = Date.now(),
  retentionMs: number = ARCHIVE_RETENTION_MS,
): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // répertoire absent : rien à purger
  }
  const cutoff = nowMs - retentionMs;
  let purged = 0;
  for (const name of entries) {
    // *.jsonl (session) et *.meta.json (métadonnées) uniquement.
    if (!/\.jsonl(\.meta\.json)?$/.test(name)) continue;
    try {
      const full = path.join(dir, name);
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full);
        purged++;
      }
    } catch {
      // fichier verrouillé ou disparu : on passe au suivant
    }
  }
  return purged;
}

/** backend-20250108.log — date LOCALE (même convention que utils/logger.ts). */
function backendLogFileName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `backend-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}.log`;
}

/** JSON compact tolérant aux échecs (même esprit que safeStringify du logger). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Fallback minimal : appendFileSync vers backend-<date>.log, dans le MÊME
 * répertoire que le logger partagé (PI_WEB_LOGS_DIR surcharge — indispensable
 * pour l'isolation des tests, cf. logger.test.ts / harness-archive.test.ts).
 */
function appendFallbackLog(line: string): void {
  try {
    const dir = process.env.PI_WEB_LOGS_DIR || path.join(DATA_DIR, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, backendLogFileName(new Date())), line + "\n");
  } catch {
    // dernier recours : silencieux (console a déjà la trace via l'appelant)
  }
}

/**
 * Trace l'archivage dans le journal backend du jour.
 *
 * Utilise le logger partagé (backend/src/utils/logger.ts — volet 2/2 du P0)
 * SI le module est disponible ; sinon fallback appendFileSync vers
 * .data/logs/backend-<YYYYMMDD>.log (MÊME nom de fichier que le logger,
 * date locale, rollover à minuit) pour ne pas bloquer le volet 1 en
 * attendant que le volet 2 soit câblé/commité.
 *
 * Import dynamique fire-and-forget : jamais bloquant, jamais lancant.
 */
export function logHarnessEvent(
  level: "info" | "warn" | "error",
  message: string,
  details?: unknown,
): void {
  // Ligne de fallback alignée sur formatLine() du logger partagé, MÊME
  // catégorie « harness » : un grep sur [harness] trouve tous les événements,
  // quel que soit le chemin (logger partagé ou fallback).
  // <ISO> [NIVEAU] [categorie] message | details-JSON
  const fallbackLine =
    `${new Date().toISOString()} [${level.toUpperCase()}] [harness] ${message}` +
    (details === undefined ? "" : ` | ${safeJson(details)}`);
  try {
    void import("../utils/logger.js")
      .then(({ logger }) => {
        logger[level]("harness", message, details);
      })
      .catch(() => {
        appendFallbackLog(fallbackLine);
      });
  } catch {
    appendFallbackLog(fallbackLine);
  }
}

/**
 * Archive le fichier de session JSONL d'un délégué en échec (best-effort).
 *
 * 1. COPIE <sessionFile> → <dir>/<base>.jsonl (suffixe -2, -3… en cas de
 *    collision : deux échecs à la même seconde pour la même fonction).
 * 2. Écrit <dir>/<base>.meta.json avec le contexte de l'échec.
 * 3. Purge les archives de plus de 7 jours (rétention simple).
 * 4. Trace une ligne dans le log backend du jour (logger partagé si dispo).
 *
 * Retourne le chemin de l'archive, ou null en cas d'échec. L'original N'EST
 * PAS supprimé ici : l'appelant (harness.ts) le supprime uniquement après un
 * archivage réussi — mieux vaut un résidu qu'une boîte noire perdue.
 */
export function archiveFailedSession(
  sessionFile: string,
  info: HarnessArchiveInfo,
  opts?: { dir?: string; now?: Date },
): string | null {
  const dir = opts?.dir ?? HARNESS_ARCHIVE_DIR;
  const now = opts?.now ?? new Date();
  try {
    if (!existsSync(sessionFile)) return null; // rien à archiver
    mkdirSync(dir, { recursive: true });
    purgeExpiredArchives(dir, now.getTime());

    const base = buildArchiveBaseName(now, info.functionName, info.cause);
    let baseName = base;
    for (let i = 2; existsSync(path.join(dir, `${baseName}.jsonl`)); i++) {
      baseName = `${base}-${i}`;
    }

    const archivePath = path.join(dir, `${baseName}.jsonl`);
    copyFileSync(sessionFile, archivePath);

    const metaPath = path.join(dir, `${baseName}.meta.json`);
    writeFileSync(metaPath, JSON.stringify(buildArchiveMeta(info, now), null, 2) + "\n");

    logHarnessEvent(
      "warn",
      `Délégué ${info.functionName} en échec — session archivée (cause: ${info.cause})`,
      {
        archive: archivePath,
        meta: metaPath,
        attempts: info.attempts,
        eventCount: info.eventCount,
        model: info.model,
        durationMs: info.durationMs,
        errorMessage: info.errorMessage,
      },
    );
    return archivePath;
  } catch (e: any) {
    logHarnessEvent(
      "error",
      `Archivage de la session déléguée impossible : ${e?.message || e}`,
      { sessionFile, cause: info.cause },
    );
    return null;
  }
}