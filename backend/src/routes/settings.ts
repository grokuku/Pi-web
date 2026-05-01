import { Router, type Request, type Response } from "express";
import {
  setModel,
  setThinkingLevel,
  cycleModel,
  getSessionInfo,
  compactSession,
  newSession,
  reloadModelRegistry,
  getSession,
} from "../pi/session.js";

const router = Router();

// GET session info (optionally for a specific project)
router.get("/session", (req: Request, res: Response) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const info = getSessionInfo(projectId);
    res.json(info);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST set model (optionally for a specific project)
router.post("/model", async (req: Request, res: Response) => {
  try {
    const { provider, modelId, projectId } = req.body;
    if (!provider || !modelId) {
      return res.status(400).json({ error: "provider and modelId required" });
    }
    const queued = await setModel(provider, modelId, projectId);
    res.json({ success: true, queued });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST cycle model (for a specific project)
router.post("/model/cycle", async (req: Request, res: Response) => {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: "projectId required" });
    }
    const result = await cycleModel(projectId);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST set thinking level (optionally for a specific project)
router.post("/thinking", async (req: Request, res: Response) => {
  try {
    const { level, projectId } = req.body;
    if (!level) {
      return res.status(400).json({ error: "level is required" });
    }
    const queued = await setThinkingLevel(level, projectId);
    res.json({ success: true, queued });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// GET current thinking level
router.get("/thinking", (req: Request, res: Response) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const info = getSessionInfo(projectId);
    res.json({ level: info?.thinkingLevel || "medium" });
  } catch {
    res.json({ level: "medium" });
  }
});

// POST new session (for a specific project)
router.post("/session/new", async (req: Request, res: Response) => {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: "projectId required" });
    }
    await newSession(projectId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST compact session
router.post("/session/compact", async (req: Request, res: Response) => {
  try {
    const { projectId, customInstructions } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: "projectId required" });
    }
    const result = await compactSession(projectId, customInstructions);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST reload model registry
router.post("/models/reload", (_req: Request, res: Response) => {
  try {
    reloadModelRegistry();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;