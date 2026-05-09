// ── Project ──────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  storage: "local" | "ssh" | "smb";
  versioning: "git" | "standalone";
  cwd: string;
  ssh?: {
    host: string;
    port: number;
    username: string;
    keyPath?: string;
    remotePath: string;
  };
  smb?: {
    share: string;
    mountPoint: string;
    username?: string;
    password?: string;
    domain?: string;
  };
  git?: {
    remote: string;
    branch: string;
    provider?: "github" | "gitlab" | "other";
    autoSync?: boolean;
    lastSync: string | null;
  };
  // Session persistence
  lastSessionId?: string;
  lastActiveAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Events ────────────────────────────────────────────

export interface PiEvent {
  type: string;
  [key: string]: any;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  category: "image" | "text" | "audio" | "binary";
  data: string; // base64 for images/binary, text content for text/code
  preview?: string; // data URL for images, first lines for text
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  thinking?: string;
  images?: { data: string; mimeType: string }[];
  usage?: {
    input: number;
    output: number;
    cost: { total: number };
  };
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  toolCalls: ToolCallInfo[];
  timestamp: number;
  usage?: {
    input: number;
    output: number;
    cost: { total: number };
  };
  // Custom message metadata (for git_notification, etc.)
  customType?: string;
  display?: boolean;
  // Images attached to user message
  images?: { data: string; mimeType: string }[];
  // Text/code files attached to user message
  attachments?: { name: string; content: string; mimeType: string }[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  args: any;
  output: string;
  isError: boolean;
  isStreaming: boolean;
}

// ── Providers ─────────────────────────────────────────

export type ProviderType = "ollama" | "openai-compatible" | "anthropic" | "google";

export interface ProviderConfig {
  id: string;
  name: string;           // custom display name
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  discoveredModels?: DiscoveredModel[];
  connectionStatus?: "ok" | "error" | "untested";
  connectionError?: string;
  lastTestedAt?: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  size?: number;
  quantization?: string;
  family?: string;
}

export const PROVIDER_PRESETS: Record<ProviderType, {
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  description: string;
}> = {
  ollama: {
    defaultBaseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    description: "Local/self-hosted Ollama server",
  },
  "openai-compatible": {
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    description: "OpenAI-compatible API (DeepSeek, Groq, etc.)",
  },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com",
    requiresApiKey: true,
    description: "Anthropic Claude API",
  },
  google: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requiresApiKey: true,
    description: "Google Gemini API",
  },
};

// ── Model Library ─────────────────────────────────────

export type AgentMode = "code" | "review" | "plan";

export interface RegisteredModel {
  id: string;                  // unique internal ID
  providerId: string;          // references ProviderConfig.id
  modelId: string;             // the model's id on the provider
  name: string;                // display name
  isDefault: boolean;          // default model for modes without a specific model
  reasoning: boolean;
  vision: boolean;             // supports image/vision input
  contextWindow: number;       // tokens
  maxTokens: number;           // max output tokens
  // Inference parameters
  temperature?: number;        // 0-2
  topP?: number;               // 0-1
  minP?: number;               // 0-1
  topK?: number;               // 1-100
  repeatPenalty?: number;      // 1-2
  // Thinking
  thinkingLevel: string;       // off, minimal, low, medium, high
}

export interface ModeConfig {
  modelId: string | null;     // RegisteredModel.id to use for this mode (null = default)
}

export interface ProjectModeConfig {
  code: ModeConfig;
  plan: ModeConfig & { enabled: boolean };
  review: ModeConfig & { enabled: boolean; maxReviews: number };
}

export interface ModelLibrary {
  models: RegisteredModel[];
  defaultModelId: string | null;
  commitModelId: string | null;
  projectModes: Record<string, ProjectModeConfig>;  // projectId → mode config
}

// ── Layout ─────────────────────────────────────────────

export type LayoutType =
  | "single"           // 1 panel: PI only
  | "horizontal-2"     // 2 panels: side by side
  | "vertical-2"       // 2 panels: stacked
  | "horizontal-3"     // 3 panels: side by side
  | "vertical-3"       // 3 panels: stacked
  | "top-2-bottom-1"   // 2 top, 1 bottom
  | "top-1-bottom-2"   // 1 top, 2 bottom
  | "left-2-right-1"   // 2 left (stacked), 1 right
  | "left-1-right-2";  // 1 left, 2 right (stacked)

export type PanelId = "pi" | "terminal" | "files";

export interface LayoutConfig {
  type: LayoutType;
  slots: PanelId[];    // which panel in each position (length = 2 or 3)
  sizes: number[];     // fractional sizes (e.g., [0.5, 0.5] or [0.33, 0.33, 0.34])
}

export const DEFAULT_LAYOUTS: Record<string, LayoutConfig> = {
  "horizontal-2":   { type: "horizontal-2",   slots: ["pi", "terminal"], sizes: [0.6, 0.4] },
  "vertical-2":     { type: "vertical-2",     slots: ["pi", "terminal"], sizes: [0.6, 0.4] },
  "horizontal-3":   { type: "horizontal-3",   slots: ["pi", "terminal", "files"], sizes: [0.4, 0.3, 0.3] },
  "vertical-3":     { type: "vertical-3",     slots: ["pi", "terminal", "files"], sizes: [0.4, 0.3, 0.3] },
  "top-2-bottom-1": { type: "top-2-bottom-1", slots: ["pi", "terminal", "files"], sizes: [0.5, 0.5, 0.5] },
  "top-1-bottom-2": { type: "top-1-bottom-2", slots: ["pi", "terminal", "files"], sizes: [0.5, 0.5, 0.5] },
  "left-2-right-1": { type: "left-2-right-1", slots: ["pi", "terminal", "files"], sizes: [0.5, 0.5, 0.5] },
  "left-1-right-2": { type: "left-1-right-2", slots: ["pi", "terminal", "files"], sizes: [0.5, 0.5, 0.5] },
};