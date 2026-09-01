/**
 * Attachments API — Upload, serve, and analyze files for Pi-Web.
 *
 * Files are stored persistently in /data/attachments/<id>/<safe-name>.
 * Metadata is stored in /data/attachments/<id>/meta.json.
 * Analysis results are cached in /data/attachments/<id>/cache/.
 *
 * The Pi extension `file-analyzer` calls the /analyze endpoint to extract
 * content from files (PDF text, image descriptions, etc.)
 */

import { Router, type Request, type Response } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, createReadStream, unlinkSync, copyFileSync, rmSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import os from "os";
import { loadModelLibrary } from "../pi/model-library.js";
import { loadProviders } from "../pi/providers.js";

// ─── Config ──────────────────────────────────────────────
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || "/data/attachments";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_FILES_PER_UPLOAD = 20;

// ─── ID validation ───────────────────────────────────────
const ATTACHMENT_ID_RE = /^[0-9a-f-]{36}$/i;
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valide un id d'attachment avant toute construction de chemin. */
function isValidAttachmentId(id: string): boolean {
  return ATTACHMENT_ID_RE.test(id);
}

/** Valide le projectId avant stockage (évite les attachements orphelins). */
function isValidProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id);
}

// ─── Filename Sanitization ───────────────────────────────
/**
 * Sanitize a filename to prevent path traversal and remove dangerous characters.
 * - Strips directory separators and path traversal patterns
 * - Replaces spaces and special chars with safe alternatives
 * - Preserves the file extension
 */
function sanitizeFileName(name: string): string {
  // Get the base name (strip any path components)
  let safe = path.basename(name);
  // Remove leading dots (hidden files, traversal)
  safe = safe.replace(/^\.+/, "");
  // Replace any character that isn't alphanumeric, dash, underscore, dot, or parentheses
  safe = safe.replace(/[^a-zA-Z0-9._\-() ]/g, "_");
  // Collapse multiple underscores/spaces
  safe = safe.replace(/[_\s]{2,}/g, "_");
  // Trim
  safe = safe.trim();
  // Fallback if nothing left
  if (!safe || safe.startsWith(".")) safe = "file";
  return safe;
}
const PI_WEB_URL = process.env.PI_WEB_URL || "http://localhost:3000";
const MODELS_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");

// ─── Types ───────────────────────────────────────────────
interface AttachmentMeta {
  id: string;
  name: string;           // sanitized filename (on disk)
  originalName?: string; // original filename as uploaded (before sanitization)
  mimeType: string;
  size: number;
  category: "image" | "text" | "audio" | "video" | "pdf" | "binary";
  projectId?: string;
  uploadedAt: string;
  analyzedAt?: string;
  analysisCache?: Record<string, string>; // query hash → result
}

// ─── Vision Model Helpers ─────────────────────────────────

/** Check if the current model supports vision */
export interface VisionModelInfo {
  modelId: string;
  providerId: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * Get full model info for the vision model (API key, base URL, etc.).
 *
 * Le visionModelId est stocké dans la model library (.data/model-library.json)
 * au format makeModelId : `${providerId}__${modelId}` avec les caractères
 * spéciaux (ex. le point de `kimi-k2.6`) remplacés par `_`. L'ancienne
 * implémentation cherchait uniquement dans ~/.pi/agent/models.json en comparant
 * `${providerId}__${m.id}` avec le m.id BRUT (contenant le point) → le matching
 * échouait et renvoyait null (« No vision model configured »).
 *
 * Correctif : on cherche d'abord dans la model library (source de vérité, qui
 * donne providerId + modelId), puis on récupère apiKey/baseUrl depuis la config
 * provider (.data/providers.json). En fallback, on cherche dans models.json en
 * normalisant la comparaison (même règle de remplacement que makeModelId).
 */
