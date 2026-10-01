// ═══════════════════════════════════════════════════════════════════════════
// Pi-Web — thème unifié sur la brique `tokens` de holaf-lib (v0.3.0)
// ─────────────────────────────────────────────────────────────────────────────
// SOURCE UNIQUE DE COULEURS : la brique HolafTokens est désormais la SEULE à
// poser les variables `--holaf-*` sur `:root`. Les variables historiques de
// Pi-Web (`hacker-theme.css`) deviennent des ALIAS de ces tokens
// (`--accent: var(--holaf-accent, <repli>)`).
//
// Les palettes Pi-Web sont déclarées comme PACKS OFFICIELS de la bibliothèque
// (`registerPreset`), réutilisables par les autres projets de l'utilisateur :
//   • `pi-web-base-dark`  / `pi-web-base-light` — surfaces, textes, sémantiques,
//     fonds de code (commun à tous les accents d'un mode) ;
//   • `pi-web-<accent>-<mode>` — 5 accents × 2 modes = 10 thèmes complets
//     (ils `extends` le pack de base du mode et n'ajoutent que accent/accent-dim).
//
// Convention de nommage : `pi-web-<accent>-<mode>`, accent ∈
// {green,purple,orange,cyan,rose}, mode ∈ {dark,light}.
//
// Depuis le sélecteur de THÈME, l'« accent » n'est plus une notion d'UI : les
// accents sont la couche basse (packs) et les THÈMES la couche affichée :
//   matrix (vert, DÉFAUT), violet, orange, cyan, rose — puis les thèmes de la
//   bibliothèque holaf (indigo, emerald, midnight, slate, amber) recopiés dans
//   des packs hôte `pi-web-lib-<famille>-<mode>`. Voir PI_WEB_THEMES.
//
// ⚠️ CONTRAINTE N°1 — ZÉRO CHANGEMENT VISUEL : les valeurs des packs sont
// copiées VERBATIM de `hacker-theme.css`. Le second argument de `var()` dans le
// CSS est le repli (l'ancienne valeur) : même si la brique ne chargeait pas, le
// rendu resterait identique. La constante `PI_WEB_PALETTES` ci-dessous est la
// copie exacte des valeurs AVANT unification (test de non-régression).
//
// ⚠️ PIÈGE RGB : Tailwind mappe les classes `hacker-*` avec
// `rgb(var(--<x>-rgb) / <alpha-value>)` pour l'opacité (`bg-hacker-accent/10`).
// Les tokens de la brique sont du HEX : les triples RGB ne peuvent donc PAS se
// déduire en CSS. On les CALCULE ici (hex → « r g b ») et on les pose comme
// tokens hôte (`--holaf-bg-rgb`…), gardant l'opacité Tailwind intacte partout.
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

export const PI_WEB_ACCENTS = ["green", "purple", "orange", "cyan", "rose"] as const;
export type PiWebAccent = (typeof PI_WEB_ACCENTS)[number];

/** Clés de persistance du MODE (inchangée) et de l'ancien ACCENT (migrée). */
export const THEME_STORAGE_KEY = "pi-web-theme";
export const ACCENT_STORAGE_KEY = "pi-web-accent";
/** Nouvelle clé de persistance du THÈME choisi (remplace ACCENT_STORAGE_KEY). */
export const THEME_NAME_STORAGE_KEY = "pi-web-theme-name";

/** Noms des packs de base (un par mode). */
export const BASE_PACK_DARK = "pi-web-base-dark";
export const BASE_PACK_LIGHT = "pi-web-base-light";

/** Une palette de mode : valeurs VERBATIM de hacker-theme.css (avant unification). */
export interface ModePalette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderBright: string;
  text: string;
  textBright: string;
  textDim: string;
  info: string;
  warn: string;
  error: string;
  codeInlineBg: string;
  codeBlockBg: string;
  toolOutputBg: string;
}

