import { useRef, useCallback, useEffect } from "react";
import type { AssistantBlock, DisplayMessage, SubAgentRun, ToolCallInfo } from "../types";
import { registerArchivedRuns, runFromActivity, toEpochMs } from "../stores/subagentRuns";
// Filet de sécurité partagé « réflexion seule ⇒ réponse » : la MÊME règle doit
// s'appliquer au live et à la conversion d'historique (sinon un rechargement
// re-déclasserait ce que le live a promu).
import { promoteThinkingOnlyAnswer } from "../utils/pi-events";

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
  // LOT 3 : tokens présents dans le contexte avant la compaction.
  tokensBefore?: number;
  // Custom/BashExecution fields
  display?: boolean;
  // ISO (buildFullUiHistory, entrées de session) ou epoch ms (messages SDK).
  timestamp?: number | string;
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
/**
 * ÉTANCHÉITÉ inter-projets : `projectId` est le projet auquel appartient
 * l'historique converti. Il est marqué sur chaque run archivé (relecture) et
 * borne leur rattachement — un run archivé relu ici ne peut jamais apparaître
 * dans la conversation d'un autre projet (ni être rattaché à ses toolCalls).
 * Optionnel pour compat (tests) : sans lui, les runs archivés restent sans
 * projet et ne sont exposés qu'aux vues non filtrées.
 */
