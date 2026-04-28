import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(homedir(), ".pi", "agent");

// Our own config
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const OLLAMA_CONFIG_FILE = path.join(DATA_DIR, "ollama-config.json");

export interface OllamaConfig {
  url: string;
  enabled: boolean;
}

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
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
  return { url: "http://172.17.0.1:11434", enabled: false };
}

export function saveOllamaConfig(config: OllamaConfig): void {
  ensureDataDir();
  writeFileSync(OLLAMA_CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function fetchOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${cleanUrl}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = (await response.json()) as { models: OllamaModel[] };
  return data.models || [];
}

export function writeOllamaModelsJson(
  models: OllamaModel[],
  baseUrl: string
): void {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const ollamaModels = models.map((m) => {
    // Determine if model likely supports vision
    const isVision = /llava|bakllava|moondream|minicpm|gemma.*vision/i.test(m.name);
    const isReasoning = /deepseek.*r1|qwen.*qwq|openthinker/i.test(m.name);

    return {
      id: m.name,
      name: `${m.name} (Ollama)`,
      reasoning: isReasoning,
      input: isVision ? ["text", "image"] : ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });

  const modelsJson = {
    providers: {
      ollama: {
        baseUrl: `${cleanUrl}/v1`,
        api: "openai-completions",
        apiKey: "ollama",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: ollamaModels,
      },
    },
  };

  if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(
    path.join(AGENT_DIR, "models.json"),
    JSON.stringify(modelsJson, null, 2)
  );
}
