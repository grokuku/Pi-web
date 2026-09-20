// ── Project ──────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  storage: "local" | "ssh" | "smb" | "linked";
  versioning: "git" | "standalone";
  cwd: string;
  // Projet LIÉ (storage === "linked") : ids des sous-projets regroupés
  // via un placeholder avec symlinks (1 niveau, locaux/SMB uniquement).
  linkedProjectIds?: string[];
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

// ── Activité en cours (StatusBar) ─────────────────────
// Décrit CE QUE l'agent fait pendant un run (dérivé des événements pi_event).
// - routing : une fonction de routage tourne (planning/execute/review/integrate)
// - thinking : le LLM réfléchit (thinking_delta)
// - tool     : un outil est exécuté (tool_execution_start hors delegate)
// - generating : le LLM produit la réponse visible (text_delta)
export type Activity =
  | { type: "routing"; routingFunction?: RoutingFunction }
  | { type: "thinking" }
  | { type: "tool"; toolName?: string }
  | { type: "generating" };

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

// ── LOT 3 : blocs de timeline de l'historique ─────────────────────────────
// Certaines entrées de l'historique pi étaient auparavant mal placées ou
// fusionnées (résultats d'outils orphelins, exécutions bash rendues en bulle
// utilisateur, compactions rendues en message assistant avec résumé dans la
// réflexion). Elles deviennent des DisplayMessage autonomes, rendus À LEUR
// DATE via un `kind` dédié (le regroupement des assistants reste inchangé).
// `role` reste "assistant" (ce ne sont pas des messages utilisateur) mais le
// `kind` les isole en groupes propres dans GroupedMessages.
export type DisplayMessageKind = "toolResult" | "bashExecution" | "compaction";

/** Exécution bash (entrée d'historique `bashExecution`). */
export interface BashExecutionInfo {
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
}

/** Compaction de conversation (entrée d'historique `compactionSummary`). */
export interface CompactionInfo {
  summary: string;
  /** Tokens présents dans le contexte AVANT compaction (libérés par celle-ci). */
  tokensBefore?: number;
}

// ── Ordre chronologique réel des blocs d'un message assistant ─────────────
// Le SDK Pi expose le contenu d'un message assistant comme un tableau ORDONNÉ
// de blocs (text / thinking / toolCall) : c'est l'ordre réel d'écriture (ex.
// texte → appel d'outil → texte). Le DisplayMessage historiquement APLATIT ces
// blocs (content: string, thinking: string, toolCalls[]) — l'ordre inter-types
// était donc perdu et le rendu regroupait par TYPE (réflexion → outils →
// texte), ce qui affichait un appel d'outil AVANT le texte qui l'a précédé.
// `blocks` préserve cette chronologie ; il est optionnel (les caches/historiques
// antérieurs en sont dépourvus → repli sur le rendu par type).
export type AssistantBlock =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "toolCall"; toolCallId: string };

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  toolCalls: ToolCallInfo[];
  /** Ordre chronologique réel des blocs (assistant uniquement, si connu). */
  blocks?: AssistantBlock[];
  timestamp: number;
  // ── LOT 3 : timeline historique (bloc autonome si `kind` est défini) ──
  kind?: DisplayMessageKind;
  /** Résultat d'outil orphelin (non rattaché à un toolCall de groupe). */
  toolResult?: ToolCallInfo;
  /** Exécution bash hors groupe (commande + sortie complète + statut). */
  bashExecution?: BashExecutionInfo;
  /** Compaction de conversation (résumé + tokens libérés). */
  compaction?: CompactionInfo;
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
  // Message injecté par le système (ex. web_screenshot via inject-to-chat) —
  // rendu à gauche avec un style système distinct, pas en bulle utilisateur.
  injected?: boolean;
  // Lot C : timing de la réflexion — sert à l'auto-repli du ThinkingBlock
  // quand la réponse commence à arriver (info consommée) et à l'affichage
  // de la durée de réflexion dans l'en-tête replié.
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
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
  // Timestamp (ms) de début du tool call — sert au chrono de streaming
  // (ToolCallTimer) et à l'aperçu d'output dépliable dans ChatView.
  startedAt?: number;
  // LOT 1 : timestamp (ms) de fin (tool_execution_end) — sert à figer la durée
  // dans les résumés d'outils (en historique, absent → durée omise).
  endedAt?: number;
  // LOT 1 : details du toolResult (diff de l'edit, truncation read/bash…),
  // utilisés par les résumés d'outils (utils/toolSummaries.ts).
  details?: any;
}

