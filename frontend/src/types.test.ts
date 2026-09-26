/**
 * Tests de thinkingLevelsForModel : n'exposer que les niveaux de réflexion
 * DÉCLARÉS par le provider (Ollama /api/show → RegisteredModel.reasoningLevels),
 * défaut du provider inclus ; information inconnue = comportement historique.
 */
import { describe, expect, it } from "vitest";
import { THINKING_LEVELS, thinkingLevelsForModel, type RegisteredModel } from "./types";

function model(overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    id: "m1",
    providerId: "p1",
    modelId: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    isDefault: false,
    reasoning: true,
    vision: false,
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

describe("thinkingLevelsForModel", () => {
  it("ne propose QUE les niveaux déclarés (+ off) — pas de medium/xhigh inventés", () => {
    const levels = thinkingLevelsForModel(
      model({ reasoningLevels: ["off", "low", "high", "max"], reasoningDefault: "high" }),
    );
    expect(levels).toEqual(["off", "low", "high", "max"]);
    expect(levels).not.toContain("medium");
    expect(levels).not.toContain("xhigh");
    expect(levels).not.toContain("minimal");
  });

  it("déclaré SANS off (values sans false) → pas d'extinction proposée", () => {
    expect(thinkingLevelsForModel(model({ reasoningLevels: ["low", "high"], reasoningDefault: "high" })))
      .toEqual(["low", "high"]);
  });

  it("information INCONNUE (reasoningLevels absent) → tous les niveaux (non-régression)", () => {
    expect(thinkingLevelsForModel(model())).toEqual(THINKING_LEVELS);
    expect(thinkingLevelsForModel(model({ reasoningLevels: [] }))).toEqual(THINKING_LEVELS);
  });

  it("défaut du provider valide mais absent de values → ajouté", () => {
    expect(thinkingLevelsForModel(model({ reasoningLevels: ["off", "low", "max"], reasoningDefault: "medium" })))
      .toEqual(["off", "low", "max", "medium"]);
  });

  it("niveaux déclarés tous inconnus du SDK → repli sur tous les niveaux", () => {
    expect(thinkingLevelsForModel(model({ reasoningLevels: ["banana", "turbo"] }))).toEqual(THINKING_LEVELS);
  });

  it("modèle non-raisonneur (values:[false] → reasoningLevels:['off']) → seulement off", () => {
    expect(thinkingLevelsForModel(model({ reasoning: false, reasoningLevels: ["off"] }))).toEqual(["off"]);
  });
});
