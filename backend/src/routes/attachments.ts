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

// ─── Config ──────────────────────────────────────────────
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || "/data/attachments";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_FILES_PER_UPLOAD = 20;

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
interface VisionModelInfo {
  modelId: string;
  providerId: string;
  apiKey: string;
  baseUrl: string;
}

/** Get full model info for the vision model (API key, base URL, etc.) */
function getVisionModelInfo(): VisionModelInfo | null {
  try {
    const library = loadModelLibrary();
    const visionModelId = library.visionModelId;
    if (!visionModelId) return null;
    
    // The model is stored in models.json providers
    const modelsJsonPath = path.join(os.homedir(), ".pi", "agent", "models.json");
    if (!existsSync(modelsJsonPath)) return null;
    
    const modelsData = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
    const providers = modelsData.providers || {};
    
    // Find the provider that has this model
    for (const [providerId, provider] of Object.entries(providers) as [string, any][]) {
      const models = provider.models || [];
      const model = models.find((m: any) => 
        m.id === visionModelId || 
        `${providerId}/${m.id}` === visionModelId ||
        `${providerId}__${m.id}` === visionModelId
      );
      if (model) {
        return {
          modelId: model.id,
          providerId,
          apiKey: provider.apiKey || "",
          baseUrl: provider.baseUrl || "https://openrouter.ai/api/v1",
        };
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/** Call a vision model to describe an image */
async function describeImageWithVisionModel(
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
      throw new Error(`Vision model API error: ${response.status} ${errorText}`);
    }
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "[No description generated]";
  } catch (err: any) {
    throw new Error(`Failed to describe image: ${err.message}`);
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

      const projectId = req.body.projectId as string | undefined;
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
  const meta = readMeta(id);
  if (!meta) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const filePath = path.join(getAttachmentDir(id), meta.name);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on disk" });
  }

  // Set Content-Disposition for downloads
  res.setHeader("Content-Disposition", `inline; filename="${meta.name}"`);
  res.setHeader("Content-Type", meta.mimeType);

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
  const meta = readMeta(id);
  if (!meta) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const dir = getAttachmentDir(id);
  if (existsSync(dir)) {
    try {
      // Remove all files in directory
      const files = readdirSync(dir);
      for (const file of files) {
        unlinkSync(path.join(dir, file));
      }
      // Remove cache directory contents
      const cacheDir = getCacheDir(id);
      if (existsSync(cacheDir)) {
        const cacheFiles = readdirSync(cacheDir);
        for (const file of cacheFiles) {
          unlinkSync(path.join(cacheDir, file));
        }
        try { mkdirSync(cacheDir, { recursive: true }); unlinkSync(cacheDir); } catch {}
      }
      // Remove directory
      try { require("fs").rmdirSync(dir, { recursive: true }); } catch {}
    } catch (error: any) {
      console.warn(`[attachments] Error cleaning up ${id}:`, error.message);
    }
  }

  res.json({ success: true });
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
  const { query, page } = req.body as { query?: string; page?: number };

  const meta = readMeta(id);
  if (!meta) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  const filePath = path.join(getAttachmentDir(id), meta.name);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on disk" });
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
          const pdfParse = require("pdf-parse");
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
      const cacheKey = `analyze${page ? `-p${page}` : ""}`;
      const cacheDir = getCacheDir(id);
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      writeFileSync(path.join(cacheDir, `${cacheKey}.json`), JSON.stringify(result), "utf-8");

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