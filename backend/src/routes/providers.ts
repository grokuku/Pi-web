import { Router, type Request, type Response } from "express";
import {
  loadProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  getProvider,
  testProviderConnection,
  type ProviderConfig,
  type ProviderType,
  PROVIDER_PRESETS,
} from "../pi/providers.js";

const router = Router();

// ── GET all providers ─────────────────────────────────

router.get("/", (_req: Request, res: Response) => {
  try {
    const providers = loadProviders();
    res.json(providers);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST create provider ──────────────────────────────

router.post("/", (req: Request, res: Response) => {
  try {
    const { name, type, baseUrl, apiKey } = req.body;
    if (!type) return res.status(400).json({ error: "type required" });
    if (!PROVIDER_PRESETS[type as ProviderType]) {
      return res.status(400).json({ error: `Unknown type: ${type}. Valid: ${Object.keys(PROVIDER_PRESETS).join(", ")}` });
    }

    const preset = PROVIDER_PRESETS[type as ProviderType];
    const provider = addProvider({
      name: name || type,
      type,
      baseUrl: baseUrl || preset.defaultBaseUrl,
      apiKey: apiKey || undefined,
    });

    res.json(provider);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT update provider ───────────────────────────────

router.put("/:id", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, type, baseUrl, apiKey } = req.body;

    const existing = getProvider(id);
    if (!existing) return res.status(404).json({ error: "Provider not found" });

    const updates: Partial<ProviderConfig> = {};
    if (name !== undefined) updates.name = name;
    if (type !== undefined) {
      if (!PROVIDER_PRESETS[type as ProviderType]) {
        return res.status(400).json({ error: `Unknown type: ${type}` });
      }
      updates.type = type;
    }
    if (baseUrl !== undefined) updates.baseUrl = baseUrl;
    if (apiKey !== undefined) updates.apiKey = apiKey;

    const provider = updateProvider(id, updates);
    res.json(provider);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── DELETE provider ───────────────────────────────────

router.delete("/:id", (req: Request, res: Response) => {
  try {
    deleteProvider(req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST test provider connection ─────────────────────

router.post("/:id/test", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const provider = getProvider(id);
    if (!provider) return res.status(404).json({ error: "Provider not found" });

    // Allow overriding baseUrl/apiKey in the test request
    const testProvider = { ...provider };
    if (req.body?.baseUrl) testProvider.baseUrl = req.body.baseUrl;
    if (req.body?.apiKey) testProvider.apiKey = req.body.apiKey;

    const result = await testProviderConnection(testProvider);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;