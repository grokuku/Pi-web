/**
 * Filet de sécurité « réflexion seule ⇒ réponse » — côté HARNESS (délégués).
 *
 * Cause racine (incident Beam) : certains services renvoient TOUT leur contenu
 * dans le champ de RAISONNEMENT en laissant le texte vide. Le SDK convertit
 * alors légitimement ce flux en un unique bloc `thinking`, sans aucun bloc
 * `text`. Or les délégués du harness ne lisaient QUE les blocs `.text`
 * (extensions/harness-orchestrator/index.ts, `fullResponse` et
 * `collectExpertResponse`) ⇒ tokens comptés, réponse VIDE à l'écran
 * (« j'ai juste un compte de tokens mais pas de vraie réponse »).
 *
 * SOURCE DE VÉRITÉ du comportement : `promoteThinkingOnlyAnswer`
 * (frontend/src/utils/pi-events.ts), qui protège déjà la session PRINCIPALE.
 * Ce module en reproduit la logique À L'IDENTIQUE — même critère STRICT, pour
 * ne jamais reclasser du vrai raisonnement en réponse :
 *   - TOUS les blocs du tour sont de type `thinking` (aucun texte, aucun outil) ;
 *   - le texte de réflexion est non vide (après trim) ;
 *   - aucun toolCall ;
 *   - stopReason !== "error" (un échec doit rester visible comme tel).
 * Le texte n'est JAMAIS mélangé à de la réflexion : si du texte existe, il est
 * utilisé tel quel et la réflexion est ignorée.
 *
 * Deux ajouts propres au harness (absents du frontend, qui n'a pas de place
 * pour un préfixe) :
 *   - {@link markThinkingFallback} : MARQUEUR VISIBLE — la réponse reconstruite
 *     n'est PAS le texte final du modèle, l'utilisateur doit le savoir ;
 *   - {@link emptyResponseMessage} : message d'erreur ACTIONNABLE quand
 *     vraiment rien n'a été produit (ni texte ni réflexion).
 *
 * L'extension harness n'est PAS couverte par vitest (elle dépend du SDK) :
 * toute la logique testable vit ici, dans un module backend PUR (aucun import
 * Express, aucun I/O, aucun appel LLM), résolu par jiti comme harness-archive.
 */

/** Bloc de contenu assistant réduit à ce dont le filet a besoin. */
export type HarnessBlockKind = "text" | "thinking" | "toolCall";

export interface HarnessAssistantBlock {
  kind: HarnessBlockKind;
  /** Texte du bloc (`""` pour un toolCall). */
  text: string;
}

/** Clés d'outil reconnues (mêmes variantes que le frontend, SDK compris). */
const TOOL_BLOCK_TYPES = new Set(["toolCall", "tool_use", "function"]);

/**
 * Convertit un `content` de message assistant en blocs typés.
 * Miroir de `blocksFromContent` (frontend/src/utils/pi-events.ts) : renvoie
 * `undefined` quand il n'y a aucun bloc exploitable (repli identique côté
 * critère : « aucun texte agrégé » ⇔ équivalent).
 */
