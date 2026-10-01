// @vitest-environment jsdom
/**
 * Vérifie la POSE RÉELLE des tokens sur :root par la brique (jsdom) :
 *   • le thème appliqué écrit bien les `--holaf-*` attendus sur <html> ;
 *   • le changement accent/mode met à jour ces variables ;
 *   • la purge par possession d'ensemble retire les résidus de la brique ;
 *   • les triples RGB (support d'opacité Tailwind) sont présents et corrects.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyPiWebTheme,
  registerPiWebPacks,
  getHolafTokens,
  __resetPacksRegistrationForTests,
} from "./pi-web-theme";

function inline(prop: string): string {
  return document.documentElement.style.getPropertyValue(prop);
}

beforeEach(() => {
  getHolafTokens().reset();
  __resetPacksRegistrationForTests();
  registerPiWebPacks();
});

describe("Pose des tokens par la brique sur :root (jsdom)", () => {
  it("applyPiWebTheme(dark, green) pose les valeurs exactes d'avant", () => {
    applyPiWebTheme("dark", "green");
    expect(inline("--holaf-surface")).toBe("#0a0a0a");
    expect(inline("--holaf-surface-elev")).toBe("#161616");
    expect(inline("--holaf-surface-raised")).toBe("#1e1e1e");
    expect(inline("--holaf-border")).toBe("#2a2a2a");
    expect(inline("--holaf-border-bright")).toBe("#3a3a3a");
    expect(inline("--holaf-text")).toBe("#c0c0c0");
    expect(inline("--holaf-text-bright")).toBe("#e0e0e0");
    expect(inline("--holaf-text-muted")).toBe("#888888");
    expect(inline("--holaf-info")).toBe("#00aaff");
    expect(inline("--holaf-warn")).toBe("#ffaa00");
    expect(inline("--holaf-danger")).toBe("#ff4444");
    expect(inline("--holaf-accent")).toBe("#00ff41");
    expect(inline("--holaf-accent-hover")).toBe("#00cc34");
  });

  it("les triples RGB sont posés (support d'opacité) et corrects", () => {
    applyPiWebTheme("dark", "purple");
    expect(inline("--holaf-bg-rgb")).toBe("10 10 10");
    expect(inline("--holaf-surface-rgb")).toBe("22 22 22");
    expect(inline("--holaf-surface-raised-rgb")).toBe("30 30 30");
    expect(inline("--holaf-border-rgb")).toBe("42 42 42");
    expect(inline("--holaf-border-bright-rgb")).toBe("58 58 58");
    expect(inline("--holaf-text-rgb")).toBe("192 192 192");
    expect(inline("--holaf-text-bright-rgb")).toBe("224 224 224");
    expect(inline("--holaf-text-dim-rgb")).toBe("136 136 136");
    expect(inline("--holaf-info-rgb")).toBe("0 170 255");
    expect(inline("--holaf-warn-rgb")).toBe("255 170 0");
    expect(inline("--holaf-error-rgb")).toBe("255 68 68");
    expect(inline("--holaf-accent-rgb")).toBe("192 132 252");
    expect(inline("--holaf-accent-dim-rgb")).toBe("168 85 247");
  });

  it("le changement mode/accent met à jour les tokens", () => {
    applyPiWebTheme("dark", "green");
    expect(inline("--holaf-surface")).toBe("#0a0a0a");
    expect(inline("--holaf-accent")).toBe("#00ff41");

    applyPiWebTheme("light", "green");
    expect(inline("--holaf-surface")).toBe("#eeece6");
    expect(inline("--holaf-accent")).toBe("#166534");
    expect(inline("--holaf-accent-hover")).toBe("#15803d");

    applyPiWebTheme("light", "cyan");
    expect(inline("--holaf-accent")).toBe("#0891b2");
    expect(inline("--holaf-accent-hover")).toBe("#0e7490");
    // La base claire est inchangée par le changement d'accent.
    expect(inline("--holaf-surface")).toBe("#eeece6");
  });

  it("purge les résidus possédés par la brique (radius/shadow/…)", () => {
    // La brique pose un preset initial (prefers-color-scheme) au chargement,
    // qui définit radius/shadow/font-size/accent-text/danger-hover. Nos packs
    // ne les définissent PAS : ils doivent disparaître après application.
    applyPiWebTheme("dark", "green");
    expect(inline("--holaf-radius")).toBe("");
    expect(inline("--holaf-shadow")).toBe("");
    expect(inline("--holaf-font-size")).toBe("");
    expect(inline("--holaf-accent-text")).toBe("");
    expect(inline("--holaf-danger-hover")).toBe("");
  });

  it("un accent inconnu retombe sur le vert (pas d'erreur)", () => {
    expect(() => applyPiWebTheme("dark", "nope")).not.toThrow();
    expect(inline("--holaf-accent")).toBe("#00ff41");
  });

  it("le style inline de <html> porte bien les variables (double preuve)", () => {
    applyPiWebTheme("dark", "rose");
    const style = document.documentElement.getAttribute("style") ?? "";
    expect(style).toContain("--holaf-accent: #f472b6");
    expect(style).toContain("--holaf-accent-rgb: 244 114 182");
  });
});
