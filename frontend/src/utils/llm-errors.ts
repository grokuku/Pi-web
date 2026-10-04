// ── Erreurs du fournisseur LLM : classification + regroupement des tentatives ─
// Logique PURE (testée dans llm-errors.test.ts), extraite du rendu pour rester
// indépendante de React.
//
// Contexte (incident 500 Ollama Cloud) : le SDK Pi retente automatiquement les
// erreurs transitoires (settings.retry : 1 essai + 3 reprises par défaut) et
// conserve CHAQUE tentative ratée dans l'historique. Le fil affichait donc N
// pavés rouges identiques, sans explication compréhensible ni action possible.
//
// Ce module fournit :
//   1. `classifyLlmError` — statut HTTP + ref + type d'erreur, à partir de
//      l'errorMessage brut du SDK (formats réels : `500: {json}`,
//      `503 "Server overloaded…"`, `429 …`, `Request was aborted`, …) ;
//   2. le mapping vers les clés i18n (titre + phrase pédagogique) ;
//   3. `groupProviderFailures` — regroupement des tentatives ratées
//      CONSÉCUTIVES d'un même tour en UN SEUL bloc repliable, avec le cas
//      « une reprise a fini par réussir » (les tentatives ratées ne doivent
//      pas laisser croire que le tour a échoué).

import type { DisplayMessage } from "../types";

// ── Classification ─────────────────────────────────────────────────────────

export type LlmErrorKind =
  | "server" // 5xx générique (500, 502…)
  | "overloaded" // 503 / « server overloaded »
  | "rate_limit" // 429
  | "timeout" // 408/504/524, « timed out »
  | "auth" // 401/403
  | "quota" // 402
  | "bad_request" // autre 4xx
  | "network" // connexion coupée
  | "aborted" // annulation locale
  | "unknown";

export interface LlmErrorInfo {
  kind: LlmErrorKind;
  /** Statut HTTP extrait du message, si présent. */
  httpStatus?: number;
  /** Référence fournisseur (ex. `(ref: <uuid>)`), si présente. */
  ref?: string;
  /** Texte brut nettoyé (une ligne, tronqué, secrets masqués). */
  detail: string;
}

/** Longueur max du détail brut affiché (diagnostic, jamais un dump complet). */
export const LLM_ERROR_DETAIL_MAX = 400;

/** Masque les motifs de secrets connus avant tout affichage (ceinture). */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]")
    .replace(
      /((?:api[_-]?key|apikey|access[_-]?token|authorization)(?:["']?\s*[:=]\s*["']?))[^"',\s)\]}]+/gi,
      "$1[redacted]",
    );
}

/**
 * Classifie un `errorMessage` de provider (même analyse que le log backend
 * C3 — backend/src/pi/provider-retry-log.ts — mais orientée affichage).
 */
export function classifyLlmError(raw?: string | null): LlmErrorInfo {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { kind: "unknown", detail: "" };

  const statusMatch = /^(\d{3})\b/.exec(text);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
  const refMatch = /\(ref:\s*([^)\s]+)\)/i.exec(text) ?? /"ref"\s*:\s*"([^"]+)"/i.exec(text);
  const ref = refMatch ? refMatch[1].trim() : undefined;

  const lower = text.toLowerCase();
  let kind: LlmErrorKind;
  if (httpStatus === 401 || httpStatus === 403) kind = "auth";
  else if (httpStatus === 402) kind = "quota";
  else if (httpStatus === 429) kind = "rate_limit";
  else if (httpStatus === 408 || httpStatus === 504 || httpStatus === 524) kind = "timeout";
  else if (httpStatus !== undefined && httpStatus >= 500) {
    kind = httpStatus === 503 && /overload/.test(lower) ? "overloaded" : "server";
  } else if (httpStatus !== undefined && httpStatus >= 400) kind = "bad_request";
  else if (/overload/.test(lower)) kind = "overloaded";
  else if (/rate.?limit|too many requests/.test(lower)) kind = "rate_limit";
  else if (/timed?\s*out|timeout/.test(lower)) kind = "timeout";
  else if (/abort/.test(lower)) kind = "aborted";
  else if (/connection|socket|terminated|network|econn/.test(lower)) kind = "network";
  else kind = "unknown";

  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  const detail = flat.length <= LLM_ERROR_DETAIL_MAX ? flat : `${flat.slice(0, LLM_ERROR_DETAIL_MAX - 1)}…`;
  return { kind, httpStatus, ref, detail };
}

/** Clé i18n du TITRE du bloc d'erreur (varie selon la nature de l'échec). */
export function llmErrorTitleKey(kind: LlmErrorKind): string {
  switch (kind) {
    case "aborted":
      return "chat.providerErrorTitleAborted";
    case "bad_request":
      return "chat.providerErrorTitleRequest";
    case "unknown":
      return "chat.providerErrorTitleUnknown";
    default:
      return "chat.providerErrorTitle";
  }
}

/** Clé i18n de la phrase pédagogique (non technique) associée au type. */
export function llmErrorMessageKey(kind: LlmErrorKind): string {
  switch (kind) {
    case "server":
      return "chat.providerErrorMessageServer";
    case "overloaded":
      return "chat.providerErrorMessageOverloaded";
    case "rate_limit":
      return "chat.providerErrorMessageRateLimit";
    case "timeout":
      return "chat.providerErrorMessageTimeout";
    case "auth":
      return "chat.providerErrorMessageAuth";
    case "quota":
      return "chat.providerErrorMessageQuota";
    case "network":
      return "chat.providerErrorMessageNetwork";
    case "aborted":
      return "chat.providerErrorMessageAborted";
    case "bad_request":
      return "chat.providerErrorMessageBadRequest";
    default:
      return "chat.providerErrorMessageUnknown";
  }
}

