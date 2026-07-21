import { Router, type Request, type Response } from "express";
import { searchLocalDocs, getDocContent, listLibrary, getLibraryStatus, searchAndArchive } from "../pi/librarian-service.js";
import { scanProjectInventory, getAllItems } from "../pi/librarian-scanner.js";
import { getProject, getAllProjects } from "../projects/manager.js";

const router = Router();

// GET /api/librarian/status — Statut de la bibliothèque
router.get("/status", (_req: Request, res: Response) => {
  res.json(getLibraryStatus());
});

// GET /api/librarian/library — Liste toute la bibliothèque
router.get("/library", (_req: Request, res: Response) => {
  res.json(listLibrary());
});

// GET /api/librarian/search?q=... — Recherche dans la bibliothèque locale
router.get("/search", (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });
  res.json(searchLocalDocs(q));
});

// GET /api/librarian/doc/:name — Récupère un doc spécifique
router.get("/doc/:name", (req: Request, res: Response) => {
  const { name } = req.params;
  const version = req.query.version as string | undefined;
  const doc = getDocContent(name, version);
  if (!doc) return res.status(404).json({ error: "Doc not found" });
  res.json(doc);
});

// POST /api/librarian/scan/:projectId — Scan l'inventaire d'un projet
router.post("/scan/:projectId", async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const project = getProject(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const inventory = await scanProjectInventory(project.cwd);
    const items = getAllItems(inventory);
    res.json({ inventory, items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/librarian/search-web — Recherche web via Webclaw + archivage
router.post("/search-web", async (req: Request, res: Response) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Missing 'query' in body" });
    const result = await searchAndArchive(query);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/librarian/update — Déclenche manuellement la mise à jour
router.post("/update", async (_req: Request, res: Response) => {
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