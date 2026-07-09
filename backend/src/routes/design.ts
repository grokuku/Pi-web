import { Router, type Request, type Response } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { Mutex } from "../utils/mutex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", ".data");
const DESIGNS_FILE = join(DATA_DIR, "designs.json");

const mutex = new Mutex();

// ── Types ──

interface DesignPage {
  id: string;
  name: string;
  html: string;
  css: string;
  thumbnail: string | null;
}

interface Design {
  id: string;
  name: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  designSystem: Record<string, unknown> | null;
  components: Record<string, unknown>[];
  pages: DesignPage[];
}

interface DesignsStore {
  designs: Design[];
}

// ── Helpers ──

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readDesigns(): DesignsStore {
  ensureDataDir();
  if (!existsSync(DESIGNS_FILE)) {
    const initial: DesignsStore = { designs: [] };
    writeFileSync(DESIGNS_FILE, JSON.stringify(initial, null, 2), "utf-8");
    return initial;
  }
  const raw = readFileSync(DESIGNS_FILE, "utf-8");
  return JSON.parse(raw) as DesignsStore;
}

function writeDesigns(store: DesignsStore): void {
  ensureDataDir();
  writeFileSync(DESIGNS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

const router = Router();

// GET /api/design — List all designs
router.get("/", (_req: Request, res: Response) => {
  try {
    const store = readDesigns();
    res.json(store.designs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/design/:id — Get a single design
router.get("/:id", (req: Request, res: Response) => {
  try {
    const store = readDesigns();
    const design = store.designs.find((d) => d.id === req.params.id);
    if (!design) {
      return res.status(404).json({ error: "Design not found" });
    }
    res.json(design);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/design/project/:projectId — Designs linked to a project
router.get("/project/:projectId", (req: Request, res: Response) => {
  try {
    const store = readDesigns();
    const designs = store.designs.filter((d) => d.projectId === req.params.projectId);
    res.json(designs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/design — Create a new design
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, projectId, designSystem, components, pages } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "name is required and must be a non-empty string" });
    }

    const now = new Date().toISOString();
    const newDesign: Design = {
      id: randomUUID(),
      name: name.trim(),
      projectId: projectId || null,
      createdAt: now,
      updatedAt: now,
      designSystem: designSystem || null,
      components: Array.isArray(components) ? components : [],
      pages: Array.isArray(pages) ? pages.map((page: any) => ({
        id: page.id || randomUUID(),
        name: page.name || "Page 1",
        html: page.html || "",
        css: page.css || "",
        thumbnail: page.thumbnail || null,
      })) : [
        {
          id: randomUUID(),
          name: "Page 1",
          html: "",
          css: "",
          thumbnail: null,
        },
      ],
    };

    await mutex.run(() => {
      const store = readDesigns();
      store.designs.push(newDesign);
      writeDesigns(store);
    });

    res.status(201).json(newDesign);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/design/:id — Update a design
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const { name, projectId, designSystem, components, pages } = req.body;

    let updatedDesign: Design | null = null;

    await mutex.run(() => {
      const store = readDesigns();
      const index = store.designs.findIndex((d) => d.id === req.params.id);
      if (index === -1) {
        return; // Will be handled after the mutex
      }

      const existing = store.designs[index];

      if (name !== undefined) {
        if (typeof name !== "string" || name.trim().length === 0) {
          throw new Error("name must be a non-empty string");
        }
        existing.name = name.trim();
      }

      if (projectId !== undefined) {
        existing.projectId = projectId;
      }

      if (designSystem !== undefined) {
        existing.designSystem = designSystem;
      }

      if (components !== undefined) {
        if (!Array.isArray(components)) {
          throw new Error("components must be an array");
        }
        existing.components = components;
      }

      if (pages !== undefined) {
        if (!Array.isArray(pages)) {
          throw new Error("pages must be an array");
        }
        existing.pages = pages.map((page: any) => ({
          id: page.id || randomUUID(),
          name: page.name || "Unnamed Page",
          html: page.html || "",
          css: page.css || "",
          thumbnail: page.thumbnail || null,
        }));
      }

      existing.updatedAt = new Date().toISOString();
      store.designs[index] = existing;
      writeDesigns(store);
      updatedDesign = existing;
    });

    if (!updatedDesign) {
      return res.status(404).json({ error: "Design not found" });
    }

    res.json(updatedDesign);
  } catch (error: any) {
    const status = error.message.includes("must be") ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

// DELETE /api/design/:id — Delete a design
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    let deleted = false;

    await mutex.run(() => {
      const store = readDesigns();
      const index = store.designs.findIndex((d) => d.id === req.params.id);
      if (index === -1) {
        return; // Will be handled after the mutex
      }
      store.designs.splice(index, 1);
      writeDesigns(store);
      deleted = true;
    });

    if (!deleted) {
      return res.status(404).json({ error: "Design not found" });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
