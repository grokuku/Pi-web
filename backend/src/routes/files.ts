import { Router, type Request, type Response } from "express";
import { readdirSync, statSync, mkdirSync, existsSync } from "fs";
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

export default router;
