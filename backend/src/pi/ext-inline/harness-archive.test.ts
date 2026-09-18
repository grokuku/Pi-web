/**
 * harness-archive.test.ts — tests des helpers d'archivage des délégués
 * (P0 OBSERVABILITÉ, volet 1/2).
 *
 * - Les helpers PURS (nommage, classification, métadonnées) sont testés
 *   directement.
 * - Les fonctions à effet de bord (purge, archivage) sont testées dans un
 *   dossier temporaire de l'OS (mkdtemp) — JAMAIS le vrai .data du repo.
 * - Les écritures de LOG (trace d'archivage via le logger partagé ou son
 *   fallback) sont isolées dans un dossier temporaire via PI_WEB_LOGS_DIR,
 *   même pattern que logger.test.ts — sinon elles pollueraient le VRAI
 *   .data/logs/backend-<aujourd'hui>.log du repo.
 */
import { afterAll, beforeAll, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import {
  archiveFailedSession,
  buildArchiveBaseName,
  buildArchiveMeta,
  classifyFailure,
  formatArchiveTimestamp,
  purgeExpiredArchives,
  slugifyCause,
  type HarnessArchiveInfo,
} from "./harness-archive.js";

// Date de référence fixe : 2026-08-01 12:34:56 locale.
const FIXED_NOW = new Date(2026, 7, 1, 12, 34, 56);

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "harness-archive-test-"));
}

// ── Isolation des écritures de log (cf. logger.test.ts) ──
// logHarnessEvent (appelé par archiveFailedSession) écrit dans le journal du
// jour via le logger partagé — ou son fallback. PI_WEB_LOGS_DIR redirige les
// DEUX vers un dossier temporaire : rien n'atteint le vrai .data/logs.
let logsTmp: string;

beforeAll(async () => {
  logsTmp = mkdtempSync(path.join(os.tmpdir(), "harness-archive-logs-"));
  process.env.PI_WEB_LOGS_DIR = logsTmp;
  // Pré-charge le logger partagé : l'import dynamique (fire-and-forget) de
  // logHarnessEvent se résout alors en microtasks, AVANT le teardown — aucune
  // écriture différée ne peut s'échapper après le nettoyage.
  await import("../../utils/logger.js");
});

afterAll(async () => {
  // Laisse retomber les écritures fire-and-forget restantes avant de retirer
  // la variable d'env (sinon elles retomberaient sur le vrai répertoire).
  await new Promise((resolve) => setImmediate(resolve));
  delete process.env.PI_WEB_LOGS_DIR;
  rmSync(logsTmp, { recursive: true, force: true });
});

const BASE_INFO: HarnessArchiveInfo = {
  functionName: "execute",
  cause: "timeout-inactivite",
  attempts: 2,
  eventCount: 42,
  lastEventAt: FIXED_NOW.getTime() - 5000,
  model: "ollama/qwen3.8-flash-next",
  durationMs: 123_456,
  lastEventExcerpt: "edit backend/src/foo.ts",
  errorMessage: "Fonction execute inactive depuis 300s — timeout d'inactivité",
};

