import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Mutex } from "./utils/mutex.js";
import { inferReasoning, inferVision, inferContextWindow } from "./pi/providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(homedir(), ".pi", "agent");

// Our own config
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const OLLAMA_CONFIG_FILE = path.join(DATA_DIR, "ollama-config.json");
const modelsJsonMutex = new Mutex();

export interface OllamaConfig {
  url: string;
  enabled: boolean;
}

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

export interface OllamaModelDetails {
  modelfile?: string;
  parameters?: string;
  template?: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    parent_model?: string;
    format?: string;
  };
  model_info?: Record<string, any>;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function getOllamaConfig(): OllamaConfig {
  try {
    ensureDataDir();
    if (existsSync(OLLAMA_CONFIG_FILE)) {
      return JSON.parse(readFileSync(OLLAMA_CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return { url: process.env.OLLAMA_URL || "http://host.docker.internal:11434", enabled: false };
}

export function saveOllamaConfig(config: OllamaConfig): void {
  ensureDataDir();
  writeFileSync(OLLAMA_CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function fetchOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${cleanUrl}/api/tags`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = (await response.json()) as { models: OllamaModel[] };
  return data.models || [];
}

/** Fetch model details from Ollama /api/show */
export async function fetchOllamaModelDetails(baseUrl: string, name: string): Promise<OllamaModelDetails | null> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${cleanUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error(`[Ollama] /api/show failed for ${name}: ${response.status}`);
      return null;
    }
    const data = (await response.json()) as OllamaModelDetails;
    return data;
  } catch (e: any) {
    console.error(`[Ollama] /api/show error for ${name}: ${e.message}`);
    return null;
  }
}

/** Extract context window (num_ctx) from Ollama show parameters */
export function extractContextWindow(details: OllamaModelDetails | null): number | null {
  if (!details?.parameters) return null;
  // Ollama model file parameters are plain text key-value pairs:
  // num_ctx 256000
  const match = details.parameters.match(/num_ctx\s+(\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

export async function writeOllamaModelsJson(
  models: OllamaModel[],
  baseUrl: string
): Promise<void> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");

  // Fetch model details in parallel (with concurrency limit to avoid hammering Ollama)
  const detailsMap = new Map<string, OllamaModelDetails | null>();
  const concurrencyLimit = 5;

  for (let i = 0; i < models.length; i += concurrencyLimit) {
    const batch = models.slice(i, i + concurrencyLimit);
    const results = await Promise.all(
      batch.map(async (m) => {
        const d = await fetchOllamaModelDetails(cleanUrl, m.name);
        return { name: m.name, details: d };
      })
    );
    for (const r of results) {
      detailsMap.set(r.name, r.details);
    }
  }

  const ollamaModels = models.map((m) => {
    const details = detailsMap.get(m.name) ?? null;
    let contextWindow = extractContextWindow(details);
    if (contextWindow === null) {
      // Fallback: try to infer from model family or name
      contextWindow = inferContextWindow(m.name);
    }
    // Sanity check: if extracted num_ctx is obviously too small (e.g. num_ctx 2048 is
    // the runner context, not the model's total context), override with inference.
    // Ollama sometimes stores the runner parameter which is lower than the model's actual
    // supported context window. Keep anything >= 32K as-is; for smaller values trust inference.
    if (contextWindow < 32000) {
      const inferred = inferContextWindow(m.name);
      if (inferred > contextWindow) contextWindow = inferred;
    }

    return {
      id: m.name,
      name: `${m.name} (Ollama)`,
      reasoning: inferReasoning(m.name),
      input: inferVision(m.name) ? ["text", "image" as const] : ["text"],
      contextWindow,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });

  // Load existing models.json and merge
  const existingPath = path.join(AGENT_DIR, "models.json");
  let existing: any = { providers: {} };
  if (existsSync(existingPath)) {
    try { existing = JSON.parse(readFileSync(existingPath, "utf-8")); } catch {}
  }

  // Merge: keep existing providers, upsert ollama
  existing.providers = existing.providers || {};
  existing.providers.ollama = {
    baseUrl: `${cleanUrl}/v1`,
    api: "openai-completions",
    apiKey: "ollama",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    models: ollamaModels,
  };

  if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
  await modelsJsonMutex.run(() => {
    writeFileSync(existingPath, JSON.stringify(existing, null, 2));
  });
}
