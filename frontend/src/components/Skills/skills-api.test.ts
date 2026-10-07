// ── Tests des helpers purs de skills-api (validation de nom, état activé) ──
import { describe, expect, it } from "vitest";
import { isSkillEnabledInList, isSkillNameValid } from "./skills-api";

describe("isSkillNameValid", () => {
  it("accepte les noms du spec Agent Skills", () => {
    for (const name of ["pi-web-ui", "codebase-memory", "a", "a1-b2"]) {
      expect(isSkillNameValid(name), name).toBe(true);
    }
  });

  it("rejette les traversées de chemin et les noms hors spec", () => {
    for (const name of ["", "  ", "../evil", "a/b", "A", "-a", "a-", "a--b", "a b", "a.b"]) {
      expect(isSkillNameValid(name), `devrait être refusé : ${JSON.stringify(name)}`).toBe(false);
    }
    expect(isSkillNameValid("a".repeat(65))).toBe(false);
  });
});

describe("isSkillEnabledInList", () => {
  it("désactive uniquement sur motif !<nom> ou -<nom>", () => {
    expect(isSkillEnabledInList([], "pi-web-ui")).toBe(true);
    expect(isSkillEnabledInList(["pi-web-ui"], "pi-web-ui")).toBe(true);
    expect(isSkillEnabledInList(["!pi-web-ui"], "pi-web-ui")).toBe(false);
    expect(isSkillEnabledInList(["-pi-web-ui"], "pi-web-ui")).toBe(false);
    expect(isSkillEnabledInList(["!autre"], "pi-web-ui")).toBe(true);
    expect(isSkillEnabledInList(undefined, "pi-web-ui")).toBe(true);
  });
});
