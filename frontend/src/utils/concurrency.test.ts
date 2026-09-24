// ── Tests unitaires : limite de concurrence LLM par provider (fonctions pures) ──
// Vitest node (pas de jsdom) : on teste la validation/normalisation du champ
// « appels simultanés » d'un provider — pas le rendu React.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_CALLS,
  MAX_PROVIDER_LIMIT,
  effectiveProviderCalls,
  normalizeProviderCallsInput,
} from "./concurrency";

describe("normalizeProviderCallsInput", () => {
  it("champ vide (\"\", null, undefined) → null", () => {
    expect(normalizeProviderCallsInput("")).toBeNull();
    expect(normalizeProviderCallsInput(null)).toBeNull();
    expect(normalizeProviderCallsInput(undefined)).toBeNull();
  });

  it("entier valide (chaîne ou nombre) → nombre", () => {
    expect(normalizeProviderCallsInput("3")).toBe(3);
    expect(normalizeProviderCallsInput(3)).toBe(3);
    expect(normalizeProviderCallsInput("2500")).toBe(2500);
    expect(normalizeProviderCallsInput(1)).toBe(1);
    expect(normalizeProviderCallsInput(MAX_PROVIDER_LIMIT)).toBe(MAX_PROVIDER_LIMIT);
  });

  it("valeur invalide → null (0, négatif, flottante, texte, hors plafond)", () => {
    expect(normalizeProviderCallsInput("0")).toBeNull();
    expect(normalizeProviderCallsInput(-1)).toBeNull();
    expect(normalizeProviderCallsInput("12.5")).toBeNull();
    expect(normalizeProviderCallsInput(1.5)).toBeNull();
    expect(normalizeProviderCallsInput("abc")).toBeNull();
    expect(normalizeProviderCallsInput(String(MAX_PROVIDER_LIMIT + 1))).toBeNull();
    expect(normalizeProviderCallsInput(NaN)).toBeNull();
  });
});

describe("effectiveProviderCalls", () => {
  it("valeur absente ou invalide → défaut 3", () => {
    expect(effectiveProviderCalls(undefined)).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
    expect(effectiveProviderCalls(null)).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
    expect(effectiveProviderCalls(0)).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
    expect(effectiveProviderCalls("oops")).toBe(DEFAULT_MAX_CONCURRENT_CALLS);
  });

  it("valeur explicite valide → cette valeur", () => {
    expect(effectiveProviderCalls(2500)).toBe(2500);
    expect(effectiveProviderCalls("4")).toBe(4);
  });
});
