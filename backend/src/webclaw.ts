import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const WEBCLAW_CONFIG_FILE = path.join(DATA_DIR, "webclaw-config.json");

// ── Types ──────────────────────────────────────────────

export interface WebclawConfig {
  url: string;
  apiKey: string;
}

// ── Persistence ────────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function getWebclawConfig(): WebclawConfig {
  try {
    ensureDataDir();
    if (existsSync(WEBCLAW_CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(WEBCLAW_CONFIG_FILE, "utf-8"));
      return {
        url: data.url || process.env.WEBCLAW_URL || "http://localhost:3001",
        apiKey: data.apiKey ?? process.env.WEBCLAW_API_KEY ?? "",
      };
    }
  } catch (e) {
    console.error("[webclaw] Failed to load config:", e);
  }
  return {
    url: process.env.WEBCLAW_URL || "http://localhost:3001",
    apiKey: process.env.WEBCLAW_API_KEY || "",
  };
}

export function setWebclawConfig(config: Partial<WebclawConfig>): WebclawConfig {
  ensureDataDir();
  const current = getWebclawConfig();
  const next: WebclawConfig = {
    url: config.url !== undefined ? config.url : current.url,
    apiKey: config.apiKey !== undefined ? config.apiKey : current.apiKey,
  };
  writeFileSync(WEBCLAW_CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}