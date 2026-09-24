/**
 * codebase-memory-mcp Extension for Pi-Web
 *
 * Provides graph-based code intelligence tools by wrapping the
 * codebase-memory-mcp binary (https://github.com/DeusData/codebase-memory-mcp).
 *
 * On first session start:
 *   1. Downloads the binary if not installed (~15 MB, ~5s)
 *   2. Starts the HTTP server on localhost:9749 (3D graph UI — the Pi-Web
 *      frontend embeds it via /cbm-ui/)
 *   3. Spawns a stdio MCP client for the FULL tool surface.
 *      (HTTP /rpc in --ui mode only allows list_projects + get_code_snippet;
 *      everything else → 403 "UI RPC method is not allowed")
 *   4. Indexes the current project
 *   5. Registers Pi tools that proxy to the MCP server (over stdio)
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
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import { join } from "path";
import { execSync, spawn, type ChildProcess } from "child_process";
import { homedir, tmpdir } from "os";
import { dirname } from "path";

// ── Carte du Repo (P1) : helper PUR de rendu + types ──
// Même pattern que harness-stream.ts/harness-archive.ts côté harness-orchestrator :
// le module backend est importé par jiti via un chemin relatif. Il est PUR
// (aucun état, aucun I/O) → une éventuelle seconde instance jiti est sans
// conséquence. Le rendu/ budget/ dégradation vivent là-bas (testés par vitest) ;
// ici ne vivent que l'extraction agrégée du graphe et le pont globalThis.
import {
  buildRepoMap,
  type RepoMapData,
  type RepoMapRoute,
  type RepoMapSymbol,
} from "../../backend/src/pi/repo-map.js";
// Résolution du projet CBM depuis le cwd (pure, testée par vitest) : gère les
// sous-dossiers et les workspaces liés qui ne sont pas indexés directement.
import {
  parseProjectList,
  resolveCbmProjectName,
  normalizeRootPath,
  type IndexedProject,
} from "../../backend/src/pi/cbm-project-resolution.js";
// Persistance CUMULÉE des compteurs d'observabilité (défaut 2) : le module pur
// sait charger/écrire .data/cbm-stats.json et agréger les compteurs.
import {
  accumulateCumulativeStats,
  emptyCumulativeStats,
  loadCbmStats,
  persistCbmStats,
  type CbmCumulativeStats,
} from "../../backend/src/pi/cbm-stats.js";

/**
 * Les projets LIÉS de Pi-Web (placeholder avec symlinks vers plusieurs dépôts)
 * sont marqués par un fichier .pi-web-linked : on ne les indexe PAS (l'index
 * suivrait les symlinks et mélangerait les dépôts — chaque sous-projet reste
 * indexé individuellement quand on y ouvre une session).
 */
function isLinkedProject(cwd: string): boolean {
  return !!cwd && existsSync(join(cwd, ".pi-web-linked"));
}

// ── Config ──────────────────────────────────────────────

// Chemin du binaire : CBM_BIN_PATH (exporté par entrypoint.sh → volume
// persistant /app/.data/bin) sinon repli historique ~/.local/bin. Les deux
// modules qui lisent ce chemin (cette extension + routes/cbm.ts) DOIVENT
// utiliser la même résolution, sinon l'un croit le binaire absent.
const BIN_PATH =
  process.env.CBM_BIN_PATH || join(homedir(), ".local", "bin", "codebase-memory-mcp");
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

// Shared usage stats — read by Express route /api/cbm/status
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.__cbmUsageStats) {
  g.__cbmUsageStats = {
    totalCalls: 0,
    totalErrors: 0,
    byTool: {} as Record<string, { ok: number; fail: number }>,
    byMode: {} as Record<string, number>,
    // JAUGE (pas un compteur de session) : nombre réel de projets connus du
    // registre CBM (root_path → nom alimenté par `list_projects`). Maintenue à
    // jour par refreshIndexedProjects() — cf. défaut « indexedProjects: 0 ».
    indexedProjects: 0,
    since: new Date().toISOString(),
  };
}

/** Track a successful CBM tool call */
function trackCall(tool: string, mode?: string) {
  const s = g.__cbmUsageStats;
  s.totalCalls++;
  if (!s.byTool[tool]) s.byTool[tool] = { ok: 0, fail: 0 };
  s.byTool[tool].ok++;
  if (mode) {
    s.byMode[mode] = (s.byMode[mode] || 0) + 1;
  }
}

/** Track a failed CBM tool call */
function trackFail(tool: string) {
  const s = g.__cbmUsageStats;
  s.totalErrors++;
  if (!s.byTool[tool]) s.byTool[tool] = { ok: 0, fail: 0 };
  s.byTool[tool].fail++;
}

// Statistiques d'ÉCHEC CBM (observabilité) — exposées par /api/cbm/status
// (champ `failures`). Objectif : pouvoir MESURER l'adoption de CBM. Auparavant,
// les erreurs MÉTIER de CBM (« project not found or not indexed ») arrivaient
// comme un simple TEXTE de résultat : elles passaient pour des succès (comptées
// « ok ») et restaient invisibles.
if (!g.__cbmFailureStats) {
  g.__cbmFailureStats = {
    total: 0,
    byTool: {} as Record<string, number>,
    byReason: {} as Record<string, number>,
    // P1 : combien de cartes servies / vides (≈ délégations SANS carte).
    repoMap: { served: 0, empty: 0 },
    recent: [] as Array<{
      at: string;
      tool: string;
      cwd: string;
      project: string;
      reason: string;
      message: string;
    }>,
  };
}

/** Classe un message d'erreur CBM en motif stable (clé des compteurs). */
function classifyCbmReason(message: string): string {
  const m = (message || "").toLowerCase();
  if (m.includes("project not found") || m.includes("not indexed")) return "project_not_found";
  if (m.includes("timed out") || m.includes("timeout")) return "timeout";
  if (m.includes("aborted")) return "aborted";
  if (m.includes("not ready") || m.includes("binary not found") || m.includes("exited")) {
    return "server_unavailable";
  }
  return "other";
}

/**
 * Journalise + comptabilise un échec CBM. BEST-EFFORT : ne jette JAMAIS (une
 * panne d'observabilité ne doit pas casser l'appel outil). Écrit une trace
 * structurée sur stderr et incrémente les compteurs globalThis.
 */