export function convertHistoryToDisplayMessages(
  history: HistoryMessage[],
  projectId?: string,
): DisplayMessage[] {
  const displayMessages: DisplayMessage[] = [];
  let pendingToolResults: Map<string, ToolCallInfo> = new Map();
  // LOT 3 : ids des toolCall DÉCLARÉS par des messages assistant. Un
  // `toolResult` dont l'id n'y figure pas est ORPHELIN (toolCall absent de
  // l'historique — ex. antérieur à une compaction) : il est alors rendu À
  // SA DATE comme bloc autonome au lieu d'être silencieusement jeté.
  const declaredToolCallIds = new Set<string>();
  // LOT 2b : runs de sous-agents archivés (entrées custom `subagent_activity`)
  // collectés pour relecture après rechargement — enregistrés dans le store
  // isolé en fin de conversion (jamais dans `messages`).
  const archivedRuns: SubAgentRun[] = [];

  // First pass: collect tool results keyed by toolCallId + ids déclarés.
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
        // LOT 1 : details du toolResult (diff edit, truncation read/bash…)
        // conservés pour les résumés d'outils. Pas de startedAt/endedAt en
        // historique → la durée est omise (comportement attendu).
        details: (msg as any).details ?? undefined,
      });
    } else if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (block?.type === "toolCall" || block?.type === "tool_use" || block?.type === "function") {
          if (block.id) declaredToolCallIds.add(block.id);
        }
      }
    }
  }

  console.log(`[history] First pass: ${pendingToolResults.size} tool results collected`);

  // Second pass: build display messages
  let currentAssistantId: string | null = null;
  let totalToolCallsFound = 0;

  for (const msg of history) {
    // Horodatage NORMALISÉ en epoch ms : le backend sérialise les entrées de
    // session en ISO 8601 (buildFullUiHistory) alors que les events LIVE sont
    // numériques. Sans ça, les dates de groupes valaient 0 et l'arithmétique
    // des runs (`now - durationMs`) donnait NaN → tout bloc daté en fin de fil.
    const ts = toEpochMs(msg.timestamp);

    // ── User messages ──
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractTextContent(msg.content);

      // Extract images from content blocks (legacy base64 format)
      const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
      const images = contentBlocks
        .filter((b: any) => b.type === "image" && (b.data || b.attachmentId))
        .map((b: any) => b.attachmentId
          ? { attachmentId: b.attachmentId, name: b.name || "image", mimeType: b.mimeType || "image/png" }
          : { data: b.data, name: b.name || "image", mimeType: b.mimeType || "image/png" }  // legacy base64 — conservée pour l'affichage direct
        );

      // Skip empty user messages (unless they have images)
      if (!text.trim() && images.length === 0) continue;

      displayMessages.push({
        id: msg.id || `user-${ts}`,
        role: "user",
        content: text,
        thinking: "",
        toolCalls: [],
        timestamp: ts,
        images: images.length > 0 ? images : undefined,
      });
    }

    // ── Assistant messages ──
    else if (msg.role === "assistant") {
      currentAssistantId = msg.id || `asst-${ts}`;

      const contentBlocks = Array.isArray(msg.content) ? msg.content : [];

      // ── Ordre chronologique réel ──
      // On itère content[] UNE fois, dans l'ordre, et on construit À LA FOIS
      // les agrégats (text/thinking/toolCalls) et le tableau ordonné `blocks`.
      // C'est ce tableau qui pilote le rendu : un texte écrit AVANT un appel
      // d'outil s'affiche AVANT lui (avant, le rendu regroupait par type →
      // l'outil apparaissait toujours au-dessus du texte).
      const textParts: string[] = [];
      const thinkParts: string[] = [];
      const toolCalls: ToolCallInfo[] = [];
      const blocks: AssistantBlock[] = [];
      for (const block of contentBlocks) {
        const b: any = block;
        if (!b) continue;
        if (b.type === "text") {
          const txt = b.text || "";
          textParts.push(txt);
          blocks.push({ kind: "text", text: txt });
        } else if (b.type === "thinking") {
          const txt = b.thinking || "";
          thinkParts.push(txt);
          blocks.push({ kind: "thinking", text: txt });
        } else if (b.type === "toolCall" || b.type === "tool_use" || b.type === "function") {
          const toolResult = pendingToolResults.get(b.id);
          toolCalls.push({
            id: b.id,
            name: b.name || b.toolName || "unknown",
            args: b.arguments || b.input || b.args || {},
            output: toolResult?.output || "",
            isError: toolResult?.isError || false,
            isStreaming: false,
            // LOT 1 : details du toolResult → résumés d'outils (diff, truncation…).
            ...(toolResult?.details !== undefined ? { details: toolResult.details } : {}),
          });
          blocks.push({ kind: "toolCall", toolCallId: b.id });
          totalToolCallsFound++;
        }
      }

      const joinedText = textParts.join("\n");
      const joinedThinking = thinkParts.join("\n");

      // (filet de sécurité) Tour « réflexion seule » → promu en réponse, comme
      // en live : un provider qui renvoie tout dans `reasoning` laisse
      // `content` vide. On ne promeut jamais un tour avec outil ni une erreur.
      const promoted = promoteThinkingOnlyAnswer({
        blocks,
        contentText: joinedText,
        thinkingText: joinedThinking,
        hasToolCalls: toolCalls.length > 0,
        stopReason: (msg as any).stopReason,
      });
      const text = promoted ? promoted.content : joinedText;
      const thinking = promoted ? promoted.thinking : joinedThinking;

      // Debug: log block types when no tool calls found but we have content blocks
      if (toolCalls.length === 0 && contentBlocks.length > 0) {
        const types = contentBlocks.map((b: any) => b.type);
        console.log(`[history] Assistant msg has ${contentBlocks.length} blocks, types: ${types.join(", ")} — no toolCall/tool_use/function found`);
      }

      // Skip empty assistant messages (can happen during streaming)
      // BUG-68 : NE PAS skip un turn qui a échoué (stopReason "error" / errorMessage)
      // — on veut afficher la bannière d'erreur même si le contenu est vide.
      const isErrorTurn = (msg as any).stopReason === "error" || !!(msg as any).errorMessage;
      if (!text.trim() && !thinking.trim() && toolCalls.length === 0 && !isErrorTurn) continue;

      displayMessages.push({
        id: currentAssistantId,
        role: "assistant",
        content: text,
        thinking,
        toolCalls,
        blocks: promoted ? promoted.blocks : (blocks.length > 0 ? blocks : undefined),
        timestamp: ts,
        usage: msg.usage ? {
          input: msg.usage.input || 0,
          output: msg.usage.output || 0,
          cost: { total: msg.usage.cost?.total || 0 },
        } : undefined,
        // BUG-68 : préserver les métadonnées d'échec LLM pour le rendu de la bannière.
        stopReason: (msg as any).stopReason,
        errorMessage: (msg as any).errorMessage,
      });
    }

    // ── Bash execution messages (LOT 3) ──
    // Rendu À LEUR DATE en bloc autonome (BashExecutionRow) : commande, sortie
    // complète repliable, exitCode visible, statut cancelled. Auparavant
    // convertie en bulle `user` avec un unique fence ```bash (sortie perdue).
    else if (msg.role === "bashExecution") {
      displayMessages.push({
        id: msg.id || `bash-${ts}`,
        role: "assistant",
        content: "",
        thinking: "",
        toolCalls: [],
        timestamp: ts,
        kind: "bashExecution",
        bashExecution: {
          command: msg.command || "",
          output: msg.output || "",
          exitCode: typeof msg.exitCode === "number" ? msg.exitCode : undefined,
          cancelled: msg.cancelled === true ? true : undefined,
        },
      });
    }

    // ── Compaction summary (LOT 3) ──
    // Rendu À SA DATE en bloc autonome (CompactionRow) : résumé lisible +
    // tokensBefore (contexte libéré). Auparavant : « *Conversation compacted* »
    // + résumé fourré dans le ThinkingBlock, sans montrer tokensBefore.
    else if (msg.role === "compactionSummary") {
      displayMessages.push({
        id: msg.id || `compact-${ts}`,
        role: "assistant",
        content: "",
        thinking: "",
        toolCalls: [],
        timestamp: ts,
        kind: "compaction",
        compaction: {
          summary: msg.summary || "",
          tokensBefore: typeof msg.tokensBefore === "number" ? msg.tokensBefore : undefined,
        },
      });
    }

    // ── Custom messages ──
    // LOT 2b : entrée custom `subagent_activity` (display:false) — résumé de la
    // vie d'un sous-agent persisté pour l'UI. Non rendue dans le fil : on en
    // fait un SubAgentRun archivé, rattaché au toolCall `delegate` correspondant
    // (FIFO + fonction) → le SubAgentBlock relit le travail du sous-agent.
    else if (msg.role === "custom" && (msg as any).customType === "subagent_activity") {
      const run = runFromActivity((msg as any).details, ts);
      if (run) archivedRuns.push(run);
    }

    else if (msg.role === "custom" && (msg as any).display !== false) {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractTextContent(msg.content as any);
      if (text.trim()) {
        displayMessages.push({
          id: msg.id || `custom-${ts}`,
          role: "user",
          content: text,
          thinking: "",
          toolCalls: [],
          timestamp: ts,
          customType: (msg as any).customType,
          display: (msg as any).display,
          // Messages système injectés (ex. web_screenshot) → rendu à gauche.
          injected: (msg as any).customType === "screenshot" || undefined,
          // Miniatures injectées par le backend (ex. web_screenshot) — le
          // backend place attachmentRefs dans details du CustomMessage.
          attachmentRefs: Array.isArray((msg as any).details?.attachmentRefs)
            ? (msg as any).details.attachmentRefs
            : undefined,
        });
      }
    }

    // ── ToolResult messages (standalone, LOT 3) ──
    // Rattachement EXACT par toolCallId : si le toolCall est DÉCLARÉ par un
    // message assistant, le résultat est déjà foldé dans ce toolCall (rendu
    // par ToolCallRow) → skip. Sinon ORPHELIN → rendu À SA DATE comme bloc
    // autonome (ToolResultRow), au lieu d'être jeté (l'ancien test
    // `pendingToolResults.has(...)` était toujours vrai → branche morte).
    else if (msg.role === "toolResult") {
      if (msg.toolCallId && declaredToolCallIds.has(msg.toolCallId)) {
        // Déjà foldé dans le toolCall d'un message assistant — skip.
        continue;
      }
      const orphan = pendingToolResults.get(msg.toolCallId!);
      if (!orphan) continue;
      displayMessages.push({
        id: msg.id || `tool-${ts}`,
        role: "assistant",
        content: "",
        thinking: "",
        toolCalls: [],
        timestamp: ts,
        kind: "toolResult",
        toolResult: orphan,
      });
    }
  }

  console.log(`[history] Converted ${history.length} raw messages → ${displayMessages.length} display messages, ${totalToolCallsFound} tool calls found`);
  // LOT 2b : enregistre les runs archivés (relecture) dans le store isolé et
  // les rattache aux tool calls `delegate` de la liste convertie. Effet de bord
  // assumé : la conversion est appelée depuis les handlers d'events (jamais au
  // render) — le store notifie les blocs concernés. ÉTANCHÉITÉ : les runs sont
  // marqués du projet de l'historique (projectId) — voir ci-dessus.
  if (archivedRuns.length > 0) registerArchivedRuns(archivedRuns, displayMessages, projectId);
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
  // Per-project streaming assistant ID (survives across switches)
  const assistantIdRef = useRef<Map<string, string | null>>(new Map());

  // Get messages for current project
  const getMessages = useCallback((): DisplayMessage[] => {
    return storeRef.current.get(projectId) || [];
  }, [projectId]);

  // Get messages for ANY project (used when processing streaming events for non-active projects)
  const getMessagesFor = useCallback((pid: string): DisplayMessage[] => {
    return storeRef.current.get(pid) || [];
  }, []);

  // Get / set assistant ID for any project (survives across switches)
  const getAssistantIdFor = useCallback((pid: string): string | null => {
    return assistantIdRef.current.get(pid) ?? null;
  }, []);
  const setAssistantIdFor = useCallback((pid: string, id: string | null): void => {
    assistantIdRef.current.set(pid, id);
  }, []);

  // Save messages for current project
  const saveMessages = useCallback((messages: DisplayMessage[]) => {
    storeRef.current.set(projectId, messages);
  }, [projectId]);

  // Save messages for a SPECIFIC project (used during project switch)
  const saveMessagesFor = useCallback((messages: DisplayMessage[], targetProjectId: string) => {
    storeRef.current.set(targetProjectId, messages);
  }, []);

  // Handle pi_history from backend — converts and sets all messages
  const handleHistory = useCallback((rawMessages: any[]) => {
    // ÉTANCHÉITÉ : les runs archivés de cet historique sont marqués du projet
    // courant (ce store est par projet) et ne fuiront pas ailleurs.
    const displayMessages = convertHistoryToDisplayMessages(rawMessages, projectId);
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
    getMessagesFor,
    getAssistantIdFor,
    setAssistantIdFor,
    saveMessages,
    saveMessagesFor,
    handleHistory,
    appendMessage,
    replaceLastAssistant,
    clearMessages,
  };
}