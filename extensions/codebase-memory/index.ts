/**
 * codebase-memory-mcp Extension for Pi-Web
 *
 * Provides graph-based code intelligence tools by wrapping the
 * codebase-memory-mcp binary (https://github.com/DeusData/codebase-memory-mcp).
 *
 * On first session start:
 *   1. Downloads the binary if not installed (~15 MB, ~5s)
 *   2. Starts the HTTP server on localhost:9749
 *   3. Indexes the current project
 *   4. Registers Pi tools that proxy to the MCP server
 *
 * Tools exposed:
 *   - cbm_search      : Search the graph by label, name pattern, semantic query
 *   - cbm_trace       : Trace call chains (inbound/outbound) up to depth 5
 *   - cbm_code        : Get code snippet for a symbol
 *   - cbm_search_code : Full-text search in code (regex, TODO/FIXME, etc.)
 *   - cbm_diff        : Change-impact analysis from git diff
 *   - cbm_arch        : Architecture overview with community detection
 *   - cbm_cypher      : Run Cypher queries against the graph
 *   - cbm_schema      : Get graph schema (node labels, edge types, stats)
 *
 * The binary is a standalone C executable with zero runtime dependencies.
 * All processing is local — code never leaves the machine.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync, spawn, type ChildProcess } from "child_process";
import { homedir } from "os";
import { dirname } from "path";

// ── Config ──────────────────────────────────────────────

const BIN_PATH = join(homedir(), ".local", "bin", "codebase-memory-mcp");
const PORT = 9749;
const BASE = `http://127.0.0.1:${PORT}`;
const DOWNLOAD_URL =
  "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh";

// Shared state — readable by the Express route /api/cbm/status
interface CbmStatus {
  installed: boolean;
  version: string | null;
  running: boolean;
  indexing: boolean;
  error: string | null;
}
let status: CbmStatus = {
  installed: false,
  version: null,
  running: false,
  indexing: false,
  error: null,
};

export function getCbmStatus(): CbmStatus {
  return status;
}

let child: ChildProcess | null = null;

// ── Utility ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getVersion(): string | null {
  if (!existsSync(BIN_PATH)) return null;
  try {
    return execSync(`"${BIN_PATH}" version`, { timeout: 5000, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

async function ensureBinary(): Promise<void> {
  if (existsSync(BIN_PATH)) {
    status.installed = true;
    status.version = getVersion();
    return;
  }

  console.log("[cbm] Binary not found, downloading...");
  status.error = null;

  // Ensure ~/.local/bin exists
  const binDir = dirname(BIN_PATH);
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  try {
    execSync(`curl -fsSL ${DOWNLOAD_URL} | bash`, {
      timeout: 120_000,
      encoding: "utf-8",
    });
    status.installed = existsSync(BIN_PATH);
    status.version = getVersion();
    console.log(`[cbm] Downloaded version ${status.version}`);
  } catch (e: any) {
    status.error = `Download failed: ${e.message}`;
    console.error("[cbm] Download failed:", e.message);
    throw e;
  }
}

async function isServerReady(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${BASE}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isServerReady()) return true;
    await sleep(500);
  }
  return false;
}

async function spawnServer(): Promise<void> {
  if (await isServerReady()) {
    status.running = true;
    return;
  }

  console.log("[cbm] Starting HTTP server on port", PORT);
  child = spawn(BIN_PATH, [`--ui=true`, `--port=${PORT}`], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  child.on("error", (err) => {
    console.error("[cbm] Process error:", err.message);
    status.error = `Server error: ${err.message}`;
    status.running = false;
  });

  child.on("exit", (code) => {
    console.log(`[cbm] Process exited with code ${code}`);
    status.running = false;
    child = null;
  });

  const ready = await waitForServer();
  if (!ready) {
    status.error = "Server did not respond in time";
    throw new Error("CBM server did not start");
  }
  status.running = true;
  status.error = null;
  console.log("[cbm] Server ready");
}

// ── MCP Communication ────────────────────────────────────

let requestId = 0;

async function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const id = ++requestId;
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`MCP call failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  // MCP tools/call returns { content: [{ type: "text", text: "..." }] }
  if (data.result?.content) {
    return data.result.content
      .map((c: any) => c.text || "")
      .join("\n");
  }
  return JSON.stringify(data.result, null, 2);
}

/** Call an MCP tool with the correct project parameter injected. */
async function mcpCallForProject(
  toolName: string,
  cwd: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const project = getProjectName(cwd);
  return mcpCall(toolName, { ...args, project }, signal);
}

