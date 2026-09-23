import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import path from "path";
import { setMaxListeners } from "events";

// Increase max listeners for abort signals (Pi SDK creates many per session)
setMaxListeners(50);

// P0 observabilité 2/2 : capture de tout console.error « extérieur » (modules,
// SDK, startup...) vers .data/logs/backend-*.log. Le logger lui-même écrit via
// la référence pristine de console.error → aucune boucle. Installé le plus tôt
// possible pour couvrir aussi le bootstrap.
installConsoleCapture();
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync } from "fs";

import projectsRouter from "./routes/projects.js";
import settingsRouter from "./routes/settings.js";
import ollamaRouter from "./routes/ollama.js";
import modelLibraryRouter from "./routes/model-library.js";
import providersRouter from "./routes/providers.js";
import routingRouter from "./routes/routing.js";
import filesRouter from "./routes/files.js";
import attachmentsRouter from "./routes/attachments.js";
import { usageRouter, recordUsage } from "./routes/usage.js";
import piSettingsRouter from "./routes/pi-settings.js";
import agentRouter from "./routes/agent.js";
import agentKeysRouter, { validateToken } from "./routes/agent-keys.js";
import cbmRouter from "./routes/cbm.js";
import designRouter from "./routes/design.js";
import librarianRouter from "./routes/librarian.js";
import harnessRouter from "./routes/harness.js";
import sharedMemoryRouter from "./routes/shared-memory.js";
import memoryRouter from "./routes/memory.js";
import previewRouter from "./routes/preview.js";
import { startLibrarianCron } from "./pi/librarian-cron.js";
import { apiAuth } from "./middleware/api-auth.js";
import type { Project } from "./projects/manager.js";
// buildFullUiHistory (+ serializeMessagesForUi, sliceUiHistoryWindow) vit dans
// pi/ui-history.ts : module PUR, extrait de index.ts pour être testable sans
// les effets de bord du bootstrap serveur (Express + WS + crons). Cf.
// pi/ui-history.test.ts. sliceUiHistoryWindow = chargement par lots (fix de
// fond du bug « messages récents manquants » : payload WS borné).
import { buildFullUiHistory, sliceUiHistoryWindow, type UiHistoryWindowMeta } from "./pi/ui-history.js";
import { runMemoryMigration } from "./pi/memory-migration.js";

// ── Logger fichier (P0 observabilité 2/2) ──
// Chaque erreur/crash est dupliqué dans .data/logs/ (persistant, lisible via
// le volume Docker) EN PLUS de stdout. Cf. utils/logger.ts et docs/logs-backend.md.
import { logger, installConsoleCapture } from "./utils/logger.js";
import {
  createPiSession,
  subscribeToEvents,
  sendPrompt,
  steerPrompt,
  abortPi,
  getSession,
  getSessionInfo,
  disposeAllSessions,
  listSessions,
  newSession as newPiSession,
  compactSession,
  setModel,
  setThinkingLevel,
  cycleModel,
  switchMode,
  applyModeToSession,
  getActiveMode,
} from "./pi/session.js";
import {
  createTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  getTerminalBuffer,
  terminalEvents,
} from "./terminal/pty.js";
import { getProject, getAllProjects } from "./projects/manager.js";
import { isCwdAllowed, isPathAllowed } from "./utils/path-security.js";
import { resolveEffectiveAllowedOrigins, isOriginEffectivelyAllowed, isAllowedOrigin } from "./utils/origins.js";
import { credentialStore } from "./projects/credential-store.js";
import { cbmStdioCall } from "./pi/cbm-stdio.js";

import os from "os";
import { syncGitInfo, purgeEmbeddedCredentialsFromRemotes } from "./projects/git.js";
import { mountAllSmbProjects, unmountAllSmb } from "./projects/smb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

// ─── Express App ───────────────────────────────────────
const app = express();

// CORS dynamique : la liste effective des origines autorisées (variables
// d'environnement + réglage UI « Sécurité », cf. utils/origins.ts) est résolue
// À CHAQUE REQUÊTE afin que les changements s'appliquent à chaud, sans restart.
// `*` (ou aucune source configurée) = allow-all ; origine non autorisée ou
// absente → aucun en-tête CORS émis (le navigateur bloque la réponse).
app.use(cors({
  origin: (origin, cb) => cb(null, isOriginEffectivelyAllowed(origin)),
}));

// ── Durcissement sécurité (lot XSS) ──
// Derrière Caddy (reverse proxy), il faut faire confiance au premier hop pour
// retrouver l'IP réelle du client — sinon tout le trafic partagerait l'IP de
// Caddy et le rate limiting serait global au lieu d'être par client.
app.set("trust proxy", 1);

// Headers de sécurité sur toutes les réponses :
// - nosniff : empêche le navigateur de deviner le MIME (un upload HTML déguisé
//   en .png ne serait plus interprété comme HTML).
// - Referrer-Policy : évite de fuiter des URLs sensibles (ex: ?token= du WS)
//   vers des sites tiers quand l'utilisateur suit un lien depuis l'app.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Rate limiting express (lot XSS) : protège contre le brute-force d'API keys
// et le spam d'uploads. Express-rate-limit v7+ : `limit` remplace `max`.
const makeLimiter = (limit: number, windowMs = 60_000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,   // RateLimit-* (standard IETF)
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down." },
  });

const apiLimiter = makeLimiter(600);        // global /api : 10 req/s — largement au-dessus de l'usage UI normal
const uploadLimiter = makeLimiter(30);      // uploads : 30/min (upload massif limité côté serveur aussi)
const sharedMemLimiter = makeLimiter(60);   // mémoire partagée : auth par clés, brute-force limité

// Montés AVANT les routeurs (ordre nécessaire), l'IP vue étant l'IP réelle du
// client grâce au trust proxy ci-dessus.
app.use("/api", apiLimiter);
app.use("/api/attachments/upload", uploadLimiter);
app.use("/api/shared-memory", sharedMemLimiter);

app.use(express.json({ limit: "50mb" }));

// ── Serve frontend static files FIRST (before CBM proxy) ──
// This ensures Pi-web's own JS/CSS assets are served correctly.
// Without this, the CBM proxy on /assets intercepts them and returns
// wrong MIME types (application/octet-stream), causing a blank page.
const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
}

// ── apiAuth middleware ──
// Toutes les routes /api passent par l'authentification globale. Les routes
// proxy CBM ci-dessous sont montées APRÈS ce middleware : elles sont donc
// protégées comme le reste de l'API (same-origin navigateur sans token).
app.use("/api", apiAuth);

