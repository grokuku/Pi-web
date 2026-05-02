import { Router, type Request, type Response } from "express";
import { readdirSync, statSync, mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";

const router = Router();

// Allowed root paths for browsing
const ALLOWED_ROOTS = ["/projects", "/home", "/root", "/app", "/mnt"];

function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return ALLOWED_ROOTS.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved.startsWith(resolvedRoot);
  });
}

interface FileEntry {
  name: string;
  type: "dir" | "file";
  size: number; // bytes, 0 for dirs
}

// GET /api/files/browse?path=/projects
router.get("/browse", (req: Request, res: Response) => {
  try {
    const targetPath = (req.query.path as string) || "/";
    const resolved = path.resolve(targetPath);

    if (!isPathAllowed(resolved)) {
      return res.status(403).json({
        error: `Access denied. Path must be within: ${ALLOWED_ROOTS.join(", ")}`,
      });
    }

    if (!existsSync(resolved)) {
      return res.status(404).json({
        error: "Directory not found",
        path: targetPath,
      });
    }

    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({
        error: "Path is not a directory",
        path: targetPath,
      });
    }

    const entries: FileEntry[] = [];
    const dirents = readdirSync(resolved, { withFileTypes: true });

    for (const d of dirents) {
      // Skip hidden files/folders (dotfiles)
      if (d.name.startsWith(".")) continue;

      try {
        const fullPath = path.join(resolved, d.name);
        const s = statSync(fullPath);
        entries.push({
          name: d.name,
          type: d.isDirectory() ? "dir" : "file",
          size: s.size,
        });
      } catch {
        // Permission error, skip this entry
      }
    }

    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = resolved === path.resolve("/") ? null : path.dirname(targetPath);

    res.json({
      path: targetPath,
      resolved: resolved,
      parent: parent && isPathAllowed(parent) ? parent : null,
      entries,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/files/mkdir
router.post("/mkdir", (req: Request, res: Response) => {
  try {
    const { parentPath, name } = req.body;

    if (!parentPath || !name) {
      return res.status(400).json({ error: "parentPath and name are required" });
    }

    // Validate name: no slashes, no dots at start
    if (name.includes("/") || name.includes("\\")) {
      return res.status(400).json({ error: "Folder name cannot contain slashes" });
    }
    if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
      return res.status(400).json({ error: "Folder name contains invalid characters" });
    }

    const resolved = path.resolve(parentPath);
    if (!isPathAllowed(resolved)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const fullPath = path.join(resolved, name);
    if (existsSync(fullPath)) {
      return res.status(409).json({ error: `"${name}" already exists` });
    }

    mkdirSync(fullPath, { recursive: true });
    res.json({ path: path.join(parentPath, name), name });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── Read file content ──
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".vue", ".svelte",
  ".css", ".scss", ".less", ".html", ".xml", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".sh", ".bash", ".zsh", ".fish",
  ".py", ".rb", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".swift", ".dart", ".lua", ".r", ".sql", ".graphql",
  ".dockerfile", ".gitignore", ".env", ".editorconfig",
  ".makefile", ".cmake", ".gradle",
  ".lock", ".log", ".csv", ".tsv",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

router.get("/read", (req: Request, res: Response) => {
  try {
    const filePath = (req.query.path as string) || "";
    const resolved = path.resolve(filePath);

    if (!isPathAllowed(resolved)) {
      return res.status(403).json({ error: "Access denied" });
    }

    if (!existsSync(resolved)) {
      return res.status(404).json({ error: "File not found" });
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Path is a directory" });
    }

    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File too large (${Math.round(stat.size / 1024)}KB). Max ${MAX_FILE_SIZE / 1024 / 1024}MB.` });
    }

    const ext = path.extname(resolved).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isText = TEXT_EXTENSIONS.has(ext) || ext === "" || stat.size < 100 * 1024;

    if (isImage) {
      const buffer = readFileSync(resolved);
      const mimeType = ext === ".svg" ? "image/svg+xml" :
        ext === ".png" ? "image/png" :
        ext === ".gif" ? "image/gif" :
        "image/jpeg";
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);
      return;
    }

    if (isText) {
      const content = readFileSync(resolved, "utf-8");
      return res.json({
        path: filePath,
        name: path.basename(resolved),
        ext,
        size: stat.size,
        content,
      });
    }

    return res.status(415).json({ error: `Cannot preview file type: ${ext}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
