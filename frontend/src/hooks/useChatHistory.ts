import { useRef, useCallback, useEffect } from "react";
import type { DisplayMessage, ToolCallInfo } from "../types";

// ─────────────────────────────────────────────────────────────
// Per-project chat history store
//
// Maintains message arrays for each project independently.
// When the user switches projects, we save the current messages
// and restore the previously stored ones for the target project.
//
// Also handles converting pi_history messages from the backend
// (raw AgentMessage format) into DisplayMessage[] for ChatView.
// ─────────────────────────────────────────────────────────────

interface HistoryMessage {
  id?: string;
  role: string;
  content: any; // string or content block array
  thinking?: string;
  toolCalls?: any[];
  // ToolResult fields
  toolCallId?: string;
  toolName?: string;
  details?: any;
  // BashExecution fields
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  // CompactionSummary fields
  summary?: string;
  // Custom/BashExecution fields
  display?: boolean;
  timestamp?: number;
  // Usage
  usage?: { input?: number; output?: number; cost?: { total?: number } };
}

/**
 * Convert raw pi_history messages into DisplayMessage[].
 *
 * The backend sends messages in the AgentMessage format from the Pi SDK.
 * We need to transform them into flat DisplayMessages for the ChatView.
 *
 * AgentMessage can be:
 *   - UserMessage:     { role: "user", content: string | ContentBlock[], timestamp }
 *   - AssistantMessage: { role: "assistant", content: ContentBlock[], ... }
 *   - ToolResultMessage: { role: "toolResult", toolCallId, toolName, content, details }
 *   - Custom messages: { role: "bashExecution" | "custom" | ... }
 *
 * ChatView displays:
 *   - User messages:    role "user" with text content
 *   - Assistant messages: role "assistant" with text content + thinking + tool calls
 *   - Tool results are folded into the preceding assistant message's toolCalls[]
 */
export function convertHistoryToDisplayMessages(history: HistoryMessage[]): DisplayMessage[] {
  const displayMessages: DisplayMessage[] = [];
  let pendingToolResults: Map<string, ToolCallInfo> = new Map();

  // First pass: collect tool results keyed by toolCallId
  for (const msg of history) {
    if (msg.role === "toolResult") {
      const outputText = extractTextContent(msg.content);
      pendingToolResults.set(msg.toolCallId!, {
        id: msg.toolCallId!,
        name: msg.toolName || "unknown",
        args: {},
        output: outputText,
        isError: msg.details?.isError ?? false,
        isStreaming: false,
      });
    }
  }

  console.log(`[history] First pass: ${pendingToolResults.size} tool results collected`);

  // Second pass: build display messages
  let currentAssistantId: string | null = null;
  let totalToolCallsFound = 0;

  for (const msg of history) {
    // ── User messages ──
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractTextContent(msg.content);

      // Skip empty user messages
      if (!text.trim()) continue;

      displayMessages.push({
        id: msg.id || `user-${msg.timestamp || Date.now()}`,
        role: "user",
        content: text,
        thinking: "",
        toolCalls: [],
        timestamp: msg.timestamp || Date.now(),
      });
    }

    // ── Assistant messages ──
    else if (msg.role === "assistant") {
      currentAssistantId = msg.id || `asst-${msg.timestamp || Date.now()}`;

      const contentBlocks = Array.isArray(msg.content) ? msg.content : [];

      // Extract text content
      const text = contentBlocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text || "")
        .join("\n");

      // Extract thinking content
      const thinking = contentBlocks
        .filter((b: any) => b.type === "thinking")
        .map((b: any) => b.thinking || "")
        .join("\n");

      // Extract tool calls, merging with their results from pendingToolResults
      // Accept multiple block type names (SDK might store as "toolCall", "tool_use", or "function")
      const toolCalls: ToolCallInfo[] = [];
      for (const block of contentBlocks) {
        if (block.type === "toolCall" || block.type === "tool_use" || block.type === "function") {
          const toolResult = pendingToolResults.get(block.id);
          toolCalls.push({
            id: block.id,
            name: block.name || block.toolName || "unknown",
            args: block.arguments || block.input || block.args || {},
            output: toolResult?.output || "",
            isError: toolResult?.isError || false,
            isStreaming: false,
          });
          totalToolCallsFound++;
        }
      }

      // Debug: log block types when no tool calls found but we have content blocks
      if (toolCalls.length === 0 && contentBlocks.length > 0) {
        const types = contentBlocks.map((b: any) => b.type);
        console.log(`[history] Assistant msg has ${contentBlocks.length} blocks, types: ${types.join(", ")} — no toolCall/tool_use/function found`);
      }

      // Skip empty assistant messages (can happen during streaming)
      if (!text.trim() && !thinking.trim() && toolCalls.length === 0) continue;

      displayMessages.push({
        id: currentAssistantId,
        role: "assistant",
        content: text,
        thinking,
        toolCalls,
        timestamp: msg.timestamp || Date.now(),
        usage: msg.usage ? {
          input: msg.usage.input || 0,
          output: msg.usage.output || 0,
          cost: { total: msg.usage.cost?.total || 0 },
        } : undefined,
      });
    }

    // ── Bash execution messages ──
    // These show up as user-like messages in the UI with the command
    else if (msg.role === "bashExecution") {
      displayMessages.push({
        id: msg.id || `bash-${msg.timestamp || Date.now()}`,
        role: "user",
        content: `\`\`\`bash\n${msg.command || ""}\n\`\`\``,
        thinking: "",
        toolCalls: [],
        timestamp: msg.timestamp || Date.now(),
      });
    }

    // ── Compaction summary ──
    else if (msg.role === "compactionSummary") {
      displayMessages.push({
        id: msg.id || `compact-${msg.timestamp || Date.now()}`,
        role: "assistant",
        content: `*Conversation compacted. Summary available.*`,
        thinking: msg.summary || "",
        toolCalls: [],
        timestamp: msg.timestamp || Date.now(),
      });
    }

    // ── Custom messages ──
    else if (msg.role === "custom" && (msg as any).display !== false) {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractTextContent(msg.content as any);
      if (text.trim()) {
        displayMessages.push({
          id: msg.id || `custom-${msg.timestamp || Date.now()}`,
          role: "user",
          content: text,
          thinking: "",
          toolCalls: [],
          timestamp: msg.timestamp || Date.now(),
        });
      }
    }

    // ── ToolResult messages (standalone) ──
    // These are handled above via pendingToolResults, so we skip them here.
    // If a tool result has no associated assistant message (orphan), we show it inline.
    else if (msg.role === "toolResult") {
      // Orphan tool result (no matching toolCall in any assistant message)
      // Check if we already processed it via pendingToolResults
      if (pendingToolResults.has(msg.toolCallId!)) {
        // Already folded into an assistant message's toolCalls — skip
        continue;
      }
      // Otherwise, it's an orphan — show as assistant message
      const outputText = extractTextContent(msg.content);
      if (outputText.trim()) {
        displayMessages.push({
          id: msg.id || `tool-${msg.timestamp || Date.now()}`,
          role: "assistant",
          content: outputText,
          thinking: "",
          toolCalls: [{
            id: msg.toolCallId || "unknown",
            name: msg.toolName || "unknown",
            args: {},
            output: outputText,
            isError: (msg.details as any)?.isError ?? false,
            isStreaming: false,
          }],
          timestamp: msg.timestamp || Date.now(),
        });
      }
    }
  }

  console.log(`[history] Converted ${history.length} raw messages → ${displayMessages.length} display messages, ${totalToolCallsFound} tool calls found`);
  return displayMessages;
}

