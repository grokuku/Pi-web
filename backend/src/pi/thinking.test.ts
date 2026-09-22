/**
 * Tests de PRÉCÉDENCE du niveau de réflexion effectif.
 *
 * Règle métier : catégorie routée (explicite) > `thinkingLevel` du modèle >
 * niveau du mode > "medium" (défaut SDK). Un modèle sans `thinkingLevel`
 * (option « défaut » de l'UI ou config historique) doit laisser s'appliquer le
 * niveau du mode — jamais un "medium" figé qui écraserait le mode.
 */
import { describe, expect, it } from "vitest";
import { resolveThinkingLevel } from "./thinking.js";

describe("resolveThinkingLevel — précédence", () => {
  it("catégorie routée (explicite) prime sur le modèle et le mode", () => {
    expect(resolveThinkingLevel("high", "low", "medium")).toBe("high");
    expect(resolveThinkingLevel("off", "max", "xhigh")).toBe("off");
  });

  it("sans catégorie : le thinkingLevel du modèle prime sur le mode", () => {
    expect(resolveThinkingLevel(undefined, "low", "medium")).toBe("low");
    expect(resolveThinkingLevel(undefined, "xhigh", "medium")).toBe("xhigh");
  });

  it("modèle sans thinkingLevel (défaut) : le niveau du mode s'applique", () => {
    expect(resolveThinkingLevel(undefined, undefined, "high")).toBe("high");
    expect(resolveThinkingLevel(undefined, "", "low")).toBe("low");
  });

  it("ni modèle ni mode : repli sur \"medium\" (défaut SDK)", () => {
    expect(resolveThinkingLevel(undefined, undefined, undefined)).toBe("medium");
    expect(resolveThinkingLevel(undefined, undefined, "")).toBe("medium");
  });
});
