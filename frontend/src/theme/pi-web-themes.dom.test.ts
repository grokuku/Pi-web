// @vitest-environment jsdom
/**
 * Preuves DOM du nouveau modèle de thème (jsdom) :
 *   • NON-RÉGRESSION Matrix : `applyPiWebTheme("dark", "matrix")` pose
 *     EXACTEMENT les mêmes `--holaf-*` que l'ancien appel `("dark", "green")` ;
 *     idem en clair. Le thème par défaut est donc visuellement l'ancien vert.
 *   • Thèmes bibliothèque : le pack hôte `pi-web-lib-*` est bien appliqué
 *     (accent, surfaces, triples RGB) et ne laisse PAS fuiter radius/shadow.
 *   • Aller-retour Matrix → bibliothèque → Matrix : retour aux valeurs exactes.
 *   • Un ancien accent de localStorage ("purple") applique bien Violet.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyPiWebTheme,
  getHolafTokens,
  registerPiWebPacks,
  __resetPacksRegistrationForTests,
} from "./pi-web-theme";

function inline(prop: string): string {
  return document.documentElement.style.getPropertyValue(prop);
}

/** Snapshot de TOUTES les variables --holaf-* posées sur <html>. */
function snapshotHolaf(): Record<string, string> {
  const style = document.documentElement.style;
  const out: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i);
    if (prop.startsWith("--holaf-")) out[prop] = style.getPropertyValue(prop);
  }
  return out;
}

beforeEach(() => {
  getHolafTokens().reset();
  __resetPacksRegistrationForTests();
  registerPiWebPacks();
});

describe("NON-RÉGRESSION — Matrix == ancien accent vert", () => {
  it("mode sombre : tokens de Matrix identiques à green, propriété par propriété", () => {
    applyPiWebTheme("dark", "matrix");
    const matrix = snapshotHolaf();
    getHolafTokens().reset();
    applyPiWebTheme("dark", "green");
    const green = snapshotHolaf();
    expect(matrix).toEqual(green);
    // Ancrage explicite des valeurs historiques.
    expect(matrix["--holaf-accent"]).toBe("#00ff41");
    expect(matrix["--holaf-accent-hover"]).toBe("#00cc34");
    expect(matrix["--holaf-surface"]).toBe("#0a0a0a");
    expect(matrix["--holaf-surface-elev"]).toBe("#161616");
    expect(matrix["--holaf-border"]).toBe("#2a2a2a");
    expect(matrix["--holaf-text"]).toBe("#c0c0c0");
    expect(matrix["--holaf-accent-rgb"]).toBe("0 255 65");
  });

  it("mode clair : tokens de Matrix identiques à green", () => {
    applyPiWebTheme("light", "matrix");
    const matrix = snapshotHolaf();
    getHolafTokens().reset();
    applyPiWebTheme("light", "green");
    const green = snapshotHolaf();
    expect(matrix).toEqual(green);
    expect(matrix["--holaf-accent"]).toBe("#166534");
    expect(matrix["--holaf-surface"]).toBe("#eeece6");
  });
});

describe("Thèmes de la bibliothèque holaf — application réelle", () => {
  it("applique Indigo sombre (pack hôte pi-web-lib-indigo-dark)", () => {
    applyPiWebTheme("dark", "indigo");
    expect(inline("--holaf-accent")).toBe("#6366f1");
    expect(inline("--holaf-accent-rgb")).toBe("99 102 241");
    expect(inline("--holaf-surface")).toBe("#1e1e1e");
    expect(inline("--holaf-border")).toBe("#3f3f46");
    expect(inline("--holaf-text")).toBe("#e4e4e7");
    expect(inline("--holaf-text-bright")).toBe("#ededef");
    expect(inline("--holaf-bg-rgb")).toBe("30 30 30");
    // Aucune fuite hors vocabulaire Pi-Web.
    expect(inline("--holaf-radius")).toBe("");
    expect(inline("--holaf-shadow")).toBe("");
    expect(inline("--holaf-font-size")).toBe("");
  });

  it("applique un thème bibliothèque clair (Amber)", () => {
    applyPiWebTheme("light", "amber");
    expect(inline("--holaf-accent")).toBe("#b45309");
    expect(inline("--holaf-surface")).toBe("#ffffff");
  });

  it("aller-retour Matrix → Indigo → Matrix : le vert est restauré à l'identique", () => {
    applyPiWebTheme("dark", "matrix");
    const before = snapshotHolaf();
    applyPiWebTheme("dark", "indigo");
    expect(inline("--holaf-accent")).toBe("#6366f1");
    applyPiWebTheme("dark", "matrix");
    expect(snapshotHolaf()).toEqual(before);
    expect(inline("--holaf-accent")).toBe("#00ff41");
  });

  it("un ancien accent mémorisé (« purple ») applique bien Violet", () => {
    applyPiWebTheme("dark", "purple");
    expect(inline("--holaf-accent")).toBe("#c084fc");
    applyPiWebTheme("light", "purple");
    expect(inline("--holaf-accent")).toBe("#8b5cf6");
  });

  it("un thème inconnu retombe sur Matrix (aucune erreur)", () => {
    expect(() => applyPiWebTheme("dark", "turquoise")).not.toThrow();
    expect(inline("--holaf-accent")).toBe("#00ff41");
  });
});
