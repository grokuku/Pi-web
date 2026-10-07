/**
 * Tests du thème Pi-Web branché sur la brique `tokens` (holaf-lib >= 0.5.0).
 *
 * Pi-Web n'enregistre AUCUN thème maison : le sélecteur n'expose QUE les FAMILLES
 * de la brique (identité `matrix` + 6 familles couleur) et applique le preset
 * `<famille>-<mode>` (`matrix-dark` par défaut). Ce fichier PROUVE, au niveau
 * VALEUR :
 *   • le catalogue affiché = les familles de la brique (matrix en tête) ;
 *   • la migration des anciens thèmes/accents vers une famille valide ;
 *   • l'aliasing complet des variables Pi-Web vers les tokens `--holaf-*` (avec
 *     les replis d'avant) et l'absence de tout preset d'accent maison ;
 *   • le support d'opacité Tailwind (triples RGB) ;
 *   • que le preset `matrix-*` de la brique + la couche hôte redonnent les valeurs
 *     EXACTES d'avant (le « ZÉRO CHANGEMENT VISUEL » de Matrix).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PI_WEB_THEMES,
  PI_WEB_FAMILY_ORDER,
  DEFAULT_THEME_ID,
  normalizeThemeId,
  themeFromLegacyAccent,
  LEGACY_ACCENT_TO_THEME,
  LEGACY_THEME_TO_FAMILY,
  getThemeDefinition,
  themePackNameFor,
  themeSwatchColor,
  hexToRgbTriple,
  buildPiWebOverlay,
  getHolafTokens,
} from "./pi-web-theme";

// Contenu réel du CSS et de la config Tailwind, lus depuis le disque.
const css = readFileSync(new URL("../styles/hacker-theme.css", import.meta.url), "utf8");
const tailwind = readFileSync(new URL("../../tailwind.config.js", import.meta.url), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// Table « AVANT » : valeurs littérales d'origine du thème Matrix (= repli CSS).
// (Écrites ici indépendamment du module pour que la comparaison ait du sens.)
// ─────────────────────────────────────────────────────────────────────────────

/** Valeurs Pi-Web d'AVANT pour les clés sémantiques du preset matrix-*. */
const BEFORE_MATRIX_DARK = {
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
  accent: "#00ff41",
  "accent-hover": "#00cc34",
};

const BEFORE_MATRIX_LIGHT = {
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
  accent: "#166534",
  "accent-hover": "#15803d",
};