function recordCbmFailure(
  tool: string,
  cwd: string,
  project: string,
  error: unknown,
  reasonHint?: string,
): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const reason = reasonHint || classifyCbmReason(message);
    const s = g.__cbmFailureStats;
    s.total++;
    s.byTool[tool] = (s.byTool[tool] || 0) + 1;
    s.byReason[reason] = (s.byReason[reason] || 0) + 1;
    s.recent.push({
      at: new Date().toISOString(),
      tool,
      cwd,
      project,
      reason,
      message: message.slice(0, 500),
    });
    if (s.recent.length > 50) s.recent.splice(0, s.recent.length - 50);
    console.error(
      `[cbm][failure] tool=${tool} reason=${reason} project=${project} cwd=${cwd} :: ${message.slice(0, 300)}`,
    );
  } catch {
    /* ignore */
  }
}

/** Comptabilise l'issue d'un pont de carte du repo (P1 : servie vs vide). */
function trackRepoMapOutcome(served: boolean): void {
  try {
    const r = g.__cbmFailureStats.repoMap;
    if (served) r.served++;
    else r.empty++;
  } catch {
    /* ignore */
  }
}

// ── Persistance CUMULÉE des compteurs (observabilité dans le temps) ──
// Les compteurs de SESSION vivent dans g.__cbmUsageStats / g.__cbmFailureStats
// (remis à zéro au démarrage). Pour suivre l'adoption de CBM dans le TEMPS, un
// cumul persisté est maintenu dans <racine>/.data/cbm-stats.json :
//   cumulative = base_persistée (chargée au boot) + compteurs de session
// La base est FIGÉE pendant le process, donc la vue est recalculée sans double
// comptage à chaque flush. La jauge `indexedProjects` (non cumulable) et
// l'anneau `recent` (session) sont volontairement exclus du cumul.
if (!g.__cbmCumulativeBase) {
  g.__cbmCumulativeBase = loadCbmStats() || emptyCumulativeStats(new Date().toISOString());
}
/** Fréquence d'écriture best-effort du cumul (le flush à l'arrêt force l'écrit). */
const CBM_STATS_FLUSH_MS = 60_000;
let cbmStatsLastFlushAt = 0;

/** Vue cumulée FRAÎCHE = base persistée + compteurs de session courants. */
function getCbmCumulativeStats(): CbmCumulativeStats {
  return accumulateCumulativeStats(
    g.__cbmCumulativeBase,
    g.__cbmUsageStats,
    g.__cbmFailureStats,
    new Date().toISOString(),
  );
}

/** Persiste la vue cumulée (throttlé sauf `force`). Best-effort : ne jette jamais. */
function flushCbmStats(force = false): CbmCumulativeStats {
  try {
    const now = Date.now();
    if (!force && now - cbmStatsLastFlushAt < CBM_STATS_FLUSH_MS) return getCbmCumulativeStats();
    cbmStatsLastFlushAt = now;
    const stats = getCbmCumulativeStats();
    persistCbmStats(stats);
    return stats;
  } catch {
    return g.__cbmCumulativeBase;
  }
}

// Flush périodique (timer non référencé : ne retient pas le process en vie).
if (!g.__cbmStatsTimer) {
  g.__cbmStatsTimer = setInterval(() => flushCbmStats(true), CBM_STATS_FLUSH_MS);
  if (typeof g.__cbmStatsTimer?.unref === "function") g.__cbmStatsTimer.unref();
}

// Ponts globalThis lus par backend/src/routes/cbm.ts (même process).
g.__cbmCumulativeView = getCbmCumulativeStats;
g.__cbmFlushStats = flushCbmStats;
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

// ── MCP stdio client state ──────────────────────────────
// codebase-memory-mcp v0.10.4: in --ui mode the HTTP /rpc endpoint only allows
// list_projects and get_code_snippet; all other methods return 403
// ("UI RPC method is not allowed"). The binary exposes the FULL MCP surface
// over stdio, so tool calls are routed through a stdio JSON-RPC 2.0 client
// instead of POST /rpc.
let stdioChild: ChildProcess | null = null;
let stdioReady = false;
let stdioBuf = "";
let stdioReqId = 0;
let stdioReadyPromise: Promise<void> | null = null;
let stdioError: string | null = null;
const stdioPending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();

// ── Utility ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extrait « 0.11.0 » de la sortie de `--version` (« codebase-memory-mcp 0.11.0 »).
 * Tolère un préfixe « v » et un suffixe de pré-version.
 */
