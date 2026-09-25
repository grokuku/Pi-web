/**
 * Tests du logger fichier (P0 observabilité 2/2).
 * Les écritures se font dans un dossier temporaire via PI_WEB_LOGS_DIR —
 * jamais dans le vrai .data/logs du repo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
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
  crashFileNameFor,
  formatLine,
  getLogsDir,
  installConsoleCapture,
  logFileNameFor,
  logger,
  purgeOldLogs,
  safeStringify,
} from "./logger.js";

describe("utils/logger — helpers purs", () => {
  it("logFileNameFor → backend-YYYYMMDD.log (complété à zéro)", () => {
    expect(logFileNameFor(new Date(2025, 0, 8, 23, 59))).toBe("backend-20250108.log");
    expect(logFileNameFor(new Date(2025, 10, 25, 0, 1))).toBe("backend-20251125.log");
  });

  it("crashFileNameFor → crash-<ISO>-<pid>.json sans caractères interdits", () => {
    const name = crashFileNameFor(new Date("2025-01-08T12:00:00.000Z"), 4321);
    expect(name).toBe("crash-2025-01-08T12-00-00-000Z-4321.json");
    // pas de ":" (interdit sur certains filesystems) ; le "." de .json reste
    expect(name).not.toContain(":");
  });

  it("formatLine → ISO + niveau + catégorie + message + détails JSON compact", () => {
    const line = formatLine("error", "ws", "boom", { a: 1 });
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[ERROR\] \[ws\] boom \| \{"a":1\}$/
    );
    // Sans détails : pas de séparateur traînant
    expect(formatLine("info", "test", "hello")).toMatch(/\[INFO\] \[test\] hello$/);
    expect(formatLine("warn", "test", "hmm")).toMatch(/\[WARN\] \[test\] hmm$/);
  });

  it("safeStringify survit aux références circulaires", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(safeStringify(a)).toBe("[object Object]");
    expect(safeStringify(undefined)).toBe("undefined");
    expect(safeStringify({ ok: true })).toBe('{"ok":true}');
  });
});

describe("utils/logger — écriture fichier (dossier temporaire)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "piweb-logs-"));
    process.env.PI_WEB_LOGS_DIR = tmp;
    expect(getLogsDir()).toBe(tmp);
  });

  afterEach(() => {
    delete process.env.PI_WEB_LOGS_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("logger.error crée le dossier + fichier du jour, une ligne par entrée", () => {
    logger.error("test", "premier", { k: "v" });
    logger.error("test", "deuxième");

    const file = path.join(tmp, logFileNameFor(new Date()));
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\[ERROR\] \[test\] premier \| \{"k":"v"\}$/);
    expect(lines[1]).toMatch(/\[ERROR\] \[test\] deuxième$/);
  });

  it("logger.crash écrit un JSON synchrone avec stack + contexte process + events", () => {
    logger.error("test", "avant-crash");
    const file = logger.crash(new Error("boom"), "uncaughtException", { note: "test" });
    expect(file).toBeTruthy();

    const parsed = JSON.parse(readFileSync(file!, "utf8"));
    expect(parsed.type).toBe("uncaughtException");
    expect(parsed.name).toBe("Error");
    expect(parsed.message).toBe("boom");
    expect(parsed.stack).toContain("boom");
    expect(parsed.context).toEqual({ note: "test" });
    expect(parsed.process.node).toBe(process.version);
    expect(parsed.process.platform).toBe(process.platform);
    expect(typeof parsed.process.uptime_s).toBe("number");
    expect(parsed.process.memory_mb.rss).toBeGreaterThan(0);
    expect(Array.isArray(parsed.recentEvents)).toBe(true);
    expect(parsed.recentEvents.join("\n")).toContain("avant-crash");
  });

  it("crash gère un reason non-Error (string) sans lever", () => {
    const file = logger.crash("simple string reason", "unhandledRejection");
    const parsed = JSON.parse(readFileSync(file!, "utf8"));
    expect(parsed.type).toBe("unhandledRejection");
    expect(parsed.message).toBe("simple string reason");
    expect(parsed.name).toBe("string");
  });

  it("purgeOldLogs supprime les fichiers de plus de 14 jours, garde les récents", () => {
    const old = path.join(tmp, "backend-20200101.log");
    const oldCrash = path.join(tmp, "crash-2020-01-01T00-00-00-000Z-1.json");
    const fresh = path.join(tmp, logFileNameFor(new Date()));
    for (const f of [old, oldCrash, fresh]) writeFileSync(f, "x");
    for (const f of [old, oldCrash]) {
      const oldDate = new Date("2020-01-01");
      utimesSync(f, oldDate, oldDate);
    }

    purgeOldLogs(tmp);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldCrash)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // Les fichiers non concernés par le pattern ne sont jamais supprimés
    const other = path.join(tmp, "autre.json");
    writeFileSync(other, "x");
    utimesSync(other, new Date("2020-01-01"), new Date("2020-01-01"));
    purgeOldLogs(tmp);
    expect(existsSync(other)).toBe(true);
  });

  it("purgeOldLogs ne lève pas si le dossier n'existe pas", () => {
    expect(() => purgeOldLogs(path.join(tmp, "n-existe-pas"))).not.toThrow();
  });

  it("le ring buffer conserve les 50 dernières lignes max", () => {
    for (let i = 0; i < 60; i++) logger.info("ring", `ligne-${i}`);
    const snap = logger.recentEventsSnapshot();
    expect(snap.length).toBeLessThanOrEqual(50);
    // Après 60 écritures, la fenêtre glissante couvre ligne-10 … ligne-59
    expect(snap[snap.length - 1]).toContain("ligne-59");
    expect(snap[0]).toContain("ligne-10");
  });

  it("le fichier du jour ne contient pas de ligne vide parasite", () => {
    logger.info("fmt", "ecriture");
    const file = path.join(tmp, logFileNameFor(new Date()));
    readdirSync(tmp); // sanity : le dossier contient bien le journal
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(readFileSync(file, "utf8").includes("\n\n")).toBe(false);
  });

  // Fin de l'angle mort des logs : les `console.warn` émis par un module
  // backend (ex. échec du prompt système) étaient invisibles dans les fichiers
  // de log. installConsoleCapture les recopie désormais (comme console.error).
  // NB : installConsoleCapture est idempotent → les deux niveaux sont vérifiés
  // dans le MÊME test (un 2e appel ne re-wrapperait pas les consoles restaurées).
  it("installConsoleCapture recopie console.warn ET console.error dans le fichier", () => {
    const origWarn = console.warn;
    const origError = console.error;
    try {
      installConsoleCapture();
      console.warn("[system-prompt] build failed: boom");
      console.error("boom-error");
      const file = path.join(tmp, logFileNameFor(new Date()));
      const content = readFileSync(file, "utf8");
      expect(content).toContain("[WARN] [console] [system-prompt] build failed: boom");
      expect(content).toContain("[ERROR] [console] boom-error");
    } finally {
      // On restaure les consoles d'origine pour ne pas polluer les tests
      // suivants (le wrapper est idempotent : captureInstalled reste vrai).
      console.warn = origWarn;
      console.error = origError;
    }
  });
});