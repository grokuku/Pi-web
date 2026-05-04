import { Router, type Request, type Response } from "express";
import {
  loadModelLibrary,
  saveModelLibrary,
  addModel,
  addModels,
  updateModel,
  removeModel,
  setDefaultModel,
  setProjectModeModel,
  setProjectModeEnabled,
  setProjectModeMaxReviews,
  getProjectModeConfig,
  getModel,
  getDefaultModel,
  getModeModel,
  makeModelId,
  cleanupProjectModes,
  inferReasoning,
  type AgentMode,
  type RegisteredModel,
} from "../pi/model-library.js";
import { loadProviders } from "../pi/providers.js";
import { setModel, setThinkingLevel, reloadModelRegistry, getModelRegistry } from "../pi/session.js";

const router = Router();

// ── Helpers ──────────────────────────────────────────

const VALID_MODES: AgentMode[] = ["code", "review", "plan"];

function validateMode(mode: string): AgentMode {
  if (!VALID_MODES.includes(mode as AgentMode)) {
    throw new Error(`Invalid mode: ${mode}. Valid: ${VALID_MODES.join(", ")}`);
  }
  return mode as AgentMode;
}

function safeDecode(encoded: string): string {
  try { return decodeURIComponent(encoded); }
  catch { return encoded; }
}

/** Generate models.json for Pi SDK from our providers + model library */
async function syncToModelsJson(): Promise<void> {
  const providers = loadProviders();
  const library = loadModelLibrary();
  const { writeModelsJson } = await import("../pi/sync-providers.js");
  await writeModelsJson(providers, library);
  reloadModelRegistry();
}

// ── GET full library ──────────────────────────────────

router.get("/", (_req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    res.json(library);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST add model(s) ─────────────────────────────────

router.post("/models", async (req: Request, res: Response) => {
  try {
    const { models } = req.body;

    if (Array.isArray(models)) {
      // Bulk add
      const entries: Omit<RegisteredModel, "id">[] = models.map((m: any) => ({
        providerId: m.providerId,
        modelId: m.modelId,
        name: m.name || m.modelId,
        isDefault: m.isDefault || false,
        reasoning: m.reasoning ?? inferReasoning(m.modelId),
        contextWindow: m.contextWindow || 128000,
        maxTokens: m.maxTokens || 16384,
        temperature: m.temperature,
        topP: m.topP,
        minP: m.minP,
        topK: m.topK,
        repeatPenalty: m.repeatPenalty,
        thinkingLevel: m.thinkingLevel || "medium",
      }));

      const library = addModels(entries);
      await syncToModelsJson();
      res.json(library);
    } else {
      // Single add
      const { providerId, modelId, name, reasoning, contextWindow, maxTokens,
              temperature, topP, minP, topK, repeatPenalty, thinkingLevel, isDefault } = req.body;

      if (!providerId || !modelId) {
        return res.status(400).json({ error: "providerId and modelId required" });
      }

      const library = addModel({
        providerId,
        modelId,
        name: name || modelId,
        isDefault: isDefault || false,
        reasoning: reasoning ?? inferReasoning(modelId),
        contextWindow: contextWindow || 128000,
        maxTokens: maxTokens || 16384,
        temperature, topP, minP, topK, repeatPenalty,
        thinkingLevel: thinkingLevel || "medium",
      });

      await syncToModelsJson();
      res.json(library);
    }
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT update model ──────────────────────────────────

router.put("/models/:id", async (req: Request, res: Response) => {
  try {
    const id = safeDecode(req.params.id);
    const library = updateModel(id, req.body);
    await syncToModelsJson();
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── DELETE model ───────────────────────────────────────

router.delete("/models/:id", async (req: Request, res: Response) => {
  try {
    const id = safeDecode(req.params.id);
    const library = removeModel(id);
    await syncToModelsJson();
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT set default model ──────────────────────────────

router.put("/models/:id/default", async (req: Request, res: Response) => {
  try {
    const id = safeDecode(req.params.id);
    const library = setDefaultModel(id);
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET/PUT project mode config ───────────────────────

router.get("/projects/:projectId/mode", (req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    const config = getProjectModeConfig(library, req.params.projectId);
    res.json(config);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/projects/:projectId/mode", async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const { mode, modelId, enabled, maxReviews } = req.body;

    if (mode) validateMode(mode);

    let library = loadModelLibrary();

    if (modelId !== undefined) {
      library = setProjectModeModel(projectId, mode, modelId);
    }
    if (enabled !== undefined && (mode === "plan" || mode === "review")) {
      library = setProjectModeEnabled(projectId, mode, enabled);
    }
    if (maxReviews !== undefined && mode === "review") {
      library = setProjectModeMaxReviews(projectId, maxReviews);
    }

    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── DELETE project mode config (cleanup) ─────────────

router.delete("/projects/:projectId/mode", (req: Request, res: Response) => {
  try {
    cleanupProjectModes(req.params.projectId);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;