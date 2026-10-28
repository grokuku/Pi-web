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
  /**
   * Fonction du process déduite de la catégorie (`functionForCategory`).
   *
   * NOTE (point c) : ce champ est INFORMATIF / RÉSERVÉ — il n'est PAS utilisé
   * pour dispatcher :
   *   - niveau MESSAGE : c'est le MODE qui garde la main sur les outils et le
   *     prompt (le routage ne choisit que le modèle, via `category`) ;
   *   - niveau SOUS-AGENT : l'orchestrateur fournit TOUJOURS une fonction
   *     explicite au tool `delegate`, qui prime sur `route.function` (celui-ci
   *     ne sert de repli que si l'orchestrateur n'en fournit aucune).
   * Il reste néanmoins journalisé (catégorie dédiée `routing`) pour l'audit.
   */
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

/**
 * Niveau de réflexion (reasoning effort) supporté par le SDK pi-coding-agent
 * 0.87.1 : c'est le type EXACT `ThinkingLevel` exporté par
 * `@earendil-works/pi-agent-core` (dist/types.d.ts).
 *
 * "off" désactive la réflexion ; "minimal".."max" correspondent à un effort
 * croissant réellement envoyé au LLM (mappé vers `reasoning_effort` par le
 * SDK, cf. pi-ai).
 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Toutes les valeurs de thinking acceptées, dans l'ordre croissant d'effort. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Garde de type : la valeur est-elle un ThinkingLevel valide du SDK ? */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface CategoryConfig {
  modelId: string | null;
  /**
   * Niveau de réflexion de la catégorie. Absent/undefined = « défaut » : on
   * garde le niveau de réflexion du MODE (rétro-compatibilité totale avec les
   * configs historiques qui ne contenaient que `modelId`).
   */
  thinkingLevel?: ThinkingLevel;
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
  /**
   * Confiance minimale pour accepter une décision du classifieur `system-one`
   * (défaut `0.35`, cf. `DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD`).
   *
   * ⚠️ SEUIL SÉPARÉ de `confidenceThreshold` (qui reste celui du classifieur
   * `chat`). Un `choice` à 4 options a une confiance — au sens System One, une
   * CONCENTRATION, pas une justesse — naturellement BASSE : mesurée de 0.119 à
   * 0.858 sur 8 messages français réels. Avec le seuil du chat (0.6), la
   * majorité des décisions justes seraient jetées.
   *
   * Le garde-fou de RISQUE (`reviewRiskThreshold`) reste INDÉPENDANT : un
   * `noul` de risque élevé force `review` quel que soit ce seuil.
   *
   * Absent = défaut (rétro-compatibilité : les configs existantes n'ont pas ce
   * champ). Valeur non numérique ou hors [0, 1] → défaut, JAMAIS d'exception.
   */
  systemOneConfidenceThreshold?: number;
  /** Modèle cheap optionnel pour le classifieur LLM de type `chat` (null = off). */
  classifierModelId: string | null;
  /**
   * TYPE de classifieur qui produit la décision de triage :
   *   - `chat`       : appel chat classique (`classifierModelId`), le modèle doit
   *                    répondre un JSON `{category,riskScore,confidence}` ;
   *   - `system-one` : API de DÉCISION native (`systemOneModelId`) — aucune
   *                    génération de texte, le modèle renvoie une décision typée
   *                    (choix + probabilité + confiance).
   * Absent = `chat` (rétro-compatibilité totale des configs existantes).
   */
  classifierType?: ClassifierType;
  /**
   * Modèle (id de la bibliothèque) utilisé par le classifieur `system-one`
   * (ex. `clef` servis par Ollama Cloud, directement ou via Switchy).
   * `null`/absent = classifieur System One désactivé.
   * ⚠️ Champ DISTINCT de `classifierModelId` : les deux classifieurs ont leur
   * propre modèle et ne se marchent jamais dessus.
   */
  systemOneModelId?: string | null;
}

/** Types de classifieur de triage admis. */
export type ClassifierType = "chat" | "system-one";

export const CLASSIFIER_TYPES: readonly ClassifierType[] = ["chat", "system-one"];

/** Garde de type : la valeur est-elle un type de classifieur valide ? */
export function isClassifierType(value: unknown): value is ClassifierType {
  return typeof value === "string" && (CLASSIFIER_TYPES as readonly string[]).includes(value);
}

/**
 * Seuil de confiance par défaut du classifieur `system-one`.
 *
 * Plus bas que celui du `chat` (0.6) parce que la confiance d'un `choice` à 4
 * options PLAFONNE bas (mesuré : 0.119 → 0.858). Le seuil de risque protège
 * indépendamment les cas sensibles.
 */
export const DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD = 0.35;

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: true,
  trivial: { modelId: null },
  standard: { modelId: null },
  complex: { modelId: null },
  review: { modelId: null },
  reviewRiskThreshold: 0.5,
  confidenceThreshold: 0.6,
  systemOneConfidenceThreshold: DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD,
  classifierModelId: null,
  classifierType: "chat",
  systemOneModelId: null,
};

/**
 * Type de classifieur EFFECTIF d'une config : une valeur inconnue/absente vaut
 * `chat` (rétro-compatibilité) — jamais un troisième comportement implicite.
 */
export function classifierTypeOf(
  config: Pick<RoutingConfig, "classifierType"> | null | undefined,
): ClassifierType {
  return isClassifierType(config?.classifierType) ? config.classifierType : "chat";
}

/**
 * Ramène un seuil de confiance à une valeur SÛRE sans jamais lever :
 * non numérique, `NaN`, infini ou hors [0, 1] → `fallback`.
 */
export function normalizeConfidenceThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}

/**
 * Seuil de confiance APPLICABLE à la config, selon le TYPE de classifieur :
 *   - `system-one` → `systemOneConfidenceThreshold` (défaut 0.35) ;
 *   - `chat`       → `confidenceThreshold` (défaut 0.6, comportement historique).
 *
 * ⚠️ Le seuil du `chat` est rendu TEL QUEL (aucune normalisation) pour ne rien
 * changer à son comportement ; seul le seuil System One est normalisé.
 */
export function confidenceThresholdFor(
  config:
    | Pick<RoutingConfig, "classifierType" | "confidenceThreshold" | "systemOneConfidenceThreshold">
    | null
    | undefined,
): number {
  if (classifierTypeOf(config) === "system-one") {
    return normalizeConfidenceThreshold(
      config?.systemOneConfidenceThreshold,
      DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD,
    );
  }
  return config?.confidenceThreshold ?? DEFAULT_ROUTING_CONFIG.confidenceThreshold;
}

/** Mots-clés de risque : toujours déclencheurs d'un biais vers capable + gate review. */
export const RISK_KEYWORDS: string[] = [
  "auth",
  "security",
  "migration",
  "migrations",
  "schema",
  "schemas",
  "secret",
  "secrets",
  "password",
  "passwords",
  "sql",
  "permission",
  "permissions",
  "credential",
  "credentials",
  "token",
  "tokens",
  "key",
  "keys",
];

/** Mots-clés de complexité sémantique : biaisent vers complex/planning. */
export const COMPLEXITY_KEYWORDS: string[] = [
  "refactor",
  "refactore",
  "architecture",
  "plusieurs fichiers",
  "multi-fichiers",
  "multifichiers",
  "module",
  "migration",
  "réorganise",
  "reorganise",
  "optimise",
  "restructure",
  "redesign",
  "concevoir",
  "design",
  "système",
  "systeme",
  "scalable",
  "réécris",
  "reecris",
  "réécriture",
  "reecriture",
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