/**
 * Extract text from content blocks (handles both string and array formats).
 */
function extractTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text || "")
      .join("\n");
  }
  return "";
}

/**
 * Hook that manages per-project chat history persistence.
 *
 * - Stores messages per project in a Map
 * - On project switch: saves current messages, restores target project's messages
 * - On pi_history event: converts raw messages and sets them
 * - Returns current messages + setter + handlers
 */
export function useChatHistory(projectId: string) {
  // Global store: persists across project switches since it's a ref
  const storeRef = useRef<Map<string, DisplayMessage[]>>(new Map());

  // Get messages for current project
  const getMessages = useCallback((): DisplayMessage[] => {
    return storeRef.current.get(projectId) || [];
  }, [projectId]);

  // Save messages for current project
  const saveMessages = useCallback((messages: DisplayMessage[]) => {
    storeRef.current.set(projectId, messages);
  }, [projectId]);

  // Handle pi_history from backend — converts and sets all messages
  const handleHistory = useCallback((rawMessages: any[]) => {
    const displayMessages = convertHistoryToDisplayMessages(rawMessages);
    storeRef.current.set(projectId, displayMessages);
    return displayMessages;
  }, [projectId]);

  // Append a single message
  const appendMessage = useCallback((msg: DisplayMessage) => {
    const current = storeRef.current.get(projectId) || [];
    // Dedup by ID
    if (current.some((m) => m.id === msg.id)) return current;
    const updated = [...current, msg];
    storeRef.current.set(projectId, updated);
    return updated;
  }, [projectId]);

  // Replace last assistant message (for streaming updates)
  const replaceLastAssistant = useCallback((msg: DisplayMessage) => {
    const current = storeRef.current.get(projectId) || [];
    const lastIdx = current.length - 1;
    if (lastIdx >= 0 && current[lastIdx].role === "assistant" && current[lastIdx].id === msg.id) {
      const updated = [...current];
      updated[lastIdx] = msg;
      storeRef.current.set(projectId, updated);
      return updated;
    }
    // If no matching last assistant, just append
    const updated = [...current, msg];
    storeRef.current.set(projectId, updated);
    return updated;
  }, [projectId]);

  // Clear messages for current project
  const clearMessages = useCallback(() => {
    storeRef.current.delete(projectId);
  }, [projectId]);

  return {
    getMessages,
    saveMessages,
    handleHistory,
    appendMessage,
    replaceLastAssistant,
    clearMessages,
  };
}