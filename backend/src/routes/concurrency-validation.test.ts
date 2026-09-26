/**
 * Tests de validateConcurrencyPayload (validation pure de la route
 * PUT /api/settings/concurrency). Aucun I/O, aucun serveur HTTP.
 *
 * Objectif : les grandes limites (ex. deepseek 2500) sont acceptées, tandis
 * que 0, les floats, les chaînes, les clés JS réservées et les délais de file
 * hors bornes sont rejetés avec un message machine.
 */
import { describe, expect, it } from "vitest";
import { validateConcurrencyPayload, MAX_SLOTS } from "./concurrency-validation.js";

const expectError = (body: unknown) => {
  const parsed = validateConcurrencyPayload(body);
  expect("error" in parsed, `attendu une erreur pour ${JSON.stringify(body)}`).toBe(true);
  return (parsed as { error: string }).error;
};

describe("validateConcurrencyPayload — acceptance", () => {
  it("accepte un override par provider élevé (deepseek: 2500)", () => {
    const parsed = validateConcurrencyPayload({ providerMaxLLMSlots: { deepseek: 2500 } });
    expect(parsed).toEqual({ value: { providerMaxLLMSlots: { deepseek: 2500 } } });
  });

  it("accepte maxLLMSlots élevé et le plafond exact", () => {
    expect(validateConcurrencyPayload({ maxLLMSlots: 2500 })).toEqual({ value: { maxLLMSlots: 2500 } });
    expect(validateConcurrencyPayload({ maxLLMSlots: MAX_SLOTS })).toEqual({ value: { maxLLMSlots: MAX_SLOTS } });
  });

  it("accepte un queueTimeoutMs dans les bornes (défaut 3600000, max 12 h)", () => {
    expect(validateConcurrencyPayload({ queueTimeoutMs: 3_600_000 })).toEqual({ value: { queueTimeoutMs: 3_600_000 } });
    expect(validateConcurrencyPayload({ queueTimeoutMs: 5_000 })).toEqual({ value: { queueTimeoutMs: 5_000 } });
    expect(validateConcurrencyPayload({ queueTimeoutMs: 600_000 })).toEqual({ value: { queueTimeoutMs: 600_000 } });
    expect(validateConcurrencyPayload({ queueTimeoutMs: 43_200_000 })).toEqual({ value: { queueTimeoutMs: 43_200_000 } });
  });

  it("corps vide → update partiel (champs indéfinis)", () => {
    expect(validateConcurrencyPayload({})).toEqual({
      value: { maxLLMSlots: undefined, providerMaxLLMSlots: undefined, queueTimeoutMs: undefined },
    });
  });
});

describe("validateConcurrencyPayload — rejets", () => {
  it("rejette 0, les chaînes et les floats pour les slots", () => {
    expect(expectError({ maxLLMSlots: 0 })).toMatch(/maxLLMSlots/);
    expect(expectError({ maxLLMSlots: "12" })).toMatch(/maxLLMSlots/);
    expect(expectError({ maxLLMSlots: 12.5 })).toMatch(/maxLLMSlots/);
    expect(expectError({ maxLLMSlots: MAX_SLOTS + 1 })).toMatch(/maxLLMSlots/);
  });

  it("rejette les valeurs invalides dans providerMaxLLMSlots", () => {
    expect(expectError({ providerMaxLLMSlots: { deepseek: 0 } })).toMatch(/providerMaxLLMSlots\.deepseek/);
    expect(expectError({ providerMaxLLMSlots: { deepseek: "2500" } })).toMatch(/providerMaxLLMSlots\.deepseek/);
    expect(expectError({ providerMaxLLMSlots: { deepseek: 12.5 } })).toMatch(/providerMaxLLMSlots\.deepseek/);
    expect(expectError({ providerMaxLLMSlots: { deepseek: MAX_SLOTS + 1 } })).toMatch(/providerMaxLLMSlots\.deepseek/);
  });

  it("rejette les clés réservées JS et les clés vides", () => {
    // JSON.parse : garantit des properties propres (dont "__proto__").
    expect(expectError(JSON.parse('{"providerMaxLLMSlots":{"__proto__":5}}'))).toMatch(/invalid provider key/);
    expect(expectError({ providerMaxLLMSlots: { constructor: 5 } })).toMatch(/invalid provider key/);
    expect(expectError({ providerMaxLLMSlots: { prototype: 5 } })).toMatch(/invalid provider key/);
    expect(expectError({ providerMaxLLMSlots: { "  ": 5 } })).toMatch(/invalid provider key/);
  });

  it("rejette providerMaxLLMSlots non-objet", () => {
    expect(expectError({ providerMaxLLMSlots: "oops" })).toMatch(/must be an object/);
    expect(expectError({ providerMaxLLMSlots: [1] })).toMatch(/must be an object/);
    expect(expectError({ providerMaxLLMSlots: null })).toMatch(/must be an object/);
  });

  it("rejette queueTimeoutMs hors bornes ou non entier", () => {
    expect(expectError({ queueTimeoutMs: 1_000 })).toMatch(/queueTimeoutMs/);
    expect(expectError({ queueTimeoutMs: 43_200_001 })).toMatch(/queueTimeoutMs/);
    expect(expectError({ queueTimeoutMs: 1.5 })).toMatch(/queueTimeoutMs/);
    expect(expectError({ queueTimeoutMs: "600000" })).toMatch(/queueTimeoutMs/);
  });
});