/** « ollama-cloud » → « Ollama Cloud » (lisible par un non-développeur). */
export function prettyProviderName(provider?: string | null): string {
  if (typeof provider !== "string" || !provider.trim()) return "";
  return provider
    .trim()
    .replace(/[-_.]+/g, " ")
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export interface LlmErrorDisplay {
  info: LlmErrorInfo;
  titleKey: string;
  messageKey: string;
  /** Args positionnels de `t(messageKey, ...)` : modèle, provider, ref, détail. */
  args: [model: string, provider: string, ref: string, detail: string];
}

/** Prépare tout ce qu'il faut au rendu (clés i18n + arguments). */
export function llmErrorDisplay(input: {
  errorMessage?: string;
  provider?: string;
  model?: string;
}): LlmErrorDisplay {
  const info = classifyLlmError(input.errorMessage);
  return {
    info,
    titleKey: llmErrorTitleKey(info.kind),
    messageKey: llmErrorMessageKey(info.kind),
    args: [
      input.model?.trim() || "",
      prettyProviderName(input.provider),
      info.ref || "",
      info.detail,
    ],
  };
}

// ── Regroupement des tentatives ratées d'un tour assistant ─────────────────

export interface ProviderErrorAttempt {
  id: string;
  timestamp?: number;
  errorMessage?: string;
  provider?: string;
  model?: string;
}

export interface ProviderErrorRun {
  /** Tentatives ratées consécutives (≥ 1), dans l'ordre chronologique. */
  attempts: ProviderErrorAttempt[];
  /** Id de la 1re tentative — base de blockId STABLE pour le repli. */
  anchorId: string;
}

/** Message assistant en échec (mêmes critères que BUG-68 : plus larges que le regroupement). */
export function isFailedAssistantMessage(m: DisplayMessage): boolean {
  return m.role === "assistant" && (m.stopReason === "error" || !!m.errorMessage);
}

/**
 * Tentative ratée SANS contenu : c'est le cas d'une panne provider (5xx)
 * survenue avant toute sortie — le SDK en retente une nouvelle. Une tentative
 * avec du texte/outils reste affichée normalement (on ne masque jamais un
 * contenu réellement produit).
 */
export function isEmptyFailedAttempt(m: DisplayMessage): boolean {
  if (!isFailedAssistantMessage(m)) return false;
  if (m.kind) return false;
  if (m.toolCalls && m.toolCalls.length > 0) return false;
  return !(m.content || "").trim() && !(m.thinking || "").trim();
}

export function attemptFromMessage(m: DisplayMessage): ProviderErrorAttempt {
  return {
    id: m.id,
    timestamp: typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : undefined,
    errorMessage: m.errorMessage,
    provider: m.provider,
    model: m.model,
  };
}

export function buildProviderErrorRun(attempts: DisplayMessage[]): ProviderErrorRun {
  if (attempts.length === 0) throw new Error("buildProviderErrorRun: au moins une tentative requise");
  return {
    attempts: attempts.map(attemptFromMessage),
    anchorId: attempts[0].id,
  };
}

/**
 * Élément de rendu d'un groupe assistant :
 *  - `message`   : un message rendu comme avant ; `failedAttemptsBefore` porte
 *                  les tentatives ratées qui l'ont PRÉCÉDÉ quand une reprise a
 *                  fini par réussir (rendues en note repliable SOUS le message
 *                  réussi, jamais comme un échec) ;
 *  - `failures`  : un bloc regroupé de tentatives ratées (échec définitif).
 */
export type AssistantTurnItem =
  | { kind: "message"; message: DisplayMessage; failedAttemptsBefore?: ProviderErrorRun }
  | { kind: "failures"; run: ProviderErrorRun };

/**
 * Regroupe les tentatives ratées CONSÉCUTIVES d'un même tour :
 *  - tentatives vides → UN seul bloc « N tentatives » (échec définitif) ;
 *  - run suivi d'un message assistant NORMAL → le run est rattaché à ce
 *    message réussi en note repliable (cas « reprise réussie ») ;
 *  - un message en échec AVEC contenu reste rendu normalement (jamais masqué) ;
 *  - un run suivi d'un message NON-assistant (bord de groupe) est rendu comme
 *    bloc autonome (pas de rattachement à un message d'un autre rôle).
 * Pure : ne mute pas `messages`, préserve l'ordre.
 */
export function groupProviderFailures(messages: DisplayMessage[]): AssistantTurnItem[] {
  const items: AssistantTurnItem[] = [];
  let run: DisplayMessage[] = [];

  const flushRun = (succeededBy?: DisplayMessage) => {
    if (run.length === 0) return;
    const built = buildProviderErrorRun(run);
    run = [];
    if (succeededBy && succeededBy.role === "assistant" && !isFailedAssistantMessage(succeededBy)) {
      items.push({ kind: "message", message: succeededBy, failedAttemptsBefore: built });
    } else {
      items.push({ kind: "failures", run: built });
    }
  };

  for (const m of messages) {
    if (isEmptyFailedAttempt(m)) {
      run.push(m);
      continue;
    }
    if (isFailedAssistantMessage(m)) {
      // Échec AVEC contenu : bloc d'erreur propre, puis le message normal.
      flushRun();
      items.push({ kind: "message", message: m });
      continue;
    }
    if (run.length > 0) {
      flushRun(m);
      if (items[items.length - 1]?.kind !== "message") items.push({ kind: "message", message: m });
      continue;
    }
    items.push({ kind: "message", message: m });
  }
  flushRun();
  return items;
}
