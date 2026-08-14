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
  category: "image" | "text" | "audio" | "video" | "pdf" | "binary";
  data: string; // base64 for images/binary, text content for text/code
  preview?: string; // data URL for images, first lines for text
  // Server-side attachment ID (after upload)
  attachmentId?: string;
  // Upload status
  uploadStatus?: "pending" | "uploading" | "done" | "error";
  uploadError?: string;
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
  _streaming?: boolean;
  usage?: {
    input: number;
    output: number;
    cost: { total: number };
  };
  // Custom message metadata (for git_notification, etc.)
  customType?: string;
  display?: boolean;
  // BUG-68 : métadonnées d'échec du turn LLM (stopReason:"error" + errorMessage)
  // Permettent d'afficher une bannière d'erreur au lieu d'un message vide.
  stopReason?: string;
  errorMessage?: string;
  // Images attached to user message (server URLs or inline base64 for legacy messages)
  images?: { attachmentId?: string; data?: string; name: string; mimeType: string }[];
  // Text/code files attached to user message (legacy, kept for old messages)
  attachments?: { name: string; content: string; mimeType: string }[];
  // Attachment references (uploaded file IDs)
  attachmentRefs?: { id: string; name: string; category: string; size: number }[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  args: any;
  output: string;
  isError: boolean;
  isStreaming: boolean;
  startTime?: number;
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
  /** Detected from provider API – takes precedence over heuristics */
  contextWindow?: number;
  reasoning?: boolean;
  vision?: boolean;
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

export type AgentMode = "code" | "harness";

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
  thinkingLevel: string;       // off, minimal, low, medium, high
}

export interface ModeConfig {
  modelId: string | null;     // RegisteredModel.id to use for this mode (null = default)
}

// ── Harness types ────────────────────────────────────

export interface HarnessAgentConfig {
  role: string;
  description: string;          // what this agent specializes in
  modelId: string | null;
  enabled: boolean;
  systemPrompt?: string;
  tools?: string[];
}

export interface HarnessConfig {
  agents: HarnessAgentConfig[];
  synthesize: boolean;
  agentTimeout?: number;       // per-agent timeout in seconds (default: 300)
  maxTasks?: number;           // safety limit (default: 20)
}

// ── Routing types (R6) ─────────────────────────────────
// Alignés sur backend/src/pi/routing-types.ts. Le routage remplace
// la liste d'experts HARNESS par 4 catégories configurables.

export type RoutingFunction = "planning" | "execute" | "review" | "integrate";

export type TaskCategory = "trivial" | "standard" | "complex" | "review";

export interface CategoryConfig {
  modelId: string | null;
}

export interface RoutingConfig {
  /** Active/désactive le routage (false = mode basic sans triage). */
  enabled: boolean;
  trivial: CategoryConfig;
  standard: CategoryConfig;
  complex: CategoryConfig;
  review: CategoryConfig;
  /** riskScore >= ce seuil force la catégorie review. */
  reviewRiskThreshold: number;
  /** Confiance minimale pour accepter une décision (sinon repli standard/execute). */
  confidenceThreshold: number;
  /** Modèle cheap optionnel pour le classifieur LLM (null = off). */
  classifierModelId: string | null;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: true,
  trivial: { modelId: null },
  standard: { modelId: null },
  complex: { modelId: null },
  review: { modelId: null },
  reviewRiskThreshold: 0.5,
  confidenceThreshold: 0.6,
  classifierModelId: null,
};

export interface ProjectModeConfig {
  code: ModeConfig;
  harness: ModeConfig & { enabled: boolean; config: HarnessConfig; routing?: RoutingConfig };
}

export interface ModelLibrary {
  models: RegisteredModel[];
  defaultModelId: string | null;
  commitModelId: string | null;
  visionModelId: string | null;     // model for image analysis fallback
  audioModelId: string | null;      // model for audio transcription
  librarianModelId: string | null;   // model for librarian doc synthesis
  projectModes: Record<string, ProjectModeConfig>;  // projectId → mode config
}

// ── Layout ─────────────────────────────────────────────

export type LayoutType =
  | "single"
  | "horizontal-2" | "vertical-2"
  | "horizontal-3" | "vertical-3"
  | "top-2-bottom-1" | "top-1-bottom-2"
  | "left-2-right-1" | "left-1-right-2";

export type PanelId = "pi" | "terminal" | "files";

export interface LayoutConfig {
  layout2: "horizontal-2" | "vertical-2";
  layout3: LayoutType & ("horizontal-3" | "vertical-3" | "top-2-bottom-1" | "top-1-bottom-2" | "left-2-right-1" | "left-1-right-2");
  slotOrder: PanelId[];               // ["pi", "terminal", "files"] — order of panels in slots
  sizes: Record<string, number[]>;    // per-layout-type sizes (e.g. { "horizontal-2": [0.6,0.4] })
}

export const PANEL_LABELS: Record<PanelId, string> = {
  pi: "PI (Chat)",
  terminal: "Terminal",
  files: "Files",
};

// ── Design Tool Types ──────────────────────────────────────
export interface DesignTypography {
  fontFamily: string;
  headings: Record<string, { fontSize: string; fontWeight: string; lineHeight: string }>;
  body: { fontSize: string; fontWeight: string; lineHeight: string };
}

export interface DesignSystem {
  colors: Record<string, string>;
  typography: DesignTypography;
  spacing: number[];
  borderRadius: string;
  shadows: string[];
  tokens: DesignToken[];
}

export interface DesignToken {
  name: string;
  value: string;
  category: "color" | "font" | "spacing" | "border-radius" | "shadow";
  type?: string;
}

export interface DesignComponent {
  id: string;
  name: string;
  html: string;
  css?: string;
  tailwindClasses?: string[];
  thumbnail?: string;
  metadata: {
    version: number;
    createdAt: string;
    updatedAt: string;
  };
}

export interface DesignPage {
  id: string;
  name: string;
  html: string;
  css?: string;
  thumbnail?: string;
}

export interface DesignProject {
  id: string;
  name: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  designSystem: DesignSystem | null;
  components: DesignComponent[];
  pages: DesignPage[];
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  layout2: "horizontal-2",
  layout3: "horizontal-3",
  slotOrder: ["pi", "terminal", "files"],
  sizes: {},
};