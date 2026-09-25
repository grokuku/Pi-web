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
import { ensureDockerHubLogin, getDockerHubStatus } from "../pi/docker-auth.js";
import {
  getUiAllowedOrigins,
  saveUiAllowedOrigins,
  resolveEffectiveAllowedOrigins,
  validateOriginInput,
} from "../utils/origins.js";
import { logger } from "../utils/logger.js";
import {
  isValidVersion,
  isMajorOrMinorBump,
  evaluateUpdateTarget,
  getApplicableBreakingChanges,
  replaceEntrypointPin,
  type SdkBreakingChange,
} from "../pi/sdk-breaking-changes.js";

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

// Interroge npm pour la DERNIÈRE version publiée du SDK pi-coding-agent.
function queryLatestPiAgentVersion(): string {
  return execSync("npm view @earendil-works/pi-coding-agent version", {
    timeout: 15000,
    encoding: "utf-8",
  }).trim();
}

/** Résumé compact d'une liste de ruptures pour les logs (versions + résumés). */
function summarizeBreakingChanges(changes: SdkBreakingChange[]) {
  return changes.map((c) => ({ version: c.version, summary: c.summary }));
}

// Check for pi-agent update — GARDE-FOU : la réponse annonce les ruptures
// connues applicables au saut `current → latest` et si un acquittement explicite
// est requis (saut mineur/majeur). Le frontend les affiche AVANT toute action.
router.get("/update-check", async (_req: Request, res: Response) => {
  try {
    const currentVersion = getPiAgentVersion();
    const latestVersion = queryLatestPiAgentVersion();
    const breakingChanges = getApplicableBreakingChanges(currentVersion, latestVersion);
    res.json({
      current: currentVersion,
      latest: latestVersion,
      updateAvailable: latestVersion !== currentVersion,
      // Ruptures des versions intermédiaires (current, latest].
      breakingChanges,
      // Saut mineur/majeur → une case de confirmation est exigée côté UI et
      // la route POST répond 409 sans `acknowledged: true`.
      requiresAck:
        latestVersion !== currentVersion && isMajorOrMinorBump(currentVersion, latestVersion),
    });
  } catch (e: any) {
    const currentVersion = getPiAgentVersion();
    res.json({
      current: currentVersion,
      latest: currentVersion,
      updateAvailable: false,
      breakingChanges: [],
      requiresAck: false,
      error: e.message,
    });
  }
});

// ── Mise à jour à chaud du SDK pi-agent (option C) ──
// Installe une version CIBLE identifiée (`targetVersion` explicite, sinon
// dernière version publiée — JAMAIS `@latest`), PERSISTE le pin (package.json
// --save-exact + entrypoint.sh) puis redémarre le container (restart policy).
// GARDE-FOU : un saut mineur/majeur est refusé (409) sans `acknowledged: true`,
// avec la liste des ruptures connues applicables (pi/sdk-breaking-changes.ts) —
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

