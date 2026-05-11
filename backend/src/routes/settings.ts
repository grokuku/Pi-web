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
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const router = Router();

// ── Version info ──
const BACKEND_DIR = join(process.cwd(), "backend");

const PI_WEB_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(BACKEND_DIR, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch { return "unknown"; }
})();

const PI_AGENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(BACKEND_DIR, "node_modules/@mariozechner/pi-coding-agent/package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch { return "unknown"; }
})();

router.get("/version", (_req: Request, res: Response) => {
  res.json({
    piWeb: PI_WEB_VERSION,
    piAgent: PI_AGENT_VERSION,
  });
});

// Check for pi-agent update
router.get("/update-check", async (_req: Request, res: Response) => {
  try {
    const result = execSync("npm view @mariozechner/pi-coding-agent version", { timeout: 15000, encoding: "utf-8" }).trim();
    const latestVersion = result;
    res.json({
      current: PI_AGENT_VERSION,
      latest: latestVersion,
      updateAvailable: latestVersion !== PI_AGENT_VERSION,
    });
  } catch (e: any) {
    res.json({ current: PI_AGENT_VERSION, latest: PI_AGENT_VERSION, updateAvailable: false, error: e.message });
  }
});

// Update pi-agent
router.post("/update", async (_req: Request, res: Response) => {
  try {
    // Update the package in the backend directory
    execSync("npm update @mariozechner/pi-coding-agent", { timeout: 120000, encoding: "utf-8", cwd: BACKEND_DIR });
    const newPkg = JSON.parse(readFileSync(join(BACKEND_DIR, "node_modules/@mariozechner/pi-coding-agent/package.json"), "utf-8"));
    res.json({ success: true, newVersion: newPkg.version, message: "Update successful. Please restart Pi-Web." });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

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