// ── Project mapping ─────────────────────────────────────
// Maps cwd → CBM project name, so tools know which graph to query.
// The project name is discovered via list_projects after indexing.
const projectByCwd = new Map<string, string>();

/** Get the CBM project name for a given cwd, or derive a fallback. */
function getProjectName(cwd: string): string {
  return projectByCwd.get(cwd) || cwd.split("/").pop() || cwd;
}

// ── Index ────────────────────────────────────────────────

async function indexProject(cwd: string): Promise<void> {
  status.indexing = true;
  console.log(`[cbm] Indexing project: ${cwd}`);
  try {
    // Use "moderate" mode for balance of speed and completeness
    // NOTE: parameter is repo_path (absolute path), not path
    await mcpCall("index_repository", { repo_path: cwd, mode: "moderate" });
    console.log("[cbm] Indexing complete");

    // Discover the project name assigned by CBM
    const listResult = await mcpCall("list_projects", {});
    try {
      const projects = JSON.parse(listResult);
      // CBM returns either an array or { projects: [...] }
      const arr = Array.isArray(projects) ? projects : (projects.projects || projects.results || []);
      // Find the project matching our cwd
      const match = arr.find((p: any) => {
        const pPath = p.path || p.repo_path || p.repo || "";
        return pPath === cwd || p.name === cwd.split("/").pop();
      });
      if (match?.name) {
        projectByCwd.set(cwd, match.name);
        console.log(`[cbm] Project name: ${match.name}`);
      } else {
        // Fallback: use directory name as project name
        const fallbackName = cwd.split("/").pop() || cwd;
        projectByCwd.set(cwd, fallbackName);
        console.log(`[cbm] Project name (fallback): ${fallbackName}`);
      }
    } catch (e: any) {
      // If list_projects parsing fails, use dir name as fallback
      const fallbackName = cwd.split("/").pop() || cwd;
      projectByCwd.set(cwd, fallbackName);
      console.warn(`[cbm] Could not parse list_projects: ${e.message}, using fallback name: ${fallbackName}`);
    }
  } catch (e: any) {
    console.warn("[cbm] Indexing failed:", e.message);
    status.error = `Indexing failed: ${e.message}`;
  } finally {
    status.indexing = false;
  }
}

// ── Tool Definitions ─────────────────────────────────────

const searchParams = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Search query. Can be a function/class name, regex pattern, or semantic query (e.g. 'retry backoff'). " +
        "For semantic search, use natural language describing the concept.",
    },
    labels: {
      type: "array",
      items: { type: "string" },
      description: "Filter by node labels (e.g. ['Function'], ['Class'], ['Route']). Optional.",
    },
    name_pattern: {
      type: "string",
      description: "Regex pattern to match node names. Optional.",
    },
    semantic_query: {
      type: "array",
      items: { type: "string" },
      description: "Keywords for semantic/vector search (finds code by meaning, not just name). Optional.",
    },
    limit: {
      type: "integer",
      description: "Max results to return. Default: 20. Max: 200.",
    },
    file_pattern: {
      type: "string",
      description: "Filter results to files matching this substring pattern. Optional.",
    },
  },
};

const traceParams = {
  type: "object",
  properties: {
    function_name: {
      type: "string",
      description: "Name of the function/method to trace.",
    },
    direction: {
      type: "string",
      enum: ["outbound", "inbound"],
      description: "outbound = what does this function call. inbound = who calls this function.",
    },
    depth: {
      type: "integer",
      description: "Max traversal depth (1-5). Default: 3.",
    },
  },
  required: ["function_name", "direction"],
};

const codeParams = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Name of the function/class/symbol to get code for.",
    },
    file: {
      type: "string",
      description: "File path to look in. Optional, but helps disambiguate.",
    },
  },
  required: ["name"],
};

const searchCodeParams = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Regex or text to search for in source code (e.g. 'TODO|FIXME', 'password.*=.*\\$').",
    },
    file_pattern: {
      type: "string",
      description: "Filter to files matching this substring. Optional.",
    },
    limit: {
      type: "integer",
      description: "Max results. Default: 20.",
    },
  },
  required: ["query"],
};

