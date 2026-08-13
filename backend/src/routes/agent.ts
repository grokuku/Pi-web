import { Router, type Request, type Response } from "express";
import { execSync } from "child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import path from "path";
import { agentAuth } from "../middleware/agent-auth.js";
import {
  createPiSession,
  sendPrompt,
  abortPi,
  getSessionInfo,
  getSession,
  getActiveToolCalls,
  isSessionStreaming,
} from "../pi/session.js";
import {
  loadModelLibrary,
  getModeModel,
  getProjectModeConfig,
  setProjectModeModel,
} from "../pi/model-library.js";
import { loadProviders } from "../pi/providers.js";
import {
  getAllProjects,
  getProject,
  createProject,
  deleteProject,
} from "../projects/manager.js";
import type { AgentMode } from "../pi/model-library.js";

const router = Router();

// ── Auth middleware on all agent routes (except health) ──
router.use(agentAuth);

// ── Health (no auth needed, handled before middleware) ──
// We'll add health to the main app router directly

// ── Helpers ──────────────────────────────────────────

import { isPathAllowed } from "../utils/path-security.js";

/** Vérifie si le cwd est un dépôt git utilisable.
 *  On exige un `.git` dans le cwd (comme `detectGit`) pour ne pas considérer
 *  un sous-dossier d'un dépôt parent comme un projet git à part entière. */
function isGitRepo(cwd: string): boolean {
  if (!existsSync(path.join(cwd, ".git"))) return false;
  try {
    const output = execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    });
    return output.trim() === "true";
  } catch {
    return false;
  }
}

/** Prend un instantané git des fichiers modifiés dans le cwd.
 *  Combine `git diff` (fichiers suivis) et `git ls-files --others` (fichiers
 *  non suivis), car `git diff` ne voit pas les nouveaux fichiers créés par l'agent.
 *  Retourne un set de chemins relatifs. */
function gitSnapshot(cwd: string): Set<string> {
  const files = new Set<string>();

  try {
    const diff = execSync("git diff --name-only", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    });
    for (const f of diff.trim().split("\n")) {
      if (f) files.add(f);
    }
  } catch {
    // Pas un dépôt git — on laisse le set vide, le fallback fs prendra le relais.
  }

  try {
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    });
    for (const f of untracked.trim().split("\n")) {
      if (f) files.add(f);
    }
  } catch {
    // Ignoré : pas de dépôt git ou aucun fichier non suivi.
  }

  return files;
}

/** Prend un instantané des fichiers du cwd sans passer par git.
 *  Retourne une map chemin relatif → mtime (ms) pour comparer les fichiers modifiés. */
function fsSnapshot(cwd: string): Map<string, number> {
  const files = new Map<string, number>();

  const walk = (dir: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // On ignore les métadonnées git et les dépendances pour rester pertinent
      // (et éviter de parcourir des milliers de fichiers inutilement).
      if (entry.name === ".git" || entry.name === "node_modules") continue;

      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        try {
          files.set(rel, statSync(full).mtimeMs);
        } catch {
          // Fichier inaccessible (permissions, suppression concurrente) — ignoré.
        }
      }
    }
  };

  walk(cwd, "");
  return files;
}

/** Diff two git snapshots. Returns files that appear in `after` but not in `before`.
 *  Note: this gives us files that were modified DURING the prompt. */
function diffSnapshots(before: Set<string>, after: Set<string>): string[] {
  const changed: string[] = [];
  for (const f of after) {
    if (!before.has(f)) changed.push(f);
  }
  return changed;
}

/** Diff two filesystem snapshots. Returns files created or touched between the snapshots. */
function diffFsSnapshots(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [file, mtime] of after) {
    const beforeMtime = before.get(file);
    if (beforeMtime === undefined || beforeMtime !== mtime) changed.push(file);
  }
  return changed;
}

/** Fichiers modifiés en mode git (diff + untracked) pour /files/changed. */
function getGitChangedFiles(cwd: string): Array<{ path: string; status: string }> {
  const files: Array<{ path: string; status: string }> = [];

  try {
    const output = execSync("git diff --name-status", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    });
    const tracked = output.trim().split("\n").filter(Boolean).map(line => {
      const [status, ...rest] = line.split("\t");
      return { path: rest.join("\t"), status: status || "M" };
    });
    files.push(...tracked);
  } catch {
    // Pas de dépôt git — le fallback fs prendra le relais.
  }

  try {
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    });
    for (const f of untracked.trim().split("\n")) {
      // Un fichier non suivi est un ajout du point de vue de l'agent.
      if (f) files.push({ path: f, status: "A" });
    }
  } catch {
    // Ignoré.
  }

  return files;
}

