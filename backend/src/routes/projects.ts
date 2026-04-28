import { Router, type Request, type Response } from "express";
import {
  getAllProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from "../projects/manager.js";
import { detectGit, getGitHistory, gitPull, gitPush, gitCheckout, syncGitInfo } from "../projects/git.js";

const router = Router();

// GET all projects
router.get("/", (_req: Request, res: Response) => {
  try {
    const projects = getAllProjects();
    res.json(projects);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET single project
router.get("/:id", (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    res.json(project);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST create project
router.post("/", (req: Request, res: Response) => {
  try {
    const { name, type, cwd, ssh, smb } = req.body;
    if (!name || !type || !cwd) {
      return res.status(400).json({ error: "name, type, and cwd are required" });
    }
    const project = createProject(name, type, cwd, ssh, smb);
    res.status(201).json(project);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// PUT update project
router.put("/:id", (req: Request, res: Response) => {
  try {
    const project = updateProject(req.params.id, req.body);
    res.json(project);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE project
router.delete("/:id", (req: Request, res: Response) => {
  try {
    deleteProject(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// GET detect git for project
router.get("/:id/git", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const gitInfo = await detectGit(project);
    res.json(gitInfo);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET git history
router.get("/:id/git/history", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const history = await getGitHistory(project.cwd);
    res.json(history);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST git pull
router.post("/:id/git/pull", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const result = await gitPull(project.cwd);
    await syncGitInfo(project);
    res.json({ result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST git push
router.post("/:id/git/push", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const result = await gitPush(project.cwd);
    res.json({ result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST git checkout
router.post("/:id/git/checkout", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const { ref } = req.body;
    if (!ref) {
      return res.status(400).json({ error: "ref is required" });
    }
    const result = await gitCheckout(project.cwd, ref);
    await syncGitInfo(project);
    res.json({ result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST sync git info
router.post("/:id/git/sync", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const updated = await syncGitInfo(project);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
