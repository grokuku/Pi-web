/**
 * Client NATIF de l'API « System One » (modèles de décision, ex. `clef`).
 *
 * ⚠️ Ce n'est PAS un client de chat : aucun message, aucun prompt, aucune
 * génération de texte, aucune conversion. Le client envoie un `state` (texte à
 * juger) et un SCHÉMA de questions typées ; le modèle rend une décision par
 * question en une passe non autorégressive.
 *
 * ── Contrat implémenté (doc officielle Ollama, lue le 2026-10-28) ───────────
 * Sources : `docs.ollama.com/api/systemone`, `docs.ollama.com/capabilities/decision`,
 * `ollama.com/library/clef`.
 *
 *   POST {base}/v1/systemone                     (⚠️ pas `/v1/system`, pas `/v1/chat/…`)
 *   Authorization: Bearer <clé>                  (clé ollama.com en direct ; locale = ignorée)
 *   Content-Type: application/json
 *
 *   Requête  { model, state, questions, images?, keep_alive? }
 *     - `state`     : chaîne non vide, ou objet/tableau sérialisé en JSON ;
 *     - `questions` : 1 à 64 questions nommées (`type` ∈ choice | noul | score,
 *                     `instructions`, `criteria`) ;
 *     - `images`    : base64 (modèles vision, ex. `clef`).
 *
 *   Réponse  { model, answers: { <nom>: <réponse typée> }, usage: {
 *              input_tokens, output_tokens } }
 *     - `choice` → { choice, probabilities, confidence }
 *     - `noul`   → { noul }   (probabilité que la réponse soit VRAIE, 0..1)
 *     - `score`  → { score, legend, probabilities, confidence }
 *
 *   ⚠️ La doc est explicite : « Returns one JSON response; streaming, video,
 *   tools, and generation controls are not supported. » → jamais de `stream`,
 *   jamais de `temperature`/`max_tokens`/`tools` dans le corps.
 *
 * ── Ce que ce module fait de la réponse ────────────────────────────────────
 * Il LIT la réponse native (choix + probabilité + confiance) et la TRADUIT en
 * `Route` (catégorie / riskScore / confidence) à la frontière, une seule fois.
 * Ce n'est pas une conversion de format générique : c'est le mapping métier
 * explicite d'une décision typée vers la structure de routage de Pi-Web.
 *
 * En cas d'échec (réseau, statut, réponse inutilisable) : `SystemOneError` —
 * JAMAIS une décision inventée. L'appelant retombe alors sur l'heuristique et
 * peut dire honnêtement que le triage LLM n'a pas eu lieu.
 */
import type { Route, TaskCategory } from "./routing-types.js";
import { functionForCategory } from "./routing-types.js";

/** Délai par défaut d'un appel de classement (le modèle est rapide : ~200 ms). */
export const SYSTEM_ONE_DEFAULT_TIMEOUT_MS = 15_000;

/** Longueur maximale du message d'erreur amont conservé (jamais un corps entier). */
const MAX_UPSTREAM_ERROR_CHARS = 300;

// ── Contrat HTTP (types) ──

/** Type de question admis par l'API (vocabulaire fermé de la doc). */
export type SystemOneQuestionType = "choice" | "noul" | "score";

export interface SystemOneQuestion {
  type: SystemOneQuestionType;
  instructions: string;
  criteria?: Record<string, string | null> | string[];
}

export interface SystemOneRequest {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, SystemOneQuestion>;
  images?: string[];
  keep_alive?: string | number;
}

