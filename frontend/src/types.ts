export interface Project {
  id: string;
  name: string;
  type: "local" | "ssh" | "smb";
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
    lastSync: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PiEvent {
  type: string;
  [key: string]: any;
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
