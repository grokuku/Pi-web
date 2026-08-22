// ── Pile centralisée des overlays (modaux, visionneuses…) ────────────────────
// Lot B — conflit Échap : le raccourci global de App.tsx (pi_abort) doit céder
// la priorité dès qu'un overlay est affiché. Règle voulue :
//   - un overlay est ouvert  → Échap ne fait QUE le fermer (chaque overlay gère
//     sa propre fermeture) ;
//   - aucun overlay ouvert   → Échap interrompt le streaming (comportement
//     historique conservé).
//
// Fonctionnement : chaque overlay s'enregistre au montage via useOverlayStack()
// et se retire au démontage. App.tsx interroge hasOpenOverlay() ; les overlays
// empilés comparent leur token avec isTopOverlay() pour ne réagir à Échap que
// lorsqu'ils sont au sommet de la pile — une pression ferme UN overlay (le plus
// récent), jamais toute la cascade de modaux imbriqués.

import { useEffect, useRef, type MutableRefObject } from "react";

type OverlayToken = symbol;

const stack: OverlayToken[] = [];

/** Empile un nouvel overlay et retourne son token unique. */
export function pushOverlay(): OverlayToken {
  const token = Symbol("overlay");
  stack.push(token);
  return token;
}

/** Retire un overlay de la pile (tolérant aux doubles retraits). */
export function popOverlay(token: OverlayToken): void {
  const idx = stack.indexOf(token);
  if (idx !== -1) stack.splice(idx, 1);
}

/** true si `token` est l'overlay le plus récent (sommet de la pile). */
export function isTopOverlay(token: OverlayToken | null): boolean {
  return token !== null && stack.length > 0 && stack[stack.length - 1] === token;
}

/** true si au moins un overlay/modal/visionneuse est actuellement ouvert. */
export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

/**
 * Hook : enregistre l'overlay pour sa durée de vie (montage → démontage) et
 * retourne un ref vers son token, à déréférencer dans isTopOverlay() dans le
 * gestionnaire Échap. L'enregistrement se fait dans useEffect (après commit)
 * pour ne jamais laisser un token orphelin dans la pile si un render est jeté
 * par React.
 */
export function useOverlayStack(): MutableRefObject<OverlayToken | null> {
  const tokenRef = useRef<OverlayToken | null>(null);
  useEffect(() => {
    const token = pushOverlay();
    tokenRef.current = token;
    return () => {
      popOverlay(token);
      tokenRef.current = null;
    };
  }, []);
  return tokenRef;
}