export interface SystemOneChoiceAnswer {
  type?: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface SystemOneNoulAnswer {
  type?: "noul";
  /** Probabilité que la réponse soit VRAIE (0..1). */
  noul: number;
}

export interface SystemOneScoreAnswer {
  type?: "score";
  score: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type SystemOneAnswer = SystemOneChoiceAnswer | SystemOneNoulAnswer | SystemOneScoreAnswer;

export interface SystemOneResponse {
  model?: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Échec HONNÊTE et typé d'un appel System One (jamais un faux succès). */
export class SystemOneError extends Error {
  /** Statut HTTP amont (0 = aucun statut : réseau, délai, réponse illisible). */
  readonly status: number;
  /** Code stable pour l'interface/le journal. */
  readonly code: string;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "SystemOneError";
    this.code = code;
    this.status = status;
  }
}

/**
 * URL de l'endpoint System One d'un fournisseur.
 *
 *   - `{base}/v1` → `{base}/v1/systemone` (dérivation identique à Switchy) ;
 *   - `{base}`    → `{base}/v1/systemone`.
 *
 * Un `baseUrl` pointant sur Switchy se comporte donc exactement comme un
 * `baseUrl` pointant sur ollama.com : `POST /v1/systemone`, `model` = nom du
 * service côté Switchy.
 */
export function systemOneEndpoint(baseUrl: string): string {
  const base = (baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new SystemOneError("no_base_url", "System One : aucun baseUrl de fournisseur configuré");
  return base.endsWith("/v1") ? `${base}/systemone` : `${base}/v1/systemone`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Message lisible d'un échec HTTP System One (français, sans corps brut entier). */
function upstreamMessage(status: number, bodyText: string): string {
  let detail = "";
  try {
    const parsed = asRecord(JSON.parse(bodyText));
    if (parsed && typeof parsed.error === "string") detail = parsed.error;
  } catch {
    detail = bodyText;
  }
  detail = detail.trim().replace(/\s+/g, " ");
  if (detail.length > MAX_UPSTREAM_ERROR_CHARS) detail = `${detail.slice(0, MAX_UPSTREAM_ERROR_CHARS)}…`;

  const motifs: Record<number, string> = {
    400: "requête refusée (schéma ou state invalide)",
    401: "clé du fournisseur refusée",
    402: "plan payant ou crédits d'usage requis",
    404: "modèle introuvable chez le fournisseur",
    413: "requête trop volumineuse",
    429: "débit dépassé chez le fournisseur",
  };
  const motif = motifs[status] ?? (status >= 500 ? "fournisseur indisponible" : "échec du fournisseur");
  return detail ? `HTTP ${status} — ${motif} : ${detail}` : `HTTP ${status} — ${motif}`;
}

/**
 * Appelle l'API System One et renvoie les RÉPONSES NATIVES (aucune décision
 * fabriquée ici). Lève `SystemOneError` pour tout échec.
 */
export async function askSystemOne(options: {
  endpoint: string;
  apiKey?: string;
  request: SystemOneRequest;
  timeoutMs?: number;
}): Promise<SystemOneResponse> {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? Math.floor(options.timeoutMs as number)
      : SYSTEM_ONE_DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  let response: Response;
  try {
    response = await fetch(options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(options.request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: any) {
    const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
    throw new SystemOneError(
      timedOut ? "timeout" : "network_error",
      timedOut
        ? `System One injoignable : délai de ${Math.round(timeoutMs / 1000)} s dépassé`
        : `System One injoignable (${error?.message || error})`,
    );
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new SystemOneError(
      response.status === 401 || response.status === 403 ? "auth_error" : "upstream_error",
      upstreamMessage(response.status, text),
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new SystemOneError("invalid_response", "System One : réponse illisible (JSON attendu)", response.status);
  }
  const root = asRecord(payload);
  const answers = root ? asRecord(root.answers) : null;
  if (!root || !answers) {
    throw new SystemOneError(
      "invalid_response",
      "System One : réponse sans objet `answers` — le fournisseur n'a pas renvoyé de décision",
      response.status,
    );
  }
  const usage = asRecord(root.usage);
  return {
    ...(typeof root.model === "string" ? { model: root.model } : {}),
    answers: answers as Record<string, SystemOneAnswer>,
    ...(usage ? { usage: usage as SystemOneResponse["usage"] } : {}),
  };
}

// ── Schéma de questions du TRIAGE de routage ──

/** Noms de questions (≤ 100 caractères ASCII : lettres, chiffres, `_`, `.`, `-`). */
export const CATEGORY_QUESTION = "category";
export const RISK_QUESTION = "risk";

/** Catégories de routage proposées, avec leur description (critère `choice`). */
const CATEGORY_CRITERIA: Record<TaskCategory, string> = {
  trivial:
    "Une tâche courte et localisée, à faible risque (renommage, formatage, petite correction, réponse à une question).",
  standard:
    "Une tâche classique de développement, sans exploration majeure (implémentation ciblée, correction simple, test).",
  complex:
    "Une tâche qui demande de l'exploration ou de la planification (refactor, architecture, migration, plusieurs fichiers, conception).",
  review:
    "Une tâche à risque : elle touche la sécurité, l'authentification, les secrets, les permissions, un schéma ou des données, ou elle est destructive.",
};

/**
 * Schéma envoyé au modèle : DEUX questions seulement, dans l'ordre voulu.
 *
 *   1. `category` (`choice`) → la catégorie de la tâche + la CONFIANCE du modèle
 *      (mesure de concentration des probabilités, 0..1) ;
 *   2. `risk` (`noul`)      → la probabilité que la tâche soit risquée (0..1),
 *      qui sert de `riskScore`.
 *
 * L'ordre des critères compte : en cas d'égalité, la doc indique que le modèle
 * suit l'ordre des options fournies. On les ordonne donc du MOINS prudent au
 * PLUS prudent (trivial → standard → complex → review) pour qu'une demande
 * ordinaire ne bascule pas par défaut sur « review » ; c'est la probabilité de
 * risque (`noul`) qui porte la prudence, via le gate `reviewRiskThreshold`.
 */
export function buildClassificationQuestions(): Record<string, SystemOneQuestion> {
  return {
    [CATEGORY_QUESTION]: {
      type: "choice",
      instructions: "Quelle catégorie de traitement décrit le mieux cette demande ?",
      criteria: {
        trivial: CATEGORY_CRITERIA.trivial,
        standard: CATEGORY_CRITERIA.standard,
        complex: CATEGORY_CRITERIA.complex,
        review: CATEGORY_CRITERIA.review,
      },
    },
    [RISK_QUESTION]: {
      type: "noul",
      instructions:
        "La demande touche-t-elle un sujet risqué (sécurité, authentification, secrets, permissions, migration de données, schéma, opération destructive) ?",
      criteria: {
        true: "Elle touche un sujet risqué ou une opération destructive.",
        false: "Elle ne touche aucun sujet risqué.",
      },
    },
  };
}

/** Normalise un libellé de catégorie renvoyé par le modèle (casse/espaces tolérés). */
export function normalizeCategoryChoice(value: unknown): TaskCategory | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "trivial" || normalized === "standard" || normalized === "complex" || normalized === "review") {
    return normalized;
  }
  return null;
}

/**
 * Mappe les réponses NATIVES vers la `Route` de Pi-Web — le SEUL endroit où la
 * décision typée devient une catégorie + un risque + une confiance.
 *
 * Lève `SystemOneError` si la réponse est inutilisable (pas de catégorie, pas de
 * confiance) : on ne fabrique jamais une décision plausible.
 */
export function mapAnswersToRoute(answers: Record<string, SystemOneAnswer>, modelLabel: string): Route {
  const categoryAnswer = asRecord(answers[CATEGORY_QUESTION]) as Record<string, unknown> | null;
  const category = normalizeCategoryChoice(categoryAnswer?.choice);
  if (!category) {
    throw new SystemOneError(
      "unusable_answer",
      `System One : réponse sans catégorie exploitable (${CATEGORY_QUESTION}) — triage heuristique appliqué`,
    );
  }

  const confidenceRaw = categoryAnswer?.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) {
    throw new SystemOneError(
      "unusable_answer",
      "System One : réponse sans `confidence` — triage heuristique appliqué",
    );
  }
  const confidence = clamp01(confidenceRaw);

  // Risque : `noul` = probabilité que la réponse soit VRAIE. Absent = risque
  // inconnu (0), et c'est l'heuristique qui garde son rôle de plancher
  // conservateur dans `resolveRoute` (`Math.max`).
  const riskAnswer = asRecord(answers[RISK_QUESTION]);
  const riskRaw = riskAnswer?.noul;
  const riskScore = typeof riskRaw === "number" && Number.isFinite(riskRaw) ? clamp01(riskRaw) : 0;
  const riskKnown = typeof riskRaw === "number" && Number.isFinite(riskRaw);

  return {
    category,
    function: functionForCategory(category),
    modelId: null,
    confidence,
    riskScore,
    reason:
      `classifieur System One (${modelLabel}) : ${CATEGORY_QUESTION}=${category}` +
      (riskKnown ? `, P(risque)=${riskScore.toFixed(3)}` : ", P(risque) indisponible") +
      `, confiance=${confidence.toFixed(3)}`,
  };
}
