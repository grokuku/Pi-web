// ── Pure PiEvent processor ───────────────────────────────────────────
// Extrait de ChatView pour pouvoir être appliqué aux messages de N'IMPORTE
// quel projet, pas seulement celui actuellement visible. C'est le correctif
// clé du bug « UI périmée après changement de projet pendant le streaming ».
//
// Retourne { messages, assistantId } — le nouvel état.
// Ne MUTE PAS le tableau d'entrée.
//
// Fonction pure (hors `t` optionnel pour l'i18n) : testable unitairement.
import type { DisplayMessage, PiEvent } from "../types";

// ── (dédup) Append de message avec déduplication par id ──────────────
// Même sémantique que useChatHistory.appendMessage (dédup par id) : si un
// message du même id existe déjà, le tableau est renvoyé tel quel. Appliqué
// aux appends LOCAUX (message user optimiste, custom/injected, erreurs) qui
// ne dédupaient pas — évite les doublons entre la version optimiste et la
// version backend du même message.
export function appendMessageDedup(prev: DisplayMessage[], msg: DisplayMessage): DisplayMessage[] {
  if (prev.some(m => m.id === msg.id)) return prev;
  return [...prev, msg];
}

/**
 * Applique un événement de streaming Pi à la liste de messages courante.
 * @param prev        messages actuels (non mutés)
 * @param evt         événement Pi reçu
 * @param assistantId id du message assistant en cours de streaming (ou null)
 * @param t           fonction de traduction i18n (optionnelle) — nécessaire
 *                   pour stocker un errorMessage localisé (ex. timeout)
 * @returns le nouvel état { messages, assistantId }
 */
export function applyPiEvent(
  prev: DisplayMessage[],
  evt: PiEvent,
  assistantId: string | null,
  t?: (key: string, ...args: any[]) => string,
): { messages: DisplayMessage[]; assistantId: string | null } {
  let msgs = prev;
  let asstId = assistantId;

  // Helper: trouve et met à jour le message assistant en streaming courant
  const updateLast = (fn: (last: DisplayMessage) => DisplayMessage) => {
    const idx = msgs.length - 1;
    if (idx < 0 || msgs[idx].role !== "assistant" || msgs[idx].id !== asstId) return;
    msgs = [...msgs];
    msgs[idx] = fn(msgs[idx]);
  };

  switch (evt.type) {
    case "message_start": {
      if (evt.message?.role === "assistant") {
        const newId: string = evt.message.id || `s-${Date.now()}`;
        asstId = newId;
        msgs = [...msgs, { id: newId, role: "assistant", content: "", thinking: "", toolCalls: [], timestamp: Date.now(), _streaming: true }];
      }
      break;
    }
    case "message_update": {
      const d = evt.assistantMessageEvent;
      if (d.type === "text_delta") updateLast(last => {
        // Lot C : au premier text_delta, on fige la durée de réflexion (le
        // thinking est consommé → le ThinkingBlock pourra se replier).
        const thinkingDurationMs = last.thinkingStartedAt !== undefined && last.thinkingDurationMs === undefined
          ? Date.now() - last.thinkingStartedAt
          : last.thinkingDurationMs;
        return { ...last, content: last.content + d.delta, thinkingDurationMs };
      });
      if (d.type === "thinking_delta") updateLast(last => ({
        ...last,
        thinking: last.thinking + d.delta,
        // Lot C : horodate le début de la réflexion au premier thinking_delta.
        thinkingStartedAt: last.thinkingStartedAt ?? Date.now(),
      }));
      if (d.type === "toolcall_start") {
        const a = d.args?.arguments ?? d.args?.input ?? d.args ?? {};
        updateLast(last => {
          if (last.toolCalls.some(tc => tc.id === d.toolCallId)) return last;
          return { ...last, toolCalls: [...last.toolCalls, { id: d.toolCallId, name: d.toolName, args: a, output: "", isError: false, isStreaming: true, startedAt: Date.now() }] };
        });
      }
      if (d.type === "toolcall_delta") {
        const da = d.argsDelta?.arguments ?? d.argsDelta?.input ?? d.argsDelta ?? {};
        updateLast(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id === d.toolCallId ? { ...tc, args: { ...tc.args, ...da } } : tc) }));
      }
      if (d.type === "toolcall_end") {
        const ea = d.toolCall?.arguments ?? d.toolCall?.input ?? d.toolCall ?? {};
        const en = d.toolCall?.name || d.toolName;
        updateLast(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id === d.toolCallId ? { ...tc, args: ea, isStreaming: false, ...(en ? { name: en } : {}) } : tc) }));
      }
      break;
    }
    case "tool_execution_start":
      updateLast(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id === evt.toolCallId ? { ...tc, isStreaming: true, startTime: tc.startTime || Date.now(), ...(evt.toolName && !tc.name ? { name: evt.toolName } : {}) } : tc) }));
      break;
    case "tool_execution_update": {
      const pt = evt.partialResult?.content?.map((c: any) => c.text || "").join("") || "";
      updateLast(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id === evt.toolCallId ? { ...tc, output: pt, isStreaming: true } : tc) }));
      break;
    }
    case "tool_execution_end": {
      const rt = evt.result?.content?.map((c: any) => c.text || "").join("") || "";
      updateLast(last => ({ ...last, toolCalls: last.toolCalls.map(tc => tc.id === evt.toolCallId ? { ...tc, output: rt, isError: evt.isError, isStreaming: false } : tc) }));
      break;
    }
    case "agent_end": {
      // Lot C : agent_end synthétisé par le backend (session.ts) avec
      // reason:"timeout" → le modèle n'a pas répondu depuis 5 min. On finalise
      // le message en cours proprement (plus de spinner infini) avec une
      // bannière d'erreur localisée.
      if (evt.reason === "timeout") {
        updateLast(last => ({
          ...last,
          _streaming: false,
          stopReason: "error",
          errorMessage: t ? t('chat.timeoutError') : 'chat.timeoutError',
        }));
        asstId = null;
      }
      break;
    }
    case "message_end": {
      if (evt.message?.role === "assistant") {
        let targetIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]._streaming && msgs[i].role === "assistant") {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx >= 0) {
          msgs = [...msgs];
          const ex = msgs[targetIdx];
          msgs[targetIdx] = {
            ...ex,
            _streaming: false,
            toolCalls: ex.toolCalls.map(tc => ({ ...tc, isStreaming: false })),
            usage: evt.message?.usage
              ? { input: evt.message.usage.input || 0, output: evt.message.usage.output || 0, cost: { total: evt.message.usage.cost?.total || 0 } }
              : ex.usage,
            // BUG-68 : préserver les métadonnées d'échec LLM pour afficher
            // une bannière d'erreur au lieu d'un assistant vide.
            stopReason: evt.message?.stopReason,
            errorMessage: evt.message?.errorMessage,
          };
        }
        asstId = null;
      }
      break;
    }
  }

  return { messages: msgs, assistantId: asstId };
}
