// ── Décision du « pin » de scroll du chat (correctif décrochage automatique) ──
// Fonction PURE (testée unitairement, sans React/DOM) au cœur du correctif.
//
// OBJECTIF : le fil reste collé en bas pendant que le contenu grandit (streaming
// du texte, blocs d'outils, sous-agents — y compris le store isolé et le
// passage en colonnes —, dépliages/replis automatiques, images, compactions),
// SAUF si l'utilisateur a VOLONTAIREMENT scrollé vers le haut. Le bouton
// « descendre en bas » reste le recours exact.
//
// DEUX SOURCES D'ÉVÉNEMENTS :
//   - "scroll" : le viewport a bougé (geste utilisateur OU mouvement subi :
//                ancrage de scroll du navigateur, pin programmatique en cours) ;
//   - "growth" : la hauteur RÉELLE du contenu a changé (ResizeObserver /
//                MutationObserver) — on raisonne sur la boîte, pas sur un
//                événement métier, pour couvrir toute cause de croissance.
//
// Le piège historique : confondre un déplacement de `scrollTop` dû au
// navigateur avec un geste UTILISATEUR (→ décrochage intempestif). On ne
// décroche donc QUE sur un geste franc vers le haut, et une croissance de
// contenu ne décroche JAMAIS.

/** Distance (px) sous laquelle on considère l'utilisateur « collé en bas ». */
export const BOTTOM_PROXIMITY_PX = 48;
/** Delta minimal (px) vers le haut pour interpréter un scroll comme VOLONTAIRE. */
export const USER_SCROLL_UP_PX = 12;

export type ScrollEventKind = "scroll" | "growth";

export interface ScrollState {
  /** scrollHeight - scrollTop - clientHeight (clampé à >= 0). */
  distanceFromBottom: number;
  /** dernierScrollTop - scrollTop : POSITIF = vers le haut, NÉGATIF = vers le bas. */
  scrollDelta: number;
  /** État de pin AVANT la décision courante. */
  wasPinned: boolean;
}

export interface ScrollDecision {
  /** Nouvel état de pin (source de vérité, à mémoriser par l'appelant). */
  pinned: boolean;
  /** Faut-il repositionner le scroll sur le bas MAINTENANT ? */
  follow: boolean;
  /** Faut-il afficher le bouton « descendre en bas » ? */
  showButton: boolean;
  /** Faut-il remettre le compteur de non-lus à zéro ? */
  clearUnread: boolean;
}

export interface ScrollOptions {
  /** Seuil de proximité du bas (px). Défaut : {@link BOTTOM_PROXIMITY_PX}. */
  proximityPx?: number;
  /** Delta minimal d'un geste vers le haut (px). Défaut : {@link USER_SCROLL_UP_PX}. */
  userScrollUpPx?: number;
}

/** Vrai si la distance au bas est sous le seuil de proximité. */
export function isNearBottom(
  distanceFromBottom: number,
  proximityPx: number = BOTTOM_PROXIMITY_PX,
): boolean {
  return distanceFromBottom < proximityPx;
}

/**
 * Calcule la décision de suivi du bas à partir d'un signal de scroll ou de
 * croissance. PURE : aucun accès DOM, aucune mutation d'état.
 */
export function resolveScrollAction(
  state: ScrollState,
  kind: ScrollEventKind,
  opts: ScrollOptions = {},
): ScrollDecision {
  const proximity = opts.proximityPx ?? BOTTOM_PROXIMITY_PX;
  const userUp = opts.userScrollUpPx ?? USER_SCROLL_UP_PX;
  const atBottom = isNearBottom(state.distanceFromBottom, proximity);

  let pinned: boolean;
  if (atBottom) {
    // Sous le seuil (ou revenu en bas) → on (ré)arme le suivi automatique.
    pinned = true;
  } else if (kind === "growth") {
    // La croissance du contenu ne décroche JAMAIS : on suit seulement si on
    // était déjà collé. Un utilisateur resté en haut n'est jamais déplacé.
    pinned = state.wasPinned;
  } else if (state.wasPinned && state.scrollDelta <= userUp) {
    // Mouvement ambigu/non imputable à un geste franc (ancrage navigateur, pin
    // programmatique encore en cours) → on CONSERVE le pin.
    pinned = true;
  } else {
    // Geste franc vers le haut, ou état déjà décroché → décrochage.
    pinned = false;
  }

  return {
    pinned,
    // On ne repositionne que sur croissance, si on suit et qu'on n'est pas déjà
    // exactement au fond → évite tout scroll en boucle (croissance → pin → …).
    follow: kind === "growth" && pinned && state.distanceFromBottom > 0,
    // Le bouton n'apparaît que si on est DÉCROCHÉ et au-dessus du seuil
    // (évite un clignotement pendant que le pin reprend la main).
    showButton: !atBottom && !pinned,
    clearUnread: atBottom,
  };
}