function parseVersion(output: string): string | null {
  const m = output.trim().match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

/**
 * Version du binaire installé, ou null s'il est absent/illisible.
 *
 * On interroge `--version` (≈25 ms, sortie « codebase-memory-mcp 0.11.0 ») et
 * NON `version` : ce dernier déclenche une activation de daemon, prend ~7 s et
 * n'écrit RIEN sur stdout (mesuré sur 0.11.0) — avec l'ancien timeout de 5 s il
 * renvoyait toujours null, ce qui faisait passer un binaire installé pour
 * absent (cf. la route /api/cbm/status).
 */
function getVersion(): string | null {
  if (!existsSync(BIN_PATH)) return null;
  try {
    return parseVersion(execSync(`"${BIN_PATH}" --version`, { timeout: 10_000, encoding: "utf-8" }));
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

  // Installer DANS le dossier du binaire (et non ~/.local/bin en dur) :
  // entrypoint.sh installe dans le volume persistant et exporte CBM_BIN_PATH —
  // ce fallback doit viser le MÊME chemin, sinon le binaire téléchargé reste
  // invisible pour BIN_PATH.
  const binDir = dirname(BIN_PATH);
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  // Téléchargement en 2 temps (script puis exécution) pour détecter réellement
  // un échec de curl (avec `curl | bash`, le code retour observé est celui de
  // bash, qui vaut 0 même si curl a échoué).
  // NB : execSync bloque la boucle d'événements pendant le téléchargement
  // (~286 Mo) ; ce chemin n'est qu'un FILET DE SÉCURITÉ — l'installation est
  // faite au démarrage du conteneur par entrypoint.sh.
  const script = join(tmpdir(), `cbm-install-${process.pid}.sh`);
  try {
    execSync(`curl -fsSL "${DOWNLOAD_URL}" -o "${script}"`, { timeout: 60_000, encoding: "utf-8" });
    execSync(`bash "${script}" --dir "${binDir}" --skip-config`, {
      timeout: 240_000,
      encoding: "utf-8",
    });
    status.installed = existsSync(BIN_PATH);
    status.version = getVersion();
    console.log(`[cbm] Downloaded version ${status.version}`);
  } catch (e: any) {
    status.error = `Download failed: ${e.message}`;
    console.error("[cbm] Download failed:", e.message);
    throw e;
  } finally {
    try {
      rmSync(script, { force: true });
    } catch {}
  }
}

// Flag module-level : UNE seule tentative d'auto-install depuis ensureStdioClient
// (évite les boucles de re-téléchargement à chaque appel de tool cbm_* quand le
// téléchargement échoue).
let attemptedAutoInstall = false;

// Sérialise les tentatives de téléchargement : session_start, before_agent_start
// et ensureStdioClient peuvent appeler ensureBinary() quasi simultanément → un
// seul téléchargement à la fois, les appelants en attente partagent la même
// promesse (même pattern que spawnPromise plus bas).
let downloadInFlight: Promise<void> | null = null;
function ensureBinaryOnce(): Promise<void> {
  if (!downloadInFlight) {
    downloadInFlight = ensureBinary().finally(() => {
      downloadInFlight = null;
    });
  }
  return downloadInFlight;
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
    // BUG-61 : en mode --ui, /rpc répond 403 pour tools/list — c'est le comportement
    // normal du serveur, pas une absence. Toute réponse HTTP (même 403/405) prouve
    // qu'un process écoute sur le port : on le réutilise au lieu de respawner
    // (un 2e spawn échouerait avec "ui.unavailable port=9749 reason=in_use").
    return true;
  } catch {
    // Seul un échec réseau (ECONNREFUSED, timeout) signifie "serveur absent".
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

// Sérialise les appels concurrents à spawnServer (race entre session_start et
// before_agent_start, ou entre deux sessions) : un seul spawn à la fois, les
// appelants en attente partagent la même promesse.
let spawnPromise: Promise<void> | null = null;

function spawnServer(): Promise<void> {
  if (!spawnPromise) {
    spawnPromise = doSpawnServer().finally(() => {
      spawnPromise = null;
    });
  }
  return spawnPromise;
}

async function doSpawnServer(): Promise<void> {
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
// All tool calls go through a stdio MCP client (full surface). The HTTP
// /rpc endpoint is only used as a last-resort fallback for the two methods
// it still allows in --ui mode (list_projects, get_code_snippet).

function onStdioData(d: Buffer): void {
  stdioBuf += d.toString("utf8");
  let idx: number;
  while ((idx = stdioBuf.indexOf("\n")) >= 0) {
    const line = stdioBuf.slice(0, idx).trim();
    stdioBuf = stdioBuf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg && typeof msg.id === "number") {
      const p = stdioPending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        stdioPending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
    }
  }
}

function onStdioExit(code: number | null): void {
  console.error(`[cbm] stdio MCP exited (code ${code})`);
  stdioReady = false;
  stdioChild = null;
  stdioError = `codebase-memory-mcp stdio exited (code ${code})`;
  for (const p of stdioPending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(stdioError));
  }
  stdioPending.clear();
}

async function ensureStdioClient(): Promise<void> {
  if (stdioChild && stdioReady) return;
  if (stdioReadyPromise) return stdioReadyPromise;
  stdioReadyPromise = (async () => {
    if (stdioChild && stdioReady) return;
    if (!existsSync(BIN_PATH)) {
      // Auto-réparation à l'appel : le binaire manque → UNE seule tentative de
      // téléchargement (flag module-level attemptedAutoInstall contre les boucles
      // et les téléchargements concurrents), puis re-check.
      if (!attemptedAutoInstall) {
        attemptedAutoInstall = true;
        console.log("[cbm] binaire absent à l'appel d'un tool cbm_*, tentative de téléchargement...");
        try {
          await ensureBinaryOnce();
        } catch (e: any) {
          console.warn("[cbm] téléchargement automatique échoué :", e.message);
        }
      }
      if (!existsSync(BIN_PATH)) {
        // Erreur ACTIONNABLE pour le LLM : ne pas retenter les cbm_* cette session.
        throw new Error(
          "codebase-memory-mcp n'est pas installé et la tentative de téléchargement automatique a échoué. " +
            "Les tools cbm_* sont INDISPONIBLES pour toute cette session — ne les réessayez PAS. " +
            "Utilisez grep et la lecture directe des fichiers à la place."
        );
      }
      console.log("[cbm] binaire téléchargé, poursuite du démarrage du client stdio");
    }
    stdioError = null;
    console.log("[cbm] Starting MCP client over stdio (full tool surface)");
    const child = spawn(BIN_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
    stdioChild = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onStdioData);
    child.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) console.error("[cbm:stdio]", s.slice(0, 1000));
    });
    child.on("error", (err) => {
      stdioReady = false;
      stdioChild = null;
      stdioError = err.message;
    });
    child.on("exit", onStdioExit);

    // MCP initialize handshake — also proves the process is alive.
    const id = ++stdioReqId;
    const initOk = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        stdioPending.delete(id);
        resolve(false);
      }, 15_000);
      stdioPending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "pi-web-cbm", version: "1.0.0" },
          },
        }) + "\n",
        (err) => {
          if (err) {
            clearTimeout(timer);
            stdioPending.delete(id);
            reject(new Error(`stdio write failed: ${err.message}`));
          }
        }
      );
    });

    if (!initOk) {
      stdioReady = false;
      throw new Error("codebase-memory-mcp stdio did not respond to initialize");
    }
    stdioReady = true;
    status.running = true;
    console.log("[cbm] MCP stdio client ready");
  })().finally(() => {
    stdioReadyPromise = null;
  });
  return stdioReadyPromise;
}

function stopStdioClient(): void {
  if (stdioChild) {
    try {
      stdioChild.stdin?.end();
    } catch {
      /* ignore */
    }
    stdioChild.kill();
    stdioChild = null;
  }
  stdioReady = false;
  for (const p of stdioPending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("codebase-memory-mcp stdio stopped"));
  }
  stdioPending.clear();
}

