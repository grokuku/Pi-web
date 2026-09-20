import { describe, it, expect } from "vitest";
import { fr } from "./fr";
import { en } from "./en";

// ── Parité i18n fr/en (1:1) ────────────────────────────────────────────────
// Les deux langues doivent exposer exactement le même arbre de clés : toute
// clé ajoutée d'un côté doit l'être de l'autre (les valeurs manquantes tombent
// sinon silencieusement sur le fallback anglais).

function collectKeys(node: unknown, prefix = ""): string[] {
  if (node == null || typeof node !== "object" || Array.isArray(node)) {
    return prefix ? [prefix] : [];
  }
  const keys: string[] = [];
  for (const key of Object.keys(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = (node as Record<string, unknown>)[key];
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...collectKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

describe("i18n parité fr/en", () => {
  it("expose exactement les mêmes clés des deux côtés", () => {
    const frKeys = collectKeys(fr).sort();
    const enKeys = collectKeys(en).sort();
    const onlyFr = frKeys.filter((k) => !enKeys.includes(k));
    const onlyEn = enKeys.filter((k) => !frKeys.includes(k));
    expect(onlyFr, `clés absentes de en.ts : ${onlyFr.join(", ")}`).toEqual([]);
    expect(onlyEn, `clés absentes de fr.ts : ${onlyEn.join(", ")}`).toEqual([]);
    expect(frKeys).toEqual(enKeys);
  });

  it("conserve le même type (string vs fonction) pour chaque clé", () => {
    const typeOf = (node: unknown, path: string): string => {
      const parts = path.split(".");
      let cur: any = node;
      for (const p of parts) cur = cur?.[p];
      return typeof cur;
    };
    for (const key of collectKeys(fr)) {
      expect(typeOf(en, key), `type divergent pour "${key}"`).toBe(typeOf(fr, key));
    }
  });
});
