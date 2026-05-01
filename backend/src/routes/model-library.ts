import { Router, type Request, type Response } from "express";
import {
  loadModelLibrary,
  setModeEnabled,
  setModeInstructions,
  setModeTools,
  setModeReadOnly,
  addModelToMode,
  removeModelFromMode,
  setActiveModel,
  setModelThinkingLevel,
  makeModelEntryId,
  getActiveModelForMode,
  getActiveMode,
  type AgentMode,
  type ModelEntry,
} from "../pi/model-library.js";
import { setModel, setThinkingLevel, reloadModelRegistry } from "../pi/session.js";

const router = Router();

// ── Helpers ──────────────────────────────────────────────

const VALID_MODES: AgentMode[] = ["code", "commit", "review", "plan"];

function validateMode(mode: string): AgentMode {
  if (!VALID_MODES.includes(mode as AgentMode)) {
    throw new Error(`Invalid mode: ${mode}. Valid: ${VALID_MODES.join(", ")}`);
  }
  return mode as AgentMode;
}

function safeDecodeURIComponent(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded; // return as-is if malformed
  }
}

async function applyModeToSession(mode: AgentMode): Promise<void> {
  // Commit mode is only used for commit messages, not the interactive session
  if (mode === "commit") return;

  const library = loadModelLibrary();
  const cfg = library.modes[mode];
  if (!cfg.activeModelId || !cfg.enabled) return;

  const entry = getActiveModelForMode(mode);
  if (!entry) return;

  try {
    reloadModelRegistry();
    await setModel(entry.provider, entry.modelId);
    await setThinkingLevel(entry.thinkingLevel);
  } catch (e: any) {
    // Model might not be available yet
    console.error(`Failed to apply mode ${mode}: ${e.message}`);
  }
}

// ── GET full library ─────────────────────────────────────

router.get("/", (_req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    res.json(library);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET active mode ───────────────────────────────────────

router.get("/active", (_req: Request, res: Response) => {
  try {
    const library = loadModelLibrary();
    const activeMode = getActiveMode(library);
    const activeEntry = activeMode ? getActiveModelForMode(activeMode) : null;
    res.json({
      mode: activeMode,
      model: activeEntry,
      config: activeMode ? library.modes[activeMode] : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT toggle mode enabled ──────────────────────────────

router.put("/modes/:mode/enabled", async (req: Request, res: Response) => {
  try {
    const mode = validateMode(req.params.mode);
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) required" });
    }
    const library = setModeEnabled(mode, enabled);

    if (enabled) {
      await applyModeToSession(mode);
    }

    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT mode instructions ─────────────────────────────────

router.put("/modes/:mode/instructions", (req: Request, res: Response) => {
  try {
    const mode = validateMode(req.params.mode);
    const { instructions } = req.body;
    if (typeof instructions !== "string") {
      return res.status(400).json({ error: "instructions (string) required" });
    }
    const library = setModeInstructions(mode, instructions);
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT mode tools ─────────────────────────────────────────

router.put("/modes/:mode/tools", (req: Request, res: Response) => {
  try {
    const mode = validateMode(req.params.mode);
    const { tools } = req.body;
    if (!Array.isArray(tools)) {
      return res.status(400).json({ error: "tools (string[]) required" });
    }
    const library = setModeTools(mode, tools);
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT mode readOnly ──────────────────────────────────────

router.put("/modes/:mode/readonly", (req: Request, res: Response) => {
  try {
    const mode = validateMode(req.params.mode);
    const { readOnly } = req.body;
    if (typeof readOnly !== "boolean") {
      return res.status(400).json({ error: "readOnly (boolean) required" });
    }
    const library = setModeReadOnly(mode, readOnly);
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST add model to mode ───────────────────────────────

router.post("/modes/:mode/models", async (req: Request, res: Response) => {
  try {
    const mode = validateMode(req.params.mode);
    const { provider, modelId, name, thinkingLevel } = req.body;
    if (!provider || !modelId) {
      return res.status(400).json({ error: "provider and modelId required" });
    }

    const entry: ModelEntry = {
      id: makeModelEntryId(provider, modelId),
      provider,
      modelId,
      name: name || modelId,
      thinkingLevel: thinkingLevel || "medium",
    };

    const library = addModelToMode(mode, entry);
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── DELETE remove model from mode ────────────────────────

router.delete("/modes/:mode/models/:entryId", (req: Request, res: Response) => {
  try {
    const mode = validateMode(req.params.mode);
    const entryId = safeDecodeURIComponent(req.params.entryId);
    const library = removeModelFromMode(mode, entryId);
    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT set active model for mode (also applies to session) ──

router.put("/modes/:mode/active", async (req: Request, res: Response) => {
  try {
    const mode = validateMode(req.params.mode);
    const { entryId } = req.body;
    if (!entryId) {
      return res.status(400).json({ error: "entryId required" });
    }

    const library = setActiveModel(mode, entryId);

    // Apply to the active Pi session
    await applyModeToSession(mode);

    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT update thinking level for a model in a mode ──────

router.put("/modes/:mode/models/:entryId/thinking", (req: Request, res: Response) => {
  try {
    const mode = validateMode(req.params.mode);
    const entryId = safeDecodeURIComponent(req.params.entryId);
    const { thinkingLevel } = req.body;
    if (!thinkingLevel) {
      return res.status(400).json({ error: "thinkingLevel required" });
    }
    const library = setModelThinkingLevel(mode, entryId, thinkingLevel);

    // If this is the active model for the active mode, apply thinking level
    const activeEntry = getActiveModelForMode(mode);
    if (activeEntry && activeEntry.id === entryId) {
      setThinkingLevel(thinkingLevel).catch(() => {});
    }

    res.json(library);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;