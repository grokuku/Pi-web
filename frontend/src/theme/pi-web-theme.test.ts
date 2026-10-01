/**
 * Tests de l'unification du thème Pi-Web sur la brique `tokens` (holaf-lib).
 *
 * Objectif n°1 : AUCUN changement visuel. Ce fichier PROUVE l'équivalence en
 * comparant, pour CHAQUE variable :
 *   • la valeur de repli écrite dans hacker-theme.css (= la valeur d'AVANT), et
 *   • la valeur résolue des packs `pi-web-*` (= la valeur d'APRÈS via la brique).
 * Si les deux sont égales pour tous les modes/accents, alors appliquer la brique
 * donne exactement les couleurs d'avant.
 *
 * On vérifie aussi : le mapping d'aliasing complet (aucune variable orpheline),
 * le calcul des triples RGB (support d'opacité Tailwind) et l'alignement du
 * tailwind.config.js sur le motif `rgb(var(--*-rgb) / <alpha-value>)`.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  PI_WEB_ACCENTS,
  BASE_PACK_DARK,
  BASE_PACK_LIGHT,
  themePackName,
  hexToRgbTriple,
  getHolafTokens,
  registerPiWebPacks,
  __resetPacksRegistrationForTests,
} from "./pi-web-theme";

// Contenu réel du CSS et de la config Tailwind, lus depuis le disque.
const css = readFileSync(new URL("../styles/hacker-theme.css", import.meta.url), "utf8");
const tailwind = readFileSync(new URL("../../tailwind.config.js", import.meta.url), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// Table « AVANT » : valeurs littérales extraites de hacker-theme.css d'origine.
// (Écrites ici indépendamment du module pour que la comparaison ait du sens.)
// ─────────────────────────────────────────────────────────────────────────────

const BASE_DARK: Record<string, string> = {
  surface: "#0a0a0a",
  "surface-elev": "#161616",
  "surface-raised": "#1e1e1e",
  border: "#2a2a2a",
  "border-bright": "#3a3a3a",
  text: "#c0c0c0",
  "text-bright": "#e0e0e0",
  "text-muted": "#888888",
  info: "#00aaff",
  warn: "#ffaa00",
  danger: "#ff4444",
  "code-inline-bg": "rgba(0, 0, 0, 0.3)",
  "code-block-bg": "rgba(0, 0, 0, 0.4)",
  "tool-output-bg": "rgba(0, 0, 0, 0.3)",
  "bg-rgb": "10 10 10",
  "surface-rgb": "22 22 22",
  "surface-raised-rgb": "30 30 30",
  "border-rgb": "42 42 42",
  "border-bright-rgb": "58 58 58",
  "text-rgb": "192 192 192",
  "text-bright-rgb": "224 224 224",
  "text-dim-rgb": "136 136 136",
  "info-rgb": "0 170 255",
  "warn-rgb": "255 170 0",
  "error-rgb": "255 68 68",
};

const BASE_LIGHT: Record<string, string> = {
  surface: "#eeece6",
  "surface-elev": "#f8f7f4",
  "surface-raised": "#ffffff",
  border: "#d0d0c8",
  "border-bright": "#b8b8b0",
  text: "#3d3d3a",
  "text-bright": "#1a1a18",
  "text-muted": "#777770",
  info: "#0070cc",
  warn: "#cc8800",
  danger: "#cc2222",
  "code-inline-bg": "rgba(0, 0, 0, 0.06)",
  "code-block-bg": "rgba(0, 0, 0, 0.08)",
  "tool-output-bg": "rgba(0, 0, 0, 0.05)",
  "bg-rgb": "238 236 230",
  "surface-rgb": "248 247 244",
  "surface-raised-rgb": "255 255 255",
  "border-rgb": "208 208 200",
  "border-bright-rgb": "184 184 176",
  "text-rgb": "61 61 58",
  "text-bright-rgb": "26 26 24",
  "text-dim-rgb": "119 119 112",
  "info-rgb": "0 112 204",
  "warn-rgb": "204 136 0",
  "error-rgb": "204 34 34",
};

/** accent + accent-hover (dim) + leurs triples RGB, par accent × mode. */
const ACCENT_EXPECTED: Record<string, Record<string, Record<string, string>>> = {
  green: {
    dark: { accent: "#00ff41", "accent-hover": "#00cc34", "accent-rgb": "0 255 65", "accent-dim-rgb": "0 204 52" },
    light: { accent: "#166534", "accent-hover": "#15803d", "accent-rgb": "22 101 52", "accent-dim-rgb": "21 128 61" },
  },
  purple: {
    dark: { accent: "#c084fc", "accent-hover": "#a855f7", "accent-rgb": "192 132 252", "accent-dim-rgb": "168 85 247" },
    light: { accent: "#8b5cf6", "accent-hover": "#7c3aed", "accent-rgb": "139 92 246", "accent-dim-rgb": "124 58 237" },
  },
  orange: {
    dark: { accent: "#fb923c", "accent-hover": "#f97316", "accent-rgb": "251 146 60", "accent-dim-rgb": "249 115 22" },
    light: { accent: "#ea580c", "accent-hover": "#c2410c", "accent-rgb": "234 88 12", "accent-dim-rgb": "194 65 12" },
  },
  cyan: {
    dark: { accent: "#22d3ee", "accent-hover": "#06b6d4", "accent-rgb": "34 211 238", "accent-dim-rgb": "6 182 212" },
    light: { accent: "#0891b2", "accent-hover": "#0e7490", "accent-rgb": "8 145 178", "accent-dim-rgb": "14 116 144" },
  },
  rose: {
    dark: { accent: "#f472b6", "accent-hover": "#ec4899", "accent-rgb": "244 114 182", "accent-dim-rgb": "236 72 153" },
    light: { accent: "#db2777", "accent-hover": "#be185d", "accent-rgb": "219 39 119", "accent-dim-rgb": "190 24 93" },
  },
};

