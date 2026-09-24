// ── Tests unitaires : concurrence LLM par provider (fonctions pures) ──
// Vitest node (pas de jsdom) : on teste la logique de normalisation / fusion
// utilisée par SettingsModal — pas le rendu React.
import { describe, it, expect } from "vitest";
import {
  normalizeProviderOverrides,
  mergeProviderLimits,
  mergeProviderLimitsIncludingOverrides,
  buildProviderOverridesPayload,
  addProviderLimitRow,
  removeProviderLimitRow,
  isValidProviderId,
  normalizeProviderLimitInput,
  MAX_PROVIDER_LIMIT,
  type ProviderLimitRow,
} from "./concurrency";

describe("normalizeProviderOverrides", () => {
  it("undefined / null / non-objet → map vide", () => {
    expect(normalizeProviderOverrides(undefined)).toEqual({});
    expect(normalizeProviderOverrides(null)).toEqual({});
    expect(normalizeProviderOverrides("oops")).toEqual({});
    expect(normalizeProviderOverrides([1, 2])).toEqual({});
    expect(normalizeProviderOverrides(42)).toEqual({});
  });

  it("conserve les entrées valides (entiers 1..20)", () => {
    expect(normalizeProviderOverrides({ anthropic: 2, openai: 20 })).toEqual({
      anthropic: 2,
      openai: 20,
    });
  });

  it("filtre les valeurs invalides : ≤ 0, flottantes, NaN, non numériques", () => {
    const raw = {
      zero: 0,
      negatif: -1,
      flottant: 2.5,
      nan: NaN,
      texte: "3" as unknown as number,
      ok: 3,
    };
    expect(normalizeProviderOverrides(raw)).toEqual({ ok: 3 });
  });

  it("conserve les limites élevées (ex. 2500) et filtre au-delà du plafond", () => {
    expect(normalizeProviderOverrides({ deepseek: 2500, limite: MAX_PROVIDER_LIMIT })).toEqual({
      deepseek: 2500,
      limite: MAX_PROVIDER_LIMIT,
    });
    expect(
      normalizeProviderOverrides({ tropGrand: MAX_PROVIDER_LIMIT + 1, ok: 3 })
    ).toEqual({ ok: 3 });
  });

  it("filtre les clés vides et les clés réservées JS (pollution de prototype)", () => {
    const raw = JSON.parse('{"__proto__":5,"constructor":3,"prototype":2," ":1,"":9,"ok":1}');
    expect(normalizeProviderOverrides(raw)).toEqual({ ok: 1 });
  });

  it("map vide → map vide (aucun override)", () => {
    expect(normalizeProviderOverrides({})).toEqual({});
  });
});

describe("mergeProviderLimits", () => {
  const providers = [
    { id: "prov-a", name: "Anthropic" },
    { id: "prov-b", name: "OpenAI" },
    { id: "prov-c" }, // pas de nom custom → fallback sur l'id
  ];

  it("associe chaque provider à son override ; absent → null (hérite)", () => {
    const rows = mergeProviderLimits(providers, { "prov-a": 2 });
    expect(rows).toEqual([
      { id: "prov-a", name: "Anthropic", value: 2 },
      { id: "prov-b", name: "OpenAI", value: null },
      { id: "prov-c", name: "prov-c", value: null },
    ]);
  });

  it("tous les providers héritent quand la map d'overrides est vide", () => {
    const rows = mergeProviderLimits(providers, {});
    expect(rows.every((r) => r.value === null)).toBe(true);
  });

  it("liste de providers vide → aucune ligne", () => {
    expect(mergeProviderLimits([], { "prov-a": 2 })).toEqual([]);
  });

  it("ne mute ni la liste ni la map d'entrée (immutabilité)", () => {
    const overrides = { "prov-a": 1 };
    const rows = mergeProviderLimits(providers, overrides);
    expect(overrides).toEqual({ "prov-a": 1 });
    expect(rows).toHaveLength(providers.length);
  });
});

