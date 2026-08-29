import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import path from "path";
import { setMaxListeners } from "events";

// Increase max listeners for abort signals (Pi SDK creates many per session)
setMaxListeners(50);
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
import sharedMemoryRouter from "./routes/shared-memory.js";
import memoryRouter from "./routes/memory.js";
import { startLibrarianCron } from "./pi/librarian-cron.js";
import { apiAuth } from "./middleware/api-auth.js";
import type { Project } from "./projects/manager.js";
import {
  createPiSession,
  subscribeToEvents,
  sendPrompt,
  steerPrompt,
  abortPi,
  getSession,
  getSessionInfo,
  getSessionMessages,
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
import { syncGitInfo } from "./projects/git.js";
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
// Mémoire partagée externe (Lot M2) : auth dédiée dans le router
// (localhost ∥ Bearer agent ∥ X-API-Key librarian).
app.use("/api/shared-memory", sharedMemoryRouter);
// Mémoire UI interne (Lot M3) : couverte par apiAuth globale (same-origin).
app.use("/api/memory", memoryRouter);

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

// ── Fonction partagée de sérialisation des messages (BUG-46 fix) ──
// Utilisée par pi_start et pi_history_request pour reconstruire l'historique UI.
function serializeMessagesForUi(messages: any[]): any[] {
  return messages.map((m: any) => {
    const base: any = {
      id: m.id,
      role: m.role,
      timestamp: m.timestamp,
    };
    if (m.role === "user") {
      base.content = m.content;
    } else if (m.role === "assistant") {
      const rawContent = Array.isArray(m.content) ? m.content : m.content;
      base.content = Array.isArray(rawContent)
        ? rawContent.map((b: any) => {
            if (b.type === "tool_use" || b.type === "function") {
              return {
                ...b,
                type: "toolCall",
                name: b.name || b.toolName || "unknown",
                arguments: b.arguments || b.input || b.args || {},
              };
            }
            return b;
          })
        : rawContent;
      base.usage = m.usage;
      // BUG-68 : préserver les métadonnées d'échec LLM (stopReason:"error" + errorMessage)
      // Sinon l'erreur est avalée ici et le frontend ne reçoit qu'un message assistant vide.
      base.stopReason = m.stopReason;
      base.errorMessage = m.errorMessage;
      base.thinking = Array.isArray(base.content)
        ? base.content.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking || "").join("")
        : undefined;
    } else if (m.role === "toolResult") {
      base.toolCallId = m.toolCallId;
      base.toolName = m.toolName;
      base.content = m.content;
      base.details = m.details;
    } else if (m.role === "bashExecution") {
      base.command = m.command;
      base.output = m.output;
      base.exitCode = m.exitCode;
      base.cancelled = m.cancelled;
    } else if (m.role === "compactionSummary") {
      base.summary = m.summary;
      base.tokensBefore = m.tokensBefore;
    } else if (m.role === "custom") {
      base.content = m.content;
      base.customType = m.customType;
      base.display = m.display;
      base.details = m.details;
    }
    return base;
  });
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
  const messages = getSessionMessages(projectId);
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
  app.get("*", (_req, res) => {
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
}

wss.on("connection", (ws: ExtendedWS) => {
  ws.isAlive = true;
  let cleanedUp = false;
  console.log("WebSocket client connected");

  // Ping/pong to keep alive
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // ── Subscribe to Pi events (routed by projectId) ──
  const unsub = subscribeToEvents((event, projectId) => {
    if (ws.readyState === ws.OPEN) {
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
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    console.log("WebSocket client disconnected");
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
      console.error("WS message error:", e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      ws.send(
        JSON.stringify({ type: "error", error: errorMessage })
      );
    }
  });

  // ── Close handler ──
  ws.on("close", cleanup);
  ws.on("error", cleanup);
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
    // ── Pi Actions (now project-scoped) ──
    case "pi_start": {
      const pid = msg.projectId || projectId;
      const project = getValidatedProject(pid);
      if (!project) return;
      const cwd = project.cwd;

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

        // Send full message history for UI reconstruction
        if (state.session) {
          const messages = state.session.messages || [];
          ws.send(JSON.stringify({
            type: "pi_history",
            projectId: pid,
            messages: serializeMessagesForUi(messages),
          }));
        }
      } catch (e: any) {
        console.error("Failed to create/resume Pi session:", e);
        ws.send(
          JSON.stringify({ type: "error", error: `Failed to start Pi session: ${e.message}` })
        );
      }
      break;
    }

    // ── Request history refresh for a project's active session ──
    case "pi_history_request": {
      const state = getSession(projectId);
      if (state?.session) {
        const messages = state.session.messages || [];
        ws.send(JSON.stringify({
          type: "pi_history",
          projectId,
          messages: serializeMessagesForUi(messages),
        }));
      }
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
      console.log(`[Pi] Prompt received for ${pid}: ${message.substring(0, 80)}${message.length > 80 ? "..." : ""} (images: ${images?.length || 0})`);
      try {
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
  console.error("[Express] Unhandled error:", err);
  const message = err?.message || (typeof err === "string" ? err : "Internal server error");
  res.status(500).json({ error: message });
});

// ─── Start Server ──────────────────────────────────────
httpServer.listen(PORT, async () => {
  // Re-create temp files for any persisted credentials (needed by GIT_ASKPASS)
  credentialStore.ensureTempFiles();

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
  console.log("Shutting down...");
  clearInterval(interval);
  // Unmount SMB shares gracefully
  try { await unmountAllSmb(); } catch (e) { console.error("[SMB] Unmount error:", e); }
  // Don't kill terminals on shutdown — they should persist
  // (In production with tmux, they'd survive process restarts)
  await disposeAllSessions();
  wss.close();
  httpServer.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Crash handler ──
process.on("uncaughtException", (error) => {
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