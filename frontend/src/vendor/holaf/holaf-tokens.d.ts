// Déclarations TypeScript pour la brique HolafTokens (holaf-lib v0.6.0).
// Copie pinnée dans vendor/holaf — le fichier .js est du JS pur (sans types),
// on déclare ici l'API publique pour que tsc passe sans `any` implicite.
// API calquée sur js/holaf-tokens.js (version 0.6.0). La brique est
// CLASSIC-COMPATIBLE : aucun export top-level, l'API est exposée via
// `window.HolafTokens` (repli `globalThis`). On peut donc l'importer par effet
// de bord (`import "./holaf-tokens.js"`) puis lire le global.

/** Carte de tokens `{ clé: valeur }` (clés sans préfixe ou avec `--…`). */
export type HolafTokenMap = Record<string, string | number>;

/** Options de `registerPreset`. */
export interface HolafPresetOptions {
  /** Nom du preset/pack dont on hérite (copie complète de base). */
  extends?: string;
  /**
   * Dérivation des clés optionnelles : `true` (défaut = groupe A+B),
   * `false` (aucune), ou tableau explicite de clés à dériver.
   */
  derive?: boolean | string[];
}

/** Résultat de `registerPreset` / `updatePreset`. */
export interface HolafPresetResult {
  name: string;
  vars: HolafTokenMap;
}

/** Résultat de `getTheme()`. */
export interface HolafThemeResult {
  name: string | null;
  vars: HolafTokenMap;
}

export interface HolafTokensApi {
  readonly VERSION: string;
  readonly PREFIX: string;
  /** Pose des tokens explicites sur `:root`. */
  setTokens(spec: { name?: string; values: HolafTokenMap }): HolafThemeResult;
  /** Applique un preset intégré / alias / pack par son nom. */
  setTheme(presetName: string): HolafThemeResult;
  /** Applique `<famille>-<mode>` (mode conservé si la famille est active). */
  setFamily(family: string, mode?: "light" | "dark"): HolafThemeResult;
  getTheme(): HolafThemeResult | null;
  getFamily(): string | null;
  getMode(): "light" | "dark" | null;
  applyPalette(accentHex: string, opts?: Record<string, unknown>): HolafThemeResult;
  /** Retire TOUTES les variables `--holaf-*` posées par la brique. */
  reset(): void;
  /** Noms valides : 18 intégrés (14 presets + 4 alias) PUIS packs hôte. */
  listPresets(): string[];
  listFamilies(): string[];
  registerPreset(name: string, tokens?: HolafTokenMap, options?: HolafPresetOptions): HolafPresetResult;
  updatePreset(name: string, tokens: HolafTokenMap): HolafPresetResult;
  unregisterPreset(name: string): boolean;
  getPreset(name: string): HolafTokenMap | null;
  /** hex → « rgba(r, g, b, a) » ; couleur non-hex renvoyée inchangée. */
  alpha(color: string, a?: number): string;
  readonly PRESETS: Record<string, HolafTokenMap>;
  readonly FAMILIES: Record<string, Record<string, unknown>>;
  readonly ALIASES: Record<string, string>;
  /** Table de migration ancien→nouveau nom (fournie aux hôtes). */
  readonly MIGRATIONS: Record<string, string>;
}

declare global {
  // eslint-disable-next-line no-var
  var HolafTokens: HolafTokensApi | undefined;
  interface Window {
    /** La brique s'expose elle-même sur window au chargement. */
    HolafTokens?: HolafTokensApi;
  }
}
