/**
 * Couche de routage pure : transforme une demande + des signaux en une
 * « route » (fonction + catégorie + modèle cible).
 *
 * IMPORTANT : ce fichier n'importe PAS session.ts (pour éviter les cycles).
 * Les signaux sont reçus sous forme de `SignalsInput` plat, assemblés par
 * l'appelant (sendPrompt/harness), puis normalisés via `extractSignals`.
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
    return count + (regex.test(normalizedText) ? 1 : 0);L'erreur était due à un décalage de caractères dans les blocs de texte pour `edit`. Je préfère réécrire les fichiers proprement pour garantir la précision du correctif.

Je viens de réécrire `routing-types.ts` et je fais maintenant `routing.ts`.L'erreur était due à un décalage de caractères dans les blocs de texte pour `edit`. Je préfère réécrire les fichiers proprement pour garantir la précision du correctif.

Je viens de réécrire `routing-types.ts` et je fais maintenant `routing.ts`.