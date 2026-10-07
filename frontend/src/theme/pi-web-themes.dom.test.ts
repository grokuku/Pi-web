// @vitest-environment jsdom
/**
 * Preuve DOM (jsdom) du « ZÉRO CHANGEMENT VISUEL » de Matrix et de l'usage
 * exclusif des presets de la brique :
 *   • `applyPiWebTheme("dark", "matrix")` pose EXACTEMENT les mêmes `--holaf-*`
 *     que ce que Pi-Web affichait avant (table AVANT ci-dessous) — idem en clair ;
 *   • `matrix` == l'ancien identifiant « green » (compat appels historiques) ;
 *   • aller-retour Matrix → famille couleur → Matrix : retour aux valeurs exactes ;
 *   • un ancien accent stocké (« purple ») applique bien la famille Améthyste ;
 *   • toutes les familles de la brique s'appliquent sans erreur et posent un accent.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { applyPiWebTheme, getHolafTokens, PI_WEB_FAMILY_ORDER } from "./pi-web-theme";

function snapshotHolaf(): Record<string, string> {
  const style = document.documentElement.style;
  const out: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i);
    if (prop.startsWith("--holaf-")) out[prop] = style.getPropertyValue(prop);
  }
  return out;
}

function inline(prop: string): string {
  return document.documentElement.style.getPropertyValue(prop);
}

// ── Table « AVANT » : variables Pi-Web réellement consommées, telles qu'elles
//    étaient posées par l'ancien pack maison `pi-web-green-<mode>`.
const BEFORE_DARK: Record<string, string> = {
  "--holaf-surface": "#0a0a0a",
  "--holaf-surface-elev": "#161616",
  "--holaf-surface-raised": "#1e1e1e",
  "--holaf-border": "#2a2a2a",
  "--holaf-border-bright": "#3a3a3a",
  "--holaf-text": "#c0c0c0",
  "--holaf-text-bright": "#e0e0e0",
  "--holaf-text-muted": "#888888",
  "--holaf-info": "#00aaff",
  "--holaf-warn": "#ffaa00",
  "--holaf-danger": "#ff4444",
  "--holaf-code-inline-bg": "rgba(0, 0, 0, 0.3)",
  "--holaf-code-block-bg": "rgba(0, 0, 0, 0.4)",
  "--holaf-tool-output-bg": "rgba(0, 0, 0, 0.3)",
  "--holaf-accent": "#00ff41",
  "--holaf-accent-hover": "#00cc34",
  "--holaf-bg-rgb": "10 10 10",
  "--holaf-surface-rgb": "22 22 22",
  "--holaf-surface-raised-rgb": "30 30 30",
  "--holaf-border-rgb": "42 42 42",
  "--holaf-border-bright-rgb": "58 58 58",
  "--holaf-text-rgb": "192 192 192",
  "--holaf-text-bright-rgb": "224 224 224",
  "--holaf-text-dim-rgb": "136 136 136",
  "--holaf-info-rgb": "0 170 255",
  "--holaf-warn-rgb": "255 170 0",
  "--holaf-error-rgb": "255 68 68",
  "--holaf-accent-rgb": "0 255 65",
  "--holaf-accent-dim-rgb": "0 204 52",
};

const BEFORE_LIGHT: Record<string, string> = {
  "--holaf-surface": "#eeece6",
  "--holaf-surface-elev": "#f8f7f4",
  "--holaf-surface-raised": "#ffffff",
  "--holaf-border": "#d0d0c8",
  "--holaf-border-bright": "#b8b8b0",
  "--holaf-text": "#3d3d3a",
  "--holaf-text-bright": "#1a1a18",
  "--holaf-text-muted": "#777770",
  "--holaf-info": "#0070cc",
  "--holaf-warn": "#cc8800",
  "--holaf-danger": "#cc2222",
  "--holaf-code-inline-bg": "rgba(0, 0, 0, 0.06)",
  "--holaf-code-block-bg": "rgba(0, 0, 0, 0.08)",
  "--holaf-tool-output-bg": "rgba(0, 0, 0, 0.05)",
  "--holaf-accent": "#166534",
  "--holaf-accent-hover": "#15803d",
  "--holaf-bg-rgb": "238 236 230",
  "--holaf-surface-rgb": "248 247 244",
  "--holaf-surface-raised-rgb": "255 255 255",
  "--holaf-border-rgb": "208 208 200",
  "--holaf-border-bright-rgb": "184 184 176",
  "--holaf-text-rgb": "61 61 58",
  "--holaf-text-bright-rgb": "26 26 24",
  "--holaf-text-dim-rgb": "119 119 112",
  "--holaf-info-rgb": "0 112 204",
  "--holaf-warn-rgb": "204 136 0",
  "--holaf-error-rgb": "204 34 34",
  "--holaf-accent-rgb": "22 101 52",
  "--holaf-accent-dim-rgb": "21 128 61",
};

beforeEach(() => {
  getHolafTokens().reset();
});

describe("NON-RÉGRESSION — Matrix (matrix-dark / matrix-light)", () => {
  it("mode sombre : chaque variable Pi-Web consommée == valeur d'avant", () => {
    applyPiWebTheme("dark", "matrix");
    for (const [prop, value] of Object.entries(BEFORE_DARK)) {
      expect(inline(prop), prop).toBe(value);
    }
  });

  it("mode clair : chaque variable Pi-Web consommée == valeur d'avant", () => {
    applyPiWebTheme("light", "matrix");
    for (const [prop, value] of Object.entries(BEFORE_LIGHT)) {
      expect(inline(prop), prop).toBe(value);
    }
  });

  it("la famille « matrix » == l'ancien identifiant « green » (compat historique)", () => {
    applyPiWebTheme("dark", "matrix");
    const viaMatrix = snapshotHolaf();
    getHolafTokens().reset();
    applyPiWebTheme("dark", "green");
    const viaGreen = snapshotHolaf();
    // Comparaison sur les variables consommées par Pi-Web uniquement.
    for (const prop of Object.keys(BEFORE_DARK)) {
      expect(viaGreen[prop], prop).toBe(viaMatrix[prop]);
    }
  });

  it("matrix-light == l'ancien identifiant « green » (compat clair)", () => {
    applyPiWebTheme("light", "matrix");
    const viaMatrix = snapshotHolaf();
    getHolafTokens().reset();
    applyPiWebTheme("light", "green");
    const viaGreen = snapshotHolaf();
    for (const prop of Object.keys(BEFORE_LIGHT)) {
      expect(viaGreen[prop], prop).toBe(viaMatrix[prop]);
    }
  });
});

describe("Bascule entre familles de la brique", () => {
  it("aller-retour Matrix → Turquoise → Matrix : le vert est restauré à l'identique", () => {
    applyPiWebTheme("dark", "matrix");
    const before = snapshotHolaf();
    applyPiWebTheme("dark", "turquoise");
    expect(inline("--holaf-accent")).toBe("#0ec7de");
    applyPiWebTheme("dark", "matrix");
    expect(snapshotHolaf()).toEqual(before);
    expect(inline("--holaf-accent")).toBe("#00ff41");
  });

  it("un ancien accent mémorisé (« purple ») applique bien la famille Améthyste", () => {
    applyPiWebTheme("dark", "purple");
    expect(inline("--holaf-accent")).toBe("#a1a3ff");
    applyPiWebTheme("light", "purple");
    expect(inline("--holaf-accent")).toBe("#4d41b0");
  });

  it("toutes les familles de la brique s'appliquent sans erreur (sombre + clair)", () => {
    for (const family of PI_WEB_FAMILY_ORDER) {
      for (const mode of ["dark", "light"] as const) {
        expect(() => applyPiWebTheme(mode, family), `${family}-${mode}`).not.toThrow();
        expect(inline("--holaf-accent"), `${family}-${mode}`).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(inline("--holaf-surface"), `${family}-${mode}`).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(inline("--holaf-accent-rgb"), `${family}-${mode}`).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
      }
    }
  });
});