async function mcpCallStdio(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<any> {
  await ensureStdioClient();
  const child = stdioChild;
  if (!child || !stdioReady || !child.stdin || !child.stdout) {
    throw new Error(stdioError || "codebase-memory-mcp stdio client not ready");
  }
  const id = ++stdioReqId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stdioPending.delete(id);
      reject(new Error(`MCP call timed out: ${toolName}`));
    }, 120_000);
    const onAbort = (): void => {
      clearTimeout(timer);
      stdioPending.delete(id);
      reject(new Error(`MCP call aborted: ${toolName}`));
    };
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    stdioPending.set(id, {
      resolve: (v) => settle(() => resolve(v)),
      reject: (e) => settle(() => reject(e)),
      timer,
    });
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }) + "\n",
      (err) => {
        if (err) {
          clearTimeout(timer);
          const p = stdioPending.get(id);
          if (p) {
            stdioPending.delete(id);
            p.reject(new Error(`MCP write failed: ${err.message}`));
          }
          if (signal) signal.removeEventListener("abort", onAbort);
        }
      }
    );
  });
}

async function mcpCallHttp(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const id = ++stdioReqId;
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
  if (data.result?.content) {
    return data.result.content.map((c: any) => c.text || "").join("\n");
  }
  return JSON.stringify(data.result, null, 2);
}

