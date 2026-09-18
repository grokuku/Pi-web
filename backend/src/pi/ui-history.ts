// ── Sérialisation de l'historique UI (pi_history) ──
// Module pur (aucune dépendance serveur) : extrait de index.ts pour être
// testable (index.ts démarre Express + WS + crons à l'import, impossible à
// charger depuis vitest sans effets de bord).

// ── Fonction partagée de sérialisation des messages (BUG-46 fix) ──
// Utilisée par pi_start et pi_history_request pour reconstruire l'historique UI.
export function serializeMessagesForUi(messages: any[]): any[] {
  return messages.map((m: any) => {
    const base: any = {
      id: m.id,
      role: m.role,
      timestamp: m.timestamp,
    };
    if (m.role === "user") {
      base.content = m.content;
    } else if (m.role === "assistant") {
      const rawContent = Array.isArray(m.content) ? m.content : m.content;
      base.content = Array.isArray(rawContent)
        ? rawContent.map((b: any) => {
            if (b.type === "tool_use" || b.type === "function") {
              return {
                ...b,
                type: "toolCall",
                name: b.name || b.toolName || "unknown",
                arguments: b.arguments || b.input || b.args || {},
              };
            }
            return b;
          })
        : rawContent;
      base.usage = m.usage;
      // BUG-68 : préserver les métadonnées d'échec LLM (stopReason:"error" + errorMessage)
      // Sinon l'erreur est avalée ici et le frontend ne reçoit qu'un message assistant vide.
      base.stopReason = m.stopReason;
      base.errorMessage = m.errorMessage;
      base.thinking = Array.isArray(base.content)
        ? base.content.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking || "").join("")
        : undefined;
    } else if (m.role === "toolResult") {
      base.toolCallId = m.toolCallId;
      base.toolName = m.toolName;
      base.content = m.content;
      base.details = m.details;
    } else if (m.role === "bashExecution") {
      base.command = m.command;
      base.output = m.output;
      base.exitCode = m.exitCode;
      base.cancelled = m.cancelled;
    } else if (m.role === "compactionSummary") {
      base.summary = m.summary;
      base.tokensBefore = m.tokensBefore;
    } else if (m.role === "custom") {
      base.content = m.content;
      base.customType = m.customType;
      base.display = m.display;
      base.details = m.details;
    }
    return base;
  });
}

// ── Historique UI COMPLET (fix « messages récents manquants ») ──
// state.session.messages = contexte LLM construit par buildSessionContext(),
// c-à-d la branche COMPACTION-AWARE : tout ce qui précède la dernière
// compaction (summary + firstKeptEntryId) est absent de ce tableau. Sur une
// longue session (ex. 2165 messages dont 4 compactions), l'UI ne recevait que
// ~204 messages — les échanges antérieurs à la dernière compaction étaient
// définitivement invisibles, et le marqueur « *Conversation compacted* » était
// le SEUL indice. De plus, les messages issus de cette reconstruction n'ont
// PAS d'id (l'id vit sur l'entrée du fichier, pas sur l'AgentMessage) → la
// dédup frontend tombait sur des ids dérivés du timestamp.
//
// Cette fonction reconstruit l'historique UI depuis les ENTRÉES brutes de la
// session (sessionManager.getEntries(), ordre du fichier = chronologique) :
//  - ids d'entrée attachés à chaque message (dédup fiable côté frontend) ;
//  - les entrées compaction restent INLINE (role compactionSummary, déjà
//    rendu par le frontend) au lieu de tronquer la liste ;
//  - les blocs image des messages PRÉ-compaction sont dépouillés pour borner
//    le payload WS (ils ne servent qu'à l'affichage ; les récentes restent).
// Le contexte LLM (compaction-aware) n'est PAS touché : c'est uniquement la
// vue UI (pi_history) qui devient complète.
export function buildFullUiHistory(session: any): any[] {
  const sm = session?.sessionManager;
  if (!sm || typeof sm.getEntries !== "function") {
    // Fallback : ancien comportement (contexte compaction-aware).
    return serializeMessagesForUi(session?.messages || []);
  }
  const entries: any[] = sm.getEntries() || [];
  // Index de la dernière compaction : au-delà, on garde tout ; avant, on
  // allège (pas d'images — le payload WS resterait multi-Mo sinon).
  let lastCompactionIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") { lastCompactionIdx = i; break; }
  }

  const uiMessages: any[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.type === "session" || entry.type === "label" ||
        entry.type === "model_change" || entry.type === "thinking_level_change") continue;

    // Compaction inline : le frontend rend déjà ce rôle
    // (« *Conversation compacted. Summary available.* »).
    if (entry.type === "compaction") {
      uiMessages.push({
        id: entry.id,
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: entry.timestamp,
      });
      continue;
    }

    if (entry.type === "branch_summary") {
      uiMessages.push({
        id: entry.id,
        role: "custom",
        customType: "branch_summary",
        content: entry.summary || "",
        display: true,
        timestamp: entry.timestamp,
      });
      continue;
    }

    if (entry.type === "custom_message") {
      uiMessages.push({
        id: entry.id,
        role: "custom",
        content: entry.content ?? [],
        customType: entry.customType,
        display: entry.display,
        details: entry.details,
        timestamp: entry.timestamp,
      });
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;
    const message: any = { ...entry.message, id: entry.id, timestamp: entry.timestamp };
    // Pré-compaction : on retire les blocs image (display-only, lourds).
    if (lastCompactionIdx >= 0 && i < lastCompactionIdx && Array.isArray(message.content)) {
      message.content = message.content.map((b: any) =>
        b?.type === "image" ? { type: "text", text: "[image omise de l'historique ancien]" } : b
      );
    }
    uiMessages.push(serializeMessagesForUi([message])[0]);
  }
  return uiMessages;
}