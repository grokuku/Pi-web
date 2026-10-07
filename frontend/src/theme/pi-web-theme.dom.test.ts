// @vitest-environment jsdom
/**
 * Vérifie la POSE RÉELLE des tokens sur :root par la brique (jsdom) via
 * `applyPiWebTheme` :
 *   • le thème appliqué écrit bien les `--holaf-*` attendus sur <html> ;
 *   • `matrix-dark` / `matrix-light` posent EXACTEMENT les couleurs d'avant ;
 *   • le changement de famille/mode met à jour ces variables ;
 *   • les triples RGB (support d'opacité Tailwind) sont présents et corrects.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { applyPiWebTheme, getHolafTokens } from "./pi-web-theme";

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
});

describe("Pose des tokens par la brique sur :root (jsdom)", () => {
  it("matrix-dark pose les valeurs exactes d'avant", () => {
    applyPiWebTheme("dark", "matrix");
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

  it("matrix-light pose les valeurs exactes d'avant", () => {
    applyPiWebTheme("light", "matrix");
    expect(inline("--holaf-surface")).toBe("#eeece6");
    expect(inline("--holaf-surface-elev")).toBe("#f8f7f4");
    expect(inline("--holaf-surface-raised")).toBe("#ffffff");
    expect(inline("--holaf-border")).toBe("#d0d0c8");
    expect(inline("--holaf-border-bright")).toBe("#b8b8b0");
    expect(inline("--holaf-text")).toBe("#3d3d3a");
    expect(inline("--holaf-text-bright")).toBe("#1a1a18");
    expect(inline("--holaf-text-muted")).toBe("#777770");
    expect(inline("--holaf-info")).toBe("#0070cc");
    expect(inline("--holaf-warn")).toBe("#cc8800");
    expect(inline("--holaf-danger")).toBe("#cc2222");
    expect(inline("--holaf-accent")).toBe("#166534");
    expect(inline("--holaf-accent-hover")).toBe("#15803d");
  });

  it("les triples RGB sont posés (support d'opacité Tailwind) et corrects", () => {
    applyPiWebTheme("dark", "matrix");
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
    expect(inline("--holaf-accent-rgb")).toBe("0 255 65");
    expect(inline("--holaf-accent-dim-rgb")).toBe("0 204 52");
  });

  it("le changement de FAMILLE met à jour l'accent et le fond", () => {
    applyPiWebTheme("dark", "matrix");
    expect(inline("--holaf-accent")).toBe("#00ff41");
    applyPiWebTheme("dark", "corail");
    expect(inline("--holaf-accent")).toBe("#fa7fb5");
    // Tokens 0.6.0 (variante C) : fonds GRIS NEUTRE partagés par les familles,
    // seul l'ACCENT distingue la famille (corail-dark surface #36252c → #171717).
    expect(inline("--holaf-surface")).toBe("#171717");
    applyPiWebTheme("dark", "turquoise");
    expect(inline("--holaf-accent")).toBe("#0ec7de");
  });

  it("le changement de MODE met à jour fond et accent (famille conservée)", () => {
    applyPiWebTheme("dark", "matrix");
    expect(inline("--holaf-surface")).toBe("#0a0a0a");
    expect(inline("--holaf-accent")).toBe("#00ff41");
    applyPiWebTheme("light", "matrix");
    expect(inline("--holaf-surface")).toBe("#eeece6");
    expect(inline("--holaf-accent")).toBe("#166534");
    expect(inline("--holaf-accent-hover")).toBe("#15803d");
  });

  it("un thème inconnu retombe sur Matrix (pas d'erreur)", () => {
    expect(() => applyPiWebTheme("dark", "nope")).not.toThrow();
    expect(inline("--holaf-accent")).toBe("#00ff41");
    expect(inline("--holaf-surface")).toBe("#0a0a0a");
  });

  it("ne laisse AUCUNE clé --holaf-* étrangère : jeu de clés stable entre familles", () => {
    applyPiWebTheme("dark", "matrix");
    const matrix = Object.keys(snapshotHolaf()).sort();
    applyPiWebTheme("dark", "ambre");
    expect(Object.keys(snapshotHolaf()).sort()).toEqual(matrix);
    expect(matrix.length).toBeGreaterThan(0);
  });

  it("le style inline de <html> porte bien les variables (double preuve)", () => {
    applyPiWebTheme("dark", "matrix");
    const style = document.documentElement.getAttribute("style") ?? "";
    expect(style).toContain("--holaf-accent: #00ff41");
    expect(style).toContain("--holaf-accent-rgb: 0 255 65");
  });

  it("reset() retire TOUTES les variables --holaf-* posées", () => {
    applyPiWebTheme("dark", "matrix");
    expect(inline("--holaf-accent")).toBe("#00ff41");
    getHolafTokens().reset();
    expect(snapshotHolaf()).toEqual({});
    expect(inline("--holaf-accent")).toBe("");
  });

  it("les deux modes d'une même famille posent des fonds distincts", () => {
    applyPiWebTheme("dark", "corail");
    const darkSurface = inline("--holaf-surface");
    applyPiWebTheme("light", "corail");
    const lightSurface = inline("--holaf-surface");
    expect(darkSurface).not.toBe(lightSurface);
    // Tokens 0.6.0 (variante C) : surface sombre #171717, surface claire #eeeeee
    // (avant : #36252c / #ffe3ed — fonds teintés remplacés par des gris neutres).
    expect(darkSurface).toBe("#171717");
    expect(lightSurface).toBe("#eeeeee");
  });
});