describe("buildProviderOverridesPayload", () => {
  it("retire les champs vides (null) → override supprimé = hérite du défaut", () => {
    const rows: ProviderLimitRow[] = [
      { id: "prov-a", name: "A", value: 3 },
      { id: "prov-b", name: "B", value: null }, // vidé par l'utilisateur
      { id: "prov-c", name: "C", value: null },
    ];
    expect(buildProviderOverridesPayload(rows)).toEqual({ "prov-a": 3 });
  });

  it("tous les champs vides → map vide {} (efface tous les overrides au PUT)", () => {
    const rows: ProviderLimitRow[] = [
      { id: "prov-a", name: "A", value: null },
      { id: "prov-b", name: "B", value: undefined as unknown as null },
    ];
    expect(buildProviderOverridesPayload(rows)).toEqual({});
  });

  it("ignore les valeurs invalides (≤ 0, flottantes, non numériques)", () => {
    const rows: ProviderLimitRow[] = [
      { id: "prov-a", name: "A", value: 0 },
      { id: "prov-b", name: "B", value: -2 },
      { id: "prov-c", name: "C", value: 1.5 },
      { id: "prov-d", name: "D", value: 2 },
      { id: "prov-e", name: "E", value: "4" as unknown as number },
    ];
    expect(buildProviderOverridesPayload(rows)).toEqual({ "prov-d": 2 });
  });

  it("accepte les grandes limites (ex. 2500) et rejette au-delà du plafond", () => {
    const rows: ProviderLimitRow[] = [
      { id: "deepseek", name: "DeepSeek", value: 2500 },
      { id: "trop", name: "Trop", value: MAX_PROVIDER_LIMIT + 1 },
    ];
    expect(buildProviderOverridesPayload(rows)).toEqual({ deepseek: 2500 });
  });

  it("aller-retour : normalize → merge → payload préserve les valeurs saisies", () => {
    const overrides = normalizeProviderOverrides({ "prov-a": 4, bogus: 0 });
    const rows = mergeProviderLimits(
      [
        { id: "prov-a", name: "A" },
        { id: "prov-b", name: "B" },
      ],
      overrides
    );
    // L'utilisateur vide prov-a et saisit 5 pour prov-b
    rows[0].value = null;
    rows[1].value = 5;
    expect(buildProviderOverridesPayload(rows)).toEqual({ "prov-b": 5 });
  });
});

describe("mergeProviderLimitsIncludingOverrides", () => {
  it("ajoute en fin de liste les overrides absents de la liste des providers", () => {
    const rows = mergeProviderLimitsIncludingOverrides(
      [{ id: "prov-a", name: "A" }],
      { "prov-a": 2, extension_prov: 2500 }
    );
    expect(rows).toEqual([
      { id: "prov-a", name: "A", value: 2 },
      { id: "extension_prov", name: "extension_prov", value: 2500 },
    ]);
  });

  it("sans override orphelin, équivaut à mergeProviderLimits", () => {
    const rows = mergeProviderLimitsIncludingOverrides([{ id: "prov-a", name: "A" }], {});
    expect(rows).toEqual([{ id: "prov-a", name: "A", value: null }]);
  });
});

describe("isValidProviderId", () => {
  it("accepte un identifiant libre non vide, rejette vides et clés réservées", () => {
    expect(isValidProviderId("ollama-cloud")).toBe(true);
    expect(isValidProviderId("  ")).toBe(false);
    expect(isValidProviderId("")).toBe(false);
    expect(isValidProviderId(42)).toBe(false);
    expect(isValidProviderId("__proto__")).toBe(false);
    expect(isValidProviderId("constructor")).toBe(false);
  });
});

describe("normalizeProviderLimitInput", () => {
  it("champ vide → null (hérite), entier valide → nombre", () => {
    expect(normalizeProviderLimitInput("")).toBeNull();
    expect(normalizeProviderLimitInput(null)).toBeNull();
    expect(normalizeProviderLimitInput(undefined)).toBeNull();
    expect(normalizeProviderLimitInput("2500")).toBe(2500);
    expect(normalizeProviderLimitInput(60)).toBe(60);
  });

  it("valeur invalide → null (0, flottante, hors plafond, texte)", () => {
    expect(normalizeProviderLimitInput("0")).toBeNull();
    expect(normalizeProviderLimitInput("12.5")).toBeNull();
    expect(normalizeProviderLimitInput(String(MAX_PROVIDER_LIMIT + 1))).toBeNull();
    expect(normalizeProviderLimitInput("abc")).toBeNull();
  });
});

describe("addProviderLimitRow / removeProviderLimitRow", () => {
  const base: ProviderLimitRow[] = [{ id: "prov-a", name: "A", value: null }];

  it("ajoute une ligne manuelle (id libre) sans muter l'entrée", () => {
    const rows = addProviderLimitRow(base, " deepseek ");
    expect(rows).toEqual([
      { id: "prov-a", name: "A", value: null },
      { id: "deepseek", name: "deepseek", value: null },
    ]);
    expect(base).toHaveLength(1); // immutabilité
  });

  it("ignore les ids invalides et les doublons", () => {
    expect(addProviderLimitRow(base, "")).toEqual(base);
    expect(addProviderLimitRow(base, "__proto__")).toEqual(base);
    expect(addProviderLimitRow(base, "prov-a")).toEqual(base);
  });

  it("supprime la ligne correspondante sans muter l'entrée", () => {
    const rows = removeProviderLimitRow(base, "prov-a");
    expect(rows).toEqual([]);
    expect(base).toHaveLength(1); // immutabilité
    expect(removeProviderLimitRow(base, "absent")).toEqual(base);
  });
});