/**
 * provider-retry-log.ts — Observabilité des échecs FOURNISSEUR et des reprises
 * automatiques du SDK Pi (correctif C3).
 *
 * Contexte (incident 500 Ollama Cloud) : les échecs provider et les 3 reprises
 * automatiques du SDK (auto_retry_start/auto_retry_end, settings.retry par
 * défaut) ne laissaient AUCUNE trace dans `.data/logs/backend-*.log` — le
 * diagnostic n'a pu aboutir qu'en fouillant les transcripts de session.
 *
 * Ce module est PUR (aucune dépendance serveur ni effet de bord) : il analyse
 * l'`errorMessage` produit par le SDK, classifie l'erreur, en extrait le statut
 * HTTP et la `ref` fournisseur, puis construit la ligne + les détails à écrire
 * via le logger fichier (le caller choisit le niveau/catégorie et logge).
 *
 * SÉCURITÉ : aucune clé API, aucun contenu de prompt n'est loggé. L'errorMessage
 * est nettoyé (une ligne, tronqué) et les motifs de secrets connus
 * (Bearer, sk-…, api_key: …) sont explicitement masqués par redactSecrets —
 * ceinture de sécurité au cas où un provider renverrait un extrait de requête.
 */

// ── Classification ─────────────────────────────────────────────────────────

export type ProviderErrorKind =
  | "server" // 5xx générique (500, 502…)
  | "overloaded" // 503 / « server overloaded »
  | "rate_limit" // 429 / « rate limit » / « too many requests »
  | "timeout" // 408/504/524, « timed out », « upstream idle timeout »
  | "auth" // 401/403 (clé invalide, abonnement)
  | "quota" // 402 (crédit épuisé)
  | "bad_request" // 4xx hors 401/402/403/408/429 (requête refusée)
  | "network" // connexion coupée (socket, terminated, ECONN…)
  | "aborted" // annulation locale (abort utilisateur/interne)
  | "unknown";

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  /** Statut HTTP extrait de l'en-tête du message, si présent. */
  httpStatus?: number;
  /** Référence fournisseur (ex. `(ref: <uuid>)`), si présente. */
  ref?: string;
  /** Message nettoyé : une ligne, secrets masqués, tronqué. */
  summary: string;
}

/** Longueur max du résumé loggé (garde-fou anti-lignes monstres). */
export const PROVIDER_ERROR_SUMMARY_MAX = 300;

/**
 * Masque les motifs de secrets connus. Un errorMessage de provider ne devrait
 * jamais en contenir, mais le log est durable : on ne prend aucun risque.
 * (Exporté pour les tests.)
 */
export function redactSecrets(text: string): string {
  return text
    // Authorization: Bearer <token>
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]")
    // Clés OpenAI-like
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]")
    // api_key / apikey / access_token / authorization : valeur
    .replace(
      /((?:api[_-]?key|apikey|access[_-]?token|authorization)(?:["']?\s*[:=]\s*["']?))[^"',\s)\]}]+/gi,
      "$1[redacted]",
    );
}

/** Réduit un texte à UNE ligne (espaces normalisés) puis le tronque. */
export function oneLineSummary(text: string, max: number = PROVIDER_ERROR_SUMMARY_MAX): string {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/**
 * Analyse un `errorMessage` de provider. Formats observés dans les transcripts :
 *   `500: {"message":"Internal Server Error (ref: <uuid>)",...}`
 *   `503 "Server overloaded, please retry shortly (ref: <uuid>)"`
 *   `429 ...` / `429: {...}` / `429 Provider returned error\n…`
 *   `524 status code (no body)`, `Request was aborted`, `Connection error.`, …
 * Ne lève jamais : une entrée inconnue est classée `unknown`.
 */
export function parseProviderError(raw: unknown): ProviderErrorInfo {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { kind: "unknown", summary: "(aucun message d'erreur)" };

  // Statut HTTP en TÊTE du message (`500: {...}`, `503 "..."`, `429 ...`)
  const statusMatch = /^(\d{3})\b/.exec(text);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;

  // Ref fournisseur : `(ref: <uuid>)` ou `"ref": "<uuid>"` (JSON)
  const refMatch = /\(ref:\s*([^)\s]+)\)/i.exec(text) ?? /"ref"\s*:\s*"([^"]+)"/i.exec(text);
  const ref = refMatch ? refMatch[1].trim() : undefined;

  const lower = text.toLowerCase();
  let kind: ProviderErrorKind;
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

  return { kind, httpStatus, ref, summary: oneLineSummary(text) };
}

// ── Entrées de log construites (pures) ─────────────────────────────────────

export type LlmLogLevel = "info" | "warn" | "error";
export type LlmLogCategory = "llm-error" | "llm-retry";

export interface LlmLogEntry {
  level: LlmLogLevel;
  category: LlmLogCategory;
  message: string;
  details: Record<string, unknown>;
}

/** Tour assistant échoué porté par un événement `message_end` du SDK. */
export interface ProviderFailureEvent {
  provider?: string;
  model?: string;
  stopReason: string;
  errorMessage: string;
}

/**
 * Détecte un `message_end` assistant en échec (stopReason `error` ou
 * errorMessage présent) et en extrait provider/modèle déclarés par le message
 * (le SDK les pose sur l'AssistantMessage — aucune donnée de session requise).
 */
