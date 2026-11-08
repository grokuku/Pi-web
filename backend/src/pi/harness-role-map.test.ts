/**
 * harness-role-map.test.ts — LOT 4 / BUG09 : un rôle inconnu est REFUSÉ.
 *
 * Avant correctif, l'extension mappait tout rôle non reconnu sur `execute`
 * (la fonction la plus permissive : edit/write/bash). Une faute de frappe
 * (`role: "code_reviewer"`) donnait donc des droits d'ÉCRITURE à un délégué
 * dont l'intention était une relecture read-only.
 */
import { describe, expect, it } from "vitest";
import {
  LEGACY_ROLE_TO_FUNCTION,
  VALID_FUNCTIONS,
  describeLegacyRoles,
  mapRoleToFunction,
  roleRefusalMessage,
} from "./harness-role-map.js";

describe("mapRoleToFunction", () => {
  it("mappe les rôles hérités connus", () => {
    expect(mapRoleToFunction("architect")).toBe("planning");
    expect(mapRoleToFunction("code-reviewer")).toBe("review");
    expect(mapRoleToFunction("security-reviewer")).toBe("review");
  });

  it("REFUSE un rôle inconnu au lieu de le mapper sur execute", () => {
    // Le cas réel du constat : faute de frappe (underscore au lieu du tiret).
    expect(mapRoleToFunction("code_reviewer")).toBeNull();
    expect(mapRoleToFunction("reviewer")).toBeNull();
    expect(mapRoleToFunction("expert")).toBeNull();
    expect(mapRoleToFunction("EXECUTE")).toBeNull();
    // Garde explicite : aucun repli permissif, quel que soit l'inconnu.
    expect(Object.values(LEGACY_ROLE_TO_FUNCTION)).not.toContain(undefined);
  });

  it("refuse les valeurs non exploitables (vide, espaces, non-string)", () => {
    expect(mapRoleToFunction("")).toBeNull();
    expect(mapRoleToFunction("   ")).toBeNull();
    expect(mapRoleToFunction(undefined)).toBeNull();
    expect(mapRoleToFunction(null)).toBeNull();
    expect(mapRoleToFunction(42)).toBeNull();
    expect(mapRoleToFunction({ role: "architect" })).toBeNull();
  });

  it("tolère les espaces autour d'un rôle valide", () => {
    expect(mapRoleToFunction("  architect  ")).toBe("planning");
  });
});

describe("roleRefusalMessage", () => {
  it("nomme le rôle reçu et liste les rôles/fonctions valides", () => {
    const msg = roleRefusalMessage("code_reviewer");
    expect(msg).toContain("code_reviewer");
    expect(msg).toContain(describeLegacyRoles());
    for (const fn of VALID_FUNCTIONS) expect(msg).toContain(fn);
    // Chaque rôle hérité accepté est énuméré avec sa cible.
    expect(msg).toContain("architect → planning");
    expect(msg).toContain("code-reviewer → review");
  });

  it("ne produit pas de trou de message pour un rôle vide/absent", () => {
    expect(roleRefusalMessage("  ")).toContain("(vide)");
    expect(roleRefusalMessage(undefined)).toContain("(vide)");
  });
});
