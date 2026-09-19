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

// ── Chargement par lots : fenêtre d'historique envoyée au client ──────────
// CAUSE RACINE du bug « messages récents manquants » : pi_history envoyait le
// payload COMPLET (2321 messages / 10,3 Mo sur la session de référence) à
// chaque ouverture/reconnexion. Un tel payload sur le WS provoque le flapping
// (fermetures 1001/1005) → l'historique est perdu en route. Correctif de
// fond : le serveur n'envoie que les N DERNIERS messages + des métadonnées de
// curseur (from/total/hasMore) ; le client demande les lots antérieurs à la
// demande via pi_history_page. La pagination DOM (GroupedMessages) et la
// reconstruction buildFullUiHistory restent inchangées.
//
// Taille du lot initial : 300 messages ≈ quelques centaines de Ko max (les
// images pré-compaction sont déjà dépouillées par buildFullUiHistory). Seuil
// ajustable ici — aucune config runtime nécessaire.
export const HISTORY_PAGE_SIZE = 300;
// Garde-fou pour un lot demandé (count) : un client buggé ne doit pas pouvoir
// faire exploser un frame WS. « Tout afficher » (all) court-circuite ce
// plafond : c'est un choix EXPLICITE de l'utilisateur (bouton dédié).
export const HISTORY_PAGE_MAX = 2000;

export interface UiHistoryWindowMeta {
  /** Index du PREMIER message envoyé, dans la liste complète (curseur). */
  from: number;
  /** Nombre total de messages UI de la session. */
  total: number;
  /** True s'il reste des messages antérieurs non envoyés. */
  hasMore: boolean;
}

export interface UiHistoryWindow extends UiHistoryWindowMeta {
  messages: any[];
  /** Index exclusif de fin de la fenêtre (= index du premier message NON envoyé). */
  end: number;
}

/** Convertit en entier tronqué, ou renvoie fallback si non numérique. */
function toIntOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Calcule la tranche d'historique à envoyer (helper PUR, testable).
 *
 * Fenêtre par défaut : les N derniers messages (count, défaut
 * HISTORY_PAGE_SIZE). `before` = curseur EXCLUSIF (index dans la liste
 * complète du premier message non chargé par le client) — les messages
 * [before-count, before-1] sont renvoyés. `beforeId` (id du premier message
 * déjà chargé) prime sur `before` quand il est trouvé dans la liste : le
 * curseur survit ainsi à tout décalage d'index (restart, purge d'entrées).
 * La liste `full` (buildFullUiHistory) est APPEND-ONLY : les index des
 * messages anciens sont stables entre deux appels, le curseur numérique seul
 * suffirait — beforeId est la ceinture de sécurité.
 *
 * `all: true` renvoie tout ce qui précède le curseur (from = 0) : utilisé
 * pour « Tout afficher », où l'utilisateur demande explicitement le poids.
 */
export function sliceUiHistoryWindow(
  full: any[],
  opts?: { before?: unknown; beforeId?: unknown; count?: unknown; all?: boolean },
): UiHistoryWindow {
  const total = Array.isArray(full) ? full.length : 0;
  const count = opts?.all
    ? Math.max(total, 1)
    : Math.min(Math.max(toIntOr(opts?.count, HISTORY_PAGE_SIZE), 1), HISTORY_PAGE_MAX);
  // Curseur par défaut = fin de liste (première page = les plus récents).
  let end = total;
  if (opts?.before !== undefined && opts?.before !== null) {
    end = Math.min(Math.max(toIntOr(opts.before, total), 0), total);
  }
  if (opts?.beforeId !== undefined && opts?.beforeId !== null && opts?.beforeId !== "") {
    const idx = (full as any[]).findIndex((m: any) => m?.id === String(opts?.beforeId));
    if (idx >= 0) end = Math.min(idx, total);
  }
  const from = Math.max(0, end - count);
  return { messages: full.slice(from, end), from, total, hasMore: from > 0, end };
}