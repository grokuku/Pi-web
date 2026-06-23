import { Router, type Request, type Response } from "express";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import os from "os";

const router = Router();

const BIN_PATH = join(os.homedir(), ".local", "bin", "codebase-memory-mcp");

/**
 * Get the version of the installed codebase-memory-mcp binary.
 * Returns null if the binary is not installed or version can't be read.
 */
function getCbmVersion(): string | null {
  if (!existsSync(BIN_PATH)) return null;
  try {
    return execSync(`"${BIN_PATH}" version`, { timeout: 5000, encoding: "utf-8" }).trim();
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
      `curl -s -o /dev/null -w "%{http_code}" http://localhost:9749/ --max-time 1`,
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
    const version = getCbmVersion();
    const installed = version !== null;
    const running = installed ? isServerRunning() : false;
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

    // Download using the official install script
    const output = execSync(
      'curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash',
      { timeout: 120_000, encoding: "utf-8" }
    );

    const version = getCbmVersion();
    res.json({ success: true, version, output: output.slice(-500) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;