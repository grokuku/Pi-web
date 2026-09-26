/**
 * Tests de la capacité RÉSOLUE de raisonnement (resolveModelCapability).
 *
 * Règle de priorité : override manuel ("yes"/"no") > détection autoritaire du
 * provider / heuristique de nom (portée par le champ `reasoning`) > "auto".
 *
 * Le champ `reasoning` d'un RegisteredModel porte déjà la détection AUTORITAIRE
 * (Ollama `POST /api/show` → objet `thinking`, via enrichWithOllamaCapabilities)
 * quand elle existe, sinon l'heuristique de nom appliquée à l'ajout/migration.
 */
import { describe, expect, it } from "vitest";
import { resolveModelCapability, type RegisteredModel } from "./model-library.js";

function makeModel(overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    id: "m1",
    providerId: "p1",
    modelId: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    isDefault: false,
    reasoning: false,
    vision: false,
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

describe("resolveModelCapability(reasoning)", () => {
  it("override 'no' PRIME sur une détection qui déclare le modèle raisonneur", () => {
    expect(resolveModelCapability(makeModel({ reasoning: true, reasoningOverride: "no" }), "reasoning")).toBe(false);
  });

  it("override 'yes' PRIME sur une détection à false (cas deepseek-v4.1-flash)", () => {
    expect(resolveModelCapability(makeModel({ modelId: "deepseek-v4.1-flash", reasoning: false, reasoningOverride: "yes" }), "reasoning")).toBe(true);
  });

  it("override 'auto' + détection autoritaire/heuristique true → true", () => {
    expect(resolveModelCapability(makeModel({ reasoning: true, reasoningOverride: "auto" }), "reasoning")).toBe(true);
  });

  it("override 'auto' + nom inconnu (reasoning=false) → false", () => {
    expect(resolveModelCapability(makeModel({ modelId: "mistral-7b", reasoning: false }), "reasoning")).toBe(false);
  });

  it("override 'auto' + /api/show values:['low','medium','high'] (reasoning=true) → true", () => {
    expect(resolveModelCapability(makeModel({ reasoning: true, reasoningOverride: "auto", reasoningLevels: ["low", "medium", "high"] }), "reasoning")).toBe(true);
  });

  it("override 'auto' + /api/show values:[false] (reasoning=false) → false", () => {
    expect(resolveModelCapability(makeModel({ reasoning: false, reasoningOverride: "auto" }), "reasoning")).toBe(false);
  });

  it("override absent (legacy) → équivaut à 'auto'", () => {
    expect(resolveModelCapability(makeModel({ reasoning: true }), "reasoning")).toBe(true);
    expect(resolveModelCapability(makeModel({ reasoning: false }), "reasoning")).toBe(false);
  });

  it("les capacités vision/audio restent inchangées (non-régression)", () => {
    expect(resolveModelCapability(makeModel({ vision: false, visionOverride: "yes" }), "vision")).toBe(true);
    expect(resolveModelCapability(makeModel({ vision: true, visionOverride: "no" }), "vision")).toBe(false);
    expect(resolveModelCapability(makeModel({ audio: true }), "audio")).toBe(true);
  });
});