router.post("/update", (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { targetVersion?: unknown; acknowledged?: unknown };
    const acknowledged = body.acknowledged === true;
    const installed = getPiAgentVersion();

    // Cible EXPLICITE si fournie, sinon dernière version publiée. Plus de
    // `@latest` aveugle : on installe toujours une version identifiée et on la
    // COMPARE à l'installée.
    const requested =
      typeof body.targetVersion === "string" ? body.targetVersion.trim() : "";
    const target = requested || queryLatestPiAgentVersion();

    // Déjà à jour → pas de redémarrage inutile.
    if (target === installed) {
      return res.json({ success: false, error: "already up to date" });
    }
    if (!isValidVersion(target)) {
      return res.status(400).json({ success: false, error: "invalid target version" });
    }

    // GARDE-FOU : un saut mineur/majeur non acquitté est REFUSÉ (409) avec la
    // liste des ruptures connues applicables (versions intermédiaires).
    const decision = evaluateUpdateTarget(installed, target, acknowledged);
    if (decision.blocked) {
      logger.warn("sdk-update", `bump ${installed} → ${target} refusé (acquittement requis)`, {
        breakingChanges: summarizeBreakingChanges(decision.breakingChanges),
      });
      return res.status(409).json({
        success: false,
        error: "breaking_changes_ack_required",
        current: installed,
        target,
        breakingChanges: decision.breakingChanges,
      });
    }

    // Saut reconnu (ou acquitté) : on trace les ruptures applicables.
    if (
      isMajorOrMinorBump(installed, target) ||
      getApplicableBreakingChanges(installed, target).length > 0
    ) {
      logger.warn("sdk-update", `bump ${installed} → ${target}`, {
        acknowledged,
        breakingChanges: summarizeBreakingChanges(decision.breakingChanges),
      });
    }

    // 1) Vérifier la ligne de pin AVANT l'install (fail-fast : si le pin est
    //    introuvable on n'installe rien, l'état reste cohérent).
    const entrypointPath = findEntrypoint();
    if (!entrypointPath) {
      throw new Error("entrypoint.sh introuvable — pin non persisté");
    }
    const content = readFileSync(entrypointPath, "utf-8");
    const updated = replaceEntrypointPin(content, target);

    // 2) Installer la version CIBLE exacte (--save-exact → pin EXACT, pas ^).
    execSync(
      `npm install @earendil-works/pi-coding-agent@${target} --no-audit --no-fund --save-exact`,
      { cwd: BACKEND_DIR, stdio: "pipe" }
    );

    // 3) Persister le pin dans entrypoint.sh (ligne déjà validée ci-dessus).
    writeFileSync(entrypointPath, updated);

    // 4) Relire la version réellement installée puis redémarrer.
    const version = getPiAgentVersion();
    logger.warn("sdk-update", `SDK mis à jour ${installed} → ${version} (redémarrage)`, {
      target,
    });
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

// ── Docker Hub ──
// Authentification persistante pour les docker pull / compose pull exécutés
// depuis le container (CLI docker + socket montés) : sans compte configuré,
// les pulls anonymes sont soumis au rate limit Docker Hub
// (« toomanyrequests: unauthenticated pull rate limit »).
// Même contrat que Webclaw/Tavily : le token n'est JAMAIS renvoyé par l'API
// ni loggué (cf. pi/docker-auth.ts).

router.get("/dockerhub", (_req: Request, res: Response) => {
  try {
    res.json(getDockerHubStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/dockerhub", (req: Request, res: Response) => {
  try {
    const { username, token } = req.body ?? {};
    // Validation stricte : les deux champs sont requis. Pas de "keep-if-absent"
    // ici : le token existant n'est pas lisible (base64 user:token décodé côté
    // auth uniquement), on redemande donc systématiquement un token.
    if (typeof username !== "string" || !username.trim()) {
      return res.status(400).json({ error: "dockerhub_username_required" });
    }
    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ error: "dockerhub_token_required" });
    }
    const result = ensureDockerHubLogin(username.trim(), token);
    if (!result.ok) {
      // Échec login (CLI absent/inutilisable + écriture config.json impossible)
      // → 400 avec un message clair (details = sortie docker sans token).
      return res.status(400).json({
        error: "dockerhub_login_failed",
        details: result.error || "unknown error",
      });
    }
    res.json({ success: true, username: username.trim() });
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
    // Validation pure (plafond large, entier, clés réservées) — voir
    // concurrency-validation.ts.
    const { validateConcurrencyPayload } = await import("./concurrency-validation.js");
    const parsed = validateConcurrencyPayload(req.body);
    if ("error" in parsed) {
      return res.status(400).json({ error: parsed.error });
    }
    const { setConcurrencyConfig } = await import("../pi/model-library.js");
    const config = await setConcurrencyConfig(parsed.value);
    const { concurrencyManager } = await import("../pi/concurrency.js");
    const stats = concurrencyManager.getStats();
    res.json({ config, stats });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;