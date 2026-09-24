import { Router, type Request, type Response } from "express";
import {
  loadProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  getProvider,
  testProviderConnection,
  toPublicProvider,
  normalizeMaxConcurrentCalls,
  syncConcurrencyProviderLimits,
  MAX_CONCURRENT_CALLS,
  type ProviderConfig,
  type ProviderType,
  PROVIDER_PRESETS,
} from "../pi/providers.js";
import { validateHttpUrl } from "../utils/ssrf.js";

const router = Router();

// ── GET all providers ─────────────────────────────────

router.get("/", (_req: Request, res: Response) => {
  try {
    const providers = loadProviders();
    res.json(providers.map(toPublicProvider));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST create provider ──────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, type, baseUrl, apiKey, maxConcurrentCalls } = req.body;
    if (!type) return res.status(400).json({ error: "type required" });
    if (!PROVIDER_PRESETS[type as ProviderType]) {
      return res.status(400).json({ error: `Unknown type: ${type}. Valid: ${Object.keys(PROVIDER_PRESETS).join(", ")}` });
    }
    // Limite de concurrence : entier 1..MAX, sinon 400 (pas de repli silencieux).
    if (maxConcurrentCalls !== undefined && normalizeMaxConcurrentCalls(maxConcurrentCalls) === undefined) {
      return res.status(400).json({ error: `maxConcurrentCalls must be an integer between 1 and ${MAX_CONCURRENT_CALLS}` });
    }

    const preset = PROVIDER_PRESETS[type as ProviderType];
    const provider = addProvider({
      name: name || type,
      type,
      baseUrl: baseUrl || preset.defaultBaseUrl,
      apiKey: apiKey || undefined,
      maxConcurrentCalls: normalizeMaxConcurrentCalls(maxConcurrentCalls),
    });

    // Le provider est la source de vérité → resynchronise la map du moteur.
    await syncConcurrencyProviderLimits();
    res.json(toPublicProvider(provider));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── PUT update provider ───────────────────────────────

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, type, baseUrl, apiKey, maxConcurrentCalls } = req.body;

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
    // Limite de concurrence : entier 1..MAX, sinon 400 (champ absent = inchangé).
    if (maxConcurrentCalls !== undefined) {
      const parsed = normalizeMaxConcurrentCalls(maxConcurrentCalls);
      if (parsed === undefined) {
        return res.status(400).json({ error: `maxConcurrentCalls must be an integer between 1 and ${MAX_CONCURRENT_CALLS}` });
      }
      updates.maxConcurrentCalls = parsed;
    }

    const provider = updateProvider(id, updates);
    // Le provider est la source de vérité → resynchronise la map du moteur.
    await syncConcurrencyProviderLimits();
    res.json(toPublicProvider(provider));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── DELETE provider ───────────────────────────────────

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await deleteProvider(req.params.id);

    // Le provider est la source de vérité → retire sa limite du moteur.
    await syncConcurrencyProviderLimits();

    // Regenerate models.json for Pi SDK after cleanup
    try {
      const { writeModelsJson } = await import("../pi/sync-providers.js");
      const { loadProviders: lp } = await import("../pi/providers.js");
      const { loadModelLibrary } = await import("../pi/model-library.js");
      await writeModelsJson(lp(), loadModelLibrary());
      const { reloadModelRegistry } = await import("../pi/session.js");
      reloadModelRegistry();
    } catch (e) {
      console.warn("[providers] Failed to sync models.json after delete:", e);
    }

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

    // SSRF : autorise les réseaux privés/loopback uniquement pour les types
    // couramment auto-hébergés (ollama, openai-compatible). Pour anthropic et
    // google (SaaS publics), on bloque tout sauf les IP publiques.
    const allowLocal = testProvider.type === "ollama" || testProvider.type === "openai-compatible";
    await validateHttpUrl(testProvider.baseUrl, {
      allowPrivate: allowLocal,
      allowLoopback: allowLocal,
    });

    const result = await testProviderConnection(testProvider);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;