// ── CBM 3D Graph UI proxy routes — protégées par apiAuth (BUG-48/50) ──
// Le CBM UI est servi par ce même serveur (same-origin) : les requêtes du
// navigateur passent apiAuth sans jeton. Les clients externes, eux, doivent
// présenter un jeton valide.
app.all("/api/index", cbmProxy);
app.all("/api/index-status", cbmProxy);
app.all("/api/logs", cbmProxy);
app.all("/api/processes", cbmProxy);
app.all("/api/process-kill", cbmProxy);
app.all("/api/layout", cbmProxy);
app.all("/api/adr", cbmProxy);
app.all("/api/project", cbmProxy);
app.all("/api/project-health", cbmProxy);
// NOTE: /api/projects (pluriel) est délibérément NON proxyé vers CBM car il
// entre en conflit avec projectsRouter (Pi-Web project management API) monté
// après apiAuth. Le CBM UI utilise /api/project (singulier) déjà proxyé ci-dessus.
app.all("/api/project-list", cbmProxy);    // au cas où
app.all("/api/stats", cbmProxy);           // statistiques du graphe
app.all("/api/graph", cbmProxy);           // données du graphe
app.all("/api/nodes", cbmProxy);           // nœuds du graphe
app.all("/api/edges", cbmProxy);           // arêtes du graphe
app.all("/api/search", cbmProxy);          // recherche dans le graphe
app.use("/api/browse", cbmProxy);

