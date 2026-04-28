import { Router, type Request, type Response } from "express";
import {
  setModel,
  setThinkingLevel,
  cycleModel,
  getSessionInfo,
  compactSession,
  newSession,
  reloadModelRegistry,
} from "../pi/session.js";

const router = Router();

// GET session info
router.get("/session", (_req: Request, res: Response) => {
  try {
    const info = getSessionInfo();
    res.json(info);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST set model
router.post("/model", async (req: Request, res: Response) => {
  try {
    const { provider, modelId } = req.body;
    if (!provider || !modelId) {
      return res.status(400).json({ error: "provider and modelId required" });
    }
    const queued = await setModel(provider, modelId);
    res.json({ success: true, queued });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST cycle model
router.post("/model/cycle", async (_req: Request, res: Response) => {
  try {
    const result = await cycleModel();
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST set thinking level
router.post("/thinking", async (req: Request, res: Response) => {
  try {
    const { level } = req.body;
    if (!level) {
      return res.status(400).json({ error: "level is required" });
    }
    const queued = await setThinkingLevel(level);
    res.json({ success: true, queued });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST new session
router.post("/session/new", async (_req: Request, res: Response) => {
  try {
    await newSession();
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST compact session
router.post("/session/compact", async (req: Request, res: Response) => {
  try {
    const { customInstructions } = req.body;
    const result = await compactSession(customInstructions);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST reload model registry (useful after Ollama config changes)
router.post("/models/reload", (_req: Request, res: Response) => {
  try {
    reloadModelRegistry();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;