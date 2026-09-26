/**
 * Garde-fou « réponse vide par épuisement du budget par la réflexion ».
 *
 * Cause racine du bug PEH : sans `reasoning_effort` explicite (ou avec un budget
 * de sortie trop court), Ollama auto-active la réflexion ; celle-ci peut consommer
 * TOUT le budget `max_tokens` ⇒ tour assistant « réflexion seule », `content` vide,
 * `finish_reason: "length"` (SDK `stopReason: "length"`).
 *
 * Choix d'implémentation : DÉTECTION PURE + JOURNALISATION d'un avertissement
 * explicite. Le reprompt automatique (même borné à un essai) a été écarté : il
 * déclencherait un second appel LLM facturé, susceptible de boucler, alors que le
 * filet d'affichage `promoteThinkingOnlyAnswer` (frontend/src/utils/pi-events.ts)
 * évite déjà un écran totalement vide. Ce module n'a donc AUCUN effet de bord sur
 * le flux d'événements (pas de nouvelle émission, pas de tour supplémentaire).
 */

/** Bloc de contenu assistant minimal (structurel, sans dépendre du SDK). */
interface AssistantContentBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
}

export interface ThinkingOnlyTruncatedTurn {
  /** Caractères de texte utile (hors espaces). */
  textChars: number;
  /** Caractères de réflexion. */
  thinkingChars: number;
  stopReason: string;
  model?: string;
  provider?: string;
  /** Niveau de réflexion effectivement utilisé par le provider, si connu. */
  providerThinkingLevel?: string;
}

/**
 * Détecte un tour assistant « réflexion seule, réponse vide, tronquée » :
 *   - `role: "assistant"` ;
 *   - `stopReason` de type LONGUEUR (`length` / `max_tokens`) = budget épuisé ;
 *   - AUCUN bloc texte non vide et AUCUN appel d'outil ;
 *   - au moins un bloc de réflexion non vide.
 * Renvoie le diagnostic, ou `null` si le tour est normal (non-régression).
 */
export function detectThinkingOnlyTruncatedTurn(message: unknown): ThinkingOnlyTruncatedTurn | null {
  if (!message || typeof message !== "object") return null;
  const m = message as any;
  if (m.role !== "assistant") return null;

  const stopReason = typeof m.stopReason === "string" ? m.stopReason : "";
  const rawStop = typeof m.rawStopReason === "string" ? m.rawStopReason : "";
  // Troncature par le budget de sortie : stopReason SDK "length", ou raisons
  // brutes du provider "length" / "max_tokens".
  const truncated =
    stopReason === "length" ||
    /^(length|max_?tokens)$/i.test(stopReason) ||
    /max_?tokens|length/i.test(rawStop);
  if (!truncated) return null;

  const content: AssistantContentBlock[] = Array.isArray(m.content) ? m.content : [];
  let textChars = 0;
  let thinkingChars = 0;
  let hasToolCall = false;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") textChars += b.text.trim().length;
    else if (b.type === "thinking" && typeof b.thinking === "string") thinkingChars += b.thinking.trim().length;
    else if (b.type === "toolCall") hasToolCall = true;
  }

  // Un tour avec outil, du texte, ou sans réflexion n'est PAS le cas visé.
  if (hasToolCall || textChars > 0 || thinkingChars === 0) return null;

  return {
    textChars,
    thinkingChars,
    stopReason: stopReason || rawStop,
    model: typeof m.model === "string" ? m.model : undefined,
    provider: typeof m.provider === "string" ? m.provider : undefined,
    providerThinkingLevel: typeof m.providerThinkingLevel === "string" ? m.providerThinkingLevel : undefined,
  };
}

/**
 * Journalise un avertissement EXPLICITE si l'événement `message_end` porte un tour
 * « réflexion seule tronqué ». Ne fait rien pour tout autre événement / tour normal.
 * Retourne le diagnostic (utile aux tests) ou `null`.
 */
export function warnIfThinkingOnlyTruncatedTurn(event: unknown, projectId: string): ThinkingOnlyTruncatedTurn | null {
  if (!event || typeof event !== "object" || (event as any).type !== "message_end") return null;
  const diag = detectThinkingOnlyTruncatedTurn((event as any).message);
  if (!diag) return null;
  const target = diag.model ? ` [${diag.provider || "?"}/${diag.model}]` : "";
  const level = diag.providerThinkingLevel ? ` niveau=${diag.providerThinkingLevel}` : "";
  console.warn(
    `[response-guard] projet ${projectId} : tour assistant « réflexion seule » TRONQUÉ ` +
    `(stopReason=${diag.stopReason}${level}${target}) — réflexion ${diag.thinkingChars} car., texte 0, ` +
    `budget max_tokens épuisé par la réflexion. Réponse vide : vérifier le niveau de réflexion ` +
    `et le budget de sortie du modèle.`,
  );
  return diag;
}
