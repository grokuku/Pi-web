// ── Règle de repli/dépli des blocs de détail (LOT 1 + correctif auto-gestion) ─
// Fonction PURE (testée unitairement, sans React) au cœur du correctif.
//
// PRÉCÉDENCE EXACTE (premier critère gagnant) :
//   1. userOverride     — l'utilisateur a cliqué l'en-tête du bloc : il décide,
//                         PRIME sur tout (auto-gestion, erreurs, réglage).
//   2. isRunning        — outil/sous-agent EN COURS d'exécution (pas encore de
//                         endedAt/résultat) → auto-DÉPLI pour montrer la sortie
//                         en direct (tail -f). TRANSITOIRE : une fois l'outil
//                         terminé, retombe sur la règle normale (4/5).
//   3. hasTextStarted   — réflexion CONSOMMÉE : le texte de la réponse a commencé
//                         à streamer → auto-REPLI (« a réfléchi Xs » reste dans
//                         l'en-tête). TRANSITOIRE ET PAS UN OVERRIDE : l'appelant
//                         calcule la condition (contenu non vide && message
//                         encore en stream) — rien n'est mémorisé ; une fois le
//                         tour terminé, la règle normale (4/5) reprend (et le
//                         réglage global redevient décisionnaire).
//   4. isError          — échec (outil en erreur, exit≠0, turn LLM échoué,
//                         sous-agent en échec) → auto-DÉPLI pour montrer l'erreur,
//                         sauf override utilisateur explicite.
//   5. réglage global   — pi-web-display-detail, évalué À CHAQUE render : changer
//                         Ctrl+T / Paramètres s'applique IMMÉDIATEMENT aux blocs
//                         déjà montés (bug corrigé : l'ancien ThinkingBlock
//                         initialisait son state une seule fois).
// NB : isRunning (outil en cours) et hasTextStarted (réflexion terminée) sont des
// états de natures différentes qui ne se rencontrent jamais sur un même bloc ;
// l'ordre 2/3 fixe seulement la précédence théorique de la fonction pure.

export type UserOverride = boolean | undefined;

export interface ExpandState {
  /** Override utilisateur (clic sur l'en-tête, mémorisé par bloc) — prime sur tout. Absent = aucun. */
  userOverride?: UserOverride;
  /** Réglage global « détail d'affichage déplié » (pi-web-display-detail). */
  defaultDetailExpanded: boolean;
  /** Échec du bloc ou de son turn porteur (isError, exit≠0, turnFailed…). */
  isError?: boolean;
  /** Outil/sous-agent en cours d'exécution → auto-dépli (sortie live). */
  isRunning?: boolean;
  /** Réflexion consommée (texte de réponse commencé, tour encore actif) → auto-repli. */
  hasTextStarted?: boolean;
}

export function resolveExpanded({
  userOverride,
  defaultDetailExpanded,
  isError = false,
  isRunning = false,
  hasTextStarted = false,
}: ExpandState): boolean {
  if (userOverride !== undefined) return userOverride;
  if (isRunning) return true;
  if (hasTextStarted) return false;
  if (isError) return true;
  return defaultDetailExpanded;
}