export function detectProviderFailureEvent(event: unknown): ProviderFailureEvent | null {
  if (!event || typeof event !== "object" || (event as any).type !== "message_end") return null;
  const m = (event as any).message;
  if (!m || typeof m !== "object" || m.role !== "assistant") return null;
  const stopReason = typeof m.stopReason === "string" ? m.stopReason : "";
  const errorMessage = typeof m.errorMessage === "string" ? m.errorMessage : "";
  if (stopReason !== "error" && !errorMessage) return null;
  return {
    provider: typeof m.provider === "string" ? m.provider : undefined,
    model:
      typeof m.responseModel === "string"
        ? m.responseModel
        : typeof m.model === "string"
          ? m.model
          : undefined,
    stopReason,
    errorMessage,
  };
}

/**
 * Construit l'entrée de log d'un échec provider (ou null si l'événement n'est
 * pas un `message_end` assistant en échec). `durationMs` = durée de la tentative
 * ratée quand le caller la connaît.
 */
export function buildProviderFailureLog(
  event: unknown,
  projectId: string,
  durationMs?: number,
): LlmLogEntry | null {
  const failure = detectProviderFailureEvent(event);
  if (!failure) return null;
  const info = parseProviderError(failure.errorMessage);
  const who = `${failure.provider ?? "?"}/${failure.model ?? "?"}`;
  const duration = typeof durationMs === "number" && Number.isFinite(durationMs)
    ? `${Math.max(0, Math.round(durationMs))}ms`
    : "?";
  return {
    level: "error",
    category: "llm-error",
    message:
      `échec provider [${who}] type=${info.kind} durée=${duration} : ${info.summary}`,
    details: {
      projectId,
      provider: failure.provider ?? null,
      model: failure.model ?? null,
      stopReason: failure.stopReason || "error",
      kind: info.kind,
      httpStatus: info.httpStatus ?? null,
      ref: info.ref ?? null,
      durationMs:
        typeof durationMs === "number" && Number.isFinite(durationMs)
          ? Math.max(0, Math.round(durationMs))
          : null,
    },
  };
}

// ── Reprises automatiques (auto_retry_start / auto_retry_end) ──────────────
// Forme SDK 0.87.1 (dist/core/agent-session.d.ts) :
//   start : { attempt, maxAttempts, delayMs, errorMessage }
//   end   : { success, attempt, finalError? }
// `attempt`/`maxAttempts` comptent les REPRISES (settings.retry.maxRetries) ;
// le nombre total de TENTATIVES du tour = 1 essai initial + maxAttempts.

export interface RetryEventSummary {
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  success?: boolean;
  errorMessage?: string;
  finalError?: string;
}

export function detectRetryEvent(
  event: unknown,
): { phase: "start" | "end"; summary: RetryEventSummary } | null {
  if (!event || typeof event !== "object") return null;
  const e = event as any;
  if (e.type !== "auto_retry_start" && e.type !== "auto_retry_end") return null;
  return {
    phase: e.type === "auto_retry_start" ? "start" : "end",
    summary: {
      attempt: typeof e.attempt === "number" ? e.attempt : undefined,
      maxAttempts: typeof e.maxAttempts === "number" ? e.maxAttempts : undefined,
      delayMs: typeof e.delayMs === "number" ? e.delayMs : undefined,
      success: typeof e.success === "boolean" ? e.success : undefined,
      errorMessage: typeof e.errorMessage === "string" ? e.errorMessage : undefined,
      finalError: typeof e.finalError === "string" ? e.finalError : undefined,
    },
  };
}

/** Entrée de log d'un événement de reprise (null si ce n'en est pas un). */
export function buildRetryLog(event: unknown, projectId: string): LlmLogEntry | null {
  const detected = detectRetryEvent(event);
  if (!detected) return null;
  const { phase, summary } = detected;
  const attempt = summary.attempt ?? 0;

  if (phase === "start") {
    const max = typeof summary.maxAttempts === "number" ? `/${summary.maxAttempts}` : "";
    const delay = typeof summary.delayMs === "number" ? ` dans ${Math.round(summary.delayMs)}ms` : "";
    const info = parseProviderError(summary.errorMessage);
    return {
      level: "warn",
      category: "llm-retry",
      message: `reprise ${attempt}${max} programmée${delay} — cause=${info.kind} : ${info.summary}`,
      details: {
        projectId,
        phase: "start",
        attempt,
        maxAttempts: summary.maxAttempts ?? null,
        delayMs: typeof summary.delayMs === "number" ? Math.round(summary.delayMs) : null,
        kind: info.kind,
        httpStatus: info.httpStatus ?? null,
        ref: info.ref ?? null,
      },
    };
  }

  if (summary.success === true) {
    return {
      level: "info",
      category: "llm-retry",
      message: `reprise RÉUSSIE après ${attempt} reprise(s) — le tour se poursuit`,
      details: { projectId, phase: "end", success: true, attempt },
    };
  }

  const cancelled = typeof summary.finalError === "string" && /cancel|abort/i.test(summary.finalError);
  const info = parseProviderError(summary.finalError);
  return {
    level: "warn",
    category: "llm-retry",
    message: `reprises ${cancelled ? "ANNULÉES" : "ÉPUISÉES"} après ${attempt} reprise(s) — ${info.summary}`,
    details: {
      projectId,
      phase: "end",
      success: false,
      attempt,
      cancelled,
      kind: info.kind,
      httpStatus: info.httpStatus ?? null,
      ref: info.ref ?? null,
    },
  };
}