beforeEach(() => {
  const HT = getHolafTokens();
  HT.reset();
  __resetPacksRegistrationForTests();
  registerPiWebPacks();
});

describe("hexToRgbTriple", () => {
  it("convertit #rrggbb et #rgb en triple décimal espacé", () => {
    expect(hexToRgbTriple("#0a0a0a")).toBe("10 10 10");
    expect(hexToRgbTriple("#ffaa00")).toBe("255 170 0");
    expect(hexToRgbTriple("#fff")).toBe("255 255 255");
    expect(hexToRgbTriple("00ff41")).toBe("0 255 65");
  });

  it("rejette un hex invalide avec une erreur claire", () => {
    expect(() => hexToRgbTriple("#xyz")).toThrow(/hex invalide/);
    expect(() => hexToRgbTriple("rgba(0,0,0,.3)")).toThrow(/hex invalide/);
  });

  it("reproduit EXACTEMENT les triples historiques de hacker-theme.css", () => {
    for (const hexToTriple of [
      { hex: "#0a0a0a", t: "10 10 10" },
      { hex: "#161616", t: "22 22 22" },
      { hex: "#1e1e1e", t: "30 30 30" },
      { hex: "#2a2a2a", t: "42 42 42" },
      { hex: "#3a3a3a", t: "58 58 58" },
      { hex: "#c0c0c0", t: "192 192 192" },
      { hex: "#e0e0e0", t: "224 224 224" },
      { hex: "#888888", t: "136 136 136" },
      { hex: "#00aaff", t: "0 170 255" },
      { hex: "#ffaa00", t: "255 170 0" },
      { hex: "#ff4444", t: "255 68 68" },
    ]) {
      expect(hexToRgbTriple(hexToTriple.hex)).toBe(hexToTriple.t);
    }
  });
});

describe("Packs Pi-Web — enregistrement & valeurs exactes (aucune régression)", () => {
  it("expose les 2 packs de base + 10 packs accent×mode", () => {
    const names = getHolafTokens().listPresets();
    expect(names).toContain(BASE_PACK_DARK);
    expect(names).toContain(BASE_PACK_LIGHT);
    for (const accent of PI_WEB_ACCENTS) {
      expect(names).toContain(themePackName(accent, "dark"));
      expect(names).toContain(themePackName(accent, "light"));
    }
  });

  it("les packs de base portent EXACTEMENT les valeurs d'avant", () => {
    for (const [pack, expected] of [
      [BASE_PACK_DARK, BASE_DARK],
      [BASE_PACK_LIGHT, BASE_LIGHT],
    ] as const) {
      const preset = getHolafTokens().getPreset(pack);
      expect(preset).not.toBeNull();
      for (const [key, value] of Object.entries(expected)) {
        expect(preset![key], `${pack}.${key}`).toBe(value);
      }
    }
  });

  for (const accent of PI_WEB_ACCENTS) {
    for (const mode of ["dark", "light"] as const) {
      it(`pack ${themePackName(accent, mode)} : accent + base conformes`, () => {
        const pack = themePackName(accent, mode);
        const preset = getHolafTokens().getPreset(pack);
        expect(preset).not.toBeNull();
        // Accent + accent-dim (mappé sur accent-hover) + triples RGB.
        for (const [key, value] of Object.entries(ACCENT_EXPECTED[accent][mode])) {
          expect(preset![key], `${pack}.${key}`).toBe(value);
        }
        // Le pack hérite du pack de base du mode (extends).
        const base = mode === "dark" ? BASE_DARK : BASE_LIGHT;
        for (const [key, value] of Object.entries(base)) {
          expect(preset![key], `${pack}.${key}`).toBe(value);
        }
      });
    }
  }
});

