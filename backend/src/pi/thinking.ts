/**
 * Résolution du niveau de réflexion (reasoning effort) EFFECTIF d'une session
 * ou d'un sous-agent.
 *
 * Précédence (de la plus forte à la plus faible) :
 *   1. `explicit`   — niveau EXPLICITE (ex. catégorie de routage) ;
 *   2. `modelThinking` — `thinkingLevel` du modèle (RegisteredModel, défaut par modèle) ;
 *   3. `modeFallback`  — niveau par défaut du MODE (ex. DEFAULT_THINKING) ;
 *   4. "medium"        — défaut du SDK pi-coding-agent.
 *
 * Fonction PURE, exportée pour les tests de précédence. Un modèle sans
 * `thinkingLevel` (config historique ou option « défaut » de l'UI) laisse donc
 * s'appliquer le niveau du mode, puis "medium".
 */
export function resolveThinkingLevel(
  explicit: string | undefined,
  modelThinking: string | undefined,
  modeFallback: string | undefined,
): string {
  return explicit || modelThinking || modeFallback || "medium";
}