app.use("/api/projects", projectsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/ollama", ollamaRouter);
app.use("/api/model-library", modelLibraryRouter);
app.use("/api/providers", providersRouter);
app.use("/api/routing", routingRouter);
app.use("/api/files", filesRouter);
app.use("/api/attachments", attachmentsRouter);
app.use("/api/usage", usageRouter);
app.use("/api/pi", piSettingsRouter);
app.use("/api/agent", agentRouter);
app.use("/api/agent-keys", agentKeysRouter);
app.use("/api/cbm", cbmRouter);
app.use("/api/design", designRouter);
app.use("/api/librarian", librarianRouter);
app.use("/api/harness", harnessRouter);
// Mémoire partagée externe (Lot M2) : auth dédiée dans le router
// (localhost ∥ Bearer agent ∥ X-API-Key librarian).
app.use("/api/shared-memory", sharedMemoryRouter);
// Mémoire UI interne (Lot M3) : couverte par apiAuth globale (same-origin).
app.use("/api/memory", memoryRouter);
// Preview (Lot Preview) : fichiers projet + mockups inline, couverts par apiAuth.
app.use("/api", previewRouter);

// ── CBM 3D Graph UI proxy ──────────────────────────────
// The CBM UI is a Vite SPA that uses absolute paths (/assets/..., /rpc, ...).
// We proxy both /cbm-ui/* (the main page) AND /assets/*, /rpc so the browser
// resolves everything through the Pi-Web port without exposing port 9749.
async function cbmProxy(req: any, res: any) {
  // Use originalUrl — Express strips the mount prefix from req.url
  // e.g. app.use("/rpc") makes req.url="/" but req.originalUrl="/rpc"
  const fullPath = req.originalUrl || req.url;
  const urlPath = fullPath.startsWith("/cbm-ui") ? fullPath.slice(7) : fullPath;

  // ── POST /rpc → route through the stdio MCP client (FULL surface) ──
  // The UI-mode HTTP /rpc on :9749 only allows list_projects + get_code_snippet;
  // everything else (get_graph_schema, search_graph, query_graph, trace_path,
  // tools/list, ...) returns 403 "UI RPC method is not allowed". stdio exposes
  // the complete MCP surface, so we answer /rpc from here instead of forwarding.
  // The response is the exact JSON-RPC envelope the SPA expects:
  //   {jsonrpc:"2.0", id, result:{content:[...], structuredContent, isError}}
  if (urlPath === "/rpc" && req.method === "POST") {
    const body = req.body || {};
    const method: unknown = body.method;
    if (typeof method !== "string" || method === "") {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: typeof body.id === "number" ? body.id : null,
        error: { code: -32600, message: "Invalid Request: missing 'method'" },
      });
    }
    try {
      const result = await cbmStdioCall(method, body.params, {
        id: typeof body.id === "number" ? body.id : undefined,
      });
      res.status(200).json(result);
    } catch (e: any) {
      console.error("[cbm-proxy] stdio RPC failed:", method, e.message);
      res.status(502).json({
        jsonrpc: "2.0",
        id: typeof body.id === "number" ? body.id : null,
        error: { code: -32000, message: e.message || "codebase-memory-mcp stdio call failed" },
      });
    }
    return;
  }

  const cbmUrl = `http://127.0.0.1:9749${urlPath}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const proxyRes = await fetch(cbmUrl, {
      method: req.method,
      headers: {
        // Strip headers that fetch() manages automatically
        ...Object.fromEntries(
          Object.entries(req.headers as Record<string, string>)
            .filter(([k]) => !["content-length", "transfer-encoding", "connection", "expect", "keep-alive", "upgrade", "host"].includes(k.toLowerCase()))
        ),
        "content-type": "application/json",
        host: "127.0.0.1:9749",
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    res.status(proxyRes.status);

    // Supprimer le header CSP qui bloque l'affichage en iframe
    // Le serveur CBM envoie frame-ancestors 'none', ce qui empêche
    // d'afficher l'UI CBM dans une iframe sur pi.holaf.fr
    const respHeaders = new Headers(proxyRes.headers);
    respHeaders.delete("content-security-policy");
    respHeaders.delete("content-security-policy-report-only");

    // Envoyer les headers (sans CSP pour permettre l'affichage en iframe)
    respHeaders.forEach((value, key) => {
      if (key.toLowerCase() !== "transfer-encoding" &&
          key.toLowerCase() !== "content-encoding" &&
          key.toLowerCase() !== "connection") {
        res.setHeader(key, value);
      }
    });

    // If HTML, rewrite absolute paths to /cbm-ui/ prefix
    const contentType = proxyRes.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      let html = await proxyRes.text();
      // Rewrite absolute paths so assets load through the proxy
      html = html.replace(/href="\//g, 'href="/cbm-ui/');
      html = html.replace(/src="\//g, 'src="/cbm-ui/');
      // Fix double-prefix if any (e.g. /cbm-ui/cbm-ui/)
      html = html.replace(/\/cbm-ui\/cbm-ui\//g, "/cbm-ui/");
      res.setHeader("content-type", contentType);
      res.send(html);
      return;
    }

    const buffer = Buffer.from(await proxyRes.arrayBuffer());
    res.send(buffer);
  } catch (e: any) {
    console.error("[cbm-proxy] Request failed:", cbmUrl, e.message, e.cause?.message || "");
    res.status(502).send("CBM graph server not available.");
  }
}

// Main UI page (iframe src)
app.use("/cbm-ui", cbmProxy);
// CBM UI assets (Vite builds to /assets/)
app.use("/assets", cbmProxy);
// CBM MCP RPC endpoint (used by the UI for graph queries)
app.use("/rpc", cbmProxy);
// Les routes CBM proxy /api/* sont déjà montées plus haut (avant apiAuth, BUG-48 fix)

// ── Read VERSION file once at startup ──
let piWebVersion = "unknown";
try {
  const versionFile = path.join(__dirname, "..", "..", "VERSION");
  if (existsSync(versionFile)) {
    piWebVersion = readFileSync(versionFile, "utf-8").trim();
  }
} catch {}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Agent API health (no auth needed)
app.get("/api/agent/health", (_req, res) => {
  res.json({ status: "ok", version: piWebVersion, uptime: Math.floor(process.uptime()) });
});

// Status/info endpoint (for welcome page)
app.get("/api/status", (_req, res) => {
  try {
    // Pi SDK version
    let piSdkVersion = "unknown";
    try {
      const pkgPath = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
      if (existsSync(pkgPath)) {
        piSdkVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version || "unknown";
      }
    } catch {}

    // Extensions from settings
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const settingsFile = path.join(agentDir, "settings.json");
    type PiSettings = { packages?: (string | { source: string })[]; [k: string]: any };
    let settings: PiSettings = {};
    try {
      if (existsSync(settingsFile)) {
        settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      }
    } catch {}

    const pkgSources = (settings.packages || []).map((p: string | { source: string }) => typeof p === "string" ? p : p.source);
    const extensions: { source: string; installed: boolean; error?: string }[] = pkgSources.map(source => {
      let installed = false;
      try {
        const pkgName = source.startsWith("@") ? source.split("/").slice(0, 2).join("/") : source.split("@")[0].split("/")[0];
        const modPath = path.join(agentDir, "node_modules", pkgName);
        const backendPath = path.join(process.cwd(), "node_modules", pkgName);
        installed = existsSync(modPath) || existsSync(backendPath);
      } catch {}
      return { source, installed };
    });

    // Active sessions count
    let activeSessions = 0;
    for (const project of getAllProjects()) {
      if (getSessionInfo(project.id)) activeSessions++;
    }

    // Uptime
    const uptimeSeconds = process.uptime();

    res.json({
      piWebVersion,
      piSdkVersion,
      extensions,
      activeSessions,
      uptimeSeconds: Math.floor(uptimeSeconds),
      projectsCount: getAllProjects().length,
      nodeVersion: process.version,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Check latest version from GitHub
app.get("/api/status/update", async (_req, res) => {
  try {
    const upstreamUrl = "https://raw.githubusercontent.com/grokuku/Pi-web/main/VERSION";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(upstreamUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return res.status(502).json({ error: `GitHub returned ${response.status}` });
    }
    const latestVersion = (await response.text()).trim();

    // Strip pre-release suffixes (-beta, -alpha, -rc, -dev) for comparison
    const stripPreRelease = (v: string) => v.replace(/[-].*$/, "").trim();
    const currentBase = stripPreRelease(piWebVersion);
    const latestBase = stripPreRelease(latestVersion);
    const updateAvailable = latestBase !== "" && latestBase !== currentBase;

    res.json({
      currentVersion: piWebVersion,
      latestVersion,
      updateAvailable,
    });
  } catch (e: any) {
    res.status(504).json({ error: e.message });
  }
});

// ── REST API for session history (for reconnection) ──
app.get("/api/sessions/:projectId/history", (req, res) => {
  const { projectId } = req.params;
  const state = getSession(projectId);
  // Historique UI COMPLET (entrées brutes, pré-compaction incluse) et non le
  // seul contexte LLM compaction-aware : cf. buildFullUiHistory.
  const messages = state?.session ? buildFullUiHistory(state.session) : [];
  res.json({ messages });
});

app.get("/api/sessions/:projectId/info", (req, res) => {
  const { projectId } = req.params;
  const info = getSessionInfo(projectId);
  res.json(info);
});

// Debug: list tools available in a session
app.get("/api/sessions/:projectId/tools", (req, res) => {
  const { projectId } = req.params;
  const state = getSession(projectId);
  if (!state?.session) {
    return res.json({ tools: [], activeTools: [], error: "No active session" });
  }
  try {
    const allTools = state.session.getAllTools();
    const activeToolNames = state.session.getActiveToolNames();
    res.json({
      tools: allTools.map((t: any) => ({ name: t.name, label: t.label })),
      activeTools: activeToolNames,
    });
  } catch (err: any) {
    res.json({ tools: [], activeTools: [], error: err.message });
  }
});

// ── SPA fallback: serve index.html for all unmatched routes ──
// (frontend static assets are already served above, before the CBM proxy)
if (existsSync(frontendDist)) {
  app.get("*", (req, res) => {
    // Les routes /api non matchées doivent renvoyer du JSON (404) et NON
    // index.html : sinon un fetch frontend qui attend du JSON recevrait du
    // HTML et planterait sur le parse ("JSON.parse: unexpected character") —
    // typiquement quand une session expirée fait répondre une page de login.
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

// ─── HTTP Server ───────────────────────────────────────
const httpServer = createServer(app);

// ── WebSocket Server ──────────────────────────────────
// L'authentification WS est durcie (correctif sécurité) : la simple
// correspondance du header Origin n'est JAMAIS suffisante (forgeable par un
// client non-navigateur). Ordre d'acceptation :
//   1) jeton valide (même validation que l'API REST, api-auth.ts) ;
//   2) connexion locale (extensions, proxy Vite en dev) ;
//   3) requête navigateur authentique : TOUS les critères requis — header
//      Origin présent ET autorisé par la liste effective (env + réglage UI,
//      résolue à chaque handshake pour le hot-reload) ET Sec-Fetch-Site:
//      same-origin ET Sec-Fetch-Mode: websocket (signature navigateur) ;
//   4) sinon → refus 401.

/** Extrait un jeton d'authentification d'une requête WebSocket. */
function extractWsToken(req: any): string | null {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const token = url.searchParams.get("token");
    if (token) return token;
  } catch {}

  const auth = req.headers.authorization as string | undefined;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

const wss = new WebSocketServer({
  server: httpServer,
  // BUG-5 : limite de taille de payload WS (25 MB) pour éviter la coupure de
  // connexion sur les grosses images (base64) envoyées via pi_prompt/pi_steer.
  // Les messages normaux (texte, JSON) sont très en dessous de cette limite.
  maxPayload: 25 * 1024 * 1024,
  verifyClient: (info, callback) => {
    const origin = info.req.headers.origin as string | undefined;

    // 1) Jeton valide : clients non-navigateur et cross-origin.
    const token = extractWsToken(info.req);
    if (token && validateToken(token)) {
      callback(true);
      return;
    }

    // 2) Connexion locale (extensions, proxy Vite en dev).
    const remoteIp = info.req.socket.remoteAddress;
    if (remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1") {
      callback(true);
      return;
    }

    // 3) Mode allow-all (`*`) : permissivité assumée par l'admin (ex. serveur
    //    interne/privé). Cohérent avec isBrowserRequest() : on accepte sans
    //    exiger Sec-Fetch-* (le proxy peut ne pas les transmettre). La
    //    protection Sec-Fetch-* reste active pour les listes d'origines
    //    explicites (pas de `*`), où le comportement strict est conservé.
    const effective = resolveEffectiveAllowedOrigins();
    if (effective.allowAll) {
      callback(true);
      return;
    }

    // 4) Requête navigateur authentique : TOUS les critères sont requis.
    //    La correspondance d'Origin seule ne suffit jamais (forgeable) : les
    //    en-têtes Sec-Fetch-* doivent également signer une requête navigateur.
    const fetchSite = (info.req.headers["sec-fetch-site"] as string | undefined)?.trim().toLowerCase();
    const fetchMode = (info.req.headers["sec-fetch-mode"] as string | undefined)?.trim().toLowerCase();
    if (
      !!origin &&
      isAllowedOrigin(origin, effective.origins) &&
      fetchSite === "same-origin" &&
      fetchMode === "websocket"
    ) {
      callback(true);
      return;
    }

    // 5) Tout le reste → refus.
    console.log(`[WS] Rejected connection (origin: ${origin || "none"}, ip: ${info.req.socket.remoteAddress})`);
    callback(false, 401, "Unauthorized");
    return;
  },
});

interface ExtendedWS extends WebSocket {
  isAlive: boolean;
  projectId?: string;  // Track which project this client is viewing
  subscribedProjects: Set<string>;  // (sécurité #5) projets auxquels ce socket est abonné
}

// ── Observabilité : envois pi_history + seuil « rattrapage massif » (AJUSTEMENT 1) ──
// L'incident « chat figé puis rattrapage massif » (WS coupé par Authentik →
// resync au retour : 2228 messages d'un coup) n'a laissé AUCUNE trace car seuls
// les sites d'erreur loggaient. Chaque envoi de pi_history trace désormais UNE
// ligne : cause (déclencheur), nb de messages, taille, durée de construction.
// Au-delà des seuils → WARN : c'est le signal « rattrapage massif » à chercher
// dans les logs la prochaine fois.
const PI_HISTORY_WARN_MESSAGES = 500;
const PI_HISTORY_WARN_BYTES = 1024 * 1024; // ~1 Mo

/**
 * Envoie un message WS `pi_history` et trace l'événement (catégorie `ws`).
 * Une ligne INFO par envoi — WARN si les seuils de rattrapage massif sont
 * dépassés. `cause` distingue les déclencheurs : pi_start (premier start),
 * pi_start_replay (rejeu après reconnexion, BUG-83), pi_history_request
 * (resync client), pi_prompt_fallback (session recréée au vol pour un prompt),
 * pi_prompt_needs_history (filet needsHistory).
 * La sérialisation n'est faite QU'UNE FOIS : la chaîne produite sert à la fois
 * de payload WS et de source pour la taille loggée.
 *
 * Chargement par lots : `window` (from/total/hasMore) est joint au payload
 * quand l'appelant a tronqué l'historique (sliceUiHistoryWindow) — le client
 * sait alors qu'il peut demander la suite via pi_history_page. Absent →
 * historique complet (format legacy, toujours supporté côté client).
 */
function sendPiHistory(
  ws: ExtendedWS,
  pid: string,
  messages: unknown[],
  cause: string,
  buildMs?: number,
  window?: UiHistoryWindowMeta,
): void {
  const body: Record<string, unknown> = { type: "pi_history", projectId: pid, messages };
  if (window) {
    body.from = window.from;
    body.total = window.total;
    body.hasMore = window.hasMore;
  }
  const payload = JSON.stringify(body);
  const details: Record<string, unknown> = {
    projectId: pid,
    cause,
    messages: Array.isArray(messages) ? messages.length : 0,
    bytes: Buffer.byteLength(payload),
  };
  if (window) {
    // Curseur de fenêtrage : from = index du 1er message envoyé, total = taille
    // complète, hasMore = reste-t-il des messages antérieurs à charger.
    details.from = window.from;
    details.total = window.total;
    details.hasMore = window.hasMore;
  }
  if (buildMs !== undefined) details.buildMs = buildMs;
  if ((details.messages as number) > PI_HISTORY_WARN_MESSAGES || (details.bytes as number) > PI_HISTORY_WARN_BYTES) {
    logger.warn("ws", "pi_history volumineux envoyé (rattrapage massif ?)", details);
  } else {
    logger.info("ws", "pi_history envoyé", details);
  }
  ws.send(payload);
}

wss.on("connection", (ws: ExtendedWS) => {
  ws.isAlive = true;
  ws.subscribedProjects = new Set();
  let cleanedUp = false;
  // AJUSTEMENT 1 : chaque connexion est tracée (l'incident a DÉBUTÉ par une
  // coupure WS invisible dans les logs). projectId inconnu à ce stade (le
  // client s'abonne ensuite via {type:"subscribe"}) → null ; il sera connu
  // à la déconnexion si le client en a envoyé un.
  logger.info("ws", "WS client connecté", { projectId: ws.projectId ?? null, clients: wss.clients.size });

  // Ping/pong to keep alive
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // ── Subscribe to Pi events (routed by projectId) ──
  // (sécurité #5) Filtrage côté SERVEUR : un event n'est envoyé QUE si ce
  // socket est abonné au projet concerné (Set<projectId> par socket). Le
  // client s'abonne via {type:"subscribe", projectId} à l'ouverture et à
  // chaque changement de projet actif.
  const unsub = subscribeToEvents((event, projectId) => {
    if (ws.readyState === ws.OPEN && ws.subscribedProjects.has(projectId)) {
      ws.send(JSON.stringify({ type: "pi_event", event, projectId }));
    }
  });

  // ── Subscribe to terminal events ──
  const onTermData = (data: { projectId: string; data: string }) => {
    if (ws.readyState === ws.OPEN) {
      // Only send terminal data for the project this client is interested in
      // (or send all and let the frontend filter)
      ws.send(JSON.stringify({ type: "terminal_data", ...data }));
    }
  };
  const onTermExit = (data: { projectId: string; exitCode: number; signal: number }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "terminal_exit", ...data }));
    }
  };

  terminalEvents.on("data", onTermData);
  terminalEvents.on("exit", onTermExit);

  // ── Send initial state (all active sessions) ──
  const projects = getAllProjects();
  const activeSessions: Record<string, any> = {};
  for (const project of projects) {
    const info = getSessionInfo(project.id);
    if (info) {
      activeSessions[project.id] = info;
    }
  }

  ws.send(
    JSON.stringify({
      type: "connected",
      data: {
        activeSessions,
        // Backward compat: return first active session
        session: Object.values(activeSessions)[0] || null,
      },
    })
  );

  // ── Cleanup helper (idempotent) ──
  const cleanup = (cause: "close" | "error", code?: number, reason?: Buffer, errMsg?: string) => {
    if (cleanedUp) return;
    cleanedUp = true;
    // AJUSTEMENT 1 : déconnexion tracée avec le contexte de l'incident —
    // dernier projectId vu, abonnements, nb de clients restants (ce socket
    // exclu s'il figure encore dans wss.clients) et raison de fermeture
    // quand elle est connue (code+raison WS sur close, message sur error).
    const details: Record<string, unknown> = {
      projectId: ws.projectId ?? null,
      subscribedProjects: [...ws.subscribedProjects],
      clients: wss.clients.size - (wss.clients.has(ws) ? 1 : 0),
      cause,
    };
    if (code !== undefined) details.code = code;
    if (reason?.length) details.reason = reason.toString();
    if (errMsg) details.error = errMsg;
    logger.info("ws", "WS client déconnecté", details);
    unsub();
    terminalEvents.off("data", onTermData);
    terminalEvents.off("exit", onTermExit);
    // IMPORTANT: Do NOT kill all terminals or sessions on disconnect!
    // Sessions and terminals persist across WebSocket reconnections.
  };

  // ── Message handler ──
  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      await handleWsMessage(ws, msg);
    } catch (e) {
      // P0 observabilité : trace persistante ; le miroir console reste actif
      // (docker logs) via logger.error.
      logger.error("ws", "WS message error", {
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      ws.send(
        JSON.stringify({ type: "error", error: errorMessage })
      );
    }
  });

  // ── Close/error handlers ──
  // Code + raison WS passés au trace quand disponibles (ex. code 1006 =
  // coupure anormale — exactement le scénario Authentik forward_auth).
  ws.on("close", (code, reason) => cleanup("close", code, reason));
  ws.on("error", (e) => cleanup("error", undefined, undefined, e instanceof Error ? e.message : String(e)));
});

// Keep-alive interval
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const ext = ws as ExtendedWS;
    if (!ext.isAlive) return ws.terminate();
    ext.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on("close", () => clearInterval(interval));

// ─── WebSocket Message Handler ─────────────────────────
async function handleWsMessage(ws: ExtendedWS, msg: any) {
  // Always update ws.projectId when a projectId is provided
  // This ensures fallback routing uses the latest project context
  if (msg.projectId) ws.projectId = msg.projectId;

  const projectId = msg.projectId || ws.projectId || "";

  // Helper to validate project exists
  function getValidatedProject(pid: string): Project | null {
    if (!pid) {
      ws.send(JSON.stringify({ type: "error", error: "projectId is required" }));
      return null;
    }
    const project = getProject(pid);
    if (!project) {
      ws.send(JSON.stringify({ type: "error", error: `Project not found: ${pid}` }));
      return null;
    }
    return project;
  }

  switch (msg.type) {
    // ── (sécurité #5) Abonnement par projet ──
    // Le client s'abonne explicitement au(x) projet(s) dont il veut recevoir
    // les events pi_event. Le serveur ne route un event QUE vers les sockets
    // abonnés au projet concerné (Set<projectId> par socket).
    case "subscribe": {
      const pid = msg.projectId || projectId;
      if (pid) {
        ws.subscribedProjects.add(pid);
        // Correctif 1 (observabilité réception) : la demande d'abonnement du
        // client était invisible — une enquête ne voyait que les ENVOIS.
        logger.info("ws", "subscribe reçu", { projectId: pid });
      }
      break;
    }
    case "unsubscribe": {
      const pid = msg.projectId || projectId;
      if (pid) {
        ws.subscribedProjects.delete(pid);
        logger.info("ws", "unsubscribe reçu", { projectId: pid });
      }
      break;
    }

    // ── Pi Actions (now project-scoped) ──
    case "pi_start": {
      const pid = msg.projectId || projectId;
      const project = getValidatedProject(pid);
      if (!project) return;
      const cwd = project.cwd;

      // AJUSTEMENT 1 : détection du replay BUG-83 (5bbe558) — un pi_start reçu
      // alors que la session du projet existe déjà est un rejeu (file d'attente
      // re-jouée après reconnexion WS, ou re-sélection du projet).
      // createPiSession étant idempotent (réutilise la session en mémoire), on
      // se contente de tracer l'événement et le volume d'historique renvoyé.
      const isReplay = !!getSession(pid)?.session;
      // Correctif 1 : la RÉCEPTION du pi_start était invisible (on ne voyait
      // que l'envoi pi_history qui suit) — on trace la demande du client.
      logger.info("ws", "pi_start reçu", {
        projectId: pid,
        replay: isReplay,
        resume: msg.resume !== false,
      });

      try {
        const state = await createPiSession(cwd, pid, {
          resume: msg.resume !== false, // Resume by default!
          sessionId: msg.sessionId,
          projectName: project.name,
        });

        // Sync git info
        if (project) {
          try { await syncGitInfo(project); } catch {}
        }

        ws.send(
          JSON.stringify({
            type: "pi_started",
            data: {
              cwd,
              projectId: pid,
              sessionId: state.session?.sessionId,
              resumed: !!state.session?.sessionId, // Indicate if this was a resume
            },
          })
        );

        // Send message history for UI reconstruction (plafonné au lot initial)
        if (state.session) {
          // fix « messages récents manquants » : historique COMPLET (entrées
          // brutes, pré-compaction incluse) au lieu du seul contexte LLM —
          // puis CHARGEMENT PAR LOTS : seuls les N derniers messages partent
          // sur le WS (le payload complet, 10 Mo / 2321 messages sur la
          // session de référence, faisait flapper la connexion → l'historique
          // était perdu en route). Le client demande les lots antérieurs via
          // pi_history_page. La source reste buildFullUiHistory (entrées
          // brutes, ids, compactions inline) — seule la TRANCHÉE change.
          const t0 = Date.now();
          const full = buildFullUiHistory(state.session);
          // AJUSTEMENT 1 : événement replay tracé à part (grep facile), le
          // détail volumétrique partant via sendPiHistory ci-dessous.
          if (isReplay) {
            logger.info("pi-session", "pi_start rejoué après reconnexion (BUG-83)", {
              projectId: pid,
              messages: full.length,
            });
          }
          const win = sliceUiHistoryWindow(full);
          sendPiHistory(ws, pid, win.messages, isReplay ? "pi_start_replay" : "pi_start", Date.now() - t0, win);
        }
      } catch (e: any) {
        // P0 observabilité : trace persistante + miroir console (docker logs).
        logger.error("pi-session", "Failed to create/resume Pi session", {
          projectId: pid,
          error: e?.message ?? String(e),
          stack: e?.stack,
        });
        ws.send(
          JSON.stringify({ type: "error", error: `Failed to start Pi session: ${e.message}` })
        );
      }
      break;
    }

    // ── Request history refresh for a project's active session ──
    // BUG « chat figé après restart » (incident 2026-09-19 12:22→12:28) : sans
    // session EN MÉMOIRE (restart/crash/deploy du backend), ce handler était un
    // NO-OP SILENCIEUX — ni log, ni erreur, ni fallback. Or c'est LE message
    // que le frontend envoie à chaque reconnexion WS pour un projet dont il
    // croit la session vivante (state.session périmé côté client — il ne peut
    // pas savoir que le backend a redémarré). Résultat : après chaque deploy,
    // les fenêtres ouvertes ne se resynchronisaient JAMAIS (UI figée sur son
    // dernier rendu, ou sur le fallback localStorage après reload — le « vieux
    // message ALLOWED_ORIGINS »). Seul un prompt guérissait l'onglet actif
    // (pi_prompt_fallback), laissant toutes les autres fenêtres figées.
    // Auto-guérison ici aussi : resume de la dernière session du projet
    // (idempotent + sérialisé, cf. e9e88be) puis envoi de l'historique (fenêtre
    // plafonnée, chargement par lots).
    case "pi_history_request": {
      // Correctif 1 : la demande de resync du client était totalement
      // invisible (seul l'envoi pi_history était tracé). Première question de
      // toute enquête « UI périmée » : est-ce que le client a DEMANDÉ ?
      // `cause` = état de la session à la réception (recréation = le client
      // a demandé après une perte côté backend).
      logger.info("ws", "pi_history_request reçu", {
        projectId,
        cause: getSession(projectId)?.session ? "session existante" : "session absente (auto-guérison)",
      });
      let state = getSession(projectId);
      if (!state?.session) {
        const project = getProject(projectId);
        if (!project) {
          ws.send(JSON.stringify({ type: "error", projectId, error: `Project not found: ${projectId}` }));
          break;
        }
        try {
          state = await createPiSession(project.cwd, projectId, {
            resume: true,
            projectName: project.name,
          });
        } catch (e: any) {
          logger.error("pi-session", "pi_history_request: échec de recréation de session", {
            projectId,
            error: e?.message ?? String(e),
          });
          ws.send(JSON.stringify({ type: "error", projectId, error: `Failed to resume session: ${e?.message ?? e}` }));
          break;
        }
      }
      if (state?.session) {
        // fix « messages récents manquants » : cf. buildFullUiHistory.
        // Chargement par lots : le resync n'envoie plus TOUT (10 Mo possibles
        // à chaque reconnexion = la cause racine du flapping) mais les N
        // derniers messages + curseur (le client pagine via pi_history_page).
        const t0 = Date.now();
        const full = buildFullUiHistory(state.session);
        const win = sliceUiHistoryWindow(full);
        sendPiHistory(ws, projectId, win.messages, "pi_history_request", Date.now() - t0, win);
      }
      break;
    }

    // ── Chargement par lots : lot antérieur d'historique (fix de fond) ──
    // Le pi_history initial ne transporte que les N derniers messages (le
    // payload complet faisait flapper le WS — codes 1001/1005 — et l'historique
    // était perdu en route). Quand l'utilisateur remonte au-delà du lot
    // chargé, le client envoie { projectId, before, beforeId, all? } et reçoit
    // le lot PRÉCÉDENT (avant le curseur) : mêmes messages sérialisés que
    // pi_history (buildFullUiHistory : entrées brutes, ids, compactions
    // inline) + curseur (from/total/hasMore). `before` est un index sur la
    // liste complète (stable : entries append-only) ; `beforeId` (id du 1er
    // message déjà chargé) prime dessus quand il est retrouvé — le curseur
    // survit ainsi à un décalage d'index (restart, purge). `all: true` =
    // « Tout afficher » : tout ce qui précède le curseur en un seul appel
    // (choix explicite de l'utilisateur, payload potentiellement gros → WARN).
    case "pi_history_page": {
      const pid = msg.projectId || projectId;
      // Correctif 1 : réception tracée avec le curseur demandé (before/all) —
      // distingue une pagination utilisateur d'un « Tout afficher ».
      logger.info("ws", "pi_history_page reçu", {
        projectId: pid,
        before: msg.before,
        beforeId: msg.beforeId,
        all: msg.all === true,
      });
      const project = getProject(pid);
      if (!project) {
        ws.send(JSON.stringify({ type: "error", projectId: pid, error: `Project not found: ${pid}` }));
        break;
      }
      // Auto-guérison, comme pi_history_request : la session peut avoir été
      // perdue (restart backend) entre le pi_history initial et ce lot.
      let pageState = getSession(pid);
      if (!pageState?.session) {
        try {
          pageState = await createPiSession(project.cwd, pid, {
            resume: true,
            projectName: project.name,
          });
        } catch (e: any) {
          logger.error("pi-session", "pi_history_page: échec de recréation de session", {
            projectId: pid,
            error: e?.message ?? String(e),
          });
          ws.send(JSON.stringify({ type: "error", projectId: pid, error: `Failed to resume session: ${e?.message ?? e}` }));
          break;
        }
      }
      if (!pageState?.session) break;
      const t0 = Date.now();
      // buildFullUiHistory reste la SOURCE (entrées brutes, ids, compactions
      // inline) : on ne change que la tranche envoyée.
      const full = buildFullUiHistory(pageState.session);
      const win = sliceUiHistoryWindow(full, {
        before: msg.before,
        beforeId: msg.beforeId,
        all: msg.all === true,
      });
      const payload = JSON.stringify({
        type: "pi_history_page",
        projectId: pid,
        messages: win.messages,
        from: win.from,
        total: win.total,
        hasMore: win.hasMore,
        before: win.end,
        all: msg.all === true,
      });
      const details = {
        projectId: pid,
        messages: win.messages.length,
        bytes: Buffer.byteLength(payload),
        from: win.from,
        total: win.total,
        before: win.end,
        all: msg.all === true,
        buildMs: Date.now() - t0,
      };
      if (details.messages > PI_HISTORY_WARN_MESSAGES || details.bytes > PI_HISTORY_WARN_BYTES) {
        logger.warn("ws", "pi_history_page volumineux envoyé (lot antérieur)", details);
      } else {
        logger.info("ws", "pi_history_page envoyé (lot antérieur)", details);
      }
      ws.send(payload);
      break;
    }

    // ── List available sessions for a project ──
    case "pi_list_sessions": {
      const project = getProject(projectId);
      if (!project) {
        ws.send(JSON.stringify({ type: "error", error: "Project not found" }));
        return;
      }
      try {
        const sessions = await listSessions(project.cwd, project.id);
        ws.send(JSON.stringify({ type: "pi_sessions_list", projectId, sessions }));
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    case "pi_prompt": {
      const pid = msg.projectId || projectId;
      const project = getValidatedProject(pid);
      if (!project) return;
      const { message, images } = msg;
      // Correctif 1 : réception tracée en logger (fichier persistant) et
      // SANS contenu — l'ancien console.log affichait les 80 premiers
      // caractères du message. Seules des métadonnées sont loggées.
      logger.info("ws", "pi_prompt reçu", {
        projectId: pid,
        messageLength: typeof message === "string" ? message.length : 0,
        images: Array.isArray(images) ? images.length : 0,
        needsHistory: !!msg.needsHistory,
      });
      try {
        // ── Anti-course pi_start/pi_prompt + filet de sécurité ──
        // pi_start peut être encore en vol (rejeu de file WS après coupure,
        // double envoi) ou avoir été perdu (WS coupé au moment du clic) : on
        // s'assure que la session existe AVANT d'envoyer le prompt. Sans ça,
        // sendPrompt jetait « No active Pi session for this project » quel que
        // soit le projet. createPiSession est idempotent et sérialisé : un appel
        // concurrent au pi_start en cours attend la MÊME promesse.
        // On pousse aussi l'historique COMPLET, sinon l'UI resterait vide alors
        // que le backend vient de restaurer la conversation.
        let historySentByFallback = false;
        if (!getSession(pid)?.session) {
          const state = await createPiSession(project.cwd, pid, {
            resume: true,
            projectName: project.name,
          });
          ws.send(
            JSON.stringify({
              type: "pi_started",
              data: {
                cwd: project.cwd,
                projectId: pid,
                sessionId: state.session?.sessionId,
                resumed: !!state.session?.sessionId,
              },
            })
          );
          if (state.session) {
            const t0 = Date.now();
            const full = buildFullUiHistory(state.session);
            const win = sliceUiHistoryWindow(full);
            // AJUSTEMENT 1 : fallback auto-guérison — le prompt a réveillé un
            // projet sans session ; l'historique restauré est aussi tracé.
            sendPiHistory(ws, pid, win.messages, "pi_prompt_fallback", Date.now() - t0, win);
            historySentByFallback = true;
          }
        }
        // ── Filet de secours « needsHistory » (régression 6210d1c) ──
        // Depuis 6210d1c, pi_history_request recrée LUI-MÊME la session (auto-
        // guérison) : le test ci-dessus (!getSession(pid)?.session) ne se
        // déclenche donc plus quand le client a manqué le pi_history de resync
        // (réponse envoyée, puis perdue dans une nouvelle coupure WS). Or seul
        // le CLIENT peut savoir qu'il n'a appliqué aucun historique pour ce
        // projet : il le déclare via msg.needsHistory (posé par ChatView au
        // premier prompt d'un projet sans pi_history appliqué). On renvoie
        // alors l'historique (la fenêtre serveur plafonnée) UNE FOIS : le
        // marqueur disparaît côté
        // client dès qu'un premier pi_history est appliqué → JAMAIS de renvoi
        // systématique à chaque prompt (coût borné, pas de « 10 Mo par prompt »).
        if (msg.needsHistory && !historySentByFallback) {
          const stateNow = getSession(pid);
          if (stateNow?.session) {
            const t0 = Date.now();
            const full = buildFullUiHistory(stateNow.session);
            const win = sliceUiHistoryWindow(full);
            sendPiHistory(ws, pid, win.messages, "pi_prompt_needs_history", Date.now() - t0, win);
          }
        }
        const result = await sendPrompt(message, pid, images);
        // If it was a slash command, send the result back
        if (result && result.command) {
          ws.send(JSON.stringify({
            type: "pi_command_result",
            projectId: pid,
            command: result.command,
            result: result.result,
          }));
        }
      } catch (e: any) {
        // BUG-68 : inclure le projectId pour que le frontend puisse router l'erreur
        // vers la bonne conversation (sinon elle est ignorée si projectId manquant).
        ws.send(JSON.stringify({ type: "error", projectId: pid, error: e.message }));
      }
      break;
    }

    case "pi_abort": {
      const pid = msg.projectId || projectId;
      // Observabilité incident : un Stop utilisateur était TOTALEMENT
      // invisible (aucune trace avant abortPi) — impossible de distinguer
      // dans les logs un abort volontaire d'une génération qui meurt seule.
      logger.warn("ws", "pi_abort reçu", { projectId: pid });
      if (!getValidatedProject(pid)) return;
      try {
        await abortPi(pid);
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    // ── Mode switching ──
    case "mode_switch": {
      const pid = msg.projectId || projectId;
      const { mode } = msg;
      if (!getValidatedProject(pid) || !mode) return;
      try {
        await switchMode(mode, pid);
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    case "pi_steer": {
      const pid = msg.projectId || projectId;
      const { message, images } = msg;
      if (!getValidatedProject(pid) || !message) return;
      try {
        // BUG-6 : transmettre les images au steer pour ne pas les perdre
        // pendant le streaming (le SDK supporte steer(text, images?)).
        await steerPrompt(message, pid, images);
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    // ── Terminal Actions (now project-scoped, persist across connections) ──
    case "terminal_input": {
      const { projectId: termProjectId, data } = msg;
      writeToTerminal(termProjectId || projectId, data);
      break;
    }

    case "terminal_resize": {
      const { projectId: termProjectId, cols, rows } = msg;
      resizeTerminal(termProjectId || projectId, cols, rows);
      break;
    }

    case "terminal_create": {
      const { projectId: termProjectId, cwd } = msg;
      const pid = termProjectId || projectId;
      const project = getProject(pid);
      if (!project) {
        ws.send(JSON.stringify({ type: "error", error: `Project not found: ${pid}` }));
        break;
      }

      const termCwd = path.resolve(cwd || project.cwd);
      // Le terminal doit rester confiné au cwd du projet concerné et sous une
      // racine autorisée. On refuse tout cwd arbitraire (ex: /etc) ou symlink
      // pointant hors du projet.
      if (!isCwdAllowed(termCwd) || !isPathAllowed(termCwd, project.cwd)) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: "Terminal cwd is not allowed for this project",
          })
        );
        break;
      }

      createTerminal(pid, termCwd);
      break;
    }

    case "terminal_kill": {
      const { projectId: termProjectId } = msg;
      killTerminal(termProjectId || projectId);
      break;
    }

    // ── Request terminal buffer (for reconnection) ──
    case "terminal_buffer": {
      const pid = msg.projectId || projectId;
      const buffer = getTerminalBuffer(pid);
      ws.send(JSON.stringify({
        type: "terminal_buffer",
        projectId: pid,
        buffer,
      }));
      break;
    }

    // ── Ping ──
    case "ping": {
      ws.send(JSON.stringify({ type: "pong" }));
      break;
    }

    // ── Design → Chat bridge ──
    case "design_send_to_chat": {
      const pid = msg.projectId || projectId;
      const { html, css } = msg;
      if (!getValidatedProject(pid)) return;
      try {
        const { sendDesignToChat } = await import("./pi/design-bridge.js");
        await sendDesignToChat(pid, html, css);
        ws.send(JSON.stringify({ type: "design_sent_to_chat", projectId: pid }));
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }
      break;
    }

    default: {
      ws.send(
        JSON.stringify({
          type: "error",
          error: `Unknown message type: ${msg.type}`,
        })
      );
    }
  }
}

// ─── Global error handler (catch unhandled errors) ────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // P0 observabilité : trace persistante + miroir console (docker logs).
  // Volontairement SANS body/headers de la requête (risque de fuite de secrets).
  logger.error("express", "Unhandled error", {
    error: err?.message ?? String(err),
    stack: err?.stack,
  });
  const message = err?.message || (typeof err === "string" ? err : "Internal server error");
  res.status(500).json({ error: message });
});

// ─── Migration mémoire BUG-02 (best-effort, AVANT le listen) ───
// Nouvelle clé de dossier mémoire (slug + empreinte sha256) : migre les dossiers
// existants une seule fois. Fire-and-forget totalement isolé : un échec de
// migration (ex. sauvegarde non vérifiable) ne bloque JAMAIS le démarrage — le
// serveur écoute quoi qu'il arrive. Détail du comportement et restauration :
// pi/memory-migration.ts.
void runMemoryMigration()
  .then((result) => {
    if (result.skipped || result.aborted) {
      logger.info("memory-migration", "migration mémoire ignorée/abandonnée", {
        skipped: result.skipped,
        aborted: result.aborted,
        reason: result.reason ?? null,
      });
      return;
    }
    logger.info("memory-migration", "migration mémoire terminée", {
      moved: result.moved,
      skippedMoves: result.skippedMoves,
      conflicts: result.conflicts,
      orphans: result.orphans,
      backupPath: result.backupPath,
      durationMs: result.durationMs,
    });
  })
  .catch((err) => {
    logger.error("memory-migration", "migration mémoire en échec (démarrage non bloqué)", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

// ─── Start Server ──────────────────────────────────────
httpServer.listen(PORT, async () => {
  // ── P0 observabilité : trace de BOOT persistante (INVESTIGATION #4) ──
  // Les sessions vivent UNIQUEMENT en mémoire (sessionsByProject) : tout
  // redémarrage du process les vide et déclenche les rattrapages
  // pi_prompt_fallback côté client. Or avant af5c6cf, ni le boot ni le
  // SIGTERM n'étaient tracés dans backend-*.log : les redéploiements Docker
  // étaient indétectables (on ne voyait que des « clients » qui disparaissent
  // sans ligne de déconnexion). Chaque boot écrit désormais une ligne dans le
  // log fichier — toute répétition de cette ligne prouve un restart et
  // explique les sessions manquantes qui suivent.
  logger.info("express", "BOOT — serveur démarré ; sessionsByProject vide (sessions rétablies à la demande depuis le disque)", {
    version: process.env.PI_WEB_VERSION || "unknown",
    pid: process.pid,
    node: process.version,
  });

  // NOTE sécurité : plus aucun temp file résident au boot. Le plaintext n'existe
  // que de façon transitoire pendant les opérations git (via withTempFile).

  // Purge de sécurité : retirer tout credential embarqué des URLs de remote git
  // (projects.json + .git/config), y compris les dépôts non enregistrés.
  try {
    await purgeEmbeddedCredentialsFromRemotes();
  } catch (e: any) {
    console.error("[startup] credential purge failed:", e?.message || e);
  }

  // Régénérer models.json pour le SDK Pi avec les capacités RÉSOLUES
  // (vision/audio overrides). Sans ça, au démarrage le SDK relit l'ancien
  // models.json persisté — qui peut encore contenir input:["text"] pour un
  // modèle avec visionOverride "yes" (→ "image omitted" au prochain prompt).
  try {
    const { writeModelsJson } = await import("./pi/sync-providers.js");
    const { loadProviders: lp } = await import("./pi/providers.js");
    const { loadModelLibrary: lml } = await import("./pi/model-library.js");
    await writeModelsJson(lp(), lml());
  } catch (e: any) {
    console.warn("[startup] models.json regeneration failed:", e.message);
  }

  // Auto-mount SMB projects
  try {
    const projects = getAllProjects();
    await mountAllSmbProjects(projects);
  } catch (e: any) {
    console.error("[SMB] Auto-mount error:", e.message);
  }

  // Démarrer le cron du libraire
  startLibrarianCron(() => getAllProjects().map(p => p.cwd));

  // Résumé informatif au démarrage (la liste réelle est résolue à chaque check).
  const effective = resolveEffectiveAllowedOrigins();
  const originSummary = effective.allowAll
    ? "all origins (allow-all)"
    : `${effective.origins.length} allowed origin(s)`;
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  ⚡ PI-WEB  ███▓▓▒▒░░  v${piWebVersion}  ░░▒▒▓▓███  ║
  ╠══════════════════════════════════════════╣
  ║  HTTP+WS → http://localhost:${PORT}                  ║
  ║  CORS/WS → ${originSummary}                  ║
  ╚══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
const shutdown = async () => {
  // P0 observabilité : la mort du process était invisible dans backend-*.log
  // (seul console.log → stdout, non persisté) — les déploys/restarts
  // (SIGTERM) ne laissaient AUCUNE trace dans le fichier, indiscernables
  // d'un crash. logger.error : niveau élevé + trace persistante.
  logger.error("express", "SIGTERM reçu — shutdown en cours");
  clearInterval(interval);
  // Unmount SMB shares gracefully
  try { await unmountAllSmb(); } catch (e) { console.error("[SMB] Unmount error:", e); }
  // Don't kill terminals on shutdown — they should persist
  // (In production with tmux, they'd survive process restarts)
  // Observabilité : la fermeture des sessions Pi est tracée (au moins une
  // ligne avant/après) — sinon l'arrêt est indistinguable d'un crash.
  try {
    logger.info("express", "disposeAllSessions — fermeture des sessions Pi");
    await disposeAllSessions();
    logger.info("express", "disposeAllSessions terminé");
  } catch (e) {
    logger.error("express", "disposeAllSessions: erreur", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  wss.close();
  httpServer.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Crash handler ──
process.on("uncaughtException", (error) => {
  // P0 observabilité : dump persistant SYNCHRONE AVANT le process.exit(1)
  // ci-dessous (écriture en qq ms, très largement dans la fenêtre de 1s).
  logger.crash(error, "uncaughtException");
  console.error("\n========== UNCAUGHT EXCEPTION ==========");
  console.error("Time:", new Date().toISOString());
  console.error("Error:", error);
  console.error("Stack:", error?.stack || "No stack available");
  console.error("=========================================");
  // Attempt graceful shutdown, but don't hang
  setTimeout(() => process.exit(1), 1000);
  try { shutdown(); } catch {}
});

process.on("unhandledRejection", (reason, promise) => {
  // P0 observabilité : dump persistant synchrone (cf. uncaughtException).
  logger.crash(reason, "unhandledRejection", { promise: String(promise) });
  console.error("\n========== UNHANDLED REJECTION ==========");
  console.error("Time:", new Date().toISOString());
  console.error("Reason:", reason);
  console.error("Promise:", promise);
  console.error("Stack:", (reason as any)?.stack || "No stack available");
  console.error("=========================================");
  // BUG-11 fix: terminer le processus comme pour uncaughtException
  // Une rejection non gérée peut laisser l'app dans un état corrompu
  setTimeout(() => process.exit(1), 1000);
  try { shutdown(); } catch {}
});