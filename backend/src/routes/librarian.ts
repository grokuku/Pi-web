import { Router, type Request, type Response } from "express";
import { getDocContent, listLibrary, getLibraryStatus, searchAndArchive, archiveDoc, sanitizeDocPathComponent, type DocEntry, type DocContent } from "../pi/librarian-service.js";
import { librarianAuth, librarianAdminOnly, loadKeys, createKey, revokeKey } from "../pi/librarian-auth.js";
import { getAllProjects } from "../projects/manager.js";

const router = Router();

// ── Key management routes (admin only — localhost) ──
// These are mounted BEFORE librarianAuth so they use their own localhost check.

// GET /api/librarian/keys — list all keys (localhost only)
router.get("/keys", librarianAdminOnly, (_req: Request, res: Response) => {
  const keys = loadKeys();
  // Mask the key value in the list response
  res.json({ keys: keys.map(k => ({ ...k, key: k.key.slice(0, 12) + "…" })) });
});

// POST /api/librarian/keys — create a new key (localhost only)
router.post("/keys", librarianAdminOnly, (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const key = createKey(name);
    // Return the full key value only on creation
    res.status(201).json(key);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/librarian/keys/:key — revoke a key (localhost only)
router.delete("/keys/:key", librarianAdminOnly, (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const deleted = revokeKey(key);
    if (!deleted) return res.status(404).json({ error: "Key not found" });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Public route (no auth) ──

// GET /api/librarian/status — Statut de la bibliothèque (health check)
router.get("/status", (_req: Request, res: Response) => {
  res.json(getLibraryStatus());
});

// ── Authenticated routes (librarianAuth: localhost bypass, else X-API-Key) ──

// GET /api/librarian/library — Liste toute la bibliothèque
router.get("/library", librarianAuth, (_req: Request, res: Response) => {
  res.json(listLibrary());
});

// POST /api/librarian/search — Recherche (web + bibliothèque locale)
router.post("/search", librarianAuth, async (req: Request, res: Response) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Missing 'query' in body" });
    const result = await searchAndArchive(query);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/librarian/doc/:name — Récupère un doc spécifique
router.get("/doc/:name", librarianAuth, (req: Request, res: Response) => {
  const { name } = req.params;
  const version = req.query.version as string | undefined;
  const doc = getDocContent(name, version);
  if (!doc) return res.status(404).json({ error: "Doc not found" });
  res.json(doc);
});

// POST /api/librarian/archive — Archive un document fourni par un agent externe
router.post("/archive", librarianAuth, (req: Request, res: Response) => {
  try {
    const { name, version, type, sourceUrl, content } = req.body;
    if (!name || !version || !content) {
      return res.status(400).json({ error: "Missing required fields: name, version, content" });
    }

    // Neutralise tout path traversal dans name/version avant construction du chemin.
    const safeName = sanitizeDocPathComponent(name);
    const safeVersion = sanitizeDocPathComponent(version);
    if (!safeName || !safeVersion) {
      return res.status(400).json({
        error: "name and version must be valid path components (no slashes, no backslashes, no '..')",
      });
    }

    const docContent: DocContent = {
      meta: {
        name: safeName,
        version: safeVersion,
        type: type || "tool",
        sourceUrl,
        updatedAt: new Date().toISOString(),
      },
      summary: content.summary || "",
      keyPoints: content.keyPoints || [],
      api: content.api || [],
      examples: content.examples || [],
      breakingChanges: content.breakingChanges,
      rawContent: content.rawContent,
    };

    const filePath = `tools/${safeName}@${safeVersion}.json`;
    const entry: DocEntry = {
      name: safeName,
      version: safeVersion,
      type: type || "tool",
      description: (content.summary || "").substring(0, 200),
      filePath,
      keywords: [safeName, ...(content.keyPoints || []).slice(0, 5)],
      updatedAt: new Date().toISOString(),
      sourceUrl,
    };

    archiveDoc(entry, docContent);
    res.status(201).json({ success: true, entry });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/librarian/update — Déclenche manuellement la mise à jour (cron)
router.post("/update", librarianAuth, async (_req: Request, res: Response) => {
  try {
    const { updateLibrary } = await import("../pi/librarian-cron.js");

    const projects = getAllProjects();
    const cwds = projects.map(p => p.cwd);

    const result = await updateLibrary(cwds);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;