interface AccentPair {
  accent: string;
  accentDim: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PALETTES Pi-Web — copie EXACTE des valeurs d'avant l'unification
// ─────────────────────────────────────────────────────────────────────────────

/** Thème sombre par défaut (`:root` de hacker-theme.css). */
export const DARK_PALETTE: ModePalette = {
  bg: "#0a0a0a",
  surface: "#161616",
  surfaceRaised: "#1e1e1e",
  border: "#2a2a2a",
  borderBright: "#3a3a3a",
  text: "#c0c0c0",
  textBright: "#e0e0e0",
  textDim: "#888888",
  info: "#00aaff",
  warn: "#ffaa00",
  error: "#ff4444",
  codeInlineBg: "rgba(0, 0, 0, 0.3)",
  codeBlockBg: "rgba(0, 0, 0, 0.4)",
  toolOutputBg: "rgba(0, 0, 0, 0.3)",
};

/** Mode clair (`.light` de hacker-theme.css). */
export const LIGHT_PALETTE: ModePalette = {
  bg: "#eeece6",
  surface: "#f8f7f4",
  surfaceRaised: "#ffffff",
  border: "#d0d0c8",
  borderBright: "#b8b8b0",
  text: "#3d3d3a",
  textBright: "#1a1a18",
  textDim: "#777770",
  info: "#0070cc",
  warn: "#cc8800",
  error: "#cc2222",
  codeInlineBg: "rgba(0, 0, 0, 0.06)",
  codeBlockBg: "rgba(0, 0, 0, 0.08)",
  toolOutputBg: "rgba(0, 0, 0, 0.05)",
};

/** Les 5 accents Pi-Web, déclinaison sombre + claire (accent + accent-dim). */
export const ACCENT_PALETTES: Record<PiWebAccent, { dark: AccentPair; light: AccentPair }> = {
  green: {
    dark: { accent: "#00ff41", accentDim: "#00cc34" },
    light: { accent: "#166534", accentDim: "#15803d" },
  },
  purple: {
    dark: { accent: "#c084fc", accentDim: "#a855f7" },
    light: { accent: "#8b5cf6", accentDim: "#7c3aed" },
  },
  orange: {
    dark: { accent: "#fb923c", accentDim: "#f97316" },
    light: { accent: "#ea580c", accentDim: "#c2410c" },
  },
  cyan: {
    dark: { accent: "#22d3ee", accentDim: "#06b6d4" },
    light: { accent: "#0891b2", accentDim: "#0e7490" },
  },
  rose: {
    dark: { accent: "#f472b6", accentDim: "#ec4899" },
    light: { accent: "#db2777", accentDim: "#be185d" },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// THÈMES (modèle UI) — remplace la notion d'« accent » dans l'interface
// ─────────────────────────────────────────────────────────────────────────────
// La brique `tokens` reste la source unique de couleurs ; le « thème » est la
// couche de NOMMAGE présentée à l'utilisateur :
//   • thèmes d'identité Pi-Web (packs `pi-web-<accent>-<mode>`) :
//       matrix (DÉFAUT, ex-accent « green »), violet (ex-« purple »), orange,
//       cyan, rose ;
//   • thèmes de la bibliothèque holaf (presets intégrés `<famille>-<mode>`,
//     recopiés dans des packs hôte `pi-web-lib-<famille>-<mode>` pour ne
//     garder que le vocabulaire de tokens Pi-Web) :
//       indigo, emerald, midnight, slate, amber.
// L'ordre d'affichage est celui de `PI_WEB_THEMES` (Matrix en premier).

export const PI_WEB_PRIMARY_THEME_IDS = ["matrix", "violet", "orange", "cyan", "rose"] as const;
export const PI_WEB_LIBRARY_THEME_IDS = ["indigo", "emerald", "midnight", "slate", "amber"] as const;
export const PI_WEB_THEME_IDS = [
  ...PI_WEB_PRIMARY_THEME_IDS,
  ...PI_WEB_LIBRARY_THEME_IDS,
] as const;
export type PiWebThemeId = (typeof PI_WEB_THEME_IDS)[number];

/** Thème par défaut : Matrix (vert néon historique). */
export const DEFAULT_THEME_ID: PiWebThemeId = "matrix";

export interface PiWebThemeDefinition {
  id: PiWebThemeId;
  /** Ancien accent Pi-Web : pack appliqué `pi-web-<accent>-<mode>` (null si bibliothèque). */
  accent: PiWebAccent | null;
  /** Famille holaf : preset intégré `<famille>-<mode>` (null si thème Pi-Web). */
  library: string | null;
  /** Clé i18n du libellé affiché (`themes.names.<id>`). */
  labelKey: string;
  /** Thème par défaut (badge DÉFAUT + repli de toute valeur inconnue). */
  isDefault: boolean;
}

/** Catalogue affiché, dans l'ordre : Matrix d'abord, puis les 4 autres couleurs. */
export const PI_WEB_THEMES: readonly PiWebThemeDefinition[] = [
  { id: "matrix", accent: "green", library: null, labelKey: "themes.names.matrix", isDefault: true },
  { id: "violet", accent: "purple", library: null, labelKey: "themes.names.violet", isDefault: false },
  { id: "orange", accent: "orange", library: null, labelKey: "themes.names.orange", isDefault: false },
  { id: "cyan", accent: "cyan", library: null, labelKey: "themes.names.cyan", isDefault: false },
  { id: "rose", accent: "rose", library: null, labelKey: "themes.names.rose", isDefault: false },
  { id: "indigo", accent: null, library: "indigo", labelKey: "themes.names.indigo", isDefault: false },
  { id: "emerald", accent: null, library: "emerald", labelKey: "themes.names.emerald", isDefault: false },
  { id: "midnight", accent: null, library: "midnight", labelKey: "themes.names.midnight", isDefault: false },
  { id: "slate", accent: null, library: "slate", labelKey: "themes.names.slate", isDefault: false },
  { id: "amber", accent: null, library: "amber", labelKey: "themes.names.amber", isDefault: false },
];

/** Définition d'un thème par identifiant (undefined si inconnu). */
export function getThemeDefinition(themeId: string): PiWebThemeDefinition | undefined {
  return PI_WEB_THEMES.find((theme) => theme.id === themeId);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION ancien accent → nouveau thème (testable, sans état incohérent)
// ─────────────────────────────────────────────────────────────────────────────
// Règle bijective : green→matrix, purple→violet, orange→orange, cyan→cyan,
// rose→rose. Toute valeur absente/vide/inconnue → matrix (DÉFAUT).
// La préférence est écrite dans la NOUVELLE clé `pi-web-theme-name`, puis
// l'ancienne clé `pi-web-accent` est SUPPRIMÉE : plus aucune lecture de
// l'ancienne valeur n'est possible (donc aucune divergence possible).

export const LEGACY_ACCENT_TO_THEME: Readonly<Record<PiWebAccent, PiWebThemeId>> = {
  green: "matrix",
  purple: "violet",
  orange: "orange",
  cyan: "cyan",
  rose: "rose",
};

/** Convertit un ancien accent en thème ; toute valeur non reconnue → Matrix. */
export function themeFromLegacyAccent(accent: unknown): PiWebThemeId {
  const key = typeof accent === "string" ? accent.trim().toLowerCase() : "";
  return LEGACY_ACCENT_TO_THEME[key as PiWebAccent] ?? DEFAULT_THEME_ID;
}

/** Normalise un identifiant de thème (nouveau) OU un ancien accent. */
export function normalizeThemeId(value: unknown): PiWebThemeId {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (PI_WEB_THEME_IDS as readonly string[]).includes(id)
    ? (id as PiWebThemeId)
    : themeFromLegacyAccent(id);
}

/** Interface minimale d'un stockage local (localStorage en production). */
export interface ThemePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Lit la préférence de thème persistée en MIGRANT l'ancienne clé d'accent :
 *   1. nouvelle clé valide → elle gagne, l'ancienne clé n'est pas touchée ;
 *   2. sinon → conversion de `pi-web-accent` (`themeFromLegacyAccent`),
 *      écriture dans la nouvelle clé puis suppression de l'ancienne ;
 *   3. aucune information exploitable → Matrix (DÉFAUT), nouvelle clé écrite.
 * Les erreurs de stockage (mode privé…) sont avalées : on rend un thème usable.
 */
export function readPersistedThemeName(storage: ThemePreferenceStorage): PiWebThemeId {
  let current: string | null = null;
  try {
    current = storage.getItem(THEME_NAME_STORAGE_KEY);
  } catch {
    current = null;
  }
  if (current && (PI_WEB_THEME_IDS as readonly string[]).includes(current)) {
    return current as PiWebThemeId;
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
    /* stockage indisponible : on rend quand même un thème */
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

/** Persiste le thème choisi (erreurs de stockage avalées). */
export function persistThemeName(themeId: PiWebThemeId): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(THEME_NAME_STORAGE_KEY, themeId);
  } catch {
    /* stockage indisponible */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convertit un hex (`#rgb` ou `#rrggbb`) en triple « r g b » (décimal, espacé)
 * attendu par Tailwind : `rgb(var(--x-rgb) / <alpha-value>)`.
 * Lève une erreur claire si l'entrée n'est pas un hex exploitable.
 */
export function hexToRgbTriple(hex: string): string {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`[pi-web-theme] hex invalide : "${hex}" (attendu #rgb ou #rrggbb).`);
  }
  return `${parseInt(h.slice(0, 2), 16)} ${parseInt(h.slice(2, 4), 16)} ${parseInt(h.slice(4, 6), 16)}`;
}

/** Parse un hex en `[r,g,b]` décimaux ; `null` si l'entrée n'est pas un hex. */
function parseHexRgb(hex: string): [number, number, number] | null {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Mélange deux hex (`ratio` 0..1 = part de `b`) ; renvoie `a` si l'entrée est
 * invalide. Sert à dériver border-bright / text-bright des thèmes bibliothèque.
 */
export function mixHex(a: string, b: string, ratio: number): string {
  const ca = parseHexRgb(a);
  const cb = parseHexRgb(b);
  if (!ca || !cb) return a;
  const r = Math.max(0, Math.min(1, ratio));
  const to2 = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).toUpperCase().padStart(2, "0");
  return `#${to2(ca[0] + (cb[0] - ca[0]) * r)}${to2(ca[1] + (cb[1] - ca[1]) * r)}${to2(ca[2] + (cb[2] - ca[2]) * r)}`;
}

/** Résout l'API de la brique (window en navigateur, globalThis ailleurs). */
export function getHolafTokens(): HolafTokensApi {
  const api =
    (typeof window !== "undefined" ? window.HolafTokens : undefined) ??
    (globalThis as unknown as { HolafTokens?: HolafTokensApi }).HolafTokens;
  if (!api || typeof api.registerPreset !== "function") {
    throw new Error(
      "[pi-web-theme] brique HolafTokens introuvable — vérifiez " +
        "src/vendor/holaf/holaf-tokens.js (v0.3.0)."
    );
  }
  return api;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction des packs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokens du pack de BASE d'un mode : tout sauf accent/accent-dim.
 * Mapping Pi-Web → hôte :
 *   --bg             ← surface          --text        ← text
 *   --surface        ← surface-elev     --text-bright ← text-bright
 *   --surface-raised ← surface-raised   --text-dim    ← text-muted
 *   --border         ← border           --error       ← danger
 *   --border-bright  ← border-bright    --info/--warn ← info/warn (clés hôte)
 */
function buildBaseTokens(p: ModePalette): HolafTokenMap {
  return {
    surface: p.bg,
    "surface-elev": p.surface,
    "surface-raised": p.surfaceRaised,
    border: p.border,
    "border-bright": p.borderBright,
    text: p.text,
    "text-bright": p.textBright,
    "text-muted": p.textDim,
    info: p.info,
    warn: p.warn,
    danger: p.error,
    "code-inline-bg": p.codeInlineBg,
    "code-block-bg": p.codeBlockBg,
    "tool-output-bg": p.toolOutputBg,
    // Triples RGB calculés (support d'opacité Tailwind).
    "bg-rgb": hexToRgbTriple(p.bg),
    "surface-rgb": hexToRgbTriple(p.surface),
    "surface-raised-rgb": hexToRgbTriple(p.surfaceRaised),
    "border-rgb": hexToRgbTriple(p.border),
    "border-bright-rgb": hexToRgbTriple(p.borderBright),
    "text-rgb": hexToRgbTriple(p.text),
    "text-bright-rgb": hexToRgbTriple(p.textBright),
    "text-dim-rgb": hexToRgbTriple(p.textDim),
    "info-rgb": hexToRgbTriple(p.info),
    "warn-rgb": hexToRgbTriple(p.warn),
    "error-rgb": hexToRgbTriple(p.error),
  };
}

/**
 * Tokens d'accent ajoutés par-dessus le pack de base.
 * `--accent` ← accent, `--accent-dim` ← accent-hover (slot sémantique standard
 * de la brique : c'est la variante secondaire utilisée pour les bordures/hover).
 */
function buildAccentTokens(a: AccentPair): HolafTokenMap {
  return {
    accent: a.accent,
    "accent-hover": a.accentDim,
    "accent-rgb": hexToRgbTriple(a.accent),
    "accent-dim-rgb": hexToRgbTriple(a.accentDim),
  };
}

/** Nom du pack complet pour un accent et un mode donnés (vert si accent inconnu). */
export function themePackName(accent: string, mode: ThemeMode): string {
  const id = (PI_WEB_ACCENTS as readonly string[]).includes(accent) ? accent : "green";
  return `pi-web-${id}-${mode}`;
}

/** Nom du pack hôte d'un thème bibliothèque (`pi-web-lib-<famille>-<mode>`). */
export function libraryPackName(family: string, mode: ThemeMode): string {
  return `pi-web-lib-${family}-${mode}`;
}

/**
 * Pack appliqué pour un THÈME (ou un ancien accent) × mode.
 * Les valeurs inconnues retombent sur Matrix : jamais d'état incohérent.
 */
export function themePackNameFor(themeId: string, mode: ThemeMode): string {
  const def = getThemeDefinition(themeId) ?? getThemeDefinition(normalizeThemeId(themeId))!;
  if (def.accent) return themePackName(def.accent, mode);
  return libraryPackName(def.library!, mode);
}

/** Couleur d'accent d'aperçu (pastille) d'un thème dans un mode donné. */
export function themeSwatchColor(themeId: string, mode: ThemeMode): string {
  const def = getThemeDefinition(themeId) ?? getThemeDefinition(normalizeThemeId(themeId))!;
  if (def.accent) return ACCENT_PALETTES[def.accent][mode].accent;
  try {
    const holaf = getHolafTokens();
    // Pack hôte prioritaire (casse normalisée) puis preset intégré.
    const preset =
      holaf.getPreset(libraryPackName(def.library!, mode)) ?? holaf.getPreset(`${def.library}-${mode}`);
    if (preset && typeof preset.accent === "string" && preset.accent) {
      return preset.accent.toLowerCase();
    }
  } catch {
    /* brique indisponible → repli vert */
  }
  return ACCENT_PALETTES.green[mode].accent;
}

/**
 * Tokens Pi-Web d'un thème bibliothèque : couleurs du preset intégré holaf
 * `<famille>-<mode>`, compléments dérivés (border-bright/text-bright) et
 * triples RGB calculés (absents des presets intégrés). Aucun radius / shadow /
 * font-size n'est recopié : le pack ne porte QUE le vocabulaire Pi-Web.
 * `null` si la famille est absente de la brique (thème simplement ignoré).
 */
function buildLibraryTokens(family: string, mode: ThemeMode): HolafTokenMap | null {
  const preset = getHolafTokens().getPreset(`${family}-${mode}`);
  if (!preset || typeof preset.surface !== "string" || typeof preset.accent !== "string") {
    return null;
  }
  const base = mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
  const str = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value : fallback;
  const surface = str(preset.surface, base.bg);
  const surfaceElev = str(preset["surface-elev"], base.surface);
  const surfaceRaised = str(preset["surface-raised"], base.surfaceRaised);
  const border = str(preset.border, base.border);
  const text = str(preset.text, base.text);
  const textMuted = str(preset["text-muted"], base.textDim);
  const accent = str(preset.accent, ACCENT_PALETTES.green[mode].accent);
  const accentHover = str(preset["accent-hover"], ACCENT_PALETTES.green[mode].accentDim);
  const danger = str(preset.danger, base.error);
  const borderBright = mixHex(border, text, 0.24);
  const textBright = mixHex(text, mode === "dark" ? "#ffffff" : "#000000", 0.35);
  const tokens: HolafTokenMap = {
    surface,
    "surface-elev": surfaceElev,
    "surface-raised": surfaceRaised,
    border,
    "border-bright": borderBright,
    text,
    "text-bright": textBright,
    "text-muted": textMuted,
    info: base.info,
    warn: base.warn,
    danger,
    "code-inline-bg": base.codeInlineBg,
    "code-block-bg": base.codeBlockBg,
    "tool-output-bg": base.toolOutputBg,
    accent,
    "accent-hover": accentHover,
  };
  const rgb: Array<[string, string]> = [
    ["bg-rgb", surface],
    ["surface-rgb", surfaceElev],
    ["surface-raised-rgb", surfaceRaised],
    ["border-rgb", border],
    ["border-bright-rgb", borderBright],
    ["text-rgb", text],
    ["text-bright-rgb", textBright],
    ["text-dim-rgb", textMuted],
    ["info-rgb", base.info],
    ["warn-rgb", base.warn],
    ["error-rgb", danger],
    ["accent-rgb", accent],
    ["accent-dim-rgb", accentHover],
  ];
  // Normalisation en minuscules : les presets intégrés mélangent les casses
  // (historiques en minuscules, familles générées en MAJUSCULES).
  for (const key of Object.keys(tokens)) {
    const value = tokens[key];
    if (typeof value === "string" && value.startsWith("#")) tokens[key] = value.toLowerCase();
  }
  for (const [key, hex] of rgb) {
    if (parseHexRgb(hex)) tokens[key] = hexToRgbTriple(hex);
  }
  return tokens;
}

let packsRegistered = false;

/**
 * Enregistre (une seule fois) les packs Pi-Web dans la brique.
 * Registre VOLATILE de la brique : à rejouer à chaque boot (fait par
 * `initPiWebTheme`). Idempotent ici pour les appels répétés côté hôte.
 */
export function registerPiWebPacks(): void {
  if (packsRegistered) return;
  const HT = getHolafTokens();
  // Packs de base (commun aux accents d'un mode). `derive:false` = on ne pose
  // QUE les valeurs explicites (prévisibilité maximale, zéro clé parasite).
  HT.registerPreset(BASE_PACK_DARK, buildBaseTokens(DARK_PALETTE), { derive: false });
  HT.registerPreset(BASE_PACK_LIGHT, buildBaseTokens(LIGHT_PALETTE), { derive: false });
  // 5 accents × 2 modes, chacun héritant du pack de base du mode (`extends`).
  for (const accent of PI_WEB_ACCENTS) {
    const pair = ACCENT_PALETTES[accent];
    HT.registerPreset(themePackName(accent, "dark"), buildAccentTokens(pair.dark), {
      extends: BASE_PACK_DARK,
      derive: false,
    });
    HT.registerPreset(themePackName(accent, "light"), buildAccentTokens(pair.light), {
      extends: BASE_PACK_LIGHT,
      derive: false,
    });
  }
  // Thèmes de la bibliothèque holaf (recopiés en packs hôte Pi-Web).
  for (const def of PI_WEB_THEMES) {
    if (!def.library) continue;
    for (const mode of ["dark", "light"] as const) {
      const tokens = buildLibraryTokens(def.library, mode);
      if (tokens) HT.registerPreset(libraryPackName(def.library, mode), tokens, { derive: false });
    }
  }
  packsRegistered = true;
}

/** Pour les tests : force un nouvel enregistrement après `reset()` de la brique. */
export function __resetPacksRegistrationForTests(): void {
  packsRegistered = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Application
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applique le thème Pi-Web : la brique pose les `--holaf-*` sur `:root`, les
 * variables Pi-Web (aliases) suivent automatiquement. Aucune valeur littérale
 * n'est posée ici : la brique est la source unique.
 * `themeOrAccent` accepte un identifiant de thème (matrix, violet, indigo…) ou
 * un ancien accent (green, purple…) ; tout inconnu retombe sur Matrix.
 */
export function applyPiWebTheme(mode: ThemeMode, themeOrAccent: string): void {
  registerPiWebPacks();
  getHolafTokens().setTheme(themePackNameFor(themeOrAccent, mode));
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
 * Boot anti-flash : enregistre les packs puis applique le thème mémorisé
 * AVANT le premier rendu (appelé en tête de `main.tsx`, de façon synchrone).
 * C'est ici que la MIGRATION de l'ancienne clé d'accent est jouée (une fois).
 */
export function initPiWebTheme(): void {
  applyPiWebTheme(readSavedMode(), readSavedThemeName());
}
