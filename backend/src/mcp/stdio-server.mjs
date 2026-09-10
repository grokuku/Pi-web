#!/usr/bin/env node
/**
 * Serveur MCP stdio de Pi-Web — couche commandes pour OpenClaw.
 *
 * Ce script est un process stdio **découplé** du backend Express : OpenClaw le
 * lance via `node`, et il appelle l'API REST de Pi-Web (localhost + agent key)
 * pour répondre aux tools. Il est volontairement **read-only** dans cette
 * étape : les tools d'écriture (edit_file, run_git commit/push,
 * run_terminal_command, run_session_prompt) viendront plus tard, derrière un
 * flag explicite.
 *
 * ── Choix d'implémentation ─────────────────────────────────────────────
 * Le protocole MCP stdio est implémenté **à la main** (JSON-RPC 2.0 sur
 * stdin/stdout, messages délimités par newline) plutôt qu'avec
 * @modelcontextprotocol/sdk. Raisons :
 *   - le protocole stdio MCP est simple (initialize + tools/list + tools/call) ;
 *   - zéro dépendance à installer dans backend (le SDK pèse ~1 Mo+ et n'apporte
 *     rien ici : pas de transport HTTP, pas de ressources/roots nécessaires) ;
 *   - le serveur reste un fichier `.mjs` autonome, exécutable directement.
 * Si un jour on a besoin de ressources, prompts ou d'un transport HTTP, on
 * pourra migrer vers le SDK sans changer la surface des tools.
 *
 * ── Configuration (env) ────────────────────────────────────────────────
 *   PI_MCP_AGENT_TOKEN  (obligatoire)  agent key Pi-Web (Bearer) pour l'API REST.
 *   PI_MCP_BASE_URL     (défaut http://localhost:3000)  base de l'API Pi-Web.
 *   PI_MCP_TIMEOUT_MS   (défaut 20000)  timeout des appels API (10-30s).
 *
 * Aucun secret n'est jamais loggé : on ne trace que le nom du tool et les
 * statuts HTTP, jamais le token ni le corps des réponses sensibles.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Version du serveur (lue depuis VERSION à la racine du repo) ─────────
let SERVER_VERSION = "0.1.0";
try {
  const versionFile = path.resolve(__dirname, "..", "..", "..", "VERSION");
  SERVER_VERSION = readFileSync(versionFile, "utf-8").trim() || SERVER_VERSION;
} catch {
  /* version par défaut si le fichier est absent */
}

// ── Configuration ───────────────────────────────────────────────────────
const TOKEN = process.env.PI_MCP_AGENT_TOKEN;
const BASE_URL = (process.env.PI_MCP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.PI_MCP_TIMEOUT_MS || 20000);

if (!TOKEN) {
  // Échec au démarrage avec un message clair : le serveur ne peut pas
  // authentifier ses appels API sans agent key.
  console.error(
    "[pi-web-mcp] ERREUR : la variable d'environnement PI_MCP_AGENT_TOKEN est obligatoire.\n" +
    "[pi-web-mcp] Créez une agent key dans l'UI Pi-Web (Settings → API Keys) et passez-la,\n" +
    "[pi-web-mcp] ex : PI_MCP_AGENT_TOKEN=pia_xxx node backend/src/mcp/stdio-server.mjs"
  );
  process.exit(1);
}

// ── Helpers API REST ─────────────────────────────────────────────────────
/**
 * Appelle l'API REST de Pi-Web avec le Bearer token et un timeout.
 * Lève une erreur avec `.status` (HTTP) et un message clair en cas d'échec.
 */
