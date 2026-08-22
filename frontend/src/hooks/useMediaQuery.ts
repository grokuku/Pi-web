import { useState, useEffect } from "react";

// ── useMediaQuery — suivi d'une media query CSS ─────────
// Retourne true si la media query est actuellement satisfaite.
// S'abonne aux changements : recalcul dès que la fenêtre franchit
// le seuil (ex. rotation mobile, redimensionnement).
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);

  return matches;
}

// ── useIsMobile — vrai en dessous du breakpoint desktop (md:768px) ──
// Mobile = valeur par défaut, desktop = classes md:*
export const useIsMobile = () => useMediaQuery("(max-width: 767px)");
