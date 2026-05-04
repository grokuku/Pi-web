import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import type { ProviderConfig, ProviderType } from "./providers.js";
import type { RegisteredModel, ModelLibrary } from "./model-library.js";

const MODELS_JSON_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
const DATA_DIR = path.join(process.cwd(), ".data");

// ── Provider type → Pi API type mapping ──────────────

const API_TYPE_MAP: Record<ProviderType, string> = {
  ollama: "openai-completions",
  "openai-compatible": "openai-completions",
  anthropic: "anthropic",
  google: "google",
};

// ── Write models.json for Pi SDK ──────────────────────

export async function writeModelsJson(
  providers: ProviderConfig[],
  library: ModelLibrary
): Promise<void> {
  // Group models by provider
  const modelsByProvider = new Map<string, RegisteredModel[]>();
  for (const model of library.models) {
    if (!modelsByProvider.has(model.providerId)) {
      modelsByProvider.set(model.providerId, []);
    }
    modelsByProvider.get(model.providerId)!.push(model);
  }

  // Build Pi SDK models.json format
  const providerEntries: Record<string, any> = {};

  for (const provider of providers) {
    const models = modelsByProvider.get(provider.id) || [];
    if (models.length === 0 && provider.type !== "ollama") continue; // Skip providers with no models (except Ollama for discovery)

    const preset = getProviderPreset(provider.type);
    const apiKey = provider.apiKey || (provider.type === "ollama" ? "ollama" : undefined);
    const apiType = API_TYPE_MAP[provider.type] || "openai-completions";

    const piProvider: any = {
      baseUrl: provider.baseUrl || preset.defaultBaseUrl,
      api: apiType,
    };

    if (apiKey) {
      piProvider.apiKey = apiKey;
    }

    if (models.length > 0) {
      piProvider.models = models.map((m) => ({
        id: m.modelId,
        name: `${m.name} (${provider.name})`,
        reasoning: m.reasoning,
        input: ["text", ...(m.reasoning ? ["text"] : [])],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));
    }

    // Use the provider ID as the Pi provider name
    // This ensures our internal IDs match what Pi SDK expects
    providerEntries[provider.id] = piProvider;
  }

  // Read existing models.json to preserve non-managed providers
  let existing: any = {};
  try {
    if (existsSync(MODELS_JSON_PATH)) {
      existing = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf-8"));
    }
  } catch {}

  // Merge: replace providers we manage, keep others
  const existingProviders = existing?.providers || {};
  const managedProviderIds = new Set(providers.map((p) => p.id));

  const mergedProviders = {
    ...existingProviders,
    // Remove any providers that were previously managed but are now deleted
  };

  // Remove deleted providers
  for (const key of Object.keys(mergedProviders)) {
    // Check if this key looks like one of our managed provider IDs
    if (key.startsWith("provider_")) {
      if (!managedProviderIds.has(key)) {
        delete mergedProviders[key];
      }
    }
  }

  // Add/update managed providers
  for (const [id, entry] of Object.entries(providerEntries)) {
    mergedProviders[id] = entry;
  }

  const output = { providers: mergedProviders };

  // Ensure directory exists
  const dir = path.dirname(MODELS_JSON_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(MODELS_JSON_PATH, JSON.stringify(output, null, 2));
  console.log(`[sync] Wrote ${Object.keys(mergedProviders).length} providers to models.json`);
}

// ── Helper ─────────────────────────────────────────────

interface ProviderPreset {
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  apiType: string;
}

const PRESETS: Record<string, ProviderPreset> = {
  ollama: { defaultBaseUrl: "http://localhost:11434/v1", requiresApiKey: false, apiType: "openai-completions" },
  "openai-compatible": { defaultBaseUrl: "https://api.openai.com/v1", requiresApiKey: true, apiType: "openai-completions" },
  anthropic: { defaultBaseUrl: "https://api.anthropic.com", requiresApiKey: true, apiType: "anthropic" },
  google: { defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", requiresApiKey: true, apiType: "google" },
};

function getProviderPreset(type: string): ProviderPreset {
  return PRESETS[type] || PRESETS["openai-compatible"];
}