/**
 * Preview API — sert des fichiers de projet et des mockups HTML ad-hoc dans la
 * fenêtre Preview du frontend (iframe).
 *
 * Deux familles de routes (toutes deux couvertes par l'auth globale /api) :
 *   - GET /api/preview/:projectId/*path  → sert un fichier du projet (confiné
 *     au cwd du projet via path-security, comme les routes files/agent).
 *   - GET /api/preview-inline/:id        → sert un HTML stocké en mémoire
 *     (Map, TTL 10 min, max 500KB, id random hex 32).
 *
 * Sécurité iframe : l'app ne pose AUCUN header X-Frame-Options global (ni CSP
 * frame-ancestors) — seuls les fichiers uploadés (attachments) et le preview du
 * File Explorer posent CSP:sandbox. Ces routes preview sont donc iframe-ables
 * sans exception supplémentaire (même-origin). On conserve néanmoins
 * X-Content-Type-Options: nosniff pour éviter le MIME-sniffing.
 */

import { Router, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import { existsSync, statSync } from "fs";
import path from "path";
import { getProject } from "../projects/manager.js";
import { isPathAllowed } from "../utils/path-security.js";

// ─── Config ──────────────────────────────────────────────
const INLINE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const INLINE_MAX_SIZE = 500 * 1024;  // 500 KB

// ─── Stockage mémoire des mockups inline ─────────────────
interface InlineEntry {
  html: string;
  expiresAt: number;
}
const inlineStore = new Map<string, InlineEntry>();

/**
 * Stocke un HTML ad-hoc et retourne son id (hex 32, alphanumérique ≥ 16).
 * Lève une erreur si le contenu dépasse la taille maximale.
 */
export function storeInlineHtml(html: string): string {
  if (Buffer.byteLength(html, "utf-8") > INLINE_MAX_SIZE) {
    throw new Error(`HTML trop volumineux (max ${INLINE_MAX_SIZE / 1024}KB)`);
  }
  const id = randomBytes(16).toString("hex");
  inlineStore.set(id, { html, expiresAt: Date.now() + INLINE_TTL_MS });
  return id;
}

/**
 * Récupère un HTML inline. Nettoie l'entrée si son TTL est expiré (nettoyage à
 * l'accès). Retourne null si l'id est inconnu ou expiré.
 */
export function getInlineHtml(id: string): string | null {
  const entry = inlineStore.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    inlineStore.delete(id);
    return null;
  }
  return entry.html;
}

// ─── Mapping MIME par extension ───────────────────────────
const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** Retourne le Content-Type d'un fichier selon son extension. */
export function mimeForPath(filePath: string): string {
  return MIME_MAP[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// ─── Résolution d'un fichier projet (logique pure, testable) ──
export type ResolveResult =
  | { ok: true; absPath: string; mime: string }
  | { ok: false; status: number; error: string };

/**
 * Résout un fichier relatif d'un projet avec confinement strict au cwd du
 * projet (path-security). Retourne le chemin absolu + le mime, ou une erreur
 * HTTP (404 projet/fichier absent, 403 hors confinement, 400 répertoire).
 */
export function resolveProjectFile(projectId: string, relPath: string): ResolveResult {
  const project = getProject(projectId);
  if (!project) {
    return { ok: false, status: 404, error: "Project not found" };
  }

  const resolved = path.resolve(project.cwd, relPath || "");
  if (!isPathAllowed(resolved, project.cwd)) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  if (!existsSync(resolved)) {
    return { ok: false, status: 404, error: "File not found" };
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return { ok: false, status: 400, error: "Path is a directory" };
  }

  return { ok: true, absPath: resolved, mime: mimeForPath(resolved) };
}

// ─── Routes ───────────────────────────────────────────────
const router = Router();

// GET /api/preview/:projectId/*path → sert un fichier du projet.
router.get("/preview/:projectId/*", (req: Request, res: Response) => {
  const { projectId } = req.params;
  const relPath = req.params[0] || "";
  const result = resolveProjectFile(projectId, relPath);

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  res.setHeader("Content-Type", result.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(result.absPath);
});

// GET /api/preview-inline/:id → sert le HTML stocké en mémoire.
router.get("/preview-inline/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  // L'id est un hex 32 (alphanumérique ≥ 16) : on refuse tout autre format.
  if (!/^[a-zA-Z0-9]{16,}$/.test(id)) {
    return res.status(404).json({ error: "Preview not found" });
  }
  const html = getInlineHtml(id);
  if (html === null) {
    return res.status(404).json({ error: "Preview not found or expired" });
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(html);
});

export default router;
