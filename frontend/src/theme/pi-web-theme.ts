// ═══════════════════════════════════════════════════════════════════════════
// Pi-Web — thème unifié sur la brique `tokens` de holaf-lib (>= 0.5.0)
// ─────────────────────────────────────────────────────────────────────────────
// SOURCE UNIQUE DE COULEURS : la brique HolafTokens est la SEULE à poser les
// variables `--holaf-*` sur `:root`. Les variables historiques de Pi-Web
// (`hacker-theme.css`) en sont des ALIAS (`--accent: var(--holaf-accent, …)`,
// le 2ᵉ argument étant le repli d'avant — donc sûr même sans la brique).
//
// Pi-Web n'enregistre AUCUN thème maison : il n'utilise QUE les presets de la
// brique, nommés `<famille>-<mode>` :
//   • la famille d'IDENTITÉ `matrix` (ex-thème « Matrix » : monochrome à accent
//     néon vert) — DÉFAUT ;
//   • les 6 familles « couleur » de la roue chromatique V2 : corail, ambre,
//     emeraude, turquoise, amethyste, neutre.
//
// Le THÈME affiché est une FAMILLE ; le MODE (`dark`/`light`) complète le nom du
// preset appliqué. Défaut = famille `matrix` + mode `dark` → preset `matrix-dark`
// (rigoureusement le thème « Matrix » d'avant).
//
// ⚠️ COUCHE HÔTE (jamais un pack) — `buildPiWebOverlay` :
//   • 7 clés sémantiques que la brique ne définit pas mais que le CSS Pi-Web
//     consomme (`border-bright`, `text-bright`, `info`, `warn`, `code-inline-bg`,
//     `code-block-bg`, `tool-output-bg`) : présentes DANS le preset `matrix-*`,
//     sinon repli par MODE (les valeurs Pi-Web d'avant) ;
//   • les TRIPLES RGB (« r g b ») CALCULÉS depuis l'hex (support d'opacité
//     Tailwind : `rgb(var(--<x>-rgb) / <alpha-value>)`) — indérivables en CSS.
// Preset + couche hôte sont posés en UN SEUL lot (`setTokens`) : aucune purge
// intermédiaire, aucun flash, et les éventuelles clés `--holaf-*` d'un preset
// précédent absentes du nouveau lot sont retirées (purge par possession).
// ═══════════════════════════════════════════════════════════════════════════

// Effet de bord : la brique est CLASSIC-COMPATIBLE (aucun export top-level) et
// s'expose sur `window.HolafTokens` (repli `globalThis`). L'import ESM exécute
// le fichier, ce qui rend l'API disponible sans `export`.
import "../vendor/holaf/holaf-tokens.js";
import type { HolafTokenMap, HolafTokensApi } from "../vendor/holaf/holaf-tokens.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types & constantes
// ─────────────────────────────────────────────────────────────────────────────

export type ThemeMode = "dark" | "light";

/** Clé de persistance du MODE clair/sombre (inchangée). */
export const THEME_STORAGE_KEY = "pi-web-theme";
/** Ancienne clé de persistance de l'« accent » (pré-unification) — migrée. */
export const ACCENT_STORAGE_KEY = "pi-web-accent";
/** Clé de persistance de la FAMILLE de thème choisie. */
export const THEME_NAME_STORAGE_KEY = "pi-web-theme-name";

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue Pi-Web = les FAMILLES de la brique holaf-lib (aucun thème maison)
// ─────────────────────────────────────────────────────────────────────────────
// Ordre d'affichage : `matrix` en tête (identité Pi-Web, défaut), puis les 6
// familles couleur de la brique. Source de vérité des noms/valeurs : la brique ;
// la brique valide réellement l'existence de chaque preset à l'application
// (`getPreset`) et retombe sans crash si un preset manque.

export const PI_WEB_FAMILY_ORDER = [
  "matrix",
  "corail",
  "ambre",
  "emeraude",
  "turquoise",
  "amethyste",
  "neutre",
] as const;
export type PiWebThemeId = (typeof PI_WEB_FAMILY_ORDER)[number];