/** Fichiers modifiés sans git : on compare les mtimes au timestamp `since`. */
function getFsChangedFiles(cwd: string, since?: string): Array<{ path: string; status: string }> {
  const snapshot = fsSnapshot(cwd);
  const files: Array<{ path: string; status: string }> = [];
  const sinceMs = since ? Date.parse(since) : NaN;

  for (const [file, mtime] of snapshot) {
    if (Number.isNaN(sinceMs)) {
      // Sans git ni timestamp de référence, tous les fichiers sont considérés ajoutés.
      files.push({ path: file, status: "A" });
    } else if (mtime > sinceMs) {
      files.push({ path: file, status: "M" });
    }
  }

  return files;
}

/** Get changed files for the /files/changed endpoint (git puis fallback fs). */
function getChangedFiles(cwd: string, since?: string): Array<{ path: string; status: string }> {
  if (isGitRepo(cwd)) return getGitChangedFiles(cwd);
  return getFsChangedFiles(cwd, since);
}

/** Collect messages from a session for the agent API response */
function collectMessages(state: any): any[] {
  const session = state?.session;
  if (!session) return [];

  const messages = session.messages || [];
  return messages.map((m: any) => {
    const base: any = {
      role: m.role,
      timestamp: m.timestamp,
    };

    if (m.role === "user") {
      base.content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    } else if (m.role === "assistant") {
      const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content || "") }];
      // Separate text, thinking, and tool calls
      const textBlocks = content.filter((b: any) => b.type === "text");
      const thinkingBlocks = content.filter((b: any) => b.type === "thinking");
      const toolBlocks = content.filter((b: any) => b.type === "tool_use" || b.type === "toolCall" || b.type === "function");

      base.content = textBlocks.map((b: any) => b.text || "").join("\n");
      base.thinking = thinkingBlocks.map((b: any) => b.thinking || "").join("\n") || undefined;

      if (toolBlocks.length > 0) {
        base.toolCalls = toolBlocks.map((b: any) => ({
          name: b.name || b.toolName || "unknown",
          arguments: b.arguments || b.input || b.args || {},
        }));
      }
      if (m.usage) base.usage = m.usage;
    } else if (m.role === "toolResult") {
      base.toolCallId = m.toolCallId;
      base.toolName = m.toolName;
      base.output = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      base.isError = m.isError || false;
    }

    return base;
  });
}

/** Get the last usage info from session messages */
function getLastUsage(state: any) {
  const session = state?.session;
  if (!session) return { input: 0, output: 0, cost: { total: 0 } };

  const messages = session.messages || [];
  // Find the last assistant message with usage
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage) {
      return {
        input: m.usage.input || 0,
        output: m.usage.output || 0,
        cost: { total: m.usage.cost?.total || 0 },
      };
    }
  }
  return { input: 0, output: 0, cost: { total: 0 } };
}

// ── 1. Projects ──────────────────────────────────────

