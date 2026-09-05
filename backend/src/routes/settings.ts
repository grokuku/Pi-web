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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getWebclawConfig, setWebclawConfig } from "../webclaw.js";
import { getTavilyConfig, setTavilyConfig } from "../tavily.js";
import {
  getUiAllowedOrigins,
  saveUiAllowedOrigins,
  resolveEffectiveAllowedOrigins,
  validateOriginInput,
} from "../utils/origins.js";

const router = Router();

// ── Version info ──
const BACKEND_DIR = join(process.cwd(), "backend");

const PI_WEB_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(BACKEND_DIR, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch { return "unknown"; }
})();

// Read pi-agent version dynamically (recalculated on each call)
function getPiAgentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(BACKEND_DIR, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch { return "unknown"; }
}

router.get("/version", (_req: Request, res: Response) => {
  res.json({
    piWeb: PI_WEB_VERSION,
    piAgent: getPiAgentVersion(),
  });
});

// Check for pi-agent update
router.get("/update-check", async (_req: Request, res: Response) => {
  try {
    const currentVersion = getPiAgentVersion();
    const result = execSync("npm view @earendil-works/pi-coding-agent version", { timeout: 15000, encoding: "utf-8" }).trim();
    const latestVersion = result;
    res.json({
      current: currentVersion,
      latest: latestVersion,
      updateAvailable: latestVersion !== currentVersion,
    });
  } catch (e: any) {
    const currentVersion = getPiAgentVersion();
    res.json({ current: currentVersion, latest: currentVersion, updateAvailable: false, error: e.message });
  }
});

// ── Mise à jour à chaud du SDK pi-agent (option C) ──
// Installe la dernière version, PERSISTE le pin (package.json --save-exact +
// entrypoint.sh) puis redémarre le container via la restart policy. Un audit
// préalable est recommandé (changelog, breaking changes, nouveaux tools) —
// cf. modale UpdateAgentModal côté frontend.

