import { Router, type Request, type Response } from "express";
import {
  getAllProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from "../projects/manager.js";
import { detectGit, getGitHistory, gitPull, gitPush, gitCheckout, syncGitInfo, getGitStatus, gitClone, gitInit, gitCommitAndPush, gitCommitPushPreview, getGitIdentity, setGitIdentity, GitIdentityError, GitAuthError, setGitCredentials, getRemoteHost, getGitDiff } from "../projects/git.js";
import { credentialStore } from "../projects/credential-store.js";
import { generateAiCommitMessage, getCommitModelInfo, injectSessionNotification } from "../pi/session.js";

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
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, storage, cwd, ssh, smb, versioning, git } = req.body;
    if (!name || !storage) {
      return res.status(400).json({ error: "name and storage are required" });
    }
    // Default cwd to /projects/{name} for local storage if not provided
    const effectiveCwd = storage === "local" ? (cwd || `/projects/${name}`) : cwd;
    if (!effectiveCwd) {
      return res.status(400).json({ error: "cwd is required for non-local storage" });
    }
    const project = await createProject(name, storage, effectiveCwd, versioning || "standalone", git, ssh, smb);
    res.status(201).json(project);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// PUT update project
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const project = await updateProject(req.params.id, req.body);
    res.json(project);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE project
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { deleteFiles } = req.query;
    const shouldDeleteFiles = deleteFiles === "true";
    await deleteProject(req.params.id, shouldDeleteFiles);
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
    if (error instanceof GitAuthError) {
      res.status(401).json({ error: error.message, code: "GIT_AUTH_REQUIRED" });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

// POST git push (raw push, no staging/commit)
router.post("/:id/git/push", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const result = await gitPush(project.cwd);
    injectSessionNotification(project.id, "✅ Code pushed to remote repository. All local commits are now on the remote.");
    res.json({ result });
  } catch (error: any) {
    if (error instanceof GitAuthError) {
      res.status(401).json({ error: error.message, code: "GIT_AUTH_REQUIRED" });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

// POST git commit and push (stage all → commit → push)
router.post("/:id/git/commit-push", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    let { subject, body } = req.body || {};

    // If no custom message, try AI generation
    if (!subject) {
      try {
        const diff = await getGitDiff(project.cwd);
        console.log(`[commit-push] No subject, got diff (${diff.length} chars), calling AI...`);
        const aiMsg = await generateAiCommitMessage(diff, project.id);
        if (aiMsg) {
          console.log(`[commit-push] AI message: "${aiMsg.subject}"`);
          subject = aiMsg.subject;
          body = aiMsg.body;
        }
      } catch (err: any) {
        console.error("[commit-push] AI generation failed:", err?.message || err);
        // Fall back to heuristic inside gitCommitAndPush
      }
    }

    const result = await gitCommitAndPush(project.cwd, subject, body);
    await syncGitInfo(project);

    // Notify the AI session that code was pushed to GitHub
    if (result.commitResult || result.pushResult) {
      const commitHash = result.commitHash || "";
      const remoteUrl = result.remoteUrl || "";
      const notification = `✅ Code successfully pushed to GitHub.
Commit: ${subject}${body ? "\n" + body : ""}
Hash: ${commitHash}
Remote: ${remoteUrl || "origin"}

All changes from this commit are now live on the remote repository. Do not suggest modifications to files that were part of this commit unless the user explicitly asks for further changes.`;
      injectSessionNotification(project.id, notification, {
        commitHash,
        subject,
        remote: remoteUrl,
      });
    }

    res.json(result);
  } catch (error: any) {
    const msg = error?.message || String(error || "Unknown error");
    if (error instanceof GitIdentityError) {
      res.status(400).json({ error: msg, code: "GIT_IDENTITY_REQUIRED" });
    } else if (error instanceof GitAuthError) {
      res.status(401).json({ error: msg, code: "GIT_AUTH_REQUIRED" });
    } else if (msg.includes("index.lock") || msg.includes("lock persisted")) {
      res.status(409).json({
        error: "Git is locked. Another operation may be in progress. Wait a moment and try again, or run: rm -f .git/index.lock",
        code: "GIT_LOCKED",
      });
    } else {
      res.status(400).json({ error: msg });
    }
  }
});

// POST git commit-push preview (get changes + commit model info)
// Pass ?ai=true to also generate an AI commit message on demand
router.post("/:id/git/commit-push/preview", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const preview = await gitCommitPushPreview(project.cwd);

    // Gather commit model info (shown in UI) without calling the AI yet
    const commitModelInfo = getCommitModelInfo();

    // Only generate AI message when explicitly requested
    let aiMessage: { subject: string; body: string } | null = null;
    if (req.query.ai === "true") {
      try {
        const diff = await getGitDiff(project.cwd);
        console.log(`[commit-push] Got diff for preview (${diff.length} chars), calling AI...`);
        aiMessage = await generateAiCommitMessage(diff, project.id);
        if (aiMessage) {
          console.log(`[commit-push] AI message: "${aiMessage.subject}"`);
        } else {
          console.warn("[commit-push] AI message generation returned null");
        }
      } catch (err: any) {
        console.error("[commit-push] AI generation failed:", err?.message || err);
      }
    }

    res.json({ ...preview, aiMessage, commitModelInfo, diff: undefined });
  } catch (error: any) {
    const msg = error?.message || String(error || "Unknown error");
    if (msg.includes("index.lock") || msg.includes("lock persisted")) {
      res.status(409).json({
        error: "Git is locked. Wait a moment then retry, or run: rm -f .git/index.lock",
        code: "GIT_LOCKED",
      });
    } else {
      res.status(400).json({ error: msg });
    }
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

// GET git status
router.get("/:id/git/status", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const status = await getGitStatus(project.cwd);
    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST git clone
router.post("/:id/git/clone", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (!project.git?.remote) {
      return res.status(400).json({ error: "No git remote configured for this project" });
    }
    const branch = project.git.branch || "main";
    const result = await gitClone(project.cwd, project.git.remote, branch);
    await syncGitInfo(project);
    res.json({ result });
  } catch (error: any) {
    if (error instanceof GitAuthError) {
      res.status(401).json({ error: error.message, code: "GIT_AUTH_REQUIRED" });
    } else {
      res.status(400).json({ error: error.message });
    }
  }
});

// POST git init (init repo + add remote for non-empty dir)
router.post("/:id/git/init", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (!project.git?.remote) {
      return res.status(400).json({ error: "No git remote configured for this project" });
    }
    const branch = project.git.branch || "main";
    const result = await gitInit(project.cwd, project.git.remote, branch);
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

// GET git identity
router.get("/:id/git/identity", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const identity = await getGitIdentity(project.cwd);
    res.json(identity || { name: "", email: "" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST set git identity
router.post("/:id/git/identity", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const { name, email } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: "name and email are required" });
    }
    await setGitIdentity(project.cwd, name, email);
    res.json({ name, email });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST set git credentials (for HTTPS auth)
router.post("/:id/git/credentials", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password/token are required" });
    }
    await setGitCredentials(project.cwd, username, password);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE git credentials (remove from memory)
router.delete("/:id/git/credentials", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    const host = await getRemoteHost(project.cwd);
    credentialStore.delete(host);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
