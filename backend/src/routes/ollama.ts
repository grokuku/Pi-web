import { Router, type Request, type Response } from "express";
import {
  getOllamaConfig,
  saveOllamaConfig,
  fetchOllamaModels,
  writeOllamaModelsJson,
} from "../ollama.js";
import { reloadModelRegistry } from "../pi/session.js";

const router = Router();

// GET ollama config
router.get("/config", (_req: Request, res: Response) => {
  try {
    res.json(getOllamaConfig());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST save ollama config
router.post("/config", (req: Request, res: Response) => {
  try {
    const { url, enabled } = req.body;
    const config = getOllamaConfig();
    if (url !== undefined) config.url = url;
    if (enabled !== undefined) config.enabled = enabled;
    saveOllamaConfig(config);
    res.json(config);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST connect & fetch models
router.post("/connect", async (req: Request, res: Response) => {
  try {
    const config = getOllamaConfig();
    const url = req.body.url || config.url;

    // Save the URL
    config.url = url;
    config.enabled = true;
    saveOllamaConfig(config);

    // Fetch models
    const models = await fetchOllamaModels(url);

    // Write models.json for Pi
    await writeOllamaModelsJson(models, url);

    // Reload model registry so newly discovered models are available
    reloadModelRegistry();

    res.json({ success: true, models, url });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST refresh models
router.post("/refresh", async (_req: Request, res: Response) => {
  try {
    const config = getOllamaConfig();
    if (!config.enabled) {
      return res.status(400).json({ error: "Ollama not configured" });
    }

    const models = await fetchOllamaModels(config.url);
    await writeOllamaModelsJson(models, config.url);

    // Reload model registry so newly discovered models are available
    reloadModelRegistry();

    res.json({ success: true, models });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