// Localise entrypoint.sh : chemin attendu BACKEND_DIR/../entrypoint.sh, sinon
// remonte les répertoires parents à la recherche d'un entrypoint.sh.
function findEntrypoint(): string | null {
  const expected = join(BACKEND_DIR, "..", "entrypoint.sh");
  if (existsSync(expected)) return expected;
  let dir = BACKEND_DIR;
  for (let i = 0; i < 6; i++) {
    dir = join(dir, "..");
    const candidate = join(dir, "entrypoint.sh");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

router.post("/update", (_req: Request, res: Response) => {
  try {
    const installed = getPiAgentVersion();
    const latest = execSync("npm view @earendil-works/pi-coding-agent version", {
      timeout: 15000,
      encoding: "utf-8",
    }).trim();

    // Déjà à jour → pas de redémarrage inutile.
    if (latest === installed) {
      return res.json({ success: false, error: "already up to date" });
    }

    // 1) Installer la dernière version (--save-exact → pin EXACT, pas ^).
    execSync(
      "npm install @earendil-works/pi-coding-agent@latest --no-audit --no-fund --save-exact",
      { cwd: BACKEND_DIR, stdio: "pipe" }
    );

    // 2) Persister le pin dans entrypoint.sh (regex générique, futur-proof).
    const entrypointPath = findEntrypoint();
    if (!entrypointPath) {
      throw new Error("entrypoint.sh introuvable — pin non persisté");
    }
    const content = readFileSync(entrypointPath, "utf-8");
    const updated = content.replace(
      /pi-coding-agent@[0-9]+\.[0-9]+\.[0-9]+/g,
      `pi-coding-agent@${latest}`
    );
    if (updated === content) {
      throw new Error("aucune ligne npm install pi-coding-agent trouvée dans entrypoint.sh");
    }
    writeFileSync(entrypointPath, updated);

    // 3) Relire la version réellement installée puis redémarrer.
    const version = getPiAgentVersion();
    res.json({ success: true, version });
    setTimeout(() => process.exit(0), 500);
  } catch (e: any) {
    // Échec (install ou persist) : pas d'exit → pas d'état incohérent.
    res.json({ success: false, error: e.message });
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

// ── Webclaw config ──
// Durcissement (lot XSS) : la clé n'est jamais renvoyée en clair au frontend.
// Le POST garde la clé existante si `apiKey` est absent (modèle providers :).

function toPublicWebclawConfig(config: { url: string; apiKey: string }) {
  return {
    url: config.url,
    hasApiKey: !!config.apiKey,
    apiKeyPreview: config.apiKey ? `••••${config.apiKey.slice(-4)}` : "",
  };
}

router.get("/webclaw", (_req: Request, res: Response) => {
  try {
    res.json(toPublicWebclawConfig(getWebclawConfig()));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/webclaw", (req: Request, res: Response) => {
  try {
    const { url, apiKey } = req.body;
    // apiKey absent → on garde la clé existante (seule l'URL est mise à jour)
    const config = setWebclawConfig({ url, ...(apiKey !== undefined ? { apiKey } : {}) });
    res.json(toPublicWebclawConfig(config));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Tavily config ──
// Même contrat que Webclaw : clé jamais renvoyée en clair, POST keep-if-absent.
// (L'ancien GET renvoyait les 8 premiers caractères et le frontend les
// réenvoyait au POST — la clé tronquée remplaçait la vraie.)

router.get("/tavily", (_req: Request, res: Response) => {
  try {
    const config = getTavilyConfig();
    res.json({
      hasApiKey: !!config.apiKey,
      apiKeyPreview: config.apiKey ? `••••${config.apiKey.slice(-4)}` : "",
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/tavily", (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    if (apiKey === undefined) return res.json({ ok: true, kept: true });
    setTavilyConfig({ apiKey });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Origines autorisées (réglage UI « Sécurité ») ──
// La liste effective = union des variables d'environnement (ALLOWED_ORIGINS /
// WS_ALLOWED_ORIGINS / PUBLIC_BASE_URL) et de la config UI persistée dans
// .data/allowed-origins.json. Si aucune source ne définit quoi que ce soit →
// `*` (comportement historique). Prend effet immédiatement, sans restart
// (cache UI invalidé à l'écriture, cf. utils/origins.ts).

// Limite défensive : la liste des origines est petite par nature.
const MAX_ALLOWED_ORIGINS = 64;

function serializeAllowedOrigins() {
  const effective = resolveEffectiveAllowedOrigins();
  return {
    // Valeur éditable (config UI seule).
    origins: getUiAllowedOrigins(),
    // Valeur effectivement appliquée aux checks HTTP et WS.
    effectiveOrigins: effective.origins,
    allowAll: effective.allowAll,
    sources: effective.sources,
  };
}

router.get("/allowed-origins", (_req: Request, res: Response) => {
  try {
    res.json(serializeAllowedOrigins());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/allowed-origins", (req: Request, res: Response) => {
  try {
    const { origins } = req.body ?? {};
    if (!Array.isArray(origins)) {
      return res.status(400).json({ error: "invalid_origin_list" });
    }
    if (origins.length > MAX_ALLOWED_ORIGINS) {
      return res.status(400).json({ error: "too_many_origins", max: MAX_ALLOWED_ORIGINS });
    }

    // Validation stricte : protocole + host (+ port), pas de chemin, pas de
    // wildcard partielle (`*` seul accepté), normalisation minuscules + dédup.
    // Rien n'est écrit si une seule entrée est invalide : l'UI affiche les
    // entrées fautives via un message localisé (codes machine ici).
    const invalid: { index: number; origin: string }[] = [];
    const validated: string[] = [];
    origins.forEach((raw: unknown, index: number) => {
      const normalized = validateOriginInput(raw);
      if (normalized === null) invalid.push({ index, origin: String(raw) });
      else validated.push(normalized);
    });
    if (invalid.length > 0) {
      return res.status(400).json({ error: "invalid_origin_list", details: invalid });
    }

    saveUiAllowedOrigins(validated);
    res.json(serializeAllowedOrigins());
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Concurrency config ──

router.get("/concurrency", async (_req: Request, res: Response) => {
  try {
    const { getConcurrencyConfig } = await import("../pi/model-library.js");
    const config = getConcurrencyConfig();
    const { concurrencyManager } = await import("../pi/concurrency.js");
    const stats = concurrencyManager.getStats();
    res.json({ config, stats });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/concurrency", async (req: Request, res: Response) => {
  try {
    const { maxLLMSlots, maxAgentSlots } = req.body;
    if (maxLLMSlots !== undefined && (typeof maxLLMSlots !== "number" || maxLLMSlots < 1 || maxLLMSlots > 20)) {
      return res.status(400).json({ error: "maxLLMSlots must be between 1 and 20" });
    }
    if (maxAgentSlots !== undefined && (typeof maxAgentSlots !== "number" || maxAgentSlots < 1 || maxAgentSlots > 50)) {
      return res.status(400).json({ error: "maxAgentSlots must be between 1 and 50" });
    }
    const { setConcurrencyConfig } = await import("../pi/model-library.js");
    const config = setConcurrencyConfig({ maxLLMSlots, maxAgentSlots });
    const { concurrencyManager } = await import("../pi/concurrency.js");
    const stats = concurrencyManager.getStats();
    res.json({ config, stats });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;