// ── Sous-agent (LOT 2) ────────────────────────────────────────────────────
// Décrit une exécution déléguée via le tool `delegate` (harness-orchestrator).
// LOT 1 : le bloc dérivait du toolCall seul (args.function + aperçu
// buildProgressText dans output). LOT 2 : les événements de streaming réels du
// sous-agent (canal WS pi_event, enveloppes {type:"subagent", …}) alimentent
// ce run via le store isolé frontend/src/stores/subagentRuns.ts — jamais le
// tableau `messages` (sinon le fil re-rend à chaque event).

/** Statut d'affichage d'un run (vue synthétique). */
export type SubAgentRunStatus = "running" | "done" | "failed";

/** Statut de fin de vie émis par subagent_end (spec LOT 2a). */
export type SubAgentEndStatus =
  | "success"
  | "error"
  | "timeout-inactivity"
  | "timeout-global"
  | "aborted";

/** Action d'outil du sous-agent (live : alimentée par les events tool_*). */
export interface SubAgentAction {
  /** Numéro séquentiel (1..N) — ordre chronologique. */
  seq: number;
  /** Id du tool call du sous-agent (rattache les updates/ends). */
  toolCallId?: string;
  toolName: string;
  /** Résumé court des arguments (chemin, commande, pattern…). */
  argSummary: string;
  /** Résumé final (« 42 lignes », « exit 0 »…) — vide tant que l'outil tourne. */
  summary: string;
  durationMs?: number;
  isError: boolean;
  outputChars?: number;
  truncated?: boolean;
  /** Output courant (live, déjà tronqué côté backend ≤2000 chars). */
  output?: string;
  /** Args bruts (live uniquement — sert au résumé final, non persisté). */
  args?: any;
  startedAt?: number;
  endedAt?: number;
}

/** Message assistant tronqué du sous-agent (subagent message_end). */
export interface SubAgentRunMessage {
  id?: string;
  /** Texte de réponse (≤4000 chars). */
  text?: string;
  /** Réflexion (≤1000 chars). */
  thinking?: string;
  textTruncated?: boolean;
  thinkingTruncated?: boolean;
  usage?: { input: number; output: number; cost: { total: number } };
  timestamp: number;
}

/** Résumé final d'un run (subagent_end / activité persistée). */
export interface SubAgentEndInfo {
  status: SubAgentEndStatus;
  attemptsMade: number;
  durationMs: number;
  actionCount: number;
  eventCount: number;
  thinkingChars: number;
  model: string;
  cause: string | null;
  errorMessage: string | null;
  responsePreview: string;
  droppedEvents: number;
}

export interface SubAgentRun {
  id: string;
  /** Fonction de routage déléguée (planning / execute / review / integrate). */
  function: string;
  /** Libellé humain (« Exécution », …). */
  label: string;
  /** Extrait de la tâche transmise au sous-agent. */
  task: string;
  /** Modèle résolu pour le sous-agent, si connu. */
  modelId?: string;
  /** Statut d'affichage. */
  status: SubAgentRunStatus;
  /** Timestamp de démarrage (live). */
  startedAt?: number;
  /** Timestamp de fin (live). */
  endedAt?: number;
  isError: boolean;
  /** Tentative en cours (1..2). */
  attempt: number;
  /** Actions d'outils (live, ordre chronologique). */
  actions: SubAgentAction[];
  /** Messages assistant du sous-agent (texte/réflexion tronqués). */
  messages: SubAgentRunMessage[];
  /** Aperçu d'activité courant (dernier output d'outil, live). */
  currentOutput?: string;
  /** Résumé final (subagent_end) — absent tant que le run tourne. */
  end?: SubAgentEndInfo;
  /** Run reconstruit depuis une entrée persistée subagent_activity (historique). */
  archived?: boolean;
  /** Tool call `delegate` rattaché (résolu par le store, absent = orphelin). */
  toolCallId?: string;
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
  vision: boolean;             // supports image/vision input (inféré — voir overrides)
  audio?: boolean;             // supports audio input (inféré)
  contextWindow: number;       // tokens
  maxTokens: number;           // max output tokens
  thinkingLevel: string;       // off, minimal, low, medium, high

  // Overrides manuels (UI) : prime sur la détection "auto"
  visionOverride?: "auto" | "yes" | "no";
  audioOverride?: "auto" | "yes" | "no";
}

/** Capacité résolue : override manuel d'abord, champ inféré sinon. */
export function resolveModelCapability(
  m: RegisteredModel,
  cap: "vision" | "audio"
): boolean {
  if (cap === "vision") {
    if (m.visionOverride === "yes") return true;
    if (m.visionOverride === "no") return false;
    return m.vision === true;
  }
  if (cap === "audio") {
    if (m.audioOverride === "yes") return true;
    if (m.audioOverride === "no") return false;
    return m.audio === true;
  }
  return false;
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