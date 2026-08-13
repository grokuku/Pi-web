/**
 * Couche de routage pure : transforme une demande + des signaux en une
 * « route » (fonction + catégorie + modèle cible).
 *
 * IMPORTANT : ce fichier n'importe PAS session.ts (pour éviter les cycles).
 * Les signaux sont reçus sous forme de `SignalsInput` plat, assemblés par
 * l'appelant (sendPrompt/harness), puis normalisés via `extractSignals`.
 */

import {
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
 * Feature flag global (kill switch) : permet de revenir à l'ancien comportement
 * sans routing. Ne tient PAS compte du flag par projet `routing.enabled` :
 * celui-ci est géré côté appelant (session.ts) via `isRoutingEnabled() &&
 * routingConfig.enabled`.
 */
export function isRoutingEnabled(): boolean {
  const raw = process.env.ROUTING_ENABLED;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
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

/** Détecte les mots-clés de risque dans la demande (insensible à la casse). */
function detectRiskKeywords(request: string): number {
  const lower = request.toLowerCase();
  return RISK_KEYWORDS.reduce((count, keyword) => {
    return count + (lower.includes(keyword) ? 1 : 0);
  }, 0);
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

  return clamp(base + riskKeywordContribution + diffContribution + toolErrorContribution + explorationContribution + spinningContribution);
}

/** Classifieur heuristique gratuit (aucun appel LLM). */
export function heuristicClassifier(request: string, signals: RoutingSignals): Route {
  const trimmed = request.trim();
  const requestLength = trimmed.length;
  // Arrondi à 4 décimales pour éviter le bruit flottant (ex. 0.839999999).
  const riskScore = Math.round(computeRiskScore(request, signals) * 10000) / 10000;

  let category: TaskCategory;
  let confidence: number;

  if (riskScore >= DEFAULT_ROUTING_CONFIG.reviewRiskThreshold) {
    category = "review";
    confidence = 0.7;
  } else if (
    requestLength <= 80 &&
    riskScore < 0.35 &&
    !signals.spinning &&
    signals.exploringRatio < 0.4 &&
    signals.changedFiles <= 1 &&
    signals.diffSize < 100
  ) {
    category = "trivial";
    confidence = 0.7;
  } else if (
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
    reason: buildHeuristicReason(category, riskScore, requestLength, signals),
  };
}

/** Construit une trace descriptive de la décision heuristique. */
function buildHeuristicReason(
  category: TaskCategory,
  riskScore: number,
  requestLength: number,
  signals: RoutingSignals,
): string {
  const parts: string[] = [
    `heuristique: catégorie ${category}`,
    `riskScore=${riskScore.toFixed(2)}`,
    `longueur=${requestLength}`,
    `toolErrorRate=${signals.toolErrorRate.toFixed(2)}`,
    `exploringRatio=${signals.exploringRatio.toFixed(2)}`,
    `changedFiles=${signals.changedFiles}`,
    `diffSize=${signals.diffSize}`,
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

  let route: Route;
  if (llmRoute && llmRoute.confidence >= confidenceThreshold) {
    route = {
      ...llmRoute,
      category: llmRoute.category,
      function: functionForCategory(llmRoute.category),
      modelId: null,
      riskScore: clamp(llmRoute.riskScore),
      confidence: clamp(llmRoute.confidence),
    };
  } else {
    route = heuristicClassifier(request, signals);
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
