/**
 * Couche de routage pure : transforme une demande + des signaux en une
 * « route » (fonction + catégorie + modèle cible).
 *
 * IMPORTANT : ce fichier n'importe PAS session.ts (pour éviter les cycles).
 * Les signaux sont reçus sous forme de `SignalsInput` plat, assemblés par
 * l'appelant (sendPrompt), puis normalisés via `extractSignals`.
 */

import {
  COMPLEXITY_KEYWORDS,
  DEFAULT_ROUTING_CONFIG,
  functionForCategory,
  RISK_KEYWORDS,
  type Route,
  type RoutingConfig,
  type RoutingSignals,
  type SignalsInput,
  type TaskCategory,
} from "./routing-types.js";
import { getDefaultModel, getModel, type ModelLibrary, type RegisteredModel } from "./model-library.js";

// Le type `Route` est réexporté par routing-types ; ce fichier le consomme.

/** Clamp une valeur dans [min, max]. */
function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Feature flag global (kill switch) : coupe le routage (niveau message ET
 * sous-agents) quand `ROUTING_ENABLED` vaut "0"/"false". Il est CONSOMMÉ par
 * les deux points d'application : `sendPrompt` (session.ts) et l'endpoint
 * `/api/routing/decision` (routes/routing.ts, utilisé par l'orchestrateur de
 * sous-agents). Le flag par projet `routing.enabled` est combiné au même
 * endroit sous la forme `isRoutingEnabled() && routingConfig.enabled`.
 */
