/**
 * Types purs du routage par complexité/signaux.
 *
 * Ce fichier ne doit importer AUCUN module métier (pas de session.ts,
 * pas de model-library.ts) afin d'éviter les cycles d'imports. Il définit
 * uniquement les contrats partagés entre la couche de routage, la config
 * projet et la session Pi.
 */

// ── Fonctions du process (remplacement des « experts » HARNESS) ──
// `planning` (et non `plan`) évite la collision avec l'ancien mode `plan`.
export type RoutingFunction = "planning" | "execute" | "review" | "integrate";

// ── Catégories de tâches ──
export type TaskCategory = "trivial" | "standard" | "complex" | "review";

/** Une décision de routage : (tâche, complexité, signaux) → (fonction, catégorie, modèle). */
export interface Route {
  category: TaskCategory;
  function: RoutingFunction;
  /** null = fallback sur le modèle par défaut (résolu par pickModel). */
  modelId: string | null;
  /** Confiance 0..1 dans la décision. */
  confidence: number;
  /** Score de risque 0..1 (déclenche le gate review au-delà du seuil). */
  riskScore: number;
  /** Trace pour logs/UI. */
  reason: string;
}

/** Signaux normalisés utilisés par les classifieurs. */
export interface RoutingSignals {
  toolErrorRate: number;          // 0..1
  spinning: boolean;
  exploringRatio: number;         // 0..1
  recentProductionIntensity: number; // 0..1
  riskKeywords: boolean;
  changedFiles: number;
  diffSize: number;
  contextUsage: number;           // 0..1
}

/** Signaux bruts fournis par l'appelant (tous optionnels, normalisés par extractSignals). */
export interface SignalsInput {
  toolErrorRate?: number;
  spinning?: boolean;
  exploringRatio?: number;
  recentProductionIntensity?: number;
  riskKeywords?: boolean;
  changedFiles?: number;
  diffSize?: number;
  contextUsage?: number;
}

export interface CategoryConfig {
  modelId: string | null;
}

export interface RoutingConfig {
  /** Switch « routage actif » par projet. false = mode basic (LLM direct, sans routage). */
  enabled: boolean;
  trivial: CategoryConfig;
  standard: CategoryConfig;
  complex: CategoryConfig;
  review: CategoryConfig;
  /** riskScore >= ce seuil force la catégorie review. */
  reviewRiskThreshold: number;
  /** Confiance minimale pour accepter une décision (sinon repli standard/execute). */
  confidenceThreshold: number;
  /** Modèle cheap optionnel pour le classifieur LLM (null = off). */
  classifierModelId: string | null;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: true,
  trivial: { modelId: null },
  standard: { modelId: null },
  complex: { modelId: null },
  review: { modelId: null },
  reviewRiskThreshold: 0.5,
  confidenceThreshold: 0.6,
  classifierModelId: null,
};

/** Mots-clés de risque : toujours déclencheurs d'un biais vers capable + gate review. */
export const RISK_KEYWORDS: string[] = [
  "auth",
  "security",
  "migration",
  "schema",
  "secret",
  "password",
  "sql",
  "permission",
  "credential",
  "token",
  "key",
];

/** Mappe une catégorie vers la fonction du process. */
export function functionForCategory(category: TaskCategory): RoutingFunction {
  switch (category) {
    case "trivial":
    case "standard":
      return "execute";
    case "complex":
      return "planning";
    case "review":
      return "review";
  }
}
