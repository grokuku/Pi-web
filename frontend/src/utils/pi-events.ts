// ── Pure PiEvent processor ───────────────────────────────────────────
// Extrait de ChatView pour pouvoir être appliqué aux messages de N'IMPORTE
// quel projet, pas seulement celui actuellement visible. C'est le correctif
// clé du bug « UI périmée après changement de projet pendant le streaming ».
//
// Retourne { messages, assistantId } — le nouvel état.
// Ne MUTE PAS le tableau d'entrée.
//
// Fonction pure (hors `t` optionnel pour l'i18n) : testable unitairement.
import type { AssistantBlock, DisplayMessage, PiEvent, ToolCallInfo } from "../types";

// ── (chronologie) Helpers purs de construction des blocs ordonnés ───────
// Un message assistant conserve, en plus de ses agrégats (content/thinking/
// toolCalls), un tableau ORDONNÉ de blocs (`blocks`) : c'est le cœur du
// correctif « fil chronologique ». Les deltas de même type consécutifs sont
// CONCATÉNÉS dans le bloc courant ; un changement de type (ou un tool call)
// ouvre un NOUVEAU bloc — l'ordre texte → outil → texte est ainsi préservé.
function appendDeltaBlock(
  blocks: AssistantBlock[] | undefined,
  kind: "text" | "thinking",
  delta: string,
): AssistantBlock[] {
  const list = blocks ?? [];
  const last = list[list.length - 1];
  if (last && last.kind === kind) {
    return [...list.slice(0, -1), { kind, text: last.text + delta }];
  }
  return [...list, { kind, text: delta }];
}

function appendToolCallBlock(
  blocks: AssistantBlock[] | undefined,
  toolCallId: string,
): AssistantBlock[] {
  const list = blocks ?? [];
  if (list.some((b) => b.kind === "toolCall" && b.toolCallId === toolCallId)) return list;
  return [...list, { kind: "toolCall", toolCallId }];
}

/**
 * Dérive l'ordre des blocs depuis le `content[]` final d'un message assistant
 * (SDK Pi). Utilisé à `message_end` quand aucun delta n'a été capturé (provider
 * non streamé, deltas manqués pendant une coupure) : sans cela le message
 * resterait vide à l'écran.
 */