export function isRoutingEnabled(): boolean {
  const raw = process.env.ROUTING_ENABLED;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Kill switch COMBINÉ : le routage n'est actif que si le flag global (env) ET
 * la config par projet/mode sont activés. Point d'entrée UNIQUE de la
 * précédence, consommé par `sendPrompt` (session.ts) et par l'endpoint de
 * décision (routes/routing.ts, orchestrateur de sous-agents inclus).
 *
 * Fonction pure (hors lecture de l'env) → testable directement.
 */
export function isRoutingActive(
  config: Pick<RoutingConfig, "enabled"> | null | undefined,
): boolean {
  return isRoutingEnabled() && !!config?.enabled;
}

/** Normalise les champs optionnels de `SignalsInput` en valeurs par défaut. */
export function extractSignals(input: SignalsInput = {}): RoutingSignals {
  return {
    toolErrorRate: clamp(Number(input.toolErrorRate ?? 0)),
    spinning: input.spinning ?? false,
    exploringRatio: clamp(Number(input.exploringRatio ?? 0)),
    recentProductionIntensity: clamp(Number(input.recentProductionIntensity ?? 0)),
    riskKeywords: input.riskKeywords ?? false,
    changedFiles: Math.max(0, Math.floor(Number(input.changedFiles ?? 0))),
    diffSize: Math.max(0, Math.floor(Number(input.diffSize ?? 0))),
    contextUsage: clamp(Number(input.contextUsage ?? 0)),
  };
}

/** Normalise un texte pour la recherche de mots-clés : minuscules + sans accents. */
function normalizeForKeywordMatch(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Échappe les caractères spéciaux d'une expression régulière. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compte les mots-clés présents (frontières de mots, insensible casse/accents). */
function countKeywordHits(request: string, keywords: string[]): number {
  const normalizedText = normalizeForKeywordMatch(request);
  return keywords.reduce((count, keyword) => {
    const normalizedKeyword = normalizeForKeywordMatch(keyword);
    if (!normalizedKeyword) return count;
    const regex = new RegExp(`\\b${escapeRegExp(normalizedKeyword)}\\b`, "i");
    return count + (regex.test(normalizedText) ? 1 : 0);
  }, 0);
}

/** Détecte les mots-clés de risque dans la demande. */
function detectRiskKeywords(request: string): number {
  return countKeywordHits(request, RISK_KEYWORDS);
}

/** Détecte les mots-clés de complexité sémantique dans la demande. */
function detectComplexityKeywords(request: string): number {
  return countKeywordHits(request, COMPLEXITY_KEYWORDS);
}

/** Verbes d'action triviaux (tâche courte et localisée). */
const TRIVIAL_ACTION_VERBS: string[] = [
  "corrige",
  "corriger",
  "fix",
  "bug",
  "ajoute",
  "ajouter",
  "modifie",
  "modifier",
  "change",
  "changer",
  "crée",
  "implémente",
  "supprime",
  "supprimer",
  "renomme",
  "renommer",
];

/** Détecte la présence d'un verbe d'action trivial. */
function detectTrivialActionVerbs(request: string): boolean {
  return countKeywordHits(request, TRIVIAL_ACTION_VERBS) > 0;
}

/** Détecte la mention de « fichier » ou d'un nom de fichier avec extension. */
function mentionsFile(request: string): boolean {
  if (/\bfichiers?\b/.test(normalizeForKeywordMatch(request))) return true;
  return /(?:^|[\s/\\])[a-z0-9_.-]+\.[a-z]{1,6}\b/i.test(request);
}

/**
 * Calcule un score de risque continu en [0,1].
 * Le biais est conservateur : un mot-clé de risque suffit à élever le score,
 * et la taille du diff / le taux d'erreur outil le renforcent.
 */
function computeRiskScore(request: string, signals: RoutingSignals): number {
  const keywordHits = detectRiskKeywords(request);
  const riskKeywordFlag = signals.riskKeywords || keywordHits > 0;

  // Contribution du diff : +0.15 par palier de 300 « lignes/caractères » de diff,
  // +0.1 par palier de 5 fichiers modifiés.
  const diffContribution = Math.min(0.3, (signals.diffSize / 300) * 0.15 + (signals.changedFiles / 5) * 0.1);
  const toolErrorContribution = Math.min(0.2, signals.toolErrorRate * 0.4);
  const explorationContribution = Math.min(0.15, signals.exploringRatio * 0.3);

  const base = 0.1;
  const riskKeywordContribution = riskKeywordFlag ? 0.35 + Math.min(0.1, keywordHits * 0.03) : 0;
  const spinningContribution = signals.spinning ? 0.15 : 0;
  const contextContribution = Math.min(0.1, signals.contextUsage * 0.15);
  const productionContribution = Math.min(0.1, signals.recentProductionIntensity * 0.2);

  return clamp(
    base +
      riskKeywordContribution +
      diffContribution +
      toolErrorContribution +
      explorationContribution +
      spinningContribution +
      contextContribution +
      productionContribution,
  );
}

/** Classifieur heuristique gratuit (aucun appel LLM). */
export function heuristicClassifier(
  request: string,
  signals: RoutingSignals,
  reviewRiskThreshold: number = DEFAULT_ROUTING_CONFIG.reviewRiskThreshold,
): Route {
  const trimmed = request.trim();
  const requestLength = trimmed.length;
  const riskKeywordHits = detectRiskKeywords(request);
  const complexityHits = detectComplexityKeywords(request);
  const hasRiskKeyword = signals.riskKeywords || riskKeywordHits > 0;
  const hasActionVerb = detectTrivialActionVerbs(request);
  const citesFile = mentionsFile(request);
  // Arrondi à 4 décimales pour éviter le bruit flottant (ex. 0.839999999).
  const riskScore = Math.round(computeRiskScore(request, signals) * 10000) / 10000;

  let category: TaskCategory;
  let confidence: number;

  if (riskScore >= reviewRiskThreshold) {
    category = "review";
    confidence = 0.7;
  } else if (
    requestLength <= 80 &&
    riskScore < 0.35 &&
    complexityHits === 0 &&
    !hasActionVerb &&
    !citesFile &&
    !hasRiskKeyword &&
    !signals.spinning &&
    signals.exploringRatio < 0.4 &&
    signals.changedFiles <= 1 &&
    signals.diffSize < 100
  ) {
    category = "trivial";
    confidence = 0.7;
  } else if (
    complexityHits > 0 ||
    riskScore >= 0.4 ||
    signals.spinning ||
    signals.exploringRatio >= 0.5 ||
    signals.changedFiles >= 3 ||
    signals.diffSize >= 300 ||
    signals.toolErrorRate >= 0.3 ||
    requestLength >= 500
  ) {
    category = "complex";
    confidence = 0.65;
  } else {
    category = "standard";
    confidence = 0.6;
  }

  return {
    category,
    function: functionForCategory(category),
    modelId: null,
    confidence,
    riskScore,
    reason: buildHeuristicReason(category, riskScore, reviewRiskThreshold, requestLength, signals, complexityHits),
  };
}

/** Construit une trace descriptive de la décision heuristique. */
function buildHeuristicReason(
  category: TaskCategory,
  riskScore: number,
  reviewRiskThreshold: number,
  requestLength: number,
  signals: RoutingSignals,
  complexityHits: number,
): string {
  const parts: string[] = [
    `heuristique: catégorie ${category}`,
    `riskScore=${riskScore.toFixed(2)}`,
    `seuil=${reviewRiskThreshold.toFixed(2)}`,
    `longueur=${requestLength}`,
    `complexityHits=${complexityHits}`,
    `toolErrorRate=${signals.toolErrorRate.toFixed(2)}`,
    `exploringRatio=${signals.exploringRatio.toFixed(2)}`,
    `changedFiles=${signals.changedFiles}`,
    `diffSize=${signals.diffSize}`,
    `contextUsage=${signals.contextUsage.toFixed(2)}`,
    `recentProductionIntensity=${signals.recentProductionIntensity.toFixed(2)}`,
  ];
  if (signals.spinning) parts.push("spinning=true");
  if (signals.riskKeywords) parts.push("riskKeywords=true");
  return parts.join(" ; ");
}

/**
 * Classifieur LLM optionnel (off par défaut).
 *
 * `runtime` est le ModelRuntime Pi (`any` pour ne pas dépendre des types SDK ici).
 * `classifierModelId` est l'id de la bibliothèque de modèles (`providerId__modelId`).
 * En cas d'échec (modèle introuvable, JSON invalide, timeout réseau), retourne `null`.
 */
export async function llmClassifier(
  request: string,
  runtime: any,
  classifierModelId: string,
): Promise<Route | null> {
  if (!runtime || !classifierModelId) return null;

  try {
    // L'id de bibliothèque est construit par makeModelId : `providerId__modelId`.
    // On coupe à la première occurrence de `__` ; le modelId peut contenir des `__`.
    const separatorIndex = classifierModelId.indexOf("__");
    if (separatorIndex <= 0) return null;

    const providerId = classifierModelId.slice(0, separatorIndex);
    const modelId = classifierModelId.slice(separatorIndex + 2);
    if (!providerId || !modelId) return null;

    const model = runtime.getModel?.(providerId, modelId);
    if (!model) return null;

    const systemPrompt =
      "You are a task classifier. Reply with ONLY a JSON object of the form " +
      '{"category":"trivial|standard|complex|review","riskScore":0..1,"confidence":0..1}. ' +
      "No explanation, no markdown.";

    const context = {
      systemPrompt,
      messages: [{ role: "user" as const, content: request, timestamp: Date.now() }],
    };

    const response = await runtime.completeSimple(model, context, {
      temperature: 0.1,
      maxTokens: 100,
    });

    const text =
      response.content
        ?.filter((c: any) => c.type === "text")
        ?.map((c: any) => c.text || "")
        ?.join("\n")
        ?.trim() || "";

    if (!text) return null;

    const parsed = parseClassificationJson(text);
    if (!parsed) return null;

    const category = normalizeCategory(parsed.category);
    if (!category) return null;

    const riskScore = clamp(Number(parsed.riskScore));
    const confidence = clamp(Number(parsed.confidence));
    if (!Number.isFinite(riskScore) || !Number.isFinite(confidence)) return null;

    return {
      category,
      function: functionForCategory(category),
      modelId: null,
      confidence,
      riskScore,
      reason: `classifieur LLM (${classifierModelId})`,
    };
  } catch (error: any) {
    console.warn("[routing] llmClassifier failed:", error?.message || error);
    return null;
  }
}

/** Extrait et parse l'objet JSON renvoyé par le classifieur LLM (tolère les code fences). */
function parseClassificationJson(text: string): { category?: unknown; riskScore?: unknown; confidence?: unknown } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeCategory(value: unknown): TaskCategory | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (normalized === "trivial" || normalized === "standard" || normalized === "complex" || normalized === "review") {
    return normalized;
  }
  return null;
}

/**
 * Fusionne classifieur LLM et heuristique.
 *
 * Règles :
 * - Si `llmRoute` a une confiance >= `config.confidenceThreshold`, on l'utilise.
 * - Sinon on retombe sur `heuristicClassifier`.
 * - Si la confiance finale < seuil, fail-safe vers `standard`/`execute`.
 * - Le gate review est appliqué en dernier : `riskScore >= reviewRiskThreshold` force `review`.
 */
export function resolveRoute(
  request: string,
  config: RoutingConfig,
  signals: RoutingSignals,
  llmRoute?: Route | null,
): Route {
  const confidenceThreshold = config.confidenceThreshold ?? DEFAULT_ROUTING_CONFIG.confidenceThreshold;
  const reviewRiskThreshold = config.reviewRiskThreshold ?? DEFAULT_ROUTING_CONFIG.reviewRiskThreshold;

  // On calcule toujours l'heuristique : son riskScore sert de garde-fou
  // conservateur (mots-clés de risque) même quand le LLM décide.
  const heuristicRoute = heuristicClassifier(request, signals, reviewRiskThreshold);

  let route: Route;
  if (llmRoute && llmRoute.confidence >= confidenceThreshold) {
    route = {
      ...llmRoute,
      category: llmRoute.category,
      function: functionForCategory(llmRoute.category),
      modelId: null,
      riskScore: Math.max(clamp(llmRoute.riskScore), heuristicRoute.riskScore),
      confidence: clamp(llmRoute.confidence),
    };
  } else {
    route = heuristicRoute;
  }

  // Gate review : un risque élevé force une relecture à contexte séparé.
  if (route.category !== "review" && route.riskScore >= reviewRiskThreshold) {
    route = {
      ...route,
      category: "review",
      function: "review",
      reason: `${route.reason} ; gate review (riskScore >= ${reviewRiskThreshold})`,
    };
  }

  // Fail-safe : si la décision n'est pas assez confiante, on reste sur le
  // comportement nominal standard/execute.
  if (route.confidence < confidenceThreshold) {
    return {
      category: "standard",
      function: "execute",
      modelId: null,
      confidence: Math.max(route.confidence, 0.5),
      riskScore: clamp(route.riskScore),
      reason: `confiance insuffisante (${route.confidence.toFixed(2)} < ${confidenceThreshold}) — repli standard/execute`,
    };
  }

  return route;
}

/**
 * Résout le modèle cible d'une route.
 *
 * `route.category` → `config[category].modelId` ; si l'id est absent ou
 * introuvable, retombe sur le modèle par défaut de la bibliothèque.
 * (Routage des SOUS-AGENTS : le modèle par défaut est le repli attendu.)
 */
export function pickModel(
  route: Route,
  config: RoutingConfig,
  library: ModelLibrary,
): RegisteredModel | null {
  const categoryConfig = config?.[route.category];
  if (categoryConfig?.modelId) {
    const configured = getModel(library, categoryConfig.modelId);
    if (configured) return configured;
  }

  const fallback = getDefaultModel(library);
  return fallback ?? null;
}

/**
 * Ordre de capacité CROISSANTE des catégories (utilisé par le biais
 * conservateur : jamais on ne descend d'un cran, seulement on monte).
 */
const CATEGORY_ASCENDING: TaskCategory[] = ["trivial", "standard", "complex", "review"];

/**
 * Catégorie EFFECTIVE utilisée pour choisir le modèle d'un MESSAGE.
 *
 * - Un `riskScore` >= `reviewRiskThreshold` force `review` (prudence) ;
 * - une `confidence` < `confidenceThreshold` déclenche le biais CONSERVATEUR :
 *   on monte d'un cran de capacité (jamais vers le bas).
 *
 * Fonction pure (aucun I/O) → testable directement.
 */
export function effectiveCategoryForModel(route: Route, config: RoutingConfig): TaskCategory {
  const reviewRiskThreshold = config.reviewRiskThreshold ?? DEFAULT_ROUTING_CONFIG.reviewRiskThreshold;
  const confidenceThreshold = config.confidenceThreshold ?? DEFAULT_ROUTING_CONFIG.confidenceThreshold;

  if (route.riskScore >= reviewRiskThreshold) return "review";

  if (route.confidence < confidenceThreshold) {
    const index = CATEGORY_ASCENDING.indexOf(route.category);
    if (index < 0) return route.category; // catégorie inconnue : on ne devine pas
    return CATEGORY_ASCENDING[Math.min(CATEGORY_ASCENDING.length - 1, index + 1)];
  }

  return route.category;
}

/**
 * Résout le modèle cible du ROUTAGE MESSAGE à partir de la catégorie effective
 * (review / biais conservateur inclus).
 *
 * Contrairement à `pickModel`, AUCUN repli sur le modèle par défaut de la
 * bibliothèque : retourne `null` quand la catégorie n'a pas de `modelId`
 * configuré/retrouvable. L'appelant (session.ts) retombe alors sur le modèle du
 * MODE (comportement actuel) — c'est le fail-safe exigé.
 *
 * Fonction pure (aucun I/O) → testable directement.
 */
export function pickRoutedModel(
  route: Route,
  config: RoutingConfig,
  library: ModelLibrary,
): RegisteredModel | null {
  const category = effectiveCategoryForModel(route, config);
  const categoryConfig = config?.[category];
  if (categoryConfig?.modelId) {
    const configured = getModel(library, categoryConfig.modelId);
    if (configured) return configured;
  }
  return null;
}