// ─────────────────────────────────────────────────────────────────────────────
// hexToRgbTriple
// ─────────────────────────────────────────────────────────────────────────────
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
    for (const { hex, t } of [
      { hex: "#0a0a0a", t: "10 10 10" },
      { hex: "#161616", t: "22 22 22" },
      { hex: "#1e1e1e", t: "30 30 30" },
      { hex: "#2a2a2a", t: "42 42 42" },
      { hex: "#c0c0c0", t: "192 192 192" },
      { hex: "#00ff41", t: "0 255 65" },
    ]) {
      expect(hexToRgbTriple(hex)).toBe(t);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue = les familles de la brique
// ─────────────────────────────────────────────────────────────────────────────
describe("catalogue des thèmes (familles de la brique)", () => {
  it("Matrix en tête, puis les 6 familles couleur ; 7 familles exactement", () => {
    expect(PI_WEB_THEMES.map((def) => def.id)).toEqual([
      "matrix",
      "corail",
      "ambre",
      "emeraude",
      "turquoise",
      "amethyste",
      "neutre",
    ]);
    expect(PI_WEB_FAMILY_ORDER).toEqual(PI_WEB_THEMES.map((def) => def.id));
  });

  it("n'a qu'un seul thème par défaut : Matrix", () => {
    const defaults = PI_WEB_THEMES.filter((def) => def.isDefault);
    expect(defaults.map((def) => def.id)).toEqual(["matrix"]);
    expect(DEFAULT_THEME_ID).toBe("matrix");
  });

  it("chaque thème porte une clé i18n unique et est résolu par getThemeDefinition", () => {
    const labelKeys = new Set<string>();
    for (const def of PI_WEB_THEMES) {
      expect(def.labelKey).toBe(`themes.names.${def.id}`);
      expect(labelKeys.has(def.labelKey), def.labelKey).toBe(false);
      labelKeys.add(def.labelKey);
      expect(getThemeDefinition(def.id)).toBe(def);
    }
    expect(getThemeDefinition("inconnu")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation & migration (fonctions pures)
// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeThemeId / themeFromLegacyAccent", () => {
  it("laisse passer les familles de la brique (casse/espaces normalisés)", () => {
    for (const family of PI_WEB_FAMILY_ORDER) {
      expect(normalizeThemeId(family)).toBe(family);
    }
    expect(normalizeThemeId("  MATRIX ")).toBe("matrix");
    expect(normalizeThemeId("Turquoise")).toBe("turquoise");
  });

  it("redirige les anciens thèmes supprimés vers la famille la plus proche", () => {
    expect(normalizeThemeId("violet")).toBe("amethyste");
    expect(normalizeThemeId("indigo")).toBe("amethyste");
    expect(normalizeThemeId("midnight")).toBe("amethyste");
    expect(normalizeThemeId("orange")).toBe("ambre");
    expect(normalizeThemeId("amber")).toBe("ambre");
    expect(normalizeThemeId("cyan")).toBe("turquoise");
    expect(normalizeThemeId("rose")).toBe("corail");
    expect(normalizeThemeId("emerald")).toBe("emeraude");
    expect(normalizeThemeId("slate")).toBe("neutre");
  });

  it("convertit les 5 anciens accents vers leur famille (vert → matrix)", () => {
    expect(themeFromLegacyAccent("green")).toBe("matrix");
    expect(themeFromLegacyAccent("purple")).toBe("amethyste");
    expect(themeFromLegacyAccent("orange")).toBe("ambre");
    expect(themeFromLegacyAccent("cyan")).toBe("turquoise");
    expect(themeFromLegacyAccent("rose")).toBe("corail");
    expect(LEGACY_ACCENT_TO_THEME).toEqual({
      green: "matrix",
      purple: "amethyste",
      orange: "ambre",
      cyan: "turquoise",
      rose: "corail",
    });
  });

  it("retombe sur Matrix pour toute valeur inconnue / absente / vide", () => {
    for (const value of ["", "  ", "turquoise-x", "nope", null, undefined, 42, {}]) {
      expect(normalizeThemeId(value), String(value)).toBe("matrix");
      expect(themeFromLegacyAccent(value), String(value)).toBe("matrix");
    }
    // La table des anciens thèmes ne contient que des familles valides.
    for (const family of Object.values(LEGACY_THEME_TO_FAMILY)) {
      expect(PI_WEB_FAMILY_ORDER).toContain(family);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nom de preset & pastille
// ─────────────────────────────────────────────────────────────────────────────
describe("themePackNameFor / themeSwatchColor", () => {
  it("compose <famille>-<mode> et accepte les anciennes valeurs", () => {
    expect(themePackNameFor("matrix", "dark")).toBe("matrix-dark");
    expect(themePackNameFor("turquoise", "light")).toBe("turquoise-light");
    expect(themePackNameFor("green", "dark")).toBe("matrix-dark");
    expect(themePackNameFor("violet", "light")).toBe("amethyste-light");
    expect(themePackNameFor("nope", "dark")).toBe("matrix-dark");
  });

  it("rend l'accent réel du preset de la brique (ou le vert si inconnu)", () => {
    expect(themeSwatchColor("matrix", "dark")).toBe("#00ff41");
    expect(themeSwatchColor("matrix", "light")).toBe("#166534");
    expect(themeSwatchColor("corail", "dark")).toBe("#fa7fb5");
    expect(themeSwatchColor("neutre", "light")).toBe("#515457");
    expect(themeSwatchColor("green", "dark")).toBe("#00ff41"); // ancien accent
    expect(themeSwatchColor("nope", "dark")).toBe("#00ff41"); // repli
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Preset `matrix-*` de la brique + couche hôte == valeurs d'avant
// ─────────────────────────────────────────────────────────────────────────────
describe("preset matrix-* de la brique", () => {
  it("existe pour les 2 modes et porte les 7 clés hôte Pi-Web", () => {
    for (const mode of ["dark", "light"] as const) {
      const preset = getHolafTokens().getPreset(`matrix-${mode}`);
      expect(preset, `matrix-${mode}`).not.toBeNull();
      for (const key of ["border-bright", "text-bright", "info", "warn", "code-inline-bg", "code-block-bg", "tool-output-bg"]) {
        expect(typeof preset![key], `matrix-${mode}.${key}`).toBe("string");
      }
    }
  });

  it("porte EXACTEMENT les valeurs principales d'avant (sombre)", () => {
    const preset = getHolafTokens().getPreset("matrix-dark")!;
    for (const [key, value] of Object.entries(BEFORE_MATRIX_DARK)) {
      expect(preset[key], `matrix-dark.${key}`).toBe(value);
    }
  });

  it("porte EXACTEMENT les valeurs principales d'avant (clair)", () => {
    const preset = getHolafTokens().getPreset("matrix-light")!;
    for (const [key, value] of Object.entries(BEFORE_MATRIX_LIGHT)) {
      expect(preset[key], `matrix-light.${key}`).toBe(value);
    }
  });

  it("preset + couche hôte == valeurs d'avant, pour les 2 modes", () => {
    for (const [mode, before] of [
      ["dark", BEFORE_MATRIX_DARK],
      ["light", BEFORE_MATRIX_LIGHT],
    ] as const) {
      const preset = getHolafTokens().getPreset(`matrix-${mode}`)!;
      const values = { ...preset, ...buildPiWebOverlay(preset, mode) };
      for (const [key, value] of Object.entries(before)) {
        expect(values[key], `matrix-${mode}.${key}`).toBe(value);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Couche hôte — triples RGB & replis par mode
// ─────────────────────────────────────────────────────────────────────────────
describe("buildPiWebOverlay", () => {
  it("calcule les 13 triples RGB depuis les hex du preset", () => {
    const preset = getHolafTokens().getPreset("matrix-dark")!;
    const overlay = buildPiWebOverlay(preset, "dark");
    expect(overlay["bg-rgb"]).toBe("10 10 10");
    expect(overlay["surface-rgb"]).toBe("22 22 22");
    expect(overlay["text-rgb"]).toBe("192 192 192");
    expect(overlay["accent-rgb"]).toBe("0 255 65");
    expect(overlay["accent-dim-rgb"]).toBe("0 204 52");
    expect(overlay["error-rgb"]).toBe("255 68 68");
    for (const key of [
      "bg-rgb", "surface-rgb", "surface-raised-rgb", "border-rgb", "border-bright-rgb",
      "text-rgb", "text-bright-rgb", "text-dim-rgb", "info-rgb", "warn-rgb", "error-rgb",
      "accent-rgb", "accent-dim-rgb",
    ]) {
      expect(overlay[key], key).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it("complète les clés sémantiques absentes avec le repli du mode (vert)", () => {
    const overlay = buildPiWebOverlay(
      { surface: "#101010", border: "#202020", text: "#d0d0d0", accent: "#00ff41" },
      "dark",
    );
    expect(overlay["border-bright"]).toBe("#3a3a3a");
    expect(overlay["text-bright"]).toBe("#e0e0e0");
    expect(overlay.info).toBe("#00aaff");
    expect(overlay.warn).toBe("#ffaa00");
    expect(overlay["code-inline-bg"]).toBe("rgba(0, 0, 0, 0.3)");
  });

  it("omet un triple dont la couleur source n'est pas un hex exploitable", () => {
    const overlay = buildPiWebOverlay({ accent: "var(--brand)", surface: "#101010" }, "dark");
    expect(overlay["accent-rgb"]).toBeUndefined();
    expect(overlay["bg-rgb"]).toBe("16 16 16");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Aliasing CSS — aucune variable orpheline, plus aucun preset d'accent maison
// ─────────────────────────────────────────────────────────────────────────────
describe("aliasing des variables Pi-Web vers les tokens holaf", () => {
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
    ["--accent", "accent"],
    ["--accent-rgb", "accent-rgb"],
    ["--accent-dim", "accent-hover"],
    ["--accent-dim-rgb", "accent-dim-rgb"],
  ];

  it("chaque variable Pi-Web est aliasée vers un token holaf (avec repli)", () => {
    for (const [piVar, holafKey] of BASE_ALIASES) {
      expect(css, `${piVar}`).toContain(`${piVar}: var(--holaf-${holafKey},`);
    }
  });

  it("les replis CSS == valeurs Matrix d'avant (sombre & clair)", () => {
    for (const [key, value] of Object.entries(BEFORE_MATRIX_DARK)) {
      expect(css, key).toContain(`var(--holaf-${key}, ${value})`);
    }
    for (const key of ["surface", "surface-elev", "surface-raised", "border", "border-bright", "text", "text-bright", "text-muted", "info", "warn", "danger", "accent", "accent-hover"]) {
      const value = (BEFORE_MATRIX_LIGHT as Record<string, string>)[key];
      expect(css, key).toContain(`var(--holaf-${key}, ${value})`);
    }
  });

  it("plus AUCUN preset d'accent maison (data-accent) ni valeur littérale non aliasée", () => {
    expect(css).not.toContain("data-accent");
    const bareDecl = /--(bg|surface|surface-raised|border|border-bright|text|text-bright|text-dim|info|warn|error|accent|accent-dim)(-rgb)?:\s*#/;
    expect(bareDecl.test(css)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Liaison avec la brique holaf-lib
// ─────────────────────────────────────────────────────────────────────────────
describe("liaison avec la brique holaf-lib", () => {
  it("les 14 presets <famille>-<mode> (7 familles × 2 modes) existent dans la brique", () => {
    for (const family of PI_WEB_FAMILY_ORDER) {
      for (const mode of ["dark", "light"] as const) {
        expect(getHolafTokens().getPreset(`${family}-${mode}`), `${family}-${mode}`).not.toBeNull();
      }
    }
  });

  it("les familles offertes par Pi-Web sont exactement celles publiées par la brique", () => {
    expect(getHolafTokens().listFamilies()).toEqual([...PI_WEB_FAMILY_ORDER]);
  });

  it("aucun preset maison pi-web-* n'est enregistré dans la brique", () => {
    const names = getHolafTokens().listPresets();
    expect(names.some((n) => n.startsWith("pi-web"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Support d'opacité Tailwind (piège RGB)
// ─────────────────────────────────────────────────────────────────────────────
describe("support d'opacité Tailwind (piège RGB)", () => {
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
});
