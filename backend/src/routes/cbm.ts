import { Router, type Request, type Response } from "express";
import { existsSync, readdirSync, statSync, readFileSync, realpathSync } from "fs";
import { execSync } from "child_process";
import { join, extname, basename, relative, resolve, dirname } from "path";
import { isPathAllowed } from "../utils/path-security.js";
import os from "os";

const router = Router();

// Même résolution de chemin que l'extension extensions/codebase-memory/
// index.ts : entrypoint.sh installe le binaire dans le volume
// persistant /app/.data/bin et exporte CBM_BIN_PATH. Sans cette variable, un
// binaire installé là serait vu comme « absent » par cette route.
const BIN_PATH =
  process.env.CBM_BIN_PATH || join(os.homedir(), ".local", "bin", "codebase-memory-mcp");
const CBM_INSTALL_URL =
  "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh";

/**
 * Extrait « 0.11.0 » de la sortie de `--version` (« codebase-memory-mcp 0.11.0 »).
 */
function parseVersion(output: string): string | null {
  const m = output.trim().match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

/**
 * Version du binaire installé (null s'il est absent ou illisible).
 *
 * IMPORTANT : on interroge `--version` (≈25 ms, sortie « codebase-memory-mcp
 * 0.11.0 ») et NON `version`. Cette dernière sous-commande, sur 0.11.0, lance
 * une activation de daemon : elle prend ~7 s et n'écrit RIEN sur stdout → avec
 * l'ancien timeout de 5 s, `getCbmVersion()` renvoyait toujours null et
 * `/api/cbm/status` annonçait `installed:false` même binaire installé et
 * serveur actif sur 9749 (le modal « Graphe 3D » affichait « Serveur non
 * démarré » pour tous les projets).
 */
function getCbmVersion(): string | null {
  if (!existsSync(BIN_PATH)) return null;
  try {
    return parseVersion(execSync(`"${BIN_PATH}" --version`, { timeout: 10_000, encoding: "utf-8" }));
  } catch {
    return null;
  }
}

/**
 * Check the latest release tag on GitHub.
 * Returns null if the request fails.
 */
async function getLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(
      "https://api.github.com/repos/DeusData/codebase-memory-mcp/releases/latest",
      { signal: controller.signal, headers: { "User-Agent": "pi-web" } }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as { tag_name?: string };
    return data.tag_name || null;
  } catch {
    return null;
  }
}

/**
 * Check if the CBM HTTP server is running on port 9749.
 */
