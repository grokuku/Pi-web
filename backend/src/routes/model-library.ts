import { Router, type Response } from "express";
import type { Request } from "../utils/http-types.js";
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
  setProjectModeHarnessConfig,
  setProjectRoutingConfig,
  applyRoutingToLibrary,
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
import { loadProviders, inferVision, inferContextWindow } from "../pi/providers.js";
import { planRoutingCopy } from "../pi/routing-copy.js";
import { getAllProjects } from "../projects/manager.js";
import { setModel, setThinkingLevel, reloadModelRegistry, getModelRegistry, getActiveMode, reapplyAllSessions, getSession, compactSession } from "../pi/session.js";

const router = Router();

// ── Helpers ──────────────────────────────────────────

const VALID_MODES: AgentMode[] = ["code", "harness"];

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
        vision: m.vision ?? inferVision(m.modelId),
        contextWindow: m.contextWindow || inferContextWindow(m.modelId),
        maxTokens: m.maxTokens || 16384,
        // Pas de niveau figé par défaut : clé absente = « défaut » (niveau du mode).
        // Évite un thinkingLevel (ex. "medium") absent des niveaux DÉCLARÉS par le provider.
        thinkingLevel: m.thinkingLevel || undefined,
        // Overrides manuels ("auto" = détection) + niveaux de réflexion découverts
        visionOverride: m.visionOverride || "auto",
        audioOverride: m.audioOverride || "auto",
        reasoningOverride: m.reasoningOverride || "auto",
        reasoningLevels: Array.isArray(m.reasoningLevels) ? m.reasoningLevels : undefined,
        reasoningDefault: typeof m.reasoningDefault === "string" ? m.reasoningDefault : undefined,
      }));

      const library = addModels(entries);
      await syncToModelsJson();
      reapplyAllSessions().catch((e) => console.warn("[model-library] Failed to reapply sessions:", e.message));
      res.json(library);
    } else {
      // Single add
      const { providerId, modelId, name, reasoning, vision, contextWindow, maxTokens,
              thinkingLevel, isDefault, reasoningOverride, reasoningLevels, reasoningDefault } = req.body;

      if (!providerId || !modelId) {
        return res.status(400).json({ error: "providerId and modelId required" });
      }

      const library = addModel({
        providerId,
        modelId,
        name: name || modelId,
        isDefault: isDefault || false,
        reasoning: reasoning ?? inferReasoning(modelId),
        vision: vision ?? inferVision(modelId),
        contextWindow: contextWindow || inferContextWindow(modelId),
        maxTokens: maxTokens || 16384,
        // Clé absente = « défaut » (niveau du mode) — jamais un niveau figé.
        thinkingLevel: thinkingLevel || undefined,
        reasoningOverride: reasoningOverride || "auto",
        // Niveaux de réflexion découverts via le provider (Ollama /api/show),
        // persistés avec le modèle (comme le chemin bulk).
        reasoningLevels: Array.isArray(reasoningLevels) ? reasoningLevels : undefined,
        reasoningDefault: typeof reasoningDefault === "string" ? reasoningDefault : undefined,
      });

      await syncToModelsJson();
      reapplyAllSessions().catch((e) => console.warn("[model-library] Failed to reapply sessions:", e.message));
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
    // Re-apply active sessions so they pick up model capability changes (e.g. vision)
    reapplyAllSessions().catch((e) => console.warn("[model-library] Failed to reapply sessions:", e.message));
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
    reapplyAllSessions().catch((e) => console.warn("[model-library] Failed to reapply sessions:", e.message));
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

// ── PUT/DELETE set commit model ────────────────────────

router.put("/commit-model/:id", async (req: Request, res: Response) => {
  try {
    const id = safeDecode(req.params.id);
    const library = loadModelLibrary();
    library.commitModelId = id;
    saveModelLibrary(library);
    await syncToModelsJson();
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/commit-model", (_req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    library.commitModelId = null;
    saveModelLibrary(library);
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT/DELETE set vision model ───────────────────────

router.put("/vision-model/:id", async (req: Request, res: Response) => {
  try {
    const id = safeDecode(req.params.id);
    const library = loadModelLibrary();
    library.visionModelId = id;
    saveModelLibrary(library);
    await syncToModelsJson();
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/vision-model", async (_req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    library.visionModelId = null;
    saveModelLibrary(library);
    await syncToModelsJson();
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT/DELETE set audio model ─────────────────────────

router.put("/audio-model/:id", async (req: Request, res: Response) => {
  try {
    const id = safeDecode(req.params.id);
    const library = loadModelLibrary();
    library.audioModelId = id;
    saveModelLibrary(library);
    await syncToModelsJson();
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/audio-model", async (_req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    library.audioModelId = null;
    saveModelLibrary(library);
    await syncToModelsJson();
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT/DELETE set librarian model ────────────────────

router.put("/librarian-model/:id", async (req: Request, res: Response) => {
  try {
    const id = safeDecode(req.params.id);
    const library = loadModelLibrary();
    library.librarianModelId = id;
    saveModelLibrary(library);
    await syncToModelsJson();
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/librarian-model", async (_req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    library.librarianModelId = null;
    saveModelLibrary(library);
    await syncToModelsJson();
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
    const activeMode = getActiveMode(req.params.projectId);
    res.json({ ...config, activeMode });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/projects/:projectId/mode", async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const { mode, modelId, enabled, config, routing, compactToFit } = req.body;

    if ((enabled !== undefined || config !== undefined || routing !== undefined) && mode !== "harness") {
      return res.status(400).json({ error: "mode requis pour enabled/config/routing" });
    }
    if (mode) validateMode(mode);

    let library = loadModelLibrary();

    // If compactToFit is set and we're assigning a model, check if context fits
    if (modelId && compactToFit) {
      const targetModel = getModel(library, modelId);
      if (targetModel?.contextWindow) {
        const state = getSession(projectId);
        const currentTokens = state?.session?.getContextUsage?.()?.tokens;
        if (currentTokens && currentTokens > targetModel.contextWindow) {
          const targetTokens = targetModel.contextWindow;
          const safeTarget = Math.floor(targetTokens * 0.9); // 90% to leave room for new responses
          const instructions =
            `Compact this conversation to fit within ${safeTarget} tokens while preserving as much information as possible. ` +
            `The conversation is being migrated to a model with a smaller context window (${targetTokens} tokens). ` +
            `PRIORITIZE: project requirements, architecture decisions, code structure, file paths, ` +
            `tool configurations, security rules, and the most recent conversation turns. ` +
            `Compress aggressively but keep all critical details intact. ` +
            `Use concise summaries for verbose tool outputs. ` +
            `Maximum information density within the token budget.`;
          await compactSession(projectId, instructions);
        }
      }
    }

    if (modelId !== undefined) {
      library = setProjectModeModel(projectId, mode, modelId);
    }
    if (enabled !== undefined && mode === "harness") {
      library = setProjectModeEnabled(projectId, mode, enabled);
    }
    if (config !== undefined && mode === "harness") {
      library = setProjectModeHarnessConfig(projectId, config);
    }
    if (routing !== undefined && mode === "harness") {
      library = setProjectRoutingConfig(projectId, routing);
    }

    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST apply a routing config to other projects ────
//
// « Appliquer ce routage à d'autres projets » (bouton de la modale de routage).
// Le routage est stocké PAR PROJET (projectModes[<id>].harness.routing) : rien
// n'est partagé ni hérité, pas même entre un projet lié et ses sous-projets.
// Cette route est donc la SEULE manière de propager une config.
//
// Corps : { sourceProjectId, scope, selectedProjectIds?, routing, dryRun? }
//  - scope ∈ « all » | « all-except-current » | « linked-subprojects » | « selected »
//    (portée EXPLICITE obligatoire : aucune valeur par défaut, une action qui
//    écrase N configurations ne doit pas partir d'un choix implicite) ;
//  - routing = config à recopier (celle de la modale, pas nécessairement
//    encore enregistrée sur le projet courant) ;
//  - dryRun = true → PRÉVISUALISATION (aucune écriture) : mêmes cibles, mêmes
//    avertissements, donc ce que l'utilisateur voit est exactement ce qui sera
//    fait.
//
// ⚠️ Écriture ATOMIQUE : tous les projets sont modifiés EN MÉMOIRE puis le
// fichier est écrit UNE seule fois (saveModelLibrary). Une erreur avant la
// sauvegarde laisse donc le fichier intact — jamais de moitié appliquée.
// ⚠️ Seul `harness.routing` est touché (voir applyRoutingToLibrary).
router.post("/routing/apply", (req: Request, res: Response) => {
  try {
    const { sourceProjectId, scope, selectedProjectIds, routing, dryRun } = req.body || {};
    if (typeof sourceProjectId !== "string" || !sourceProjectId) {
      return res.status(400).json({ error: "sourceProjectId is required" });
    }
    // La config est normalisée/bornée par applyRoutingToLibrary ; on refuse
    // seulement un corps manifestement vide (rien à recopier).
    if (!routing || typeof routing !== "object") {
      return res.status(400).json({ error: "routing is required" });
    }

    const projects = getAllProjects();
    const library = loadModelLibrary();

    const plan = planRoutingCopy({
      scope,
      sourceProjectId,
      projects,
      selectedProjectIds,
      routing,
      library,
    });

    if (dryRun === true) {
      return res.json({ dryRun: true, sourceProjectId, scope, ...plan, applied: [] });
    }

    // Garde-fou : ne JAMAIS écrire sur une portée vide sans le dire.
    if (plan.targets.length === 0) {
      return res.status(400).json({
        error: "Aucun projet cible pour cette portée",
        ...plan,
        applied: [],
      });
    }

    // Tout ou rien : une seule écriture disque après application en mémoire.
    const { applied } = applyRoutingToLibrary(
      library,
      plan.targets.map((p) => p.id),
      routing,
    );
    saveModelLibrary(library);

    const updatedLibrary = loadModelLibrary();
    res.json({
      dryRun: false,
      sourceProjectId,
      scope,
      ...plan,
      applied,
      library: updatedLibrary,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message || "Échec de l'application du routage" });
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