/**
 * backend/src/pi/cbm-stdio.ts
 *
 * MCP stdio client for the codebase-memory-mcp binary (v0.10.5).
 *
 * WHY THIS EXISTS:
 *   In --ui mode (--ui=true --port=9749) the binary only exposes list_projects
 *   and get_code_snippet over its HTTP /rpc endpoint; every other method
 *   (get_graph_schema, search_graph, query_graph, trace_path, tools/list, ...)
 *   returns 403 "UI RPC method is not allowed". The FULL MCP surface is only
 *   available over stdio — launch the binary with NO arguments.
 *
 *   The CBM 3D graph UI (served via /cbm-ui/) calls POST /rpc with JSON-RPC
 *   requests (tools/call, tools/list, initialize, ...). The backend proxy in
 *   index.ts routes those calls through this module instead of forwarding to
 *   :9749, so the graph data loads through Pi-Web's port.
 *
 * This module lazily spawns the binary as a stdio MCP server, performs the
 * initialize handshake, and exposes cbmStdioCall(method, params, opts) which
 * resolves with the full JSON-RPC response envelope
 * {jsonrpc, id, result|error}. The process is respawned automatically on the
 * next call if it dies (lazy restart).
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BIN_PATH = join(homedir(), ".local", "bin", "codebase-memory-mcp");
const INIT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000; // graph queries on big repos can be slow
const CLIENT_NAME = "pi-web-backend";
const CLIENT_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";

interface PendingRequest {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let child: ChildProcess | null = null;
let ready = false;
let nextId = 0;
let buf = "";
let initPromise: Promise<void> | null = null;
let lastError: string | null = null;

const pending = new Map<number, PendingRequest>();

function log(...args: any[]): void {
  console.error("[cbm-stdio]", ...args);
}

/** Clear all in-flight requests and reset the client state. */
function reset(reason: string): void {
  ready = false;
  child = null;
  lastError = reason;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

/** Parse newline-delimited JSON-RPC messages from the binary's stdout. */
function onData(d: Buffer): void {
  buf += d.toString("utf8");
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore partial / non-JSON lines
    }
    if (msg && typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          p.resolve(msg);
        }
      }
    }
  }
}

function onExit(code: number | null, signal: string | null): void {
  log(`stdio process exited (code=${code}, signal=${signal}); will respawn on next call`);
  reset(`codebase-memory-mcp stdio exited (code=${code}, signal=${signal})`);
}

/** Allocate the next JSON-RPC id, honouring an explicit id from the caller. */
function nextRequestId(explicitId: number | null | undefined): number {
  if (
    typeof explicitId === "number" &&
    Number.isFinite(explicitId) &&
    !pending.has(explicitId)
  ) {
    nextId = Math.max(nextId, explicitId + 1);
    return explicitId;
  }
  return ++nextId;
}

/** Spawn the binary and complete the MCP initialize handshake (once). */
async function ensureStdioClient(): Promise<void> {
  if (child && ready) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (child && ready) return;

    if (!existsSync(BIN_PATH)) {
      throw new Error(`codebase-memory-mcp binary not found at ${BIN_PATH}`);
    }
    // A previous process may have died; make sure it is cleaned up.
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
      child = null;
    }
    ready = false;
    lastError = null;

    log("starting stdio MCP server (full tool surface)");
    const c = spawn(BIN_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
    child = c;
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", onData);
    c.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) log(s.slice(0, 1000));
    });
    c.on("error", (err) => {
      log("process error:", err.message);
      reset(`codebase-memory-mcp stdio error: ${err.message}`);
    });
    c.on("exit", onExit);

    // ── initialize handshake (also proves the process is alive) ──
    const initId = nextRequestId(undefined);
    const initOk = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(initId);
        resolve(false);
      }, INIT_TIMEOUT_MS);
      pending.set(initId, {
        resolve: () => { clearTimeout(timer); resolve(true); },
        reject: () => { clearTimeout(timer); resolve(false); },
        timer,
      });
      c.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: initId,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
          },
        }) + "\n",
        (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(initId);
            resolve(false);
          }
        }
      );
    });

    if (!initOk) {
      ready = false;
      try { c.kill(); } catch { /* ignore */ }
      child = null;
      throw new Error("codebase-memory-mcp stdio did not respond to initialize");
    }

    // Notify the server we are done initializing (no response expected).
    try {
      c.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    } catch { /* ignore */ }

    ready = true;
    log("stdio MCP client ready");
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

export interface CbmCallOptions {
  /** Explicit JSON-RPC id to echo in the response (default: auto-increment). */
  id?: number | null;
  /** AbortSignal to cancel an in-flight call. */
  signal?: AbortSignal;
}

export interface CbmJsonRpcResponse {
  jsonrpc: string;
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Send a JSON-RPC request to the CBM stdio MCP server and return the full
 * response envelope ({jsonrpc, id, result} or {jsonrpc, id, error}).
 *
 * Notifications (method starting with "notifications/") are written without
 * waiting for a response and resolve immediately with an empty result.
 */
export async function cbmStdioCall(
  method: string,
  params?: unknown,
  opts: CbmCallOptions = {}
): Promise<CbmJsonRpcResponse> {
  // Notifications never produce a response — write and return immediately.
  if (typeof method === "string" && method.startsWith("notifications/")) {
    await ensureStdioClient();
    const c = child;
    if (!c || !c.stdin) {
      throw new Error(lastError || "codebase-memory-mcp stdio client not ready");
    }
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    await new Promise<void>((resolve, reject) => {
      c.stdin!.write(JSON.stringify(msg) + "\n", (err) =>
        err ? reject(new Error(`MCP write failed: ${err.message}`)) : resolve()
      );
    });
    return { jsonrpc: "2.0", id: null, result: {} };
  }

  await ensureStdioClient();
  const c = child;
  if (!c || !ready || !c.stdin || !c.stdout) {
    throw new Error(lastError || "codebase-memory-mcp stdio client not ready");
  }

  const id = nextRequestId(opts.id);
  const { signal } = opts;
  return new Promise<CbmJsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP call timed out after ${CALL_TIMEOUT_MS}ms: ${method}`));
    }, CALL_TIMEOUT_MS);
    const onAbort = (): void => {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`MCP call aborted: ${method}`));
    };
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    pending.set(id, {
      resolve: (m) => settle(() => resolve(m)),
      reject: (e) => settle(() => reject(e)),
      timer,
    });
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) request.params = params;
    c.stdin!.write(JSON.stringify(request) + "\n", (err) => {
      if (err) {
        clearTimeout(timer);
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          p.reject(new Error(`MCP write failed: ${err.message}`));
        }
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    });
  });
}