const diffParams = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the git repository. Defaults to project root.",
    },
  },
};

const archParams = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the project. Defaults to project root.",
    },
  },
};

const cypherParams = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Cypher query to run against the knowledge graph (read-only). Example: MATCH (f:Function)-[:CALLS]->(g:Function) RETURN f.name, g.name LIMIT 10",
    },
  },
  required: ["query"],
};

const schemaParams = {
  type: "object",
  properties: {},
};

// ── Extension Entry Point ────────────────────────────────

export default async function (pi: ExtensionAPI) {
  console.log("[cbm] Extension loaded");

  // ── session_start: download, spawn, index ──
  pi.on("session_start", async (_event, ctx) => {
    try {
      // 1. Download binary if needed (only once)
      if (!existsSync(BIN_PATH)) {
        await ensureBinary();
      }

      // 2. Start server if not running (only once)
      if (!status.running) {
        await spawnServer();
      }

      // 3. Index THIS project (each project gets its own graph)
      //    Skip if already indexed (projectByCwd has an entry for this cwd)
      if (!projectByCwd.has(ctx.cwd)) {
        await indexProject(ctx.cwd);
      } else {
        console.log(`[cbm] Project already indexed: ${ctx.cwd} → ${projectByCwd.get(ctx.cwd)}`);
      }
    } catch (e: any) {
      console.error("[cbm] Initialization failed:", e.message);
      status.error = e.message;
    }
  });

  // ── Cleanup ──
  pi.on("session_shutdown", async () => {
    // Keep the server running — it's shared across sessions
    // It will be killed when the container/process exits
  });

  // ── Register tools ──

  pi.registerTool({
    name: "cbm_search",
    label: "Search Graph",
    description:
      "Search the codebase knowledge graph. Find functions, classes, routes by name, label, pattern, or semantic meaning. " +
      "Much faster and cheaper than grep+read for structural questions.",
    promptSnippet: "Search the codebase knowledge graph by name, label, pattern, or meaning",
    promptGuidelines: [
      "Use cbm_search when looking for functions, classes, or symbols by name or pattern — it's 100x cheaper than grep+read chains.",
      "Use cbm_search with semantic_query for concept-based search (e.g. find 'retry' logic even if named 'backoff' or 'reconnect').",
    ],
    parameters: searchParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const args: Record<string, unknown> = { query: params.query };
      if (params.labels) args.labels = params.labels;
      if (params.name_pattern) args.name_pattern = params.name_pattern;
      if (params.semantic_query) args.semantic_query = params.semantic_query;
      if (params.limit) args.limit = params.limit;
      if (params.file_pattern) args.file_pattern = params.file_pattern;
      const result = await mcpCallForProject("search_graph", ctx.cwd, args, signal);
      return { content: [{ type: "text", text: result }] };
    },
  });

  pi.registerTool({
    name: "cbm_trace",
    label: "Trace Call Path",
    description:
      "Trace call chains in the codebase. Find what a function calls (outbound) or who calls a function (inbound). " +
      "Depth up to 5 hops. Resolves types across files and packages.",
    promptSnippet: "Trace call chains (who calls what, up to 5 hops)",
    promptGuidelines: [
      "Use cbm_trace to understand call chains instead of reading multiple files.",
    ],
    parameters: traceParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const result = await mcpCallForProject("trace_call_path", ctx.cwd, {
        function_name: params.function_name,
        direction: params.direction,
        depth: params.depth || 3,
      }, signal);
      return { content: [{ type: "text", text: result }] };
    },
  });

  pi.registerTool({
    name: "cbm_code",
    label: "Get Code Snippet",
    description:
      "Get the source code of a function, class, or symbol from the knowledge graph. " +
      "Returns the code with file path and line numbers.",
    promptSnippet: "Get source code for a symbol from the graph",
    parameters: codeParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const args: Record<string, unknown> = { name: params.name };
      if (params.file) args.file = params.file;
      const result = await mcpCallForProject("get_code_snippet", ctx.cwd, args, signal);
      return { content: [{ type: "text", text: result }] };
    },
  });

  pi.registerTool({
    name: "cbm_search_code",
    label: "Search Code Text",
    description:
      "Full-text search across the codebase source code. Supports regex. " +
      "Use for finding TODOs, FIXMEs, specific patterns, or text in code.",
    promptSnippet: "Full-text search in source code (regex supported)",
    parameters: searchCodeParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const args: Record<string, unknown> = { query: params.query };
      if (params.file_pattern) args.file_pattern = params.file_pattern;
      if (params.limit) args.limit = params.limit;
      const result = await mcpCallForProject("search_code", ctx.cwd, args, signal);
      return { content: [{ type: "text", text: result }] };
    },
  });

  pi.registerTool({
    name: "cbm_diff",
    label: "Change Impact Analysis",
    description:
      "Analyze the impact of uncommitted changes. Maps git diff to affected symbols, " +
      "computes blast radius, and classifies risk. Perfect for understanding what a change affects before shipping.",
    promptSnippet: "Analyze git diff impact: affected symbols, blast radius, risk classification",
    promptGuidelines: [
      "Use cbm_diff before committing to understand the blast radius of your changes.",
      "Use cbm_diff during code review to see exactly which symbols are affected by the changes.",
    ],
    parameters: diffParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const args: Record<string, unknown> = {};
      if (params.path) args.path = params.path;
      const result = await mcpCallForProject("detect_changes", ctx.cwd, args, signal);
      return { content: [{ type: "text", text: result }] };
    },
  });

  pi.registerTool({
    name: "cbm_arch",
    label: "Architecture Overview",
    description:
      "Get an architecture overview of the project: module boundaries, communities, " +
      "key components, and their relationships. Uses Leiden community detection.",
    promptSnippet: "Get project architecture overview with module boundaries",
    promptGuidelines: [
      "Use cbm_arch in PLAN mode to understand the project structure before proposing changes.",
    ],
    parameters: archParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const args: Record<string, unknown> = {};
      if (params.path) args.path = params.path;
      const result = await mcpCallForProject("get_architecture", ctx.cwd, args, signal);
      return { content: [{ type: "text", text: result }] };
    },
  });

  pi.registerTool({
    name: "cbm_cypher",
    label: "Cypher Query",
    description:
      "Run a read-only Cypher query against the knowledge graph. " +
      "For advanced structural queries that cbm_search or cbm_trace can't express. " +
      "Example: MATCH (f:Function)-[:CALLS]->(g:Function) RETURN f.name, g.name LIMIT 10",
    promptSnippet: "Run a Cypher query against the codebase graph",
    parameters: cypherParams,
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const result = await mcpCallForProject("query_graph", ctx.cwd, { query: params.query }, signal);
      return { content: [{ type: "text", text: result }] };
    },
  });

  pi.registerTool({
    name: "cbm_schema",
    label: "Graph Schema",
    description:
      "Get the schema of the knowledge graph: node labels, edge types, property definitions, " +
      "and statistics (node count, edge count). Useful for understanding what data is available.",
    promptSnippet: "Get knowledge graph schema and stats",
    parameters: schemaParams,
    async execute(_toolCallId, _params: any, signal, _onUpdate, ctx) {
      const result = await mcpCallForProject("get_graph_schema", ctx.cwd, {}, signal);
      return { content: [{ type: "text", text: result }] };
    },
  });

  // ── Command: update the binary ──
  pi.registerCommand("cbm-update", {
    description: "Update codebase-memory-mcp binary to the latest version",
    handler: async (_args, ctx) => {
      if (!existsSync(BIN_PATH)) {
        ctx.ui.notify("Binary not installed. It will download on next session start.", "warn");
        return;
      }
      ctx.ui.setStatus("cbm", "Updating...");
      try {
        const output = execSync(`"${BIN_PATH}" update`, {
          timeout: 120_000,
          encoding: "utf-8",
        });
        const newVersion = getVersion();
        status.version = newVersion;

        // Restart the server
        if (child) {
          child.kill();
          child = null;
        }
        status.running = false;
        await spawnServer();

        ctx.ui.setStatus("cbm", `Ready (v${newVersion})`);
        ctx.ui.notify(`Updated to ${newVersion}!`, "info");
        console.log("[cbm] Update output:", output.slice(-200));
      } catch (e: any) {
        ctx.ui.setStatus("cbm", "Update failed");
        ctx.ui.notify(`Update failed: ${e.message}`, "error");
        console.error("[cbm] Update failed:", e.message);
      }
    },
  });
}