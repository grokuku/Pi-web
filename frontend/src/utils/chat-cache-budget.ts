// ── Plafonnement du cache local du fil : taille en OCTETS, pas en messages ──
// MESURÉ (voir chat-cache-budget.test.ts) : le plafond historique `200
// messages` ne protège RIEN. Un fil réaliste de 200 messages ne pèse que
// ~1,2 Mo, alors que CINQ messages porteurs d'une sortie de sous-agent
// (~1 Mo chacun, ≈ 257k tokens) suffisent à dépasser le quota de ~5 Mo de
// localStorage. Le volume est donc porté par QUELQUES messages, pas par leur
// nombre : le plafond doit se compter en octets sérialisés.
//
// Ce module est PUR (aucun accès au stockage) : il décide ce qui part au
// cache — N derniers messages, sorties d'outils tronquées — et retire les
// plus ANCIENS jusqu'à tenir dans le budget. Les messages récents sont donc
// toujours conservés (exigence : « dépassement → les récents restent »).
import type { DisplayMessage, ToolCallInfo } from "../types";

/** Taille sérialisée d'une valeur JSON (octets UTF-8). */
export function utf8Bytes(value: unknown): number {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof json !== "string") return 0;
  if (typeof TextEncoder === "undefined") return json.length * 2;
  return new TextEncoder().encode(json).length;
}

/** Suffixe ajouté à un contenu tronqué par le cache (l'utilisateur est prévenu). */
export const CACHE_TRUNCATION_SUFFIX = "\n\n…[contenu tronqué par le cache local]";

/** Longueur max conservée par bloc lourd (sortie d'outil, bash, réflexion). */
export const CHAT_CACHE_BLOCK_MAX_CHARS = 4_000;

/**
 * Longueur max du TEXTE d'un message conservé au cache. Le contenu est la
 * conversation elle-même, donc le seuil est large (20 000 caractères) : seuls
 * les messages exceptionnels (rapports de sous-agents de ~1 Mo) sont réduits.
 * Ils restent lisibles en tête et sont rechargés en entier depuis le serveur.
 */
export const CHAT_CACHE_CONTENT_MAX_CHARS = 20_000;

/** Nombre de messages récents conservés par défaut (borne de sécurité). */
export const CHAT_CACHE_MAX_MESSAGES_DEFAULT = 300;

/** Garde-fou : on ne descend jamais sous ce nombre de messages récents. */
export const CHAT_CACHE_MIN_KEPT_MESSAGES = 1;

function truncateText(value: string | undefined | null, maxChars: number): { text: string; truncated: boolean } {
  if (typeof value !== "string" || value.length <= maxChars) {
    return { text: typeof value === "string" ? value : "", truncated: false };
  }
  return { text: value.slice(0, maxChars) + CACHE_TRUNCATION_SUFFIX, truncated: true };
}

function truncateToolCall(call: ToolCallInfo, maxChars: number): { call: ToolCallInfo; truncated: boolean } {
  const { text, truncated } = truncateText(call?.output, maxChars);
  if (!truncated) return { call, truncated: false };
  // Copie : jamais de mutation des messages affichés (le fil live partage
  // ses objets avec le rendu React).
  return { call: { ...call, output: text }, truncated: true };
}

/**
 * Copie superficielle des messages en TRONQUANT les blocs qui pèsent :
 * sorties d'outils, sorties bash, résultats d'outils orphelins, réflexion et
 * données d'images inline (base64). Le TEXTE de conversation (`content`) est
 * conservé : c'est ce que l'utilisateur relit au premier rendu.
 */
export function truncateHeavyFields(
  messages: DisplayMessage[],
  maxChars: number = CHAT_CACHE_BLOCK_MAX_CHARS,
  contentMaxChars: number = CHAT_CACHE_CONTENT_MAX_CHARS
): { messages: DisplayMessage[]; truncated: boolean } {
  let truncated = false;
  const out = messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    let next: DisplayMessage = m;

    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const calls: ToolCallInfo[] = [];
      let callsChanged = false;
      for (const call of m.toolCalls) {
        const r = truncateToolCall(call, maxChars);
        if (r.truncated) { callsChanged = true; truncated = true; }
        calls.push(r.call);
      }
      if (callsChanged) next = { ...next, toolCalls: calls };
    }

    if (m.toolResult) {
      const r = truncateToolCall(m.toolResult, maxChars);
      if (r.truncated) { truncated = true; next = { ...next, toolResult: r.call }; }
    }

    if (m.bashExecution && typeof m.bashExecution.output === "string" && m.bashExecution.output.length > maxChars) {
      truncated = true;
      next = {
        ...next,
        bashExecution: { ...m.bashExecution, output: m.bashExecution.output.slice(0, maxChars) + CACHE_TRUNCATION_SUFFIX },
      };
    }

    if (typeof m.content === "string" && m.content.length > contentMaxChars) {
      truncated = true;
      next = { ...next, content: m.content.slice(0, contentMaxChars) + CACHE_TRUNCATION_SUFFIX };
    }

    if (typeof m.thinking === "string" && m.thinking.length > maxChars) {
      truncated = true;
      next = { ...next, thinking: m.thinking.slice(0, maxChars) + CACHE_TRUNCATION_SUFFIX };
    }

    // Images inline (base64) : jamais mises en cache — seul le nom/mime reste,
    // l'URL serveur (`attachmentId`) suffit au rendu après resync.
    if (Array.isArray(m.images) && m.images.some((img) => typeof img?.data === "string" && img.data.length > 0)) {
      truncated = true;
      next = {
        ...next,
        images: m.images.map((img) => ({ ...img, data: undefined })),
      };
    }

    return next;
  });
  return { messages: out, truncated };
}

