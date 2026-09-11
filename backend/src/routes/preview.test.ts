/**
 * Tests unitaires de la Preview API (routes/preview.ts).
 * Aucun serveur HTTP : on teste la logique pure exportée (stockage inline,
 * résolution de fichier projet, mapping MIME) — pattern des tests existants.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import {
  storeInlineHtml,
  getInlineHtml,
  mimeForPath,
  resolveProjectFile,
} from "./preview.js";

// Mock du gestionnaire de projets pour contrôler le cwd sans dépendre du disque.
const { getProjectMock } = vi.hoisted(() => ({ getProjectMock: vi.fn() }));
vi.mock("../projects/manager.js", () => ({
  getProject: getProjectMock,
}));

const TEST_ROOT = "/projects/__piweb_preview_test__";
const PROJ = path.join(TEST_ROOT, "projA");

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJ, { recursive: true });
  getProjectMock.mockReset();
  getProjectMock.mockReturnValue({ id: "projA", cwd: PROJ });
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── preview-inline : stockage / TTL / 404 / taille max ──

describe("preview-inline (stockage mémoire)", () => {
  it("stocke un HTML et retourne un id hex 32 (alphanumérique ≥ 16)", () => {
    const id = storeInlineHtml("<h1>Hello</h1>");
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(getInlineHtml(id)).toBe("<h1>Hello</h1>");
  });

  it("retourne null pour un id inconnu (404)", () => {
    expect(getInlineHtml("00000000000000000000000000000000")).toBeNull();
  });

  it("nettoie l'entrée expirée à l'accès (TTL 10 min)", () => {
    vi.useFakeTimers();
    try {
      const id = storeInlineHtml("<p>expire</p>");
      expect(getInlineHtml(id)).toBe("<p>expire</p>");
      // On avance le temps au-delà du TTL (10 min) : l'accès doit nettoyer.
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      expect(getInlineHtml(id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuse un HTML de plus de 500KB", () => {
    const big = "x".repeat(500 * 1024 + 1);
    expect(() => storeInlineHtml(big)).toThrow(/trop volumineux/);
  });
});

// ── serving fichier : 404 hors projet / 200 réel / mime ──

describe("preview fichier projet (resolveProjectFile)", () => {
  it("retourne 404 si le projet est introuvable", () => {
    getProjectMock.mockReturnValue(undefined);
    const r = resolveProjectFile("ghost", "index.html");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("retourne 404 si le fichier n'existe pas", () => {
    const r = resolveProjectFile("projA", "missing.html");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("refuse un chemin hors du cwd du projet (403)", () => {
    const outside = path.join(TEST_ROOT, "other", "secret.txt");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "secret");
    // Traversée ../ pour sortir du projet.
    const r = resolveProjectFile("projA", path.join("..", "other", "secret.txt"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("retourne 200 + chemin absolu + mime correct sur un fichier réel", () => {
    const file = path.join(PROJ, "index.html");
    fs.writeFileSync(file, "<h1>ok</h1>");
    const r = resolveProjectFile("projA", "index.html");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.absPath).toBe(file);
      expect(r.mime).toBe("text/html; charset=utf-8");
    }
  });

  it("retourne 400 si le chemin est un répertoire", () => {
    const r = resolveProjectFile("projA", ".");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

// ── mapping MIME ──

describe("mimeForPath", () => {
  it.each([
    ["a.html", "text/html; charset=utf-8"],
    ["a.css", "text/css; charset=utf-8"],
    ["a.js", "text/javascript; charset=utf-8"],
    ["a.mjs", "text/javascript; charset=utf-8"],
    ["a.json", "application/json; charset=utf-8"],
    ["a.svg", "image/svg+xml"],
    ["a.png", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.ico", "image/x-icon"],
    ["a.txt", "text/plain; charset=utf-8"],
    ["a.md", "text/markdown; charset=utf-8"],
  ])("mappe %s → %s", (file, expected) => {
    expect(mimeForPath(file)).toBe(expected);
  });

  it("retombe sur application/octet-stream pour une extension inconnue", () => {
    expect(mimeForPath("a.xyz")).toBe("application/octet-stream");
  });
});
