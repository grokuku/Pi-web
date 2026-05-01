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
  images?: string[];
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
}

export interface ToolCallInfo {
  id: string;
  name: string;
  args: any;
  output: string;
  isError: boolean;
  isStreaming: boolean;
}

// ── Model Library ──────────────────────────────────────

export type AgentMode = "code" | "review" | "plan" | "commit";

export interface ModelEntry {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  thinkingLevel: string;
}

export interface ModeConfig {
  enabled: boolean;
  activeModelId: string | null;
  models: ModelEntry[];
  instructions: string;
  tools: string[];
  readOnly: boolean;
}

export interface ModelLibrary {
  modes: Record<AgentMode, ModeConfig>;
}