// Déclarations TypeScript pour la brique HolafIcons (holaf-lib v0.1.6).
// Copie pinnée dans vendor/holaf — le fichier .js est du JS pur (sans types),
// on déclare ici l'API publique pour que tsc --noEmit passe sans `any` implicite.
// API calquée sur js/holaf-icons.js (version 0.1.6) : list/get/render.
// Style : tracés 24×24, `stroke="currentColor"`, `stroke-width="2"`, `fill="none"`.

/** Options de `render()` : taille (width/height) et classe CSS du `<svg>`. */
export interface HolafIconsRenderOptions {
  /** Taille en pixels (défaut 24 ; valeur invalide → 24). */
  size?: number | string;
  /** Attribut `class` du `<svg>` (alias historique). */
  class?: string;
  /** Attribut `class` du `<svg>` (prioritaire sur `class`). */
  className?: string;
}

export interface HolafIconsApi {
  /** Version de la brique (ex. "0.1.6"). */
  version: string;
  /** Noms de toutes les icônes disponibles (ordre de définition). */
  list(): string[];
  /** SVG complet 24×24 ; lève une erreur claire si le nom est inconnu. */
  get(name: string): string;
  /** SVG complet avec `size` / `class` ; lève une erreur si le nom est inconnu. */
  render(name: string, opts?: HolafIconsRenderOptions): string;
}

export const HolafIcons: HolafIconsApi;

declare global {
  interface Window {
    /** La brique s'expose elle-même sur window au chargement (dual ESM + global). */
    HolafIcons?: HolafIconsApi;
  }
}