router.get("/projects", (_req: Request, res: Response) => {
  try {
    const projects = getAllProjects().map(p => ({
      id: p.id,
      name: p.name,
      storage: p.storage,
      cwd: p.cwd,
      createdAt: p.createdAt,
      lastActiveAt: p.lastActiveAt,
    }));
    res.json({ projects });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/projects", async (req: Request, res: Response) => {
  try {
    const { name, storage, cwd } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const effectiveCwd = cwd || `/projects/${name}`;
    const project = await createProject(name, storage || "local", effectiveCwd);
    res.status(201).json({
      id: project.id,
      name: project.name,
      storage: project.storage,
      cwd: project.cwd,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/projects/:id", (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json({
      id: project.id,
      name: project.name,
      storage: project.storage,
      cwd: project.cwd,
      git: project.git ? { remote: project.git.remote, branch: project.git.branch } : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/projects/:id", async (req: Request, res: Response) => {
  try {
    const deleteFiles = req.query.deleteFiles === "true";
    await deleteProject(req.params.id, deleteFiles);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── 2. Models ────────────────────────────────────────

router.get("/models", (_req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    const providers = loadProviders();

    const models = library.models.map(m => {
      const provider = providers.find(p => p.id === m.providerId);
      return {
        id: m.id,
        name: m.name,
        providerId: m.providerId,
        modelId: m.modelId,
        providerName: provider?.name || provider?.type || m.providerId,
        reasoning: m.reasoning,
        vision: m.vision,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      };
    });

    res.json({ models, defaultModelId: library.defaultModelId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 3. Mode ──────────────────────────────────────────

router.get("/projects/:id/mode", (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const library = loadModelLibrary();
    const providers = loadProviders();
    const pm = getProjectModeConfig(library, req.params.id);

    function modelInfo(modelId: string | null) {
      if (!modelId) return null;
      const m = library.models.find(m => m.id === modelId);
      if (!m) return null;
      const provider = providers.find(p => p.id === m.providerId);
      return {
        modelId: m.id,
        modelName: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        providerName: provider?.name || m.providerId,
      };
    }

    const state = getSession(req.params.id);
    const activeMode = state?.activeMode || "code";

    res.json({
      activeMode,
      modes: {
        code: { modelId: pm.code.modelId, ...(modelInfo(pm.code.modelId) || {}) },
        review: {
          modelId: pm.review.modelId,
          enabled: pm.review.enabled,
          maxReviews: pm.review.maxReviews,
          fixWithInstructions: pm.review.fixWithInstructions ?? true,
          ...(modelInfo(pm.review.modelId) || {}),
        },
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/projects/:id/mode", async (req: Request, res: Response) => {
  try {
    const { mode, modelId } = req.body;
    if (!mode) return res.status(400).json({ error: "mode is required" });
    if (!["code", "review"].includes(mode)) {
      return res.status(400).json({ error: `Invalid mode: ${mode}. Valid: code, review` });
    }

    const library = loadModelLibrary();
    const providers = loadProviders();

    if (modelId !== undefined) {
      const model = library.models.find(m => m.id === modelId);
      if (!model && modelId !== null) {
        return res.status(400).json({ error: `Model not found: ${modelId}` });
      }
      setProjectModeModel(req.params.id, mode as AgentMode, modelId);
    }

    // Re-read library after update
    const updatedLibrary = loadModelLibrary();
    const pm = getProjectModeConfig(updatedLibrary, req.params.id);
    const modeConfig = (pm as any)[mode];
    const currentModelId = modeConfig?.modelId;
    const model = currentModelId ? updatedLibrary.models.find((m: any) => m.id === currentModelId) : null;
    const provider = model ? providers.find(p => p.id === model.providerId) : null;

    res.json({
      mode,
      modelId: currentModelId || null,
      modelName: model?.name || null,
      contextWindow: model?.contextWindow || 0,
      maxTokens: model?.maxTokens || 0,
      providerName: provider?.name || null,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── 4. Chat ──────────────────────────────────────────

router.post("/projects/:id/chat", async (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const { message, images, timeout: timeoutSecs } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message (string) is required" });
    }

    const timeout = Math.min(timeoutSecs || 300, 600) * 1000; // max 10 minutes

    // 1. Create/resume session
    const state = await createPiSession(project.cwd, project.id, { projectName: project.name });

    // 2. Apply mode/model from library config (code mode)
    const library = loadModelLibrary();
    const desiredModel = getModeModel(library, project.id, "code");
    if (desiredModel && state.session) {
      const currentModel = state.session.model;
      const needsUpdate = !currentModel ||
        currentModel.id !== desiredModel.modelId ||
        currentModel.provider !== desiredModel.providerId;

      if (needsUpdate) {
        const { applyModeToSession } = await import("../pi/session.js");
        await applyModeToSession("code", project.id);
      }
    }

    // 3. Snapshot files before prompt (git si possible, sinon timestamps fs)
    const hasGit = isGitRepo(project.cwd);
    const beforeSnapshot: Set<string> | Map<string, number> = hasGit
      ? gitSnapshot(project.cwd)
      : fsSnapshot(project.cwd);

    // 4. Send prompt and wait for completion
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortPi(project.id).catch(() => {});
    }, timeout);

    let status: string;
    try {
      await sendPrompt(message, project.id, images);
      status = "completed";
    } catch (e: any) {
      if (timedOut) {
        status = "timeout";
      } else if (e.message?.includes("abort") || e.message?.includes("cancelled")) {
        status = "aborted";
      } else {
        status = "error";
        clearTimeout(timeoutHandle);
        return res.status(500).json({ status: "error", error: e.message, messages: [] });
      }
    }
    clearTimeout(timeoutHandle);

    // 5. Snapshot files after prompt
    const afterSnapshot: Set<string> | Map<string, number> = hasGit
      ? gitSnapshot(project.cwd)
      : fsSnapshot(project.cwd);
    const filesChanged = hasGit
      ? diffSnapshots(beforeSnapshot as Set<string>, afterSnapshot as Set<string>)
      : diffFsSnapshots(beforeSnapshot as Map<string, number>, afterSnapshot as Map<string, number>);

    // 6. Collect messages
    const freshState = getSession(project.id);
    const messages = collectMessages(freshState);
    const usage = getLastUsage(freshState);

    res.json({
      status,
      messages,
      filesChanged: filesChanged.map(f => path.join(project.cwd, f)),
      usage,
    });
  } catch (e: any) {
    res.status(500).json({ status: "error", error: e.message, messages: [] });
  }
});

router.get("/projects/:id/chat/status", (req: Request, res: Response) => {
  try {
    const state = getSession(req.params.id);
    if (!state) return res.json({ running: false });

    const tools = getActiveToolCalls();
    const currentTool = Array.from(tools.values()).find((t: any) => t.projectId === req.params.id) as any;

    res.json({
      running: isSessionStreaming(req.params.id) || false,
      currentTool: currentTool?.toolName || null,
      tokensUsed: state.session?.messages?.length
        ? state.session.messages.reduce((sum: number, m: any) => sum + (m.usage?.input || 0), 0)
        : 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/projects/:id/chat/abort", async (req: Request, res: Response) => {
  try {
    await abortPi(req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 5. Context ───────────────────────────────────────

router.get("/projects/:id/context", (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const state = getSession(req.params.id);
    const library = loadModelLibrary();
    const providers = loadProviders();
    const desiredModel = getModeModel(library, req.params.id, "code");

    let modelInfo = { id: "", name: "", contextWindow: 0, maxTokens: 0 };
    if (desiredModel) {
      modelInfo = {
        id: desiredModel.id,
        name: desiredModel.name,
        contextWindow: desiredModel.contextWindow,
        maxTokens: desiredModel.maxTokens,
      };
    } else if (state?.session?.model) {
      const sm = state.session.model as any;
      modelInfo = {
        id: sm.id || "",
        name: sm.name || sm.id || "",
        contextWindow: sm.contextWindow || 128000,
        maxTokens: sm.maxTokens || 16384,
      };
    }

    // Calculate context used from session messages
    let contextUsed = 0;
    if (state?.session?.messages) {
      contextUsed = state.session.messages.reduce(
        (sum: number, m: any) => sum + (m.usage?.input || 0) + (m.usage?.output || 0),
        0
      );
    }

    const contextPercent = modelInfo.contextWindow > 0
      ? Math.round((contextUsed / modelInfo.contextWindow) * 100)
      : 0;

    res.json({
      projectId: project.id,
      activeMode: state?.activeMode || "code",
      model: modelInfo,
      contextUsed,
      contextPercent,
      sessionId: state?.session?.sessionId || null,
      // BUG-72 : état réel du SDK (source de vérité), pas le flag backend stale.
      sessionRunning: isSessionStreaming(req.params.id) || false,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 6. Files ─────────────────────────────────────────

router.get("/projects/:id/files/changed", (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const sinceParam = req.query.since;
    if (sinceParam !== undefined && typeof sinceParam !== "string") {
      return res.status(400).json({ error: "Invalid since date" });
    }
    if (sinceParam !== undefined && Number.isNaN(Date.parse(sinceParam))) {
      return res.status(400).json({ error: "Invalid since date" });
    }

    const files = getChangedFiles(project.cwd, sinceParam);
    res.json({ files });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/projects/:id/files", (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const targetPath = (req.query.path as string) || project.cwd;
    const resolved = path.resolve(targetPath);

    // Confinement au cwd du projet : un agent du projet A ne peut pas lire
    // les fichiers du projet B même s'ils partagent une racine globale.
    if (!isPathAllowed(resolved, project.cwd)) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!existsSync(resolved)) {
      return res.status(404).json({ error: "Directory not found" });
    }

    const entries = readdirSync(resolved, { withFileTypes: true })
      .filter(d => !d.name.startsWith("."))
      .map(d => ({
        name: d.name,
        type: d.isDirectory() ? "dir" as const : "file" as const,
        size: d.isDirectory() ? 0 : statSync(path.join(resolved, d.name)).size,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ path: targetPath, entries });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/projects/:id/files/read", (req: Request, res: Response) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const filePath = (req.query.path as string) || "";
    const resolved = path.resolve(filePath);

    // Confinement au cwd du projet (même logique que /projects/:id/files).
    if (!isPathAllowed(resolved, project.cwd)) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!existsSync(resolved)) {
      return res.status(404).json({ error: "File not found" });
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Path is a directory, not a file" });
    }

    const content = readFileSync(resolved, "utf-8");
    res.json({
      path: filePath,
      content,
      size: stat.size,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