async function mcpCall(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  let data: any;
  try {
    data = await mcpCallStdio(toolName, args, signal);
  } catch (e: any) {
    // Last-resort fallback: the UI-mode HTTP /rpc still accepts these two.
    if (toolName === "list_projects" || toolName === "get_code_snippet") {
      return mcpCallHttp(toolName, args, signal);
    }
    throw e;
  }
  if (data && data.error) {
    throw new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  // CBM renvoie les erreurs MÉTIER (ex. « project not found or not indexed »)
  // dans un result JSON-RPC VALIDE : isError=true + structuredContent.error,
  // sans objet `error`. Sans ce test, elles passaient pour des succès (comptées
  // « ok ») et n'apparaissaient nulle part côté observabilité.
  if (data && (data.isError || data?.structuredContent?.error)) {
    const text = Array.isArray(data?.content)
      ? data.content.map((c: any) => c?.text || "").join("\n")
      : "";
    const detail = text || data?.structuredContent?.error || "CBM tool error";
    throw new Error(`MCP error: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  // MCP tools/call returns { content: [{ type: "text", text: "..." }] }
  if (data?.content) {
    return data.content.map((c: any) => c.text || "").join("\n");
  }
  return JSON.stringify(data, null, 2);
}

/** Call an MCP tool with the correct project parameter injected. */
async function mcpCallForProject(
  toolName: string,
  cwd: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const project = await resolveProjectForCwd(cwd);
  try {
    const result = await mcpCall(toolName, { ...args, project }, signal);
    trackCall(toolName);
    return result;
  } catch (e: any) {
    trackFail(toolName);
    recordCbmFailure(toolName, cwd, project, e);
    throw e;
  }
}

// ── Carte du Repo (P1) : extraction agrégée + pont globalThis ──
// Objectif : les sous-agents (harness-orchestrator) démarrent à contexte VIDE et
// re-paient l'exploration. On leur injecte d'office une vue compacte du graphe
// (fichiers + hubs + routes) construite ici, via le pont globalThis (même
// process, chargement par jiti).
//
// MINIMISATION DES APPELS MCP : le moteur Cypher de CBM ne supporte qu'UN seul
// WITH et PAS d'UNION → on ne peut pas tout obtenir en une requête. On fait donc
// TROIS requêtes agrégées (hubs / fichiers / routes) et on les CACHE 5 min
// (même fraîcheur que l'index). Le coût est amorti sur toutes les délégations de
// la fenêtre, au lieu d'une exploration par sous-agent.
const REPO_MAP_CACHE_TTL_MS = 5 * 60 * 1000;

// Hubs : fonctions les plus appelées (CALLS entrants) + fichier + signature.
// P3 : ORDER BY rendu DÉTERMINISTE (inbound DESC, puis nom asc) — indispensable
// pour que le prompt système "stable" soit identique au fil des extractions.
const REPO_MAP_HUBS_CYPHER =
  "MATCH (f:Function)<-[:CALLS]-(c:Function) " +
  "RETURN f.name AS symbol, f.file_path AS file, f.signature AS sig, count(c) AS inbound " +
  "ORDER BY inbound DESC, f.name ASC LIMIT 60";

// Fichiers : liste des nœuds File (alimente l'arborescence du palier dégradé).
const REPO_MAP_FILES_CYPHER =
  "MATCH (file:File) RETURN file.path AS path ORDER BY path LIMIT 300";

// Routes : méthode + chemin (peu liées aux fichiers dans le graphe, on borne).
// P3 : ORDER BY explicite (sans lui, l'ordre du moteur n'est pas garanti).
const REPO_MAP_ROUTES_CYPHER =
  "MATCH (r:Route) RETURN r.method AS method, r.name AS path ORDER BY r.method, r.name LIMIT 80";

/** Résultat brut d'un query_graph en format JSON : { columns, rows }. */
function parseQueryRows(result: string): unknown[][] {
  try {
    const parsed = JSON.parse(result);
    return Array.isArray(parsed?.rows) ? (parsed.rows as unknown[][]) : [];
  } catch {
    return [];
  }
}

/** Cache par cwd (extraction brute, avant rendu — le boost dépend de la tâche). */
interface RepoMapCacheEntry {
  data: RepoMapData;
  at: number;
}
const repoMapCache = new Map<string, RepoMapCacheEntry>();

/**
 * Extrait les données de la carte via des requêtes Cypher AGRÉGÉES.
 * Tolérant aux pannes : une requête qui échoue ne prive pas des deux autres
 * (allSettled) — une carte partielle vaut mieux que pas de carte.
 */
async function extractRepoMapData(cwd: string): Promise<RepoMapData> {
  // Garantir le nom CBM du projet : au démarrage (ou si session_start n'a pas
  // encore fini) la Map mémoire est vide et getProjectName retomberait sur le
  // nom de dossier, que CBM ne connaît pas (préfixe « projects- »). Idempotent
  // et no-op si déjà résolu récemment.
  try {
    await discoverProjectName(cwd);
  } catch {}
  const [hubsRes, filesRes, routesRes] = await Promise.allSettled([
    mcpCallForProject("query_graph", cwd, { query: REPO_MAP_HUBS_CYPHER, format: "json", max_rows: 80 }),
    mcpCallForProject("query_graph", cwd, { query: REPO_MAP_FILES_CYPHER, format: "json", max_rows: 320 }),
    mcpCallForProject("query_graph", cwd, { query: REPO_MAP_ROUTES_CYPHER, format: "json", max_rows: 100 }),
  ]);

  const hubs: RepoMapSymbol[] = [];
  if (hubsRes.status === "fulfilled") {
    for (const r of parseQueryRows(hubsRes.value)) {
      const name = String(r?.[0] ?? "");
      if (!name) continue;
      const sig = r?.[2] != null && String(r[2]).length > 0 ? String(r[2]) : undefined;
      hubs.push({
        name,
        file: String(r?.[1] ?? ""),
        inbound: Number(r?.[3]) || 0,
        ...(sig ? { signature: sig } : {}),
      });
    }
  }

  const files: string[] = [];
  if (filesRes.status === "fulfilled") {
    for (const r of parseQueryRows(filesRes.value)) {
      const p = String(r?.[0] ?? "");
      if (p) files.push(p);
    }
  }

  const routes: RepoMapRoute[] = [];
  const seenRoutes = new Set<string>();
  if (routesRes.status === "fulfilled") {
    for (const r of parseQueryRows(routesRes.value)) {
      const path = String(r?.[1] ?? "");
      if (!path) continue;
      const method = String(r?.[0] ?? "").toUpperCase();
      const key = `${method} ${path}`;
      if (seenRoutes.has(key)) continue;
      seenRoutes.add(key);
      routes.push({ method, path });
    }
  }

  if (files.length === 0 && hubs.length === 0 && routes.length === 0) {
    reportRepoMapUnavailable(cwd, [hubsRes, filesRes, routesRes]);
  }

  return { files, hubs, routes };
}

/**
 * Observabilité P1 : une carte VIDE signifie que les sous-agents démarrent SANS
 * carte du repo. On trace explicitement la raison (échec MCP vs graphe vide) au
 * lieu du silence actuel (le seul avertissement vivait dans les ponts).
 */
function reportRepoMapUnavailable(
  cwd: string,
  results: Array<PromiseSettledResult<string>>,
): void {
  const project = getProjectName(cwd);
  const rejected = results.find((r) => r.status === "rejected") as
    | PromiseRejectedResult
    | undefined;
  if (rejected) {
    recordCbmFailure("__repo_map", cwd, project, rejected.reason ?? new Error("mcp_error"), "mcp_error");
  } else {
    recordCbmFailure("__repo_map", cwd, project, new Error("empty_graph"), "empty_graph");
  }
}

/**
 * Récupère les données brutes de la carte, depuis le cache 5 min si frais,
 * sinon via extraction Cypher. Factorisé pour que les deux ponts P3 (stable
 * et annexe) partagent EXACTEMENT les mêmes données (et donc le même cache).
 */
async function getRepoMapData(cwd: string): Promise<RepoMapData> {
  const cached = repoMapCache.get(cwd);
  if (cached && Date.now() - cached.at < REPO_MAP_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await extractRepoMapData(cwd);
  repoMapCache.set(cwd, { data, at: Date.now() });
  return data;
}

/**
 * Construit la carte du repo STABLE (P3) pour un cwd : classement par
 * centralité seule, SANS hint de tâche (`rank: "stable"`). Le texte ne dépend
 * donc QUE du projet — condition du prompt caching cross-délégation.
 *
 * Publique et exposée aux sous-agents via le pont globalThis
 * (`__cbmRepoMap`) ; destinée au PROMPT SYSTÈME du sous-agent. NE JETTE JAMAIS :
 * toute erreur (graphe non indexé, binaire absent, MCP indisponible…) → null.
 */
export async function buildRepoMapCached(cwd: string): Promise<string | null> {
  try {
    if (!cwd) return null;
    const data = await getRepoMapData(cwd);
    const text = buildRepoMap(data, { rank: "stable" });
    // Compte chaque délégation servie/vide (P1 : adoption de la carte).
    trackRepoMapOutcome(!!text);
    return text ? text : null;
  } catch (e: any) {
    trackRepoMapOutcome(false);
    recordCbmFailure("__repo_map", cwd, "", e, "map_build_error");
    console.warn(`[cbm] carte du repo (stable) indisponible pour ${cwd} : ${e?.message || e}`);
    return null;
  }
}

/**
 * Construit l'ANNEXE de pertinence (P3) : mêmes données que la carte stable
 * (cache PARTAGÉ via getRepoMapData), mais classement BOOSTÉ par la tâche
 * (`rank: "task"`).
 *
 * Exposée via le pont globalThis `__cbmRepoMapAnnex` ; destinée au PREMIER
 * MESSAGE USER du sous-agent — jamais au prompt système (le contenu variant
 * par tâche y invaliderait le cache du préfixe). NE JETTE JAMAIS → null.
 */
export async function buildRepoMapAnnexCached(
  cwd: string,
  task?: string,
  context?: string,
): Promise<string | null> {
  try {
    if (!cwd) return null;
    const data = await getRepoMapData(cwd);
    const text = buildRepoMap(data, { task, context, rank: "task" });
    trackRepoMapOutcome(!!text);
    return text ? text : null;
  } catch (e: any) {
    trackRepoMapOutcome(false);
    recordCbmFailure("__repo_map_annex", cwd, "", e, "map_build_error");
    console.warn(`[cbm] annexe de carte indisponible pour ${cwd} : ${e?.message || e}`);
    return null;
  }
}

// Ponts globalThis lus par l'extension harness-orchestrator (même process).
// Publiés au chargement du module pour être disponibles dès la 1re délégation.
// Deux entrées distinctes (P3) : `__cbmRepoMap` = préfixe système STABLE,
// `__cbmRepoMapAnnex` = annexe de pertinence boostée par la tâche (message user).
const REPO_MAP_BRIDGE_KEY = "__cbmRepoMap";
(globalThis as any)[REPO_MAP_BRIDGE_KEY] = buildRepoMapCached;
const REPO_MAP_ANNEX_BRIDGE_KEY = "__cbmRepoMapAnnex";
(globalThis as any)[REPO_MAP_ANNEX_BRIDGE_KEY] = buildRepoMapAnnexCached;

// ── Project mapping ─────────────────────────────────────
// Maps cwd → { projectName: string, lastIndexedAt: number }
// The project name is discovered via list_projects after indexing.
interface ProjectInfo {
  projectName: string;
  lastIndexedAt: number;
}
const projectByCwd = new Map<string, ProjectInfo>();
const REINDEX_INTERVAL_MS = 5 * 60 * 1000; // 5 min — keeps index fresh without being too expensive

// ── Résolution du projet CBM depuis le cwd ──────────────
// CBM identifie un projet par son root_path (list_projects). Le pont dérivait
// le nom du NOM DE DOSSIER du cwd : correct à la racine d'un dépôt indexé
// (« Pi-Web »), mais FAUX pour un sous-dossier ou un workspace COMPOSITE jamais
// indexé (projet lié `.pi-web-linked`, ex. « Yuki and Libs ») →
// « project not found or not indexed ». On tient donc un registre
// root_path → nom, et on résout via la règle documentée dans
// backend/src/pi/cbm-project-resolution.ts (pure, testée par vitest).
const indexedProjects = new Map<string, string>(); // root_path normalisé → nom CBM
let indexedProjectsFetchedAt = 0;
let indexedProjectsLastAttemptAt = 0;
// Backoff des tentatives quand le registre reste vide (serveur indisponible) :
// évite de marteler list_projects à chaque appel cbm_*.
const REGISTRY_RETRY_MS = 30_000;

/** Cibles réelles des symlinks d'un workspace lié (vide si cwd non lié). */
function listLinkedTargets(cwd: string): string[] {
  try {
    if (!existsSync(join(cwd, ".pi-web-linked"))) return [];
    const targets: string[] = [];
    for (const entry of readdirSync(cwd)) {
      try {
        targets.push(realpathSync(join(cwd, entry)));
      } catch {
        /* symlink cassé → ignoré */
      }
    }
    return targets;
  } catch {
    return [];
  }
}

/** Get the CBM project name for a given cwd, or derive a fallback. */
function getProjectName(cwd: string): string {
  if (!cwd) {
    console.warn("[cbm] getProjectName called with empty cwd, using fallback 'default'");
    return "default";
  }
  // Chemin rapide : entrée exacte posée après indexation/résolution.
  const cached = projectByCwd.get(cwd);
  if (cached) return cached.projectName;
  const indexed: IndexedProject[] = [...indexedProjects.entries()].map(([rootPath, name]) => ({
    rootPath,
    name,
  }));
  const resolved = resolveCbmProjectName(cwd, indexed, { linkedTargets: listLinkedTargets(cwd) });
  // Repli historique (nom de dossier) conservé pour ne rien casser.
  return resolved || cwd.split("/").pop() || cwd;
}

// ── Project discovery ───────────────────────────────────
// Au démarrage (restart container), la DB CBM existe déjà mais la Map en mémoire
// projectByCwd est vide. Il faut découvrir le nom CBM sans ré-indexer.

/** Remplit le registre root_path → nom depuis `list_projects` (TTL 5 min). */
async function refreshIndexedProjects(force = false): Promise<void> {
  const fresh =
    indexedProjects.size > 0 && Date.now() - indexedProjectsFetchedAt < REINDEX_INTERVAL_MS;
  if (!force && fresh) return;
  if (!force && Date.now() - indexedProjectsLastAttemptAt < REGISTRY_RETRY_MS) return;
  indexedProjectsLastAttemptAt = Date.now();
  try {
    // `list_projects` renvoie une TABLE TEXTE (pas du JSON) : parseProjectList
    // gère les deux formats (l'ancien JSON.parse échouait toujours).
    const raw = await mcpCall("list_projects", {});
    let count = 0;
    for (const p of parseProjectList(raw)) {
      indexedProjects.set(normalizeRootPath(p.rootPath), p.name);
      count++;
    }
    // Source de vérité de `usage.indexedProjects` : la TAILLE du registre
    // (nombre de projets réellement indexés connus de CBM), et non le nombre
    // d'indexations lancées. Corrige le « indexedProjects: 0 » trompeur.
    // Mise à jour seulement si la liste est non vide : une réponse vide
    // transitoire (serveur CBM momentanément indisponible) ne doit pas
    // écraser une valeur connue par 0.
    if (count > 0) {
      g.__cbmUsageStats.indexedProjects = indexedProjects.size;
      indexedProjectsFetchedAt = Date.now();
    } else {
      console.warn("[cbm] list_projects : aucune entrée parsable");
    }
  } catch (e: any) {
    console.warn(`[cbm] refreshIndexedProjects failed: ${e.message}`);
  }
}

// Pont lu par /api/cbm/status : rafraîchit le registre avant de lire la jauge
// `usage.indexedProjects` (no-op si déjà rafraîchi récemment). Best-effort.
g.__cbmRefreshProjectRegistry = refreshIndexedProjects;

/**
 * Résolution ASYNCHRONE : garantit le registre (le projet LIÉ n'est jamais
 * indexé par session_start, et la Map mémoire est vide après un restart) puis
 * applique la règle de la plus spécifique à la plus large.
 */
async function resolveProjectForCwd(cwd: string): Promise<string> {
  await refreshIndexedProjects();
  return getProjectName(cwd);
}

async function discoverProjectName(cwd: string): Promise<void> {
  // Déjà en cache et récent → rien à faire
  const existing = projectByCwd.get(cwd);
  if (existing && Date.now() - existing.lastIndexedAt < REINDEX_INTERVAL_MS) return;

  try {
    await refreshIndexedProjects();
    const name = getProjectName(cwd);
    projectByCwd.set(cwd, { projectName: name, lastIndexedAt: Date.now() });
    console.log(`[cbm] Discovered project name: ${name} for cwd ${cwd}`);
  } catch (e: any) {
    console.warn(`[cbm] discoverProjectName failed: ${e.message}`);
  }
}

// ── Index ────────────────────────────────────────────────

async function indexProject(cwd: string): Promise<void> {
  // Projets LIÉS : jamais indexés (le placeholder n'est pas un dépôt, et
  // l'indexation suivrait les symlinks en mélangeant les sous-projets).
  if (isLinkedProject(cwd)) {
    console.log(`[cbm] Indexing skipped for linked project: ${cwd}`);
    return;
  }
  status.indexing = true;
  console.log(`[cbm] Indexing project: ${cwd}`);
  try {
    // Use "moderate" mode for balance of speed and completeness
    // NOTE: parameter is repo_path (absolute path), not path
    await mcpCall("index_repository", { repo_path: cwd, mode: "moderate" });
    console.log("[cbm] Indexing complete");
    g.__cbmUsageStats.indexedProjects += 1;

    // Découvrir le nom attribué par CBM : rafraîchir le registre (force) puis
    // résoudre. BUG-65 : `list_projects` renvoie une TABLE TEXTE et non du
    // JSON — l'ancien JSON.parse échouait donc TOUJOURS et retombait sur le nom
    // de dossier. On lit maintenant le registre root_path → nom.
    // NB : `usage.indexedProjects` n'est plus incrémenté ici (c'était un
    // compteur d'INDEXATIONS de session, trompeur) ; il reflète désormais la
    // taille réelle du registre, posée par refreshIndexedProjects().
    await refreshIndexedProjects(true);
    const resolved = indexedProjects.get(normalizeRootPath(cwd)) || getProjectName(cwd);
    projectByCwd.set(cwd, { projectName: resolved, lastIndexedAt: Date.now() });
    console.log(`[cbm] Project name: ${resolved}`);
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

  // ── session_start: download, spawn, index (NON-BLOCKING) ──
  // Fire-and-forget so session creation is not delayed by CBM init.
  pi.on("session_start", (_event, ctx) => {
    (async () => {
      try {
        // Auto-réparation au boot : si le binaire manque, on tente de le
        // télécharger (ensureBinary sait le faire) au lieu de skipper la session.
        // Non-bloquant : en cas d'échec, cbm reste indisponible mais la session
        // démarre normalement (comme avant).
        if (!status.running && !existsSync(BIN_PATH)) {
          console.log("[cbm] session_start: binaire absent, tentative de téléchargement...");
          try {
            await ensureBinaryOnce();
          } catch (e: any) {
            console.warn("[cbm] session_start: cbm indisponible cette session :", e.message);
            return;
          }
          console.log("[cbm] session_start: binaire téléchargé, poursuite de l'init");
        }
        if (isLinkedProject(ctx.cwd)) {
          console.log(`[cbm] session_start: linked project, skipping CBM init for ${ctx.cwd}`);
          return;
        }
        if (!status.running) {
          await spawnServer();
        }
        // D'abord découvrir le nom du projet (au cas où la DB existe déjà)
        await discoverProjectName(ctx.cwd);
        const projInfo = projectByCwd.get(ctx.cwd);
        if (projInfo && Date.now() - projInfo.lastIndexedAt < REINDEX_INTERVAL_MS) {
          console.log(`[cbm] Project already indexed: ${ctx.cwd} → ${projInfo.projectName}`);
        } else {
          await indexProject(ctx.cwd);
        }
      } catch (e: any) {
        console.error("[cbm] session_start failed:", e.message);
        status.error = e.message;
      }
    })();
  });

  // ── Fallback: before_agent_start — ensure server + index if needed ──
  // NON-BLOCKING: fire-and-forget so the LLM can start immediately.
  // CBM init (download, spawn, index) can take minutes — we must not block the agent.
  pi.on("before_agent_start", (_event, ctx) => {
    // Fire-and-forget: start/init in background, don't await
    (async () => {
      try {
        // Auto-réparation au boot : si le binaire manque, on tente de le
        // télécharger (ensureBinary sait le faire) au lieu de skipper le turn.
        // Non-bloquant : en cas d'échec, cbm reste indisponible mais l'agent
        // démarre normalement (comme avant).
        if (!status.running && !existsSync(BIN_PATH)) {
          console.log("[cbm] before_agent_start: binaire absent, tentative de téléchargement...");
          try {
            await ensureBinaryOnce();
          } catch (e: any) {
            console.warn("[cbm] before_agent_start: cbm indisponible cette session :", e.message);
            return;
          }
          console.log("[cbm] before_agent_start: binaire téléchargé, poursuite de l'init");
        }
        if (isLinkedProject(ctx.cwd)) {
          console.log(`[cbm] before_agent_start: linked project, skipping CBM init for ${ctx.cwd}`);
          return;
        }
        if (!status.running) {
          await spawnServer();
        }
        if (ctx.cwd) {
          // D'abord découvrir le nom du projet (au cas où la DB existe déjà)
          await discoverProjectName(ctx.cwd);
          const projInfo = projectByCwd.get(ctx.cwd);
          if (!projInfo || Date.now() - projInfo.lastIndexedAt > REINDEX_INTERVAL_MS) {
            console.log(`[cbm] Indexing project (before_agent_start): ${ctx.cwd}`);
            await indexProject(ctx.cwd);
          }
        }
      } catch (e: any) {
        console.error("[cbm] before_agent_start failed:", e.message);
      }
    })();
  });

  // ── tool_execution_end: re-index after file edits ──
  // When Pi edits or writes a file, the CBM index becomes stale.
  // We trigger a fast incremental re-index so the next cbm_* call sees fresh data.
  pi.on("tool_execution_end", (event, ctx) => {
    // Only react to file-modifying tools
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    // Avoid re-index storm (multiple edits in quick succession)
    if (!ctx.cwd) return;
    const projInfo = projectByCwd.get(ctx.cwd);
    if (projInfo && Date.now() - projInfo.lastIndexedAt < 5_000) return; // max once per 5s

    // Non-blocking: fire-and-forget so the agent can continue immediately
    (async () => {
      console.log(`[cbm] File modified (${event.toolName}), re-indexing...`);
      await indexProject(ctx.cwd);
    })();
  });

  // ── Cleanup ──
  pi.on("session_shutdown", async () => {
    // Keep the server running — it's shared across sessions
    // It will be killed when the container/process exits
    // Flush final des compteurs cumulés (best-effort, jamais bloquant).
    try {
      flushCbmStats(true);
    } catch {
      /* ignore */
    }
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
      // BUG : le serveur `search_graph` attend `label` (string), pas `labels` (array).
      // Un tableau `labels` est silencieusement ignoré (vérifié via curl : filtrage inopérant).
      // Le serveur ne gère qu'un seul label par appel → on envoie le premier élément.
      // (le join par virgule renvoie 0 résultat : "No nodes with this label").
      if (Array.isArray(params.labels) && params.labels.length > 0) {
        args.label = String(params.labels[0]);
      }
      if (params.name_pattern) args.name_pattern = params.name_pattern;
      if (params.semantic_query) args.semantic_query = params.semantic_query;
      if (params.limit) args.limit = params.limit;
      if (params.file_pattern) args.file_pattern = params.file_pattern;
      const result = await mcpCallForProject("search_graph", ctx.cwd, args, signal);
      return { content: [{ type: "text", text: result }], details: undefined };
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
      // BUG : le serveur expose `trace_path`, pas `trace_call_path` (vérifié via tools/list).
      const result = await mcpCallForProject("trace_path", ctx.cwd, {
        function_name: params.function_name,
        direction: params.direction,
        depth: params.depth || 3,
      }, signal);
      return { content: [{ type: "text", text: result }], details: undefined };
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
      // BUG-59 (cbm_code) : le serveur MCP CBM exige `qualified_name` (champ requis,
      // vérifié via curl sur localhost:9749/rpc → "qualified_name is required").
      // `name` seul échoue. On envoie donc name + qualified_name (le serveur tolère
      // les props inconnues : name/file passent sans erreur, testé via curl).
      const args: Record<string, unknown> = {
        name: params.name,
        qualified_name: params.name,
      };
      if (params.file) args.file = params.file;
      const result = await mcpCallForProject("get_code_snippet", ctx.cwd, args, signal);
      return { content: [{ type: "text", text: result }], details: undefined };
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
      // BUG : le serveur `search_code` exige `pattern` (requis) — envoyer `query` échoue
      // avec "pattern is required" (vérifié via curl). On garde `query` dans le schéma
      // côté LLM (pour ne pas casser les appels existants) et on le mappe vers `pattern`.
      const args: Record<string, unknown> = { pattern: params.query };
      if (params.file_pattern) args.file_pattern = params.file_pattern;
      if (params.limit) args.limit = params.limit;
      const result = await mcpCallForProject("search_code", ctx.cwd, args, signal);
      return { content: [{ type: "text", text: result }], details: undefined };
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
      // BUG : le serveur MCP CBM ne fournit AUCUN tool `detect_changes` (vérifié via
      // tools/list : 8 tools seulement, aucun équivalent diff). Fallback LOCAL : lire
      // le diff git, puis retrouver les symboles affectés via query_graph (nœuds dont
      // file_path correspond au fichier modifié).
      const repoDir = params.path || ctx.cwd;
      let files: string[] = [];
      try {
        // Fichiers modifiés/supprimés vs HEAD (staged + unstaged)
        const diffOut = execSync("git diff --name-only HEAD", {
          cwd: repoDir,
          encoding: "utf-8",
          timeout: 30_000,
        });
        // Fichiers untracked (ligne porcelain "?? chemin")
        const statusOut = execSync("git status --porcelain", {
          cwd: repoDir,
          encoding: "utf-8",
          timeout: 30_000,
        });
        const set = new Set<string>();
        diffOut.split("\n").forEach((l) => { const t = l.trim(); if (t) set.add(t); });
        statusOut.split("\n").forEach((l) => {
          // Format porcelain : 2 lettres d'état + espace + chemin ("??" = untracked)
          const p = l.length > 3 ? l.slice(3).trim() : "";
          if (p) set.add(p);
        });
        files = [...set];
      } catch (e: any) {
        return {
          content: [{
            type: "text",
            text: `cbm_diff : impossible de lire le diff git dans "${repoDir}" — ${e.message}. ` +
              "Vérifiez que ce chemin est un dépôt git valide.",
          }],
          details: undefined,
        };
      }
      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "cbm_diff : aucune modification détectée (working tree propre)." }],
          details: undefined,
        };
      }
      const lines: string[] = [`Modifications détectées (${files.length} fichier(s)) :`];
      for (const file of files) {
        lines.push(`\n## ${file}`);
        // Échapper les guillemets du chemin pour la requête Cypher
        const safePath = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const cypher =
          `MATCH (n) WHERE n.file_path = "${safePath}" ` +
          "RETURN n.name, n.label, n.start_line ORDER BY n.start_line";
        try {
          const res = await mcpCallForProject("query_graph", repoDir, { query: cypher }, signal);
          const parsed = JSON.parse(res);
          const rows: unknown[][] = parsed.rows || [];
          if (rows.length === 0) {
            lines.push("  (aucun symbole indexé pour ce fichier)");
          } else {
            for (const r of rows) {
              lines.push(`  - ${r[1]} ${r[0]} (ligne ${r[2]})`);
            }
          }
        } catch (e: any) {
          lines.push(`  (recherche de symboles impossible : ${e.message})`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
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
      return { content: [{ type: "text", text: result }], details: undefined };
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
      return { content: [{ type: "text", text: result }], details: undefined };
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
      return { content: [{ type: "text", text: result }], details: undefined };
    },
  });

  // ── Command: update the binary ──
  pi.registerCommand("cbm-update", {
    description: "Update codebase-memory-mcp binary to the latest version",
    handler: async (_args, ctx) => {
      if (!existsSync(BIN_PATH)) {
        ctx.ui.notify("Binary not installed. It will download on next session start.", "info");
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

        // Restart the server (HTTP UI) + stdio MCP client
        if (child) {
          child.kill();
          child = null;
        }
        stopStdioClient();
        status.running = false;
        await spawnServer();
        await ensureStdioClient().catch((e: any) =>
          console.warn("[cbm] stdio respawn after update failed:", e.message)
        );

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