export function blocksFromAssistantContent(content: unknown): HarnessAssistantBlock[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks: HarnessAssistantBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as any;
    if (b.type === "text") {
      blocks.push({ kind: "text", text: typeof b.text === "string" ? b.text : "" });
    } else if (b.type === "thinking") {
      blocks.push({ kind: "thinking", text: typeof b.thinking === "string" ? b.thinking : "" });
    } else if (TOOL_BLOCK_TYPES.has(b.type)) {
      blocks.push({ kind: "toolCall", text: "" });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

/** Textes agrégés d'un `content` (blocs absents ⇒ chaînes vides). */
function aggregateContent(content: unknown): {
  blocks: HarnessAssistantBlock[] | undefined;
  contentText: string;
  thinkingText: string;
  hasToolCalls: boolean;
} {
  const blocks = blocksFromAssistantContent(content);
  let contentText = "";
  let thinkingText = "";
  let hasToolCalls = false;
  for (const b of blocks ?? []) {
    if (b.kind === "text") contentText += b.text;
    else if (b.kind === "thinking") thinkingText += b.text;
    else hasToolCalls = true;
  }
  return { blocks, contentText, thinkingText, hasToolCalls };
}

/**
 * Critère STRICT de promotion « réflexion seule ⇒ réponse » — copie de
 * `promoteThinkingOnlyAnswer` (frontend/src/utils/pi-events.ts), à l'identique.
 * Renvoie le texte de réflexion à utiliser comme réponse, ou `null` si le tour
 * ne doit PAS être promu (non-régression : tout tour normal reste inchangé).
 */
export function promoteThinkingOnlyAnswer(input: {
  blocks: HarnessAssistantBlock[] | undefined;
  contentText: string;
  thinkingText: string;
  hasToolCalls: boolean;
  stopReason?: string;
}): string | null {
  const { blocks, contentText, thinkingText, hasToolCalls, stopReason } = input;
  if (hasToolCalls || stopReason === "error") return null;
  if (!thinkingText.trim()) return null;
  // « tous les blocs sont de type thinking » : on exige des blocs explicites et
  // tous `thinking`. Repli (blocs absents) : aucun texte agrégé → équivalent.
  const allThinking = blocks && blocks.length > 0
    ? blocks.every((b) => b.kind === "thinking")
    : contentText.trim() === "";
  if (!allThinking) return null;
  return thinkingText;
}

export interface ThinkingFallback {
  /** Réponse reconstruite (réflexion des tours promus, joints par "\n\n"). */
  text: string;
  /** Caractères utiles récupérés (diagnostic / journal). */
  chars: number;
}

/**
 * Applique le filet à une liste de messages de session (forme SDK) : chaque
 * tour assistant est examiné INDÉPENDAMMENT (comme le frontend, qui traite un
 * `message_end` à la fois), puis les tours promus sont agrégés.
 * Renvoie `null` si aucun tour n'est promouvable (⇒ texte prioritaire, ou
 * vraie réponse vide quand il n'y a rien du tout).
 */
export function promoteThinkingOnlyAnswerFromMessages(messages: unknown): ThinkingFallback | null {
  if (!Array.isArray(messages)) return null;
  const promoted: string[] = [];
  let hasText = false;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as any;
    if (m.role !== "assistant") continue;
    const stopReason = typeof m.stopReason === "string" ? m.stopReason : undefined;
    const aggregate = aggregateContent(m.content);
    // Un TEXTE quelque part dans la conversation reste PRIORITAIRE : la
    // réflexion ne sert de réponse que si RIEN n'a été écrit (jamais de mélange
    // réflexion + texte dans un même rendu).
    if (aggregate.contentText.trim()) hasText = true;
    const text = promoteThinkingOnlyAnswer({ ...aggregate, stopReason });
    if (text && text.trim()) promoted.push(text);
  }
  if (hasText || promoted.length === 0) return null;
  const joined = promoted.join("\n\n");
  return { text: joined, chars: joined.trim().length };
}

// ── Marquage VISIBLE de la réponse reconstruite ──────────────────────────

/**
 * Marqueur apposé en tête d'une réponse reconstruite depuis la réflexion :
 * l'utilisateur doit savoir que ce n'est PAS le texte final du modèle (sinon on
 * remplacerait un mensonge — « rien » — par un autre — « voici la réponse »).
 */
export const THINKING_FALLBACK_MARKER =
  "💭 Réponse reconstruite depuis la RÉFLEXION du modèle — aucun texte final n'a été produit (à vérifier).";

/** Préfixe la réponse du marqueur visible. Idempotent. */
export function markThinkingFallback(text: string): string {
  if (text.startsWith(THINKING_FALLBACK_MARKER)) return text;
  return `${THINKING_FALLBACK_MARKER}\n\n${text}`;
}

// ── Message d'erreur ACTIONNABLE (vraiment rien produit) ─────────────────

/**
 * Message rendu à l'orchestrateur quand un délégué n'a produit NI texte NI
 * réflexion exploitable. Il doit être ACTIONNABLE : dire que le modèle n'a
 * peut-être émis que du raisonnement et orienter vers les DEUX leviers réels
 * (niveau de réflexion du service, déclaration `reasoning: true` dans la
 * bibliothèque de modèles — jamais une config inventée).
 */
export function emptyResponseMessage(input: {
  /** Libellé humain de la fonction déléguée (« Exécution », …). */
  funcLabel: string;
  /** Label "provider/model" effectif (diagnostic). */
  modelLabel: string;
  /** Caractères de réflexion observés au flux (0 = rien du tout). */
  thinkingChars?: number;
}): string {
  const thinkingNote = (input.thinkingChars ?? 0) > 0
    ? `Le modèle a bien émis du raisonnement (${input.thinkingChars} car.) mais aucun texte final exploitable.`
    : `Le modèle n'a produit ni texte ni réflexion exploitable (le raisonnement éventuel n'a pas été restitué).`;
  return [
    `❌ ${input.funcLabel} n'a produit aucune réponse (modèle ${input.modelLabel}).`,
    thinkingNote,
    `Pistes : vérifier le niveau de réflexion du service (un modèle à raisonnement peut renvoyer ` +
      `tout son contenu dans le raisonnement, sans texte), ou déclarer ce modèle \`reasoning: true\` ` +
      `dans la bibliothèque de modèles.`,
    `Session archivée dans .data/logs/harness/ (cause : réponse vide).`,
  ].join(" ");
}
