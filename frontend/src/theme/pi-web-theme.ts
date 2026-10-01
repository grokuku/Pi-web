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
// {green,purple,orange,cyan,rose}, mode ∈ {dark,light}. Le vert est l'accent
// par défaut de Pi-Web (data-accent absent).
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

/** Clés de persistance (identiques à App.tsx — préservées à l'identique). */
export const THEME_STORAGE_KEY = "pi-web-theme";
export const ACCENT_STORAGE_KEY = "pi-web-accent";

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
 */
export function applyPiWebTheme(mode: ThemeMode, accent: string): void {
  registerPiWebPacks();
  getHolafTokens().setTheme(themePackName(accent, mode));
}

function readSavedMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "dark";
  } catch {
    return "dark";
  }
}

function readSavedAccent(): string {
  try {
    return localStorage.getItem(ACCENT_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * Boot anti-flash : enregistre les packs puis applique le thème mémorisé
 * AVANT le premier rendu (appelé en tête de `main.tsx`, de façon synchrone).
 */
export function initPiWebTheme(): void {
  applyPiWebTheme(readSavedMode(), readSavedAccent());
}