function blocksFromContent(content: unknown): AssistantBlock[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks: AssistantBlock[] = [];
  for (const block of content) {
    const b = block as any;
    if (!b) continue;
    if (b.type === "text") blocks.push({ kind: "text", text: b.text || "" });
    else if (b.type === "thinking") blocks.push({ kind: "thinking", text: b.thinking || "" });
    else if (b.type === "toolCall" || b.type === "tool_use" || b.type === "function") {
      if (b.id) blocks.push({ kind: "toolCall", toolCallId: b.id });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

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

// ── Préservation des messages user « en vol » ───────────────────────────
// Un pi_history peut arriver pendant que le client vient d'envoyer un prompt
// (filet de secours needsHistory — régression 6210d1c, rejeu de file WS,
// fallback pi_prompt) : le backend construit l'historique AVANT de committer
// le message de l'utilisateur, donc le remplacement wholesale de la liste par
// l'historique reçu ferait DISPARAÎTRE le message tout juste tapé (id
// optimiste ≠ id d'entrée backend, dédup par id inopérant).
//
// Correctif « question disparue » (incident Yuki) : l'ancienne fenêtre de 15 s
// expirait pendant les gros rattrapages (1,96 Mo à transférer/parser) et la
// question du user disparaissait. La préservation ne dépend PLUS de l'ÂGE :
// un message user optimiste est préservé tant qu'il n'est PAS PRÉSENT dans
// l'historique reçu (confirmation par CONTENU, quel que soit l'âge) :
//   - « dernier user » : s'il est le DERNIER user de l'historique reçu, c'est
//     le flux normal (commité) → pas de ré-ajout (pas de doublon permanent) ;
//   - « absent partout » : jamais commité → PRÉSERVÉ, quel que soit l'âge ;
//   - « doublon ancien » : matche un user PLUS ANCIEN de l'historique — un
//     candidat RÉCENT (< windowMs) est quand même préservé (nouvel envoi à
//     contenu identique : un doublon ancien ne doit pas le masquer) ; un
//     candidat ANCIEN est considéré déjà commité (on ne ressuscite pas un
//     vieux message que l'historique contient déjà) ;
//   - fenêtrage serveur (pi_history tronqué, windowFrom > 0) : les messages
//     ANTÉRIEURS au plus vieux message de la fenêtre sont ATTENDUS absents
//     (ils vivent dans les lots antérieurs, pi_history_page) — on ne peut ni
//     les confirmer ni les déclarer perdus : on ne les ré-attache PAS (sinon
//     chaque resync dupliquerait en queue les vieux lots déjà chargés).
//     Marge PENDING_WINDOW_SKEW_MS : horloges client/serveur désynchronisées.
export const PENDING_USER_WINDOW_MS = 15_000;
/** Marge d'horloge client/serveur pour la borne « hors fenêtre serveur ». */
export const PENDING_WINDOW_SKEW_MS = 120_000;

export interface PendingUserOptions {
  /**
   * Index (dans la liste complète backend) du PREMIER message de l'historique
   * reçu. 0 (défaut) = historique complet ; > 0 = fenêtre (pi_history
   * tronqué, complété par les lots pi_history_page).
   */
  windowFrom?: number;
}

export function findPendingUserMessages(
  existing: DisplayMessage[],
  history: DisplayMessage[],
  now: number = Date.now(),
  windowMs: number = PENDING_USER_WINDOW_MS,
  opts: PendingUserOptions = {},
): DisplayMessage[] {
  const candidates = existing.filter(
    (m) =>
      m.role === "user" &&
      !m._streaming &&
      typeof m.timestamp === "number" &&
      Number.isFinite(m.timestamp) &&
      now - m.timestamp >= 0
  );
  if (candidates.length === 0) return [];

  // Borne « hors fenêtre serveur » : si l'historique reçu est une TRANCHE,
  // les candidats plus vieux que son message le plus ancien (marge de skew)
  // sont attendus absents → jamais ré-attachés (pas de résurrection des lots
  // antérieurs déjà chargés à chaque resync).
  let windowFloorTs = -Infinity;
  if ((opts.windowFrom ?? 0) > 0) {
    const stamps = history
      .map((m) => m.timestamp)
      .filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts));
    if (stamps.length > 0) windowFloorTs = Math.min(...stamps) - PENDING_WINDOW_SKEW_MS;
  }

  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const historyUserContents = new Set(
    history.filter((m) => m.role === "user").map((m) => (m.content || "").trim())
  );

  return candidates.filter((c) => {
    const ts = c.timestamp as number;
    if (ts <= windowFloorTs) return false; // antérieur à la fenêtre serveur → hors périmètre
    const content = (c.content || "").trim();
    if (!content) return true; // non identifiable (ex. image seule) → conservé
    if (lastUser && (lastUser.content || "").trim() === content) return false; // commité en dernier user (flux normal)
    if (!historyUserContents.has(content)) return true; // absent de l'historique reçu → NON confirmé → préservé, quel que soit l'âge
    // Présent mais PAS en dernier user (doublon ancien) : récent → nouvel
    // envoi à contenu identique (préservé) ; ancien → déjà commité (jeté).
    return now - ts < windowMs;
  });
}

// ── Chargement par lots : préfixage d'un lot antérieur (pi_history_page) ──
// Le backend n'envoie que les N derniers messages dans pi_history (fix de
// fond du bug « messages récents manquants » : un payload complet faisait
// flapper le WS). Les lots antérieurs arrivent via pi_history_page et sont
// PRÉFIXÉS à la liste locale. Helper PUR, testable hors React.
//
// - Dédup par id : le lot et la liste locale partagent l'espace d'ids d'entrée
//   backend ; un doublon (rejeu de file, race avec un pi_history) est écarté.
// - Aucun doublon DANS le lot lui-même (idem, garde-fou).
// - L'ordre est préservé : [lot…, existant…] — le lot est chronologiquement
//   antérieur. Les messages sans id ne sont jamais dupliqués mais aussi
//   jamais dédupés (conservés tels quels, comportement conservateur).
export function prependHistoryBatch(prev: DisplayMessage[], batch: DisplayMessage[]): DisplayMessage[] {
  if (batch.length === 0) return prev;
  const fresh: DisplayMessage[] = [];
  const batchIds = new Set<string>();
  for (const m of batch) {
    if (m.id) {
      if (batchIds.has(m.id)) continue; // doublon DANS le lot
      batchIds.add(m.id);
    }
    fresh.push(m);
  }
  if (fresh.length === 0) return prev;
  const known = new Set(prev.map((m) => m.id));
  const novel = fresh.filter((m) => !m.id || !known.has(m.id));
  if (novel.length === 0) return prev;
  return [...novel, ...prev];
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

  // ── (fix silence) Recherche du message porteur d'un tool call par ID ──
  // Le SDK clôture le message assistant (message_end → asstId devient null)
  // AVANT d'exécuter les outils : les events tool_execution_* arrivent donc
  // APRÈS que l'assistantId courant soit perdu. L'ancien `updateLast` (qui
  // exige `id === asstId`) les JETAIT tous — la sortie live, le flag isStreaming
  // et les durées d'outil n'étaient jamais appliqués (seule la relecture
  // pi_history les faisait apparaître). On retrouve donc le message par
  // l'ID de tool call, quel que soit l'état de streaming.
  const findToolCallMsgIdx = (toolCallId: string): number => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant" || !m.toolCalls) continue;
      if (m.toolCalls.some((tc) => tc.id === toolCallId)) return i;
    }
    return -1;
  };

  // Applique une mise à jour au tool call identifié. `create` permet de
  // (re)créer l'entrée sur le dernier message assistant si l'event de départ
  // (toolcall_start) a été manqué (coupure WS), avec ajout du bloc ordonné.
  const applyToolCall = (
    toolCallId: string,
    fn: (tc: ToolCallInfo) => ToolCallInfo,
    create?: () => ToolCallInfo,
  ) => {
    const idx = findToolCallMsgIdx(toolCallId);
    if (idx === -1) {
      if (!create) return;
      const lastIdx = msgs.length - 1;
      if (lastIdx < 0 || msgs[lastIdx].role !== "assistant") return;
      msgs = [...msgs];
      const m = msgs[lastIdx];
      msgs[lastIdx] = {
        ...m,
        toolCalls: [...m.toolCalls, create()],
        blocks: appendToolCallBlock(m.blocks, toolCallId),
      };
      return;
    }
    msgs = [...msgs];
    const m = msgs[idx];
    msgs[idx] = { ...m, toolCalls: m.toolCalls.map((tc) => (tc.id === toolCallId ? fn(tc) : tc)) };
  };

  switch (evt.type) {
    case "message_start": {
      if (evt.message?.role === "assistant") {
        const newId: string = evt.message.id || `s-${Date.now()}`;
        asstId = newId;
        msgs = [...msgs, { id: newId, role: "assistant", content: "", thinking: "", toolCalls: [], blocks: [], timestamp: Date.now(), _streaming: true }];
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
        return { ...last, content: last.content + d.delta, blocks: appendDeltaBlock(last.blocks, "text", d.delta), thinkingDurationMs };
      });
      if (d.type === "thinking_delta") updateLast(last => ({
        ...last,
        thinking: last.thinking + d.delta,
        blocks: appendDeltaBlock(last.blocks, "thinking", d.delta),
        // Lot C : horodate le début de la réflexion au premier thinking_delta.
        thinkingStartedAt: last.thinkingStartedAt ?? Date.now(),
      }));
      if (d.type === "toolcall_start") {
        const a = d.args?.arguments ?? d.args?.input ?? d.args ?? {};
        updateLast(last => {
          if (last.toolCalls.some(tc => tc.id === d.toolCallId)) return last;
          return {
            ...last,
            toolCalls: [...last.toolCalls, { id: d.toolCallId, name: d.toolName, args: a, output: "", isError: false, isStreaming: true, startedAt: Date.now() }],
            blocks: appendToolCallBlock(last.blocks, d.toolCallId),
          };
        });
      }
      if (d.type === "toolcall_delta") {
        const da = d.argsDelta?.arguments ?? d.argsDelta?.input ?? d.argsDelta ?? {};
        applyToolCall(d.toolCallId, tc => ({ ...tc, args: { ...tc.args, ...da } }));
      }
      if (d.type === "toolcall_end") {
        const ea = d.toolCall?.arguments ?? d.toolCall?.input ?? d.toolCall ?? {};
        const en = d.toolCall?.name || d.toolName;
        applyToolCall(d.toolCallId, tc => ({ ...tc, args: ea, isStreaming: false, ...(en ? { name: en } : {}) }));
      }
      break;
    }
    case "tool_execution_start":
      applyToolCall(
        evt.toolCallId,
        tc => ({ ...tc, isStreaming: true, startTime: tc.startTime || Date.now(), ...(evt.toolName && !tc.name ? { name: evt.toolName } : {}) }),
        () => ({ id: evt.toolCallId, name: evt.toolName || "unknown", args: evt.args || {}, output: "", isError: false, isStreaming: true, startedAt: Date.now(), startTime: Date.now() }),
      );
      break;
    case "tool_execution_update": {
      const pt = evt.partialResult?.content?.map((c: any) => c.text || "").join("") || "";
      applyToolCall(evt.toolCallId, tc => ({ ...tc, output: pt, isStreaming: true }));
      break;
    }
    case "tool_execution_end": {
      const rt = evt.result?.content?.map((c: any) => c.text || "").join("") || "";
      // LOT 1 : on capture aussi endedAt (durée figée pour les résumés d'outils)
      // et details (diff de l'edit, truncation read/bash…) s'ils sont exposés
      // par le résultat du tool — sans changement backend : le champ est déjà
      // présent dans l'event émis par le SDK.
      const details = evt.result?.details ?? undefined;
      applyToolCall(
        evt.toolCallId,
        tc => ({ ...tc, output: rt, isError: evt.isError, isStreaming: false, endedAt: Date.now(), ...(details !== undefined ? { details } : {}) }),
        () => ({ id: evt.toolCallId, name: evt.toolName || "unknown", args: {}, output: rt, isError: evt.isError, isStreaming: false, endedAt: Date.now(), ...(details !== undefined ? { details } : {}) }),
      );
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
          // ── (chronologie) content[] final = ordre réel d'écriture ──
          // Si aucun bloc n'a été capturé (provider non streamé / deltas
          // manqués pendant une coupure), on reconstruit le contenu ET l'ordre
          // depuis le content[] final, sinon le message resterait vide.
          const content = evt.message?.content;
          let contentText = ex.content;
          let thinkingText = ex.thinking;
          let toolCalls = ex.toolCalls;
          let blocks = ex.blocks;
          if (Array.isArray(content) && content.length > 0) {
            const hasStreamed = !!ex.content.trim() || !!ex.thinking.trim() || ex.toolCalls.length > 0;
            if (!hasStreamed) {
              const textParts: string[] = [];
              const thinkParts: string[] = [];
              const tcs: ToolCallInfo[] = [];
              for (const block of content) {
                const b = block as any;
                if (!b) continue;
                if (b.type === "text") textParts.push(b.text || "");
                else if (b.type === "thinking") thinkParts.push(b.thinking || "");
                else if (b.type === "toolCall" || b.type === "tool_use" || b.type === "function") {
                  tcs.push({
                    id: b.id,
                    name: b.name || b.toolName || "unknown",
                    args: b.arguments || b.input || b.args || {},
                    output: "",
                    isError: false,
                    isStreaming: false,
                  });
                }
              }
              contentText = textParts.join("\n");
              thinkingText = thinkParts.join("\n");
              toolCalls = tcs;
            }
            if (!blocks || blocks.length === 0) blocks = blocksFromContent(content);
          }
          msgs[targetIdx] = {
            ...ex,
            content: contentText,
            thinking: thinkingText,
            blocks,
            toolCalls: toolCalls.map(tc => ({ ...tc, isStreaming: false })),
            _streaming: false,
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
