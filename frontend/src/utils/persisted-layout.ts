// ── Lecture des préférences de mise en page persistées (localStorage) ──────
// F20 : `parseFloat`/`parseInt` d'une valeur corrompue donnaient `NaN`, appliqué
// tel quel en CSS (`fontSize: NaN%`, largeur `NaN`) — panne NON réparable depuis
// l'interface. Même patron que la validation de `panels` dans App.tsx : toute
// valeur non finie ou hors bornes retombe sur le défaut.

/** Bornes de zoom (identiques aux boutons +/− de l'en-tête, App.tsx). */
export const ZOOM_BOUNDS = { min: 0.6, max: 1.5 } as const;
/** Bornes de largeur de la barre latérale (identiques au drag, App.tsx). */
export const SIDEBAR_WIDTH_BOUNDS = { min: 140, max: 400 } as const;

/**
 * Nombre fini issu d'une chaîne localStorage, sinon `fallback`.
 * `null`/`""`/`"abc"`/`"NaN"`/`"Infinity"`/hors-bornes → `fallback`.
 */
export function readFiniteNumber(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

/** Zoom persisté (`pi-web-zoom`), validé et borné. */
export function readPersistedZoom(raw: string | null, fallback = 1.2): number {
  return readFiniteNumber(raw, fallback, ZOOM_BOUNDS.min, ZOOM_BOUNDS.max);
}

/** Largeur de sidebar persistée (`pi-web-sidebar-width`), arrondie et bornée. */
export function readPersistedSidebarWidth(raw: string | null, fallback = 192): number {
  return Math.round(readFiniteNumber(raw, fallback, SIDEBAR_WIDTH_BOUNDS.min, SIDEBAR_WIDTH_BOUNDS.max));
}