describe("formatArchiveTimestamp", () => {
  it("formate <YYYYMMDD>-<HHMMSS> en heure locale avec zéros", () => {
    expect(formatArchiveTimestamp(FIXED_NOW)).toBe("20260801-123456");
    expect(formatArchiveTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
  });
});

describe("slugifyCause", () => {
  it("minuscule, sans accents, hors [a-z0-9] → tiret", () => {
    expect(slugifyCause("Erreur modèle")).toBe("erreur-modele");
    expect(slugifyCause("Abort  utilisateur !!")).toBe("abort-utilisateur");
    expect(slugifyCause("timeout d'inactivité")).toBe("timeout-d-inactivite");
  });

  it("borne la longueur et retourne 'cause' si vide", () => {
    expect(slugifyCause("")).toBe("cause");
    const long = slugifyCause("x".repeat(100) + "—fin");
    expect(long.length).toBeLessThanOrEqual(40);
  });
});

describe("buildArchiveBaseName", () => {
  it("produit <date>-<fonction>-<cause> sanitisés", () => {
    expect(buildArchiveBaseName(FIXED_NOW, "execute", "timeout-inactivite")).toBe(
      "20260801-123456-execute-timeout-inactivite",
    );
    expect(buildArchiveBaseName(FIXED_NOW, "planning", "Erreur modèle")).toBe(
      "20260801-123456-planning-erreur-modele",
    );
  });
});

describe("classifyFailure", () => {
  it("classe les messages du harness (timeout/abort)", () => {
    expect(classifyFailure("Fonction execute inactive depuis 300s — timeout d'inactivité")).toBe(
      "timeout-inactivite",
    );
    expect(classifyFailure("Fonction review a dépassé le timeout global de 1800s")).toBe(
      "timeout-global",
    );
    expect(
      classifyFailure("Délégation interrompue par l'utilisateur (abort de l'orchestrator)"),
    ).toBe("abort-utilisateur");
  });

  it("classe les erreurs LLM/provider courantes (filet)", () => {
    expect(classifyFailure("No API key for provider_x/qwen3.8-flash-next")).toBe("erreur-modele");
    expect(classifyFailure("HTTP 429 rate limit exceeded")).toBe("erreur-modele");
  });

  it("fallback 'erreur-exception' pour une cause inconnue (≠ succès)", () => {
    expect(classifyFailure("Cannot read properties of undefined (reading 'foo')")).toBe(
      "erreur-exception",
    );
    expect(classifyFailure("")).toBe("erreur-exception");
  });
});

describe("buildArchiveMeta", () => {
  it("expose tous les champs de diagnostic du P0", () => {
    const meta = buildArchiveMeta(BASE_INFO, FIXED_NOW);
    expect(meta).toMatchObject({
      archivedAt: FIXED_NOW.toISOString(),
      function: "execute",
      cause: "timeout-inactivite",
      attempts: 2,
      eventCount: 42,
      lastEventAtMs: BASE_INFO.lastEventAt,
      lastEventAt: BASE_INFO.lastEventAt === null ? null : new Date(BASE_INFO.lastEventAt).toISOString(),
      model: "ollama/qwen3.8-flash-next",
      durationMs: 123_456,
      lastEventExcerpt: "edit backend/src/foo.ts",
      errorMessage: BASE_INFO.errorMessage,
    });
  });

  it("omet errorMessage si absent et lastEventAt null si aucun event", () => {
    const meta = buildArchiveMeta(
      { ...BASE_INFO, errorMessage: undefined, lastEventAt: null },
      FIXED_NOW,
    );
    expect(meta.lastEventAt).toBeNull();
    expect("errorMessage" in meta).toBe(false);
  });
});

describe("purgeExpiredArchives", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "harness-purge-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("purge uniquement les archives de plus de la rétention", () => {
    const old = path.join(dir, "20260101-000000-execute-erreur.jsonl");
    const fresh = path.join(dir, "20260801-000000-execute-erreur.jsonl");
    const oldMeta = `${old}.meta.json`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(old, "{}\n");
    writeFileSync(fresh, "{}\n");
    writeFileSync(oldMeta, "{}\n");
    // Backdate le mtime des vieux fichiers au-delà de 7 jours.
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(old, stale, stale);
    utimesSync(oldMeta, stale, stale);

    const purged = purgeExpiredArchives(dir);
    expect(purged).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldMeta)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("ne touche pas aux autres fichiers du dossier", () => {
    const other = path.join(dir, "readme.txt");
    writeFileSync(other, "keep me");
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(other, stale, stale);
    expect(purgeExpiredArchives(dir)).toBe(0);
    expect(existsSync(other)).toBe(true);
  });
});

describe("archiveFailedSession", () => {
  let dir: string;
  let sessionFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "harness-archive-"));
    sessionFile = path.join(dir, "session.jsonl");
    // Session « boîte noire » factice (JSONL du SDK Pi).
    writeFileSync(
      sessionFile,
      '{"type":"session"}\n{"type":"message","role":"assistant","stopReason":"error"}\n',
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copie la session + écrit les métadonnées", () => {
    const archivePath = archiveFailedSession(
      sessionFile,
      BASE_INFO,
      { dir, now: FIXED_NOW },
    );
    expect(archivePath).toBe(path.join(dir, "20260801-123456-execute-timeout-inactivite.jsonl"));
    expect(existsSync(archivePath!)).toBe(true);
    expect(readFileSync(archivePath!, "utf-8")).toBe(readFileSync(sessionFile, "utf-8"));

    const metaPath = path.join(dir, "20260801-123456-execute-timeout-inactivite.meta.json");
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.function).toBe("execute");
    expect(meta.cause).toBe("timeout-inactivite");
    expect(meta.attempts).toBe(2);
    expect(meta.eventCount).toBe(42);
    expect(meta.model).toBe("ollama/qwen3.8-flash-next");
    expect(meta.durationMs).toBe(123_456);
    expect(meta.errorMessage).toBe(BASE_INFO.errorMessage);
  });

  it("suffixe -2 en cas de collision à la même seconde", () => {
    const first = archiveFailedSession(sessionFile, BASE_INFO, { dir, now: FIXED_NOW });
    const second = archiveFailedSession(sessionFile, BASE_INFO, { dir, now: FIXED_NOW });
    expect(first).toMatch(/20260801-123456-execute-timeout-inactivite\.jsonl$/);
    expect(second).toMatch(/20260801-123456-execute-timeout-inactivite-2\.jsonl$/);
    // 2 archives (le fichier source session.jsonl est à part).
    expect(readdirSync(dir).filter((f) => /-execute-timeout-inactivite(-2)?\.jsonl$/.test(f)).length).toBe(2);
  });

  it("retourne null si le fichier de session n'existe pas", () => {
    expect(archiveFailedSession(path.join(dir, "absent.jsonl"), BASE_INFO, { dir })).toBeNull();
  });
});