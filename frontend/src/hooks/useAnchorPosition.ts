// ── useAnchorPosition ─────────────────────────────────
// Calcule la position « fixed » d'un menu/popover ancré sous le bord
// bas-droit d'un bouton, pour un rendu via createPortal(document.body).
//
// Pourquoi : les dropdowns portés dans <body> sont en position:fixed et
// doivent suivre le bouton déclencheur. Le calcul se fait au moment où le
// menu s'ouvre, puis est RE-EXÉCUTÉ au scroll (capture — couvre le scroll
// interne du header overflow-x-auto) et au resize, tant que le menu est
// ouvert. On utilise document.documentElement.clientWidth/Height (et non
// window.innerWidth/Height) pour exclure la scrollbar et éviter un décalage.
// Un clamp empêche le menu de sortir du bas de l'écran.

import { useCallback, useEffect, useRef, useState } from "react";

export interface AnchorPos {
  top: number;
  right: number;
}

/**
 * @param getAnchor renvoie le bouton ancré (null si indisponible). Re-créé
 *   à chaque render (il lit des refs) : le hook mémorise la version récente
 *   dans une ref pour ne pas ré-abonner inutilement.
 * @param open true quand le menu est ouvert.
 * @param offset espace vertical sous le bouton (px).
 * @param targetKey identifie la CIBLE du popover (ex. le mode de bouton actif).
 *   Quand elle change, la position est recalculée même si `open` reste vrai
 *   (ex. bascule d'un mode à un autre sans fermer le menu).
 */
export function useAnchorPosition(
  getAnchor: () => HTMLElement | null,
  open: boolean,
  offset = 4,
  targetKey?: string
): AnchorPos | null {
  const [pos, setPos] = useState<AnchorPos | null>(null);
  const getAnchorRef = useRef(getAnchor);
  getAnchorRef.current = getAnchor;

  const compute = useCallback((): AnchorPos | null => {
    const el = getAnchorRef.current();
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const top = Math.min(rect.bottom + offset, vh - 8);
    const right = Math.max(0, vw - rect.right);
    return { top, right };
  }, [offset]);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    setPos(compute());
    const handle = () => setPos(compute());
    // scroll en phase de capture : capte le scroll du header (overflow-x-auto)
    // et de toute zone scrollable interne, pas seulement le scroll de window.
    window.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
    };
  }, [open, compute, targetKey]);

  return pos;
}