export interface CacheFitOptions {
  /** Budget en octets sérialisés pour CETTE entrée de cache. */
  maxBytes: number;
  /** Plafond du nombre de messages conservés (les plus récents). */
  maxMessages?: number;
  /** Longueur max par bloc lourd. */
  blockMaxChars?: number;
  /** Longueur max du texte de conversation (`content`). */
  contentMaxChars?: number;
  /** false → ne pas tronquer les blocs lourds (plafond en messages seulement). */
  truncateBlocks?: boolean;
}

export interface CacheFitResult {
  /** Messages à écrire (les plus récents, blocs lourds tronqués). */
  messages: DisplayMessage[];
  /** Taille sérialisée du résultat, en octets. */
  bytes: number;
  /** Nombre de messages évincés (les plus anciens). */
  dropped: number;
  /** true si au moins un bloc lourd a été tronqué. */
  truncated: boolean;
  /** false → même réduit à un message, ça ne tient pas (rien d'utile à écrire). */
  fits: boolean;
}

/** Taille sérialisée des N derniers messages d'une liste. */
function bytesOfTail(messages: DisplayMessage[], keep: number): number {
  return utf8Bytes(messages.slice(messages.length - keep));
}

/**
 * Ajuste un fil au budget du cache.
 *
 * Ordre des leviers (du moins destructeur au plus destructeur) :
 *  1. ne garder que les `maxMessages` derniers ;
 *  2. tronquer les blocs lourds (sorties d'outils, réflexion, images inline) ;
 *  3. retirer les messages les plus ANCIENS jusqu'à tenir dans `maxBytes`
 *     (recherche dichotomique sur le nombre de messages récents conservés).
 * Si un SEUL message dépasse encore le budget, `fits=false` et la liste est
 * celle de ce dernier message (l'appelant décide de ne rien écrire).
 */
export function fitMessagesToBudget(
  messages: DisplayMessage[],
  opts: CacheFitOptions
): CacheFitResult {
  const maxMessages = Math.max(CHAT_CACHE_MIN_KEPT_MESSAGES, Math.trunc(opts.maxMessages ?? CHAT_CACHE_MAX_MESSAGES_DEFAULT));
  const maxBytes = Math.max(0, Math.trunc(opts.maxBytes));
  const blockMaxChars = Math.max(0, Math.trunc(opts.blockMaxChars ?? CHAT_CACHE_BLOCK_MAX_CHARS));
  const contentMaxChars = Math.max(0, Math.trunc(opts.contentMaxChars ?? CHAT_CACHE_CONTENT_MAX_CHARS));

  const source = Array.isArray(messages) ? messages.filter((m) => m && typeof m === "object") : [];
  const windowed = source.length > maxMessages ? source.slice(-maxMessages) : source;
  const prepared = opts.truncateBlocks === false
    ? { messages: windowed, truncated: false }
    : truncateHeavyFields(windowed, blockMaxChars, contentMaxChars);

  const list = prepared.messages;
  if (list.length === 0) {
    return { messages: [], bytes: 0, dropped: 0, truncated: prepared.truncated, fits: true };
  }

  const total = bytesOfTail(list, list.length);
  if (total <= maxBytes) {
    return { messages: list, bytes: total, dropped: source.length - list.length, truncated: prepared.truncated, fits: true };
  }

  // Recherche dichotomique du plus grand suffixe qui tient dans le budget.
  let lo = CHAT_CACHE_MIN_KEPT_MESSAGES;
  let hi = list.length;
  let best = -1;
  let bestBytes = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bytes = bytesOfTail(list, mid);
    if (bytes <= maxBytes) {
      best = mid;
      bestBytes = bytes;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === -1) {
    // Même le dernier message seul ne tient pas : on ne garde que lui pour que
    // l'appelant sache quoi signaler (fits=false), sans écrire de monstre.
    const last = list.slice(-CHAT_CACHE_MIN_KEPT_MESSAGES);
    return {
      messages: last,
      bytes: utf8Bytes(last),
      dropped: source.length - last.length,
      truncated: prepared.truncated,
      fits: false,
    };
  }

  return {
    messages: list.slice(list.length - best),
    bytes: bestBytes,
    dropped: source.length - best,
    truncated: prepared.truncated,
    fits: true,
  };
}