describe("Mapping d'aliasing complet — avant (repli CSS) == après (pack)", () => {
  const BASE_ALIASES: Array<[string, string]> = [
    ["--bg", "surface"],
    ["--surface", "surface-elev"],
    ["--surface-raised", "surface-raised"],
    ["--border", "border"],
    ["--border-bright", "border-bright"],
    ["--text", "text"],
    ["--text-bright", "text-bright"],
    ["--text-dim", "text-muted"],
    ["--info", "info"],
    ["--warn", "warn"],
    ["--error", "danger"],
    ["--code-inline-bg", "code-inline-bg"],
    ["--code-block-bg", "code-block-bg"],
    ["--tool-output-bg", "tool-output-bg"],
    ["--bg-rgb", "bg-rgb"],
    ["--surface-rgb", "surface-rgb"],
    ["--surface-raised-rgb", "surface-raised-rgb"],
    ["--border-rgb", "border-rgb"],
    ["--border-bright-rgb", "border-bright-rgb"],
    ["--text-rgb", "text-rgb"],
    ["--text-bright-rgb", "text-bright-rgb"],
    ["--text-dim-rgb", "text-dim-rgb"],
    ["--info-rgb", "info-rgb"],
    ["--warn-rgb", "warn-rgb"],
    ["--error-rgb", "error-rgb"],
  ];

  it("chaque variable de base est aliasée vers un token holaf", () => {
    for (const [piVar, holafKey] of BASE_ALIASES) {
      expect(css, `${piVar}`).toContain(`${piVar}: var(--holaf-${holafKey},`);
    }
  });

  it("chaque variable d'accent est aliasée vers un token holaf", () => {
    for (const [piVar, holafKey] of [
      ["--accent", "accent"],
      ["--accent-rgb", "accent-rgb"],
      ["--accent-dim", "accent-hover"],
      ["--accent-dim-rgb", "accent-dim-rgb"],
    ] as Array<[string, string]>) {
      expect(css, `${piVar}`).toContain(`${piVar}: var(--holaf-${holafKey},`);
    }
  });

  it("les valeurs de repli du CSS == valeurs des packs (base, dark & light)", () => {
    for (const [pack, expected] of [
      [BASE_PACK_DARK, BASE_DARK],
      [BASE_PACK_LIGHT, BASE_LIGHT],
    ] as const) {
      const preset = getHolafTokens().getPreset(pack)!;
      for (const holafKey of Object.keys(expected)) {
        const fallback = expected[holafKey];
        expect(preset[holafKey]).toBe(fallback);
        expect(css).toContain(`var(--holaf-${holafKey}, ${fallback})`);
      }
    }
  });

  it("les valeurs de repli du CSS == valeurs des packs (accent, 5×2)", () => {
    for (const accent of PI_WEB_ACCENTS) {
      for (const mode of ["dark", "light"] as const) {
        const preset = getHolafTokens().getPreset(themePackName(accent, mode))!;
        const expected = ACCENT_EXPECTED[accent][mode];
        const piVars: Record<string, string> = {
          accent: "--accent",
          "accent-rgb": "--accent-rgb",
          "accent-hover": "--accent-dim",
          "accent-dim-rgb": "--accent-dim-rgb",
        };
        for (const holafKey of Object.keys(expected)) {
          const fallback = expected[holafKey];
          expect(preset[holafKey]).toBe(fallback);
          expect(css).toContain(`${piVars[holafKey]}: var(--holaf-${holafKey}, ${fallback});`);
        }
      }
    }
  });

  it("aucune variable de thème ne reste en valeur littérale non aliasée", () => {
    // Les seules valeurs littérales tolérées sont les replis DANS var(...).
    // On vérifie qu'il n'existe pas de `--bg: #…` (ou autre) hors alias.
    const bareDecl = /--(bg|surface|surface-raised|border|border-bright|text|text-bright|text-dim|info|warn|error|accent|accent-dim)(-rgb)?:\s*#/;
    expect(bareDecl.test(css)).toBe(false);
  });
});

describe("Support d'opacité Tailwind (piège RGB)", () => {
  it("tailwind.config.js mappe hacker-* sur rgb(var(--*-rgb) / <alpha-value>)", () => {
    const expected: Array<[string, string]> = [
      ["bg", "bg-rgb"],
      ["surface", "surface-rgb"],
      ["surface-raised", "surface-raised-rgb"],
      ["border", "border-rgb"],
      ["border-bright", "border-bright-rgb"],
      ["accent", "accent-rgb"],
      ["accent-dim", "accent-dim-rgb"],
      ["text", "text-rgb"],
      ["text-bright", "text-bright-rgb"],
      ["text-dim", "text-dim-rgb"],
      ["warn", "warn-rgb"],
      ["error", "error-rgb"],
      ["info", "info-rgb"],
    ];
    for (const [tailwindKey, rgbVar] of expected) {
      expect(tailwind, `hacker.${tailwindKey}`).toContain(
        `rgb(var(--${rgbVar}) / <alpha-value>)`
      );
    }
  });

  it("chaque -rgb consommé par Tailwind est posé par un pack (triple valide)", () => {
    const rgbVars = [
      "bg-rgb",
      "surface-rgb",
      "surface-raised-rgb",
      "border-rgb",
      "border-bright-rgb",
      "accent-rgb",
      "accent-dim-rgb",
      "text-rgb",
      "text-bright-rgb",
      "text-dim-rgb",
      "warn-rgb",
      "error-rgb",
      "info-rgb",
    ];
    const preset = getHolafTokens().getPreset(themePackName("rose", "light"))!;
    for (const key of rgbVars) {
      expect(preset[key], key).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });
});