async function callApi(apiPath, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      const apiMsg =
        (data && typeof data === "object" && (data.error || data.message)) ||
        `HTTP ${res.status}`;
      const err = new Error(String(apiMsg));
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error(`Timeout après ${TIMEOUT_MS} ms en appelant l'API Pi-Web (${apiPath})`);
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Récupère le cwd d'un projet (pour résoudre les chemins relatifs). */
async function getProjectCwd(projectId) {
  const project = await callApi(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!project || !project.cwd) {
    const err = new Error("Projet introuvable ou sans cwd");
    err.status = 404;
    throw err;
  }
  return project.cwd;
}

// ── Définition des tools (read-only) ────────────────────────────────────
// Descriptions orientées agent : c'est ce que l'agent OpenClaw lit pour
// décider quand appeler chaque tool et ce qu'il en retire.
const TOOLS = [
  {
    name: "pi.list_projects",
    description:
      "Liste tous les projets Pi-Web : id, nom, stockage, cwd, dates de création et de dernière activité. " +
      "À appeler en premier pour découvrir les projets disponibles et récupérer leur id (projectId) " +
      "avant d'utiliser les autres tools pi.*.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "pi.get_project",
    description:
      "Détails d'un projet Pi-Web : cwd, configuration git (remote, branche), stockage et dates. " +
      "Utile pour connaître le répertoire de travail d'un projet avant de lire des fichiers ou " +
      "d'inspecter son état git.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Identifiant du projet (ex: proj_1)" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "pi.read_file",
    description:
      "Lit le contenu d'un fichier d'un projet. Le chemin est relatif au cwd du projet (ex: src/index.ts). " +
      "La sécurité des chemins est gérée côté backend : tout accès hors du cwd du projet est refusé. " +
      "Retourne le contenu, la taille et l'extension du fichier.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Identifiant du projet" },
        path: { type: "string", description: "Chemin relatif au cwd du projet (ex: src/index.ts)" },
      },
      required: ["projectId", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "pi.list_files",
    description:
      "Parcourt l'arborescence d'un projet : liste les entrées (dossiers et fichiers) d'un répertoire. " +
      "Le chemin est relatif au cwd du projet ; s'il est omis, liste la racine du projet. " +
      "Les fichiers cachés (dotfiles) sont masqués. Utile pour explorer la structure du code.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Identifiant du projet" },
        path: { type: "string", description: "Chemin relatif au cwd (défaut: racine du projet)" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "pi.run_git_status",
    description:
      "État git d'un projet : branche, fichiers modifiés/ajoutés/supprimés, en avance/en retard sur le remote. " +
      "Lecture seule (aucune modification). À appeler pour savoir si un projet a des changements non commités " +
      "ou des commits non poussés avant de décider d'une action.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Identifiant du projet" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "pi.list_sessions",
    description:
      "Liste les sessions Yuki actives de tous les projets : sessionId, modèle, mode actif, streaming, " +
      "nombre de messages. À appeler pour savoir quels projets ont une session de code en cours.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "pi.get_session_status",
    description:
      "État de la session Yuki d'un projet : active ou non, modèle utilisé, mode actif, streaming en cours, " +
      "contexte utilisé. À appeler pour vérifier si un projet est en train de travailler (streaming) " +
      "ou pour connaître le modèle et le contexte d'une session.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Identifiant du projet" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
];

// ── Implémentation des tools ────────────────────────────────────────────
const TOOL_HANDLERS = {
  async "pi.list_projects"() {
    // API projets (riche : inclut git, dates) — protégée par apiAuth.
    const data = await callApi("/api/projects");
    return data;
  },

  async "pi.get_project"({ projectId }) {
    return callApi(`/api/projects/${encodeURIComponent(projectId)}`);
  },

  async "pi.read_file"({ projectId, path: relPath }) {
    if (!relPath || typeof relPath !== "string") {
      const err = new Error("Paramètre 'path' (chemin relatif) requis");
      err.status = 400;
      throw err;
    }
    const cwd = await getProjectCwd(projectId);
    const abs = path.resolve(cwd, relPath);
    return callApi(
      `/api/agent/projects/${encodeURIComponent(projectId)}/files/read?path=${encodeURIComponent(abs)}`
    );
  },

  async "pi.list_files"({ projectId, path: relPath }) {
    const cwd = await getProjectCwd(projectId);
    const abs = relPath ? path.resolve(cwd, relPath) : cwd;
    return callApi(
      `/api/agent/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(abs)}`
    );
  },

  async "pi.run_git_status"({ projectId }) {
    return callApi(`/api/projects/${encodeURIComponent(projectId)}/git/status`);
  },

  async "pi.list_sessions"() {
    const projects = await callApi("/api/projects");
    const sessions = [];
    for (const p of projects || []) {
      try {
        const info = await callApi(`/api/sessions/${encodeURIComponent(p.id)}/info`);
        if (info) sessions.push({ projectId: p.id, projectName: p.name, ...info });
      } catch {
        // Projet sans session active → on l'ignore silencieusement.
      }
    }
    return { sessions };
  },

  async "pi.get_session_status"({ projectId }) {
    const info = await callApi(`/api/sessions/${encodeURIComponent(projectId)}/info`);
    if (!info) {
      const err = new Error("Aucune session Yuki active pour ce projet");
      err.status = 404;
      throw err;
    }
    return info;
  },
};

// ── Protocole MCP stdio (JSON-RPC 2.0) ─────────────────────────────────
const PROTOCOL_VERSION = "2024-11-05";

/** Sérialise une réponse JSON-RPC et l'écrit sur stdout (délimité newline). */
function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Construit un résultat MCP textuel (content) à partir d'une valeur. */
function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/** Construit une erreur MCP (isError) à partir d'une erreur d'API. */
function toolError(err) {
  const status = err.status || 500;
  const prefix =
    status === 401 ? "Authentification API refusée (401)" :
    status === 403 ? "Accès refusé par la sécurité des chemins (403)" :
    status === 404 ? "Ressource introuvable (404)" :
    status === 504 ? "Timeout API" :
    `Erreur API (${status})`;
  return {
    content: [
      {
        type: "text",
        text: `${prefix} : ${err.message || "erreur inconnue"}`,
      },
    ],
    isError: true,
  };
}

/**
 * Traite un message JSON-RPC entrant et renvoie la réponse (ou null pour les
 * notifications, qui n'appellent pas de réponse).
 */
async function handleRequest(msg) {
  const { id, method, params } = msg;

  // Notifications : pas de réponse attendue.
  if (id === undefined || id === null) {
    return null;
  }

  try {
    switch (method) {
      case "initialize": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "pi-web", version: SERVER_VERSION },
          },
        };
      }

      case "tools/list": {
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };
      }

      case "tools/call": {
        const { name, arguments: args } = params || {};
        const handler = TOOL_HANDLERS[name];
        if (!handler) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Tool inconnu : ${name}` },
          };
        }
        try {
          const value = await handler(args || {});
          return { jsonrpc: "2.0", id, result: textResult(value) };
        } catch (err) {
          // Les erreurs API (401, 404, path-security, timeout) remontent comme
          // résultat MCP avec un message clair — jamais de secret dans le log.
          return { jsonrpc: "2.0", id, result: toolError(err) };
        }
      }

      case "ping": {
        return { jsonrpc: "2.0", id, result: {} };
      }

      default: {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Méthode inconnue : ${method}` },
        };
      }
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Erreur interne : ${err.message || "inconnue"}` },
    };
  }
}

// ── Boucle de lecture stdin (ligne par ligne) ────────────────────────────
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Ligne non-JSON : on répond une erreur de parse JSON-RPC.
      sendMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error : JSON invalide" },
      });
      continue;
    }

    const response = await handleRequest(msg);
    if (response) sendMessage(response);
  }
});

// Quand stdin se ferme, on laisse le process se terminer naturellement : les
// appels API en cours (fetch) maintiennent la boucle d'événements vivante et
// leurs réponses sont écrites avant la sortie. Pas de process.exit() ici, qui
// tuerait les requêtes asynchrones encore en vol.
process.stdin.on("end", () => {
  /* fin de stdin : le process sortira quand plus rien n'est en attente */
});