export function getVisionModelInfo(): VisionModelInfo | null {
  try {
    const library = loadModelLibrary();
    const visionModelId = library.visionModelId;
    if (!visionModelId) return null;

    // 1) Source de vérité : la model library. On y trouve le RegisteredModel
    //    (providerId + modelId), puis on résout apiKey/baseUrl via le provider.
    const registered = library.models.find((m) => m.id === visionModelId);
    if (registered) {
      const provider = loadProviders().find((p) => p.id === registered.providerId);
      if (provider) {
        return {
          modelId: registered.modelId,
          providerId: registered.providerId,
          apiKey: provider.apiKey || "",
          baseUrl: provider.baseUrl || "https://openrouter.ai/api/v1",
        };
      }
    }

    // 2) Fallback : chercher dans ~/.pi/agent/models.json (providers).
    //    On normalise la comparaison comme makeModelId pour couvrir les formats
    //    m.id / providerId/m.id / providerId__m.id (avec ou sans remplacement).
    const modelsJsonPath = path.join(os.homedir(), ".pi", "agent", "models.json");
    if (!existsSync(modelsJsonPath)) return null;

    const modelsData = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
    const providers = modelsData.providers || {};

    const normalize = (s: string) => s.replace(/[^a-zA-Z0-9_\-:]/g, "_");

    for (const [providerId, provider] of Object.entries(providers) as [string, any][]) {
      const models = provider.models || [];
      const model = models.find((m: any) =>
        m.id === visionModelId ||
        `${providerId}/${m.id}` === visionModelId ||
        `${providerId}__${m.id}` === visionModelId ||
        `${providerId}__${normalize(m.id)}` === visionModelId
      );
      if (model) {
        return {
          modelId: model.id,
          // BUG-2 : normaliser le providerId comme makeModelId (même règle de
          // remplacement des caractères spéciaux) pour rester cohérent avec le
          // format attendu par le reste du code (model library).
          providerId: normalize(providerId),
          apiKey: provider.apiKey || "",
          baseUrl: provider.baseUrl || "https://openrouter.ai/api/v1",
        };
      }
    }

    return null;
  } catch (e: any) {
    // BUG-3 : ne pas avaler l'erreur en silence — logguer pour le diagnostic.
    console.warn("[attachments] getVisionModelInfo failed:", e?.message || e);
    return null;
  }
}

/**
 * Sanitise un texte d'erreur avant de l'exposer (fuite d'apiKey / secrets).
 * - Retire les en-têtes Authorization / jetons Bearer.
 * - Limite la longueur à maxLen caractères.
 */
export function sanitizeErrorText(text: string, maxLen = 200): string {
  if (!text) return "";
  let safe = text;
  // En-têtes Authorization (ex. "Authorization: Bearer sk-...")
  safe = safe.replace(/(authorization\s*:\s*)[^\r\n,]+/gi, "$1[REDACTED]");
  // Jetons Bearer isolés
  safe = safe.replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[REDACTED]");
  // Limite de longueur
  if (safe.length > maxLen) safe = safe.slice(0, maxLen) + "…";
  return safe;
}

/** Call a vision model to describe an image */
export async function describeImageWithVisionModel(
  base64: string,
  mimeType: string,
  prompt: string,
  modelInfo: VisionModelInfo
): Promise<string> {
  try {
    // Use OpenAI-compatible chat completions API (works with OpenRouter, OpenAI, Ollama, etc.)
    const baseUrl = modelInfo.baseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/chat/completions`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${modelInfo.apiKey}`,
      },
      body: JSON.stringify({
        model: modelInfo.modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1024,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      // BUG-1 : ne pas exposer le corps de réponse brut (peut contenir des
      // secrets / apiKey). On tronque et on retire les en-têtes Authorization.
      throw new Error(`Vision model API error: ${response.status} ${sanitizeErrorText(errorText)}`);
    }
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "[No description generated]";
  } catch (err: any) {
    // BUG-1 : sanitise le message d'erreur avant de le propager (fuite apiKey).
    throw new Error(`Failed to describe image: ${sanitizeErrorText(err?.message || String(err))}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────

function getCategory(mimeType: string, fileName: string): AttachmentMeta["category"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) return "pdf";

  const TEXT_MIME_TYPES = new Set([
    "text/plain", "text/csv", "text/markdown", "text/html", "text/css",
    "text/xml", "text/yaml", "text/x-yaml", "application/json",
    "application/xml", "application/yaml", "application/x-yaml",
    "application/javascript", "application/typescript",
    "application/x-shellscript",
  ]);
  if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType)) return "text";

  const codeExts = new Set([
    "js", "ts", "tsx", "jsx", "py", "rb", "rs", "go", "java", "kt",
    "swift", "c", "cpp", "h", "hpp", "cs", "php", "sh", "bash",
    "sql", "r", "scala", "yaml", "yml", "json", "xml", "html", "css",
    "md", "txt", "log", "toml", "ini", "cfg", "env",
  ]);
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (codeExts.has(ext)) return "text";

  return "binary";
}

function getAttachmentDir(id: string): string {
  return path.join(ATTACHMENTS_DIR, id);
}

function getMetaPath(id: string): string {
  return path.join(ATTACHMENTS_DIR, id, "meta.json");
}

function getFilePath(id: string, name: string): string {
  return path.join(ATTACHMENTS_DIR, id, name);
}

function getCacheDir(id: string): string {
  return path.join(ATTACHMENTS_DIR, id, "cache");
}

/** Simple hash for cache keys based on query + page */
function hashCacheKey(query: string, page?: number): string {
  let hash = 0;
  const key = `${query}|${page ?? ""}`;
  for (let i = 0; i < key.length; i++) {
    const chr = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // 32-bit
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function readMeta(id: string): AttachmentMeta | null {
  try {
    const raw = readFileSync(getMetaPath(id), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeMeta(meta: AttachmentMeta): void {
  const dir = getAttachmentDir(meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getMetaPath(meta.id), JSON.stringify(meta, null, 2), "utf-8");
}

function ensureAttachmentsDir(): void {
  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }
}

// ─── Multer (lazy-loaded) ────────────────────────────────
let uploadMiddleware: any;

async function getUploadMiddleware() {
  if (!uploadMiddleware) {
    const { default: multer } = await import("multer");
    uploadMiddleware = multer({
      dest: "/tmp/pi-web-attachments/",
      limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_PER_UPLOAD },
    });
  }
  return uploadMiddleware;
}

// ─── Routes ───────────────────────────────────────────────

const router = Router();

/**
 * POST /api/attachments/upload
 * Upload one or more files. Returns metadata for each.
 */
router.post("/upload", async (req: Request, res: Response) => {
  try {
    const upload = await getUploadMiddleware();
    upload.array("files", MAX_FILES_PER_UPLOAD)(req, res, async (err: any) => {
      if (err) {
        return res.status(400).json({ error: err.message || "Upload error" });
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files provided" });
      }

      const rawProjectId = req.body.projectId;
      if (typeof rawProjectId !== "string" || !isValidProjectId(rawProjectId)) {
        // Nettoyer les fichiers temporaires déjà écrits par multer avant de rejeter.
        for (const file of files) {
          try { unlinkSync(file.path); } catch {}
        }
        return res.status(400).json({ error: "projectId (UUID) is required" });
      }
      const projectId = rawProjectId;
      const results: AttachmentMeta[] = [];

      for (const file of files) {
        const id = randomUUID();
        const safeName = sanitizeFileName(file.originalname);
        const category = getCategory(file.mimetype || "application/octet-stream", file.originalname);
        const meta: AttachmentMeta = {
          id,
          name: safeName,
          originalName: file.originalname,
          mimeType: file.mimetype || "application/octet-stream",
          size: file.size,
          category,
          projectId,
          uploadedAt: new Date().toISOString(),
        };

        // Create attachment directory and move file there
        const dir = getAttachmentDir(id);
        mkdirSync(dir, { recursive: true });
        mkdirSync(path.join(dir, "cache"), { recursive: true });

        const destPath = path.join(dir, safeName);
        copyFileSync(file.path, destPath);
        try { unlinkSync(file.path); } catch {} // Clean up temp file

        // Write metadata
        writeMeta(meta);
        results.push(meta);
      }

      res.json({ attachments: results });
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/attachments
 * List all attachments, optionally filtered by projectId.
 */
router.get("/", (req: Request, res: Response) => {
  ensureAttachmentsDir();

  const projectId = req.query.projectId as string | undefined;
  const results: AttachmentMeta[] = [];

  try {
    const dirs = readdirSync(ATTACHMENTS_DIR);
    for (const id of dirs) {
      const metaPath = getMetaPath(id);
      if (!existsSync(metaPath)) continue;
      try {
        const meta = readMeta(id);
        if (!meta) continue;
        // Only include files for the given project (or all if no filter)
        if (projectId && meta.projectId !== projectId) continue;
        results.push(meta);
      } catch { continue; }
    }
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ attachments: results });
});

/**
 * GET /api/attachments/:id
 * Get attachment metadata.
 */
router.get("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAttachmentId(id)) {
    return res.status(400).json({ error: "Invalid attachment id" });
  }
  const meta = readMeta(id);
  if (!meta) {
    return res.status(404).json({ error: "Attachment not found" });
  }
  res.json(meta);
});

/**
 * GET /api/attachments/:id/file
 * Serve the actual file (for viewing/downloading).
 */
router.get("/:id/file", (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAttachmentId(id)) {
    return res.status(400).json({ error: "Invalid attachment id" });
  }
  const meta = readMeta(id);
  if (!meta) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const filePath = path.join(getAttachmentDir(id), meta.name);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on disk" });
  }

  // ── Durcissement XSS (lot sécurité) ──
  // Les fichiers uploadés ne doivent jamais pouvoir s'exécuter sur l'origine
  // de Pi-Web (un HTML/SVG avec <script> servit en inline = XSS stockée qui
  // pourrait appeler l'API avec les droits same-origin).
  // - nosniff + CSP:sandbox bloquent l'exécution de scripts même en navigation
  //   directe (sandbox n'affecte NI l'affichage <img> NI le viewer PDF).
  // - Les MIME exécutables sont forcés en "attachment" (téléchargement au lieu
  //   d'ouverture navigateur). Le rendu <img> côté UI ignore le Disposition.
  const dangerousInlineMimes = new Set([
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "text/xml",
  ]);
  const disposition = dangerousInlineMimes.has(meta.mimeType.toLowerCase()) ? "attachment" : "inline";
  // Échapper le filename pour éviter une injection dans le header
  const safeName = meta.name.replace(/[\r\n"]/g, "");
  res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);
  res.setHeader("Content-Type", meta.mimeType);
  res.setHeader("Content-Security-Policy", "sandbox");

  const stream = createReadStream(filePath);
  stream.pipe(res);
  stream.on("error", () => {
    res.status(500).json({ error: "Error streaming file" });
  });
});

/**
 * DELETE /api/attachments/:id
 * Delete an attachment and its files.
 */
router.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAttachmentId(id)) {
    return res.status(400).json({ error: "Invalid attachment id" });
  }
  const meta = readMeta(id);
  if (!meta) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const dir = getAttachmentDir(id);
  if (existsSync(dir)) {
    try {
      // Supprime tout le dossier d'attachment (fichiers + cache) en un seul appel
      // BUG-04 fix: l'ancien code utilisait unlinkSync sur un dossier (ne marche pas)
      // et rmdirSync (deprecated). rmSync recursive+force fait tout proprement.
      rmSync(dir, { recursive: true, force: true });
    } catch (error: any) {
      console.warn(`[attachments] Error cleaning up ${id}:`, error.message);
    }
  }

  res.json({ success: true });
});

/**
 * POST /api/attachments/:id/inject-to-chat
 *
 * ROUTE INTERNE (localhost-only via apiAuth — utilisée par les extensions Pi,
 * ex. web-screenshot, qui appellent l'API en http://127.0.0.1:3000) :
 * injecte dans le fil de chat de la session du projet un message portant
 * l'attachment en miniature cliquable (attachmentRefs dans details).
 *
 * Body: { projectId?, cwd?, caption? }
 *   - projectId (UUID) prioritaire ; sinon résolution par cwd (chemin exact du
 *     projet — fiable depuis une extension, qui ne connaît pas l'UUID) ;
 *     sinon fallback meta.projectId.
 *   - cwd permet aussi de CORRIGER meta.projectId si l'extension avait écrit
 *     le nom du répertoire au lieu de l'UUID (bug préexistant de l'upload
 *     extension).
 *
 * Réponse: { success, injected, projectId }
 *   - injected=false (ex. session inactive) → l'extension dégrade sans erreur.
 */
router.post("/:id/inject-to-chat", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAttachmentId(id)) {
    return res.status(400).json({ error: "Invalid attachment id" });
  }
  const meta = readMeta(id);
  if (!meta) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const body = (req.body || {}) as { projectId?: string; cwd?: string; caption?: string };

  // ── Résolution du projet cible ──
  let projectId: string | undefined;
  if (typeof body.projectId === "string" && isValidProjectId(body.projectId)) {
    projectId = body.projectId;
  } else if (typeof body.cwd === "string" && body.cwd.trim()) {
    try {
      const { getAllProjects } = await import("../projects/manager.js");
      const project = getAllProjects().find((p) => p.cwd === body.cwd);
      if (project) projectId = project.id;
    } catch (e: any) {
      console.warn(`[attachments] inject-to-chat: project lookup by cwd failed:`, e?.message || e);
    }
  }
  if (!projectId && typeof meta.projectId === "string" && isValidProjectId(meta.projectId)) {
    projectId = meta.projectId;
  }
  if (!projectId) {
    return res.status(400).json({ error: "Cannot resolve project: provide projectId (UUID) or a cwd matching a project" });
  }

  // ── Correction éventuelle de meta.projectId (upload extension avec nom de
  // répertoire au lieu d'UUID) — non bloquant en cas d'échec d'écriture. ──
  if (meta.projectId !== projectId) {
    try {
      meta.projectId = projectId;
      writeMeta(meta);
    } catch (e: any) {
      console.warn(`[attachments] inject-to-chat: could not fix meta.projectId for ${id}:`, e?.message || e);
    }
  }

  // Import dynamique : session.ts importe déjà attachments.ts (getVisionModelInfo…)
  // en statique → un import statique inverse créerait une dépendance circulaire.
  const { injectAttachmentToChat } = await import("../pi/session.js");
  const ref = { id: meta.id, name: meta.name, category: meta.category, size: meta.size };
  const injected = await injectAttachmentToChat(projectId, [ref], body.caption);

  res.json({ success: true, injected, projectId });
});

/**
 * POST /api/attachments/:id/analyze
 * Analyze a file and return extracted content.
 *
 * The analysis depends on the file category:
 * - text/code: return the file content directly
 * - image: return base64 data (for vision models)
 * - pdf: extract text (using pdf-parse if available)
 * - audio/video: return placeholder (would need Whisper/ffmpeg)
 * - binary: return placeholder
 */
router.post("/:id/analyze", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidAttachmentId(id)) {
    return res.status(400).json({ error: "Invalid attachment id" });
  }
  const { query, page, force } = req.body as { query?: string; page?: number; force?: boolean };

  const meta = readMeta(id);
  if (!meta) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const filePath = path.join(getAttachmentDir(id), meta.name);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on disk" });
  }

  // ── Cache check ──
  const effectiveQuery = query || "describe this file";
  const cacheKey = hashCacheKey(effectiveQuery, page);
  const cacheDir = getCacheDir(id);
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);

  if (!force && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      console.log(`[attachments] Cache hit for ${id} (${cacheKey})`);
      return res.json(cached);
    } catch {
      console.warn(`[attachments] Corrupt cache for ${id}, re-analyzing...`);
    }
  }

  try {
    let result: { content: string; type: string; pages?: number; mimeType?: string; base64?: string };

    switch (meta.category) {
      case "text": {
        // Read text content directly
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const maxLines = 2000;
        const truncated = lines.length > maxLines;
        const contentStr = truncated
          ? lines.slice(0, maxLines).join("\n") + `\n\n[... truncated, ${lines.length} total lines]`
          : content;
        result = { content: contentStr, type: "text", pages: lines.length };
        break;
      }

      case "pdf": {
        // Try to extract text using pdf-parse
        try {
          const pdfParseModule = await import("pdf-parse");
          const pdfParse = (pdfParseModule as any).default || (pdfParseModule as any).PDFParse || pdfParseModule;
          const buffer = readFileSync(filePath);
          const pdfData = await pdfParse(buffer, {
            max: page ? 1 : 50, // Limit pages
            pagerender: page ? undefined : undefined,
          });
          let text = pdfData.text || "";
          if (text.length > 50000) {
            text = text.slice(0, 50000) + "\n\n[... truncated]";
          }
          result = { content: text, type: "pdf", pages: pdfData.numpages };
        } catch (err: any) {
          // pdf-parse not available or PDF parsing failed
          result = {
            content: `[PDF file: ${meta.name}, ${meta.size} bytes]\n\nPDF text extraction is not available. The file can be viewed or downloaded for manual analysis.\nInstall pdf-parse package to enable PDF text extraction.`,
            type: "pdf-unavailable",
            pages: 0,
          };
        }
        break;
      }

      case "image": {
        const buffer = readFileSync(filePath);
        const base64 = buffer.toString("base64");
        const modelInfo = getVisionModelInfo();
        
        if (buffer.length > 20 * 1024 * 1024) {
          // Image too large for inline analysis
          result = {
            content: `[Image file: ${meta.name}, ${meta.size} bytes, ${meta.mimeType}]\n\nImage is too large (>20MB) for inline analysis.`,
            type: "image-too-large",
          };
        } else if (modelInfo) {
          // Always use the configured vision model to describe the image
          try {
            const description = await describeImageWithVisionModel(base64, meta.mimeType, query || "Describe this image in detail", modelInfo);
            result = {
              content: `[Image: ${meta.name}]\n\n${description}`,
              type: "image-described",
            };
          } catch (err: any) {
            result = {
              content: `[Image file: ${meta.name}, ${meta.size} bytes, ${meta.mimeType}]\n\nVision model (${modelInfo.modelId}) returned an error: ${err.message}.`,
              type: "image-error",
            };
          }
        } else {
          // No vision model configured
          result = {
            content: `[Image file: ${meta.name}, ${meta.size} bytes, ${meta.mimeType}]\n\n⚠️ No vision model configured. To enable image analysis, configure a vision model in Settings → Analysis Models.`,
            type: "image-no-vision",
          };
        }
        break;
      }

      case "audio": {
        result = {
          content: `[Audio file: ${meta.name}, ${meta.size} bytes, ${meta.mimeType}]\n\nAudio transcription is not yet available. To enable it, configure a Whisper-compatible transcription service.`,
          type: "audio",
        };
        break;
      }

      case "video": {
        result = {
          content: `[Video file: ${meta.name}, ${meta.size} bytes, ${meta.mimeType}]\n\nVideo analysis is not yet available. To enable it, install ffmpeg and configure a Whisper-compatible transcription service.`,
          type: "video",
        };
        break;
      }

      default: {
        // Binary/unknown
        result = {
          content: `[Binary file: ${meta.name}, ${meta.size} bytes, ${meta.mimeType}]\n\nThis file type cannot be analyzed directly. It can be downloaded for manual inspection.`,
          type: "binary",
        };
        break;
      }
    }

    // Cache the result
    try {
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(result), "utf-8");

      // Update metadata
      meta.analyzedAt = new Date().toISOString();
      writeMeta(meta);
    } catch {
      // Cache failure is non-critical
    }

    res.json(result);
  } catch (error: any) {
    console.error(`[attachments] Analysis error for ${id}:`, error);
    res.status(500).json({ error: `Analysis failed: ${error.message}` });
  }
});

// ─── Cleanup on project delete ──────────────────────────
/**
 * Delete all attachments belonging to a project.
 * Called from project manager when a project is deleted.
 */
export function deleteAttachmentsForProject(projectId: string): number {
  if (!existsSync(ATTACHMENTS_DIR)) return 0;
  let deleted = 0;
  try {
    const dirs = readdirSync(ATTACHMENTS_DIR, { withFileTypes: true });
    for (const dirent of dirs) {
      if (!dirent.isDirectory()) continue;
      const metaPath = path.join(ATTACHMENTS_DIR, dirent.name, "meta.json");
      try {
        const meta: AttachmentMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (meta.projectId === projectId) {
          rmSync(path.join(ATTACHMENTS_DIR, dirent.name), { recursive: true, force: true });
          deleted++;
        }
      } catch {
        // Can't read meta — skip
      }
    }
  } catch {
    // Can't read attachments dir — skip
  }
  if (deleted > 0) {
    console.log(`[Attachments] Deleted ${deleted} attachment(s) for project ${projectId}`);
  }
  return deleted;
}

export default router;