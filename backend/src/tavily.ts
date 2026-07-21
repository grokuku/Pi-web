import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", ".data");
const TAVILY_CONFIG_FILE = path.join(DATA_DIR, "tavily-config.json");

export interface TavilyConfig {
  apiKey: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function getTavilyConfig(): TavilyConfig {
  try {
    ensureDataDir();
    if (existsSync(TAVILY_CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(TAVILY_CONFIG_FILE, "utf-8"));
      return { apiKey: data.apiKey ?? "" };
    }
  } catch (e) {
    console.error("[tavily] Failed to load config:", e);
  }
  return { apiKey: "" };
}

export function setTavilyConfig(config: Partial<TavilyConfig>): TavilyConfig {
  ensureDataDir();
  const current = getTavilyConfig();
  const next: TavilyConfig = {
    apiKey: config.apiKey !== undefined ? config.apiKey : current.apiKey,
  };
  writeFileSync(TAVILY_CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}