/** Famille par défaut : `matrix` (mode sombre → preset `matrix-dark`). */
export const DEFAULT_THEME_ID: PiWebThemeId = "matrix";

export interface PiWebThemeDefinition {
  id: PiWebThemeId;
  /** Clé i18n du libellé affiché (`themes.names.<id>`). */
  labelKey: string;
  /** Thème par défaut (badge DÉFAUT + repli de toute valeur inconnue). */
  isDefault: boolean;
}

/** Catalogue affiché, dans l'ordre : Matrix d'abord, puis les familles couleur. */
export const PI_WEB_THEMES: readonly PiWebThemeDefinition[] = PI_WEB_FAMILY_ORDER.map(
  (id) => ({ id, labelKey: `themes.names.${id}`, isDefault: id === DEFAULT_THEME_ID }),
);

/** Définition d'un thème par identifiant (undefined si inconnu). */
export function getThemeDefinition(themeId: string): PiWebThemeDefinition | undefined {
  return PI_WEB_THEMES.find((theme) => theme.id === themeId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration des anciennes préférences → famille de la brique
// ─────────────────────────────────────────────────────────────────────────────
// Règle : toute valeur stockée (ancien THÈME Pi-Web, ancien ACCENT, ou famille de
// la brique) est RAMENÉE à une famille EXISTANTE — jamais d'état incohérent.
// Les anciens thèmes supprimés sont redirigés vers la famille la plus proche
// (violet/indigo/midnight → amethyste, orange/amber → ambre, cyan → turquoise,
// rose → corail, emerald → emeraude, slate → neutre) ; green (ancien accent) →
// matrix ; toute valeur absente/vide/inconnue → matrix (DÉFAUT).

/** Anciens THÈMES Pi-Web (clé `pi-web-theme-name`) → famille de la brique. */
export const LEGACY_THEME_TO_FAMILY: Readonly<Record<string, PiWebThemeId>> = {
  matrix: "matrix",
  violet: "amethyste",
  orange: "ambre",
  cyan: "turquoise",
  rose: "corail",
  indigo: "amethyste",
  emerald: "emeraude",
  midnight: "amethyste",
  slate: "neutre",
  amber: "ambre",
};

/** Anciens ACCENTS Pi-Web (clé `pi-web-accent`) → famille de la brique. */
export const LEGACY_ACCENT_TO_THEME: Readonly<Record<string, PiWebThemeId>> = {
  green: "matrix",
  purple: "amethyste",
  orange: "ambre",
  cyan: "turquoise",
  rose: "corail",
};

// Table unique de résolution : familles de la brique (identité) + anciens
// thèmes + anciens accents. Toute valeur non reconnue retombe sur le défaut.
const FAMILY_RESOLUTION: Readonly<Record<string, PiWebThemeId>> = Object.freeze({
  ...Object.fromEntries(PI_WEB_FAMILY_ORDER.map((f) => [f, f])),
  ...LEGACY_THEME_TO_FAMILY,
  ...LEGACY_ACCENT_TO_THEME,
});

/** Convertit un ancien accent Pi-Web en famille ; toute valeur inconnue → Matrix. */
export function themeFromLegacyAccent(accent: unknown): PiWebThemeId {
  const key = typeof accent === "string" ? accent.trim().toLowerCase() : "";
  return LEGACY_ACCENT_TO_THEME[key] ?? DEFAULT_THEME_ID;
}

/** Normalise tout identifiant (famille, ancien thème ou ancien accent) en famille. */
export function normalizeThemeId(value: unknown): PiWebThemeId {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FAMILY_RESOLUTION[id] ?? DEFAULT_THEME_ID;
}

/** Interface minimale d'un stockage local (localStorage en production). */
export interface ThemePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Lit la préférence de thème persistée en la MIGRANT vers une famille valide :
 *   1. clé `pi-web-theme-name` présente → normalisée en famille ; si la valeur
 *      stockée était un ancien thème (ex. « violet »), la clé est réécrite (ex.
 *      « amethyste ») pour purger l'ancien vocabulaire ;
 *   2. sinon → conversion de `pi-web-accent` (`themeFromLegacyAccent`), écriture
 *      dans la nouvelle clé puis suppression de l'ancienne ;
 *   3. aucune information exploitable → `matrix` (DÉFAUT), nouvelle clé écrite.
 * Les erreurs de stockage (mode privé…) sont avalées : on rend toujours une
 * famille utilisable (jamais d'écran cassé).
 */
export function readPersistedThemeName(storage: ThemePreferenceStorage): PiWebThemeId {
  let stored: string | null = null;
  try {
    stored = storage.getItem(THEME_NAME_STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (stored !== null) {
    const family = normalizeThemeId(stored);
    if (family !== stored) {
      try {
        storage.setItem(THEME_NAME_STORAGE_KEY, family);
      } catch {
        /* stockage indisponible : la valeur normalisée reste utilisable */
      }
    }
    return family;
  }
  let legacy: string | null = null;
  try {
    legacy = storage.getItem(ACCENT_STORAGE_KEY);
  } catch {
    legacy = null;
  }
  const migrated = themeFromLegacyAccent(legacy);
  try {
    storage.setItem(THEME_NAME_STORAGE_KEY, migrated);
    if (legacy !== null) storage.removeItem(ACCENT_STORAGE_KEY);
  } catch {
    /* stockage indisponible : on rend quand même une famille */
  }
  return migrated;
}

/** Lit la préférence depuis le localStorage du navigateur (repli Matrix). */
export function readSavedThemeName(): PiWebThemeId {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_THEME_ID;
    return readPersistedThemeName(localStorage);
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Persiste la famille de thème choisie (erreurs de stockage avalées). */
export function persistThemeName(themeId: PiWebThemeId): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(THEME_NAME_STORAGE_KEY, themeId);
  } catch {
    /* stockage indisponible */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires hex / RGB
// ─────────────────────────────────────────────────────────────────────────────

/** Parse un hex (`#rgb` / `#rrggbb`) en `[r,g,b]` décimaux ; `null` si invalide. */
function parseHexRgb(hex: unknown): [number, number, number] | null {
  let h = typeof hex === "string" ? hex.trim().replace(/^#/, "") : "";
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Vrai si `value` est un hex exploitable (utilisé pour ne poser que des triples sûrs). */
function isHex(value: unknown): value is string {
  return parseHexRgb(value) !== null;
}

/**
 * Convertit un hex (`#rgb` ou `#rrggbb`) en triple « r g b » (décimal, espacé)
 * attendu par Tailwind : `rgb(var(--x-rgb) / <alpha-value>)`.
 * Lève une erreur claire si l'entrée n'est pas un hex exploitable.
 */
export function hexToRgbTriple(hex: string): string {
  const rgb = parseHexRgb(hex);
  if (!rgb) {
    throw new Error(`[pi-web-theme] hex invalide : "${hex}" (attendu #rgb ou #rrggbb).`);
  }
  return `${rgb[0]} ${rgb[1]} ${rgb[2]}`;
}

/** Résout l'API de la brique (window en navigateur, globalThis ailleurs). */
export function getHolafTokens(): HolafTokensApi {
  const api =
    (typeof window !== "undefined" ? window.HolafTokens : undefined) ??
    (globalThis as unknown as { HolafTokens?: HolafTokensApi }).HolafTokens;
  if (!api || typeof api.getPreset !== "function" || typeof api.setTokens !== "function") {
    throw new Error(
      "[pi-web-theme] brique HolafTokens introuvable — vérifiez " +
        "src/vendor/holaf/holaf-tokens.js (v0.5.0)."
    );
  }
  return api;
}

// ─────────────────────────────────────────────────────────────────────────────
// Couche hôte Pi-Web — clés sémantiques hors brique + triples RGB
// ─────────────────────────────────────────────────────────────────────────────
// Valeurs de REPLI par mode = les valeurs Pi-Web d'AVANT (ex-thème Matrix). Elles
// ne servent que pour les familles qui ne portent pas ces clés (toutes sauf
// `matrix`).

interface PiWebModeDefaults {
  borderBright: string;
  textBright: string;
  info: string;
  warn: string;
  codeInlineBg: string;
  codeBlockBg: string;
  toolOutputBg: string;
}

const MODE_DEFAULTS: Readonly<Record<ThemeMode, PiWebModeDefaults>> = {
  dark: {
    borderBright: "#3a3a3a",
    textBright: "#e0e0e0",
    info: "#00aaff",
    warn: "#ffaa00",
    codeInlineBg: "rgba(0, 0, 0, 0.3)",
    codeBlockBg: "rgba(0, 0, 0, 0.4)",
    toolOutputBg: "rgba(0, 0, 0, 0.3)",
  },
  light: {
    borderBright: "#b8b8b0",
    textBright: "#1a1a18",
    info: "#0070cc",
    warn: "#cc8800",
    codeInlineBg: "rgba(0, 0, 0, 0.06)",
    codeBlockBg: "rgba(0, 0, 0, 0.08)",
    toolOutputBg: "rgba(0, 0, 0, 0.05)",
  },
};

/**
 * Repli STATIQUE de la famille `matrix` (valeurs Pi-Web d'avant), utilisé
 * UNIQUEMENT si la brique vendordée ne fournit pas les presets `matrix-*`
 * (brique trop ancienne) : garantit un rendu correct plutôt qu'un écran cassé.
 * N'est jamais atteint avec la brique vendue (>= 0.5.0).
 */
const PI_WEB_STATIC_FALLBACK: Readonly<Record<ThemeMode, HolafTokenMap>> = {
  dark: {
    "surface": "#0a0a0a",
    "surface-elev": "#161616",
    "surface-raised": "#1e1e1e",
    "border": "#2a2a2a",
    "border-bright": "#3a3a3a",
    "text": "#c0c0c0",
    "text-bright": "#e0e0e0",
    "text-muted": "#888888",
    "info": "#00aaff",
    "warn": "#ffaa00",
    "danger": "#ff4444",
    "accent": "#00ff41",
    "accent-hover": "#00cc34",
    "code-inline-bg": "rgba(0, 0, 0, 0.3)",
    "code-block-bg": "rgba(0, 0, 0, 0.4)",
    "tool-output-bg": "rgba(0, 0, 0, 0.3)",
  },
  light: {
    "surface": "#eeece6",
    "surface-elev": "#f8f7f4",
    "surface-raised": "#ffffff",
    "border": "#d0d0c8",
    "border-bright": "#b8b8b0",
    "text": "#3d3d3a",
    "text-bright": "#1a1a18",
    "text-muted": "#777770",
    "info": "#0070cc",
    "warn": "#cc8800",
    "danger": "#cc2222",
    "accent": "#166534",
    "accent-hover": "#15803d",
    "code-inline-bg": "rgba(0, 0, 0, 0.06)",
    "code-block-bg": "rgba(0, 0, 0, 0.08)",
    "tool-output-bg": "rgba(0, 0, 0, 0.05)",
  },
};

/**
 * Construit la couche hôte Pi-Web à fusionner par-dessus un preset de la brique :
 *   • 7 clés sémantiques (pack du preset si présent, sinon repli par mode) ;
 *   • 13 triples RGB calculés depuis les hex (support d'opacité Tailwind).
 * Les triples ne sont posés que si la couleur source est un hex exploitable
 * (sinon la clé est omise → le repli CSS de hacker-theme.css prend le relais).
 */
export function buildPiWebOverlay(preset: HolafTokenMap, mode: ThemeMode): HolafTokenMap {
  const d = MODE_DEFAULTS[mode];
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const pick = (key: string, fallback: string): string => str(preset[key]) ?? fallback;

  const surface = str(preset.surface);
  const surfaceElev = str(preset["surface-elev"]);
  const surfaceRaised = str(preset["surface-raised"]);
  const border = str(preset.border);
  const text = str(preset.text);
  const textMuted = str(preset["text-muted"]);
  const accent = str(preset.accent);
  const accentHover = str(preset["accent-hover"]);
  const danger = str(preset.danger);

  const borderBright = pick("border-bright", d.borderBright);
  const textBright = pick("text-bright", d.textBright);
  const info = pick("info", d.info);
  const warn = pick("warn", d.warn);

  const overlay: HolafTokenMap = {
    "border-bright": borderBright,
    "text-bright": textBright,
    info,
    warn,
    "code-inline-bg": pick("code-inline-bg", d.codeInlineBg),
    "code-block-bg": pick("code-block-bg", d.codeBlockBg),
    "tool-output-bg": pick("tool-output-bg", d.toolOutputBg),
  };

  const rgbSources: Array<[string, string | null]> = [
    ["bg-rgb", surface],
    ["surface-rgb", surfaceElev],
    ["surface-raised-rgb", surfaceRaised],
    ["border-rgb", border],
    ["border-bright-rgb", borderBright],
    ["text-rgb", text],
    ["text-bright-rgb", textBright],
    ["text-dim-rgb", textMuted],
    ["info-rgb", info],
    ["warn-rgb", warn],
    ["error-rgb", danger],
    ["accent-rgb", accent],
    ["accent-dim-rgb", accentHover],
  ];
  for (const [key, hex] of rgbSources) {
    if (isHex(hex)) overlay[key] = hexToRgbTriple(hex);
  }
  return overlay;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nom du preset appliqué & pastille d'aperçu
// ─────────────────────────────────────────────────────────────────────────────

/** Nom du preset de la brique appliqué pour une famille (ou valeur héritée) × mode. */
export function themePackNameFor(themeId: string, mode: ThemeMode): string {
  return `${normalizeThemeId(themeId)}-${mode}`;
}

/** Couleur d'accent d'aperçu (pastille) : l'accent réel du preset de la brique. */
export function themeSwatchColor(themeId: string, mode: ThemeMode): string {
  const family = normalizeThemeId(themeId);
  try {
    const preset = getHolafTokens().getPreset(`${family}-${mode}`);
    if (preset && typeof preset.accent === "string" && preset.accent) {
      return preset.accent.toLowerCase();
    }
  } catch {
    /* brique indisponible → repli ci-dessous */
  }
  const fallback = PI_WEB_STATIC_FALLBACK[mode].accent;
  return typeof fallback === "string" ? fallback : "#00ff41";
}

// ─────────────────────────────────────────────────────────────────────────────
// Application
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applique le thème Pi-Web : récupère le preset `<famille>-<mode>` de la brique,
 * le complète avec la couche hôte (triples RGB + clés sémantiques) puis pose le
 * TOUT en un seul lot via `setTokens`. La brique écrit les `--holaf-*` sur
 * `:root` ; les variables Pi-Web (aliases dans hacker-theme.css) suivent.
 *
 * `themeOrLegacy` accepte une famille de la brique, un ancien thème Pi-Web
 * (violet, indigo…) ou un ancien accent (green, purple…) ; tout inconnu → matrix.
 */
export function applyPiWebTheme(mode: ThemeMode, themeOrLegacy: string): void {
  const family = normalizeThemeId(themeOrLegacy);
  const presetName = `${family}-${mode}`;
  const HT = getHolafTokens();
  const preset =
    HT.getPreset(presetName) ??
    HT.getPreset(`${DEFAULT_THEME_ID}-${mode}`) ??
    PI_WEB_STATIC_FALLBACK[mode];
  HT.setTokens({ name: presetName, values: { ...preset, ...buildPiWebOverlay(preset, mode) } });
}

function readSavedMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Boot anti-flash : applique le thème mémorisé AVANT le premier rendu (appelé en
 * tête de `main.tsx`, de façon synchrone). C'est ici que la MIGRATION des
 * anciennes préférences (thème/accent) est jouée (une fois).
 */
export function initPiWebTheme(): void {
  applyPiWebTheme(readSavedMode(), readSavedThemeName());
}