function isServerRunning(): boolean {
  try {
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9749/ --max-time 1`,
      { timeout: 3000, encoding: "utf-8" }
    ).trim();
    return result === "200" || result === "404"; // 404 is fine, means server is up but no root route
  } catch {
    return false;
  }
}

// GET /api/cbm/status — version info and update availability
router.get("/status", async (_req: Request, res: Response) => {
  try {
    // `installed` ne dépend QUE de la présence du binaire : une lecture de
    // version ratée ne doit JAMAIS faire passer un binaire installé pour
    // absent (l'UI en déduisait « Serveur non démarré » alors que 9749
    // répondait). `running` est évalué indépendamment.
    const installed = existsSync(BIN_PATH);
    const version = installed ? getCbmVersion() : null;
    const running = installed && isServerRunning();
    const latestVersion = await getLatestVersion();

    // Update available if latest is different from current (normalize v-prefix)
    let updateAvailable = false;
    if (latestVersion && version) {
      const normCurrent = version.startsWith("v") ? version : `v${version}`;
      updateAvailable = normCurrent !== latestVersion;
    }

    res.json({
      installed,
      version,
      latestVersion,
      updateAvailable,
      running,
      binaryPath: installed ? BIN_PATH : null,
      // Usage stats from the extension (tracked per CBM tool call)
      usage: (globalThis as any).__cbmUsageStats || null,
      // Échecs CBM (par tool + par motif) — observabilité de l'adoption de CBM.
      failures: (globalThis as any).__cbmFailureStats || null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cbm/update — update the binary and restart the server
router.post("/update", async (_req: Request, res: Response) => {
  try {
    if (!existsSync(BIN_PATH)) {
      return res.status(400).json({ error: "Binary not installed. It will be auto-downloaded on next session start." });
    }

    // Run the built-in updater
    const updateOutput = execSync(`"${BIN_PATH}" update`, {
      timeout: 120_000,
      encoding: "utf-8",
    });

    // Read the new version
    const newVersion = getCbmVersion();
    const latestVersion = await getLatestVersion();
    let updateAvailable = false;
    if (latestVersion && newVersion) {
      const normCurrent = newVersion.startsWith("v") ? newVersion : `v${newVersion}`;
      updateAvailable = normCurrent !== latestVersion;
    }

    res.json({
      success: true,
      newVersion,
      latestVersion,
      updateAvailable,
      output: updateOutput.slice(-500),  // last 500 chars of output
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cbm/download — manually trigger download (if not installed)
router.post("/download", async (_req: Request, res: Response) => {
  try {
    if (existsSync(BIN_PATH)) {
      return res.json({ success: true, message: "Already installed", version: getCbmVersion() });
    }

    // Download using the official install script — dans le dossier de BIN_PATH
    // (volume persistant) pour que le binaire soit bien celui que le backend lit.
    const output = execSync(
      `curl -fsSL ${CBM_INSTALL_URL} | bash -s -- --dir "${dirname(BIN_PATH)}" --skip-config`,
      { timeout: 300_000, encoding: "utf-8" }
    );

    const version = getCbmVersion();
    res.json({ success: true, version, output: output.slice(-500) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Excluded directories (same as the HTML page) ────────────
const EXCLUDED_DIRS = new Set([
  ".git", ".svn", "node_modules", "bower_components", "vendor", "packages",
  "__pycache__", ".pytest_cache", ".ruff_cache", ".tox", "venv", ".venv",
  "env", ".env", "virtualenv", "dist", "build", "out", "target", ".turbo",
  ".next", ".nuxt", ".svelte-kit", ".cache", "coverage", ".idea", ".vscode",
  ".vs", ".gradle", "Pods", "bin", "obj", "Debug", "Release",
]);

const BINARY_EXTS = new Set([
  "png","jpg","jpeg","gif","webp","bmp","ico","mp3","wav","ogg","flac",
  "mp4","avi","mov","webm","mkv","pdf","doc","docx","xls","xlsx",
  "zip","tar","gz","bz2","xz","rar","7z","tgz","zst","deb","rpm","dmg",
  "iso","jar","war","ear","apk","exe","dll","so","dylib","o","a","lib",
  "pyc","pyo","class","wasm","woff","woff2","ttf","otf","eot",
  "ico","svg","eot","ttf","otf","woff","woff2",
]);

const ASSET_EXTS = new Set([
  "png","jpg","jpeg","gif","webp","bmp","ico","tiff","avif","svg",
  "mp3","wav","ogg","flac","aac","m4a","opus","mid","midi",
  "mp4","avi","mov","webm","mkv","flv","wmv","m4v","3gp",
  "woff","woff2","ttf","otf","eot",
  "pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","epub",
]);

const CONFIG_NAMES = new Set([
  "package.json", "tsconfig.json", "dockerfile", "makefile", "gnumakefile",
  ".gitignore", ".editorconfig", ".env", "docker-compose.yml", "vite.config.ts",
  "tailwind.config.js", "postcss.config.js", ".prettierrc", ".eslintrc",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "gemfile", "rakefile",
  "procfile", "cmakelists.txt",
]);

const LANG_MAP: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
  mjs: "JavaScript", cjs: "JavaScript", py: "Python", pyw: "Python",
  rb: "Ruby", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin",
  c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", cs: "C#",
  swift: "Swift", php: "PHP", html: "HTML", htm: "HTML",
  css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
  vue: "Vue", svelte: "Svelte", json: "JSON", yaml: "YAML", yml: "YAML",
  toml: "TOML", xml: "XML", md: "Markdown", mdx: "Markdown",
  sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell",
  ps1: "PowerShell", lua: "Lua", r: "R", scala: "Scala",
  dart: "Dart", zig: "Zig", nim: "Nim",
  ex: "Elixir", exs: "Elixir", erl: "Erlang", hs: "Haskell",
  clj: "Clojure", cljs: "Clojure", elm: "Elm",
  tf: "Terraform", gradle: "Gradle", proto: "Protobuf",
  graphql: "GraphQL", gql: "GraphQL",
  ini: "INI", cfg: "INI", conf: "INI",
  lock: "Lockfile", log: "Log", gitignore: "Git",
};

function detectLang(name: string): string {
  const ext = extname(name).toLowerCase().slice(1);
  if (LANG_MAP[ext]) return LANG_MAP[ext];
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "Dockerfile";
  if (lower === "makefile") return "Makefile";
  if (lower.startsWith(".env")) return "Env";
  return "Unknown";
}

function isCodeFile(name: string): boolean {
  const ext = extname(name).toLowerCase().slice(1);
  if (!ext) return false;
  if (BINARY_EXTS.has(ext)) return false;
  const lang = detectLang(name);
  return lang !== "Unknown" || false;
}

function walkDir(dirPath: string, basePath: string): any[] {
  const results: any[] = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const relPath = relative(basePath, fullPath);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        results.push(...walkDir(fullPath, basePath));
      } else if (entry.isFile()) {
        try {
          const stats = statSync(fullPath);
          const isAsset = ASSET_EXTS.has(extname(entry.name).toLowerCase().slice(1));
          const isConfig = CONFIG_NAMES.has(entry.name.toLowerCase()) ||
            entry.name.toLowerCase().startsWith(".git") ||
            entry.name.toLowerCase().endsWith(".lock");
          const isCode = !isAsset && !isConfig && isCodeFile(entry.name);
          let lines = 0, blankLines = 0;
          if (isCode && stats.size < 2 * 1024 * 1024) {
            try {
              const content = readFileSync(fullPath, "utf-8");
              const allLines = content.split("\n");
              lines = allLines.length;
              blankLines = allLines.filter(l => l.trim() === "").length;
            } catch {}
          }
          results.push({
            path: relPath,
            name: entry.name,
            extension: extname(entry.name).toLowerCase().slice(1) || "—",
            lang: detectLang(entry.name),
            lines,
            blankLines,
            codeLines: lines - blankLines,
            size: stats.size,
            category: isAsset ? "asset" : isConfig ? "config" : isCode ? "code" : "other",
          });
        } catch {}
      }
    }
  } catch {}
  return results;
}

// POST /api/cbm/code-stats — scan a project directory and return code stats
router.post("/code-stats", (req: Request, res: Response) => {
  try {
    const { path: projectPath } = req.body as { path?: string };
    if (!projectPath) return res.status(400).json({ error: "path is required" });

    // Sécurité : ne scanner que des chemins explicitement autorisés.
    // isPathAllowed résout les liens symboliques avant de comparer aux racines.
    const resolved = resolve(projectPath);
    if (!isPathAllowed(resolved)) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!existsSync(resolved)) return res.status(404).json({ error: "Path not found" });

    // Parcourir le chemin réel (et non le chemin lexical) pour éviter qu'un
    // symlink racine ne soit suivi vers un emplacement hors racine autorisée.
    const realRoot = realpathSync(resolved);
    const start = Date.now();
    const files = walkDir(realRoot, realRoot);

    // Group by language (code only)
    const langStats: Record<string, { files: number; lines: number; blank: number; codeLines: number }> = {};
    files.filter(f => f.category === "code").forEach(f => {
      if (!langStats[f.lang]) langStats[f.lang] = { files: 0, lines: 0, blank: 0, codeLines: 0 };
      langStats[f.lang].files++;
      langStats[f.lang].lines += f.lines;
      langStats[f.lang].blank += f.blankLines;
      langStats[f.lang].codeLines += f.codeLines;
    });

    const codeFiles = files.filter(f => f.category === "code");
    const assetFiles = files.filter(f => f.category === "asset");
    const configFiles = files.filter(f => f.category === "config");

    res.json({
      totalCodeFiles: codeFiles.length,
      totalLines: codeFiles.reduce((s, f) => s + f.lines, 0),
      totalCodeLines: codeFiles.reduce((s, f) => s + f.codeLines, 0),
      totalBlank: codeFiles.reduce((s, f) => s + f.blankLines, 0),
      totalSize: files.reduce((s, f) => s + f.size, 0),
      langStats: Object.entries(langStats)
        .sort(([, a], [, b]) => b.lines - a.lines)
        .map(([lang, stats]) => ({ lang, ...stats })),
      topFiles: codeFiles
        .sort((a, b) => b.lines - a.lines)
        .slice(0, 15)
        .map(f => ({ path: f.path, name: f.name, lang: f.lang, lines: f.lines, size: f.size })),
      files: files.map(f => ({
        path: f.path, name: f.name, extension: f.extension,
        lang: f.lang, lines: f.lines, size: f.size, category: f.category,
      })),
      excludedDirs: [...EXCLUDED_DIRS],
      scanTimeMs: Date.now() - start,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;