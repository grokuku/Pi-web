import { describe, it, expect } from "vitest";
import { compareProjectsByName, projectNamesMatch, sortProjectsByName } from "./project-sort";
import type { Project } from "../types";

function makeProject(name: string, id = name): Project {
  return {
    id,
    name,
    storage: "local",
    versioning: "standalone",
    cwd: `/projects/${name}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("sortProjectsByName", () => {
  it("trie par ordre alphabétique insensible à la casse", () => {
    const sorted = sortProjectsByName(
      ["BxRGB", "aikore", "Zeta", "mango"].map((n) => makeProject(n))
    ).map((p) => p.name);
    expect(sorted).toEqual(["aikore", "BxRGB", "mango", "Zeta"]);
  });

  it("neutralise les accents (Édyn rangé comme Edyn)", () => {
    const sorted = sortProjectsByName(
      ["Zeta", "Édyn", "Delta", "Alpha"].map((n) => makeProject(n))
    ).map((p) => p.name);
    // « Édyn » se place entre Delta et Zeta, sans être rejeté en fin de liste.
    expect(sorted).toEqual(["Alpha", "Delta", "Édyn", "Zeta"]);
  });

  it("trie numériquement (Yuki 2 avant Yuki 10)", () => {
    const sorted = sortProjectsByName(
      ["Yuki 10", "Yuki 2", "Yuki 1"].map((n) => makeProject(n))
    ).map((p) => p.name);
    expect(sorted).toEqual(["Yuki 1", "Yuki 2", "Yuki 10"]);
  });

  it("est stable et déterministe pour des noms équivalents (casse/accents)", () => {
    const first = sortProjectsByName(["aiKo", "AIKO", "aiko"].map((n) => makeProject(n))).map((p) => p.name);
    const second = sortProjectsByName(["aiko", "AIKO", "aiKo"].map((n) => makeProject(n))).map((p) => p.name);
    expect(first).toEqual(second);
  });

  it("ne mute PAS le tableau d'entrée", () => {
    const input = ["Zeta", "Alpha"].map((n) => makeProject(n));
    const snapshot = input.map((p) => p.name);
    sortProjectsByName(input);
    expect(input.map((p) => p.name)).toEqual(snapshot);
  });

  it("préserve les objets (identité et propriétés des projets)", () => {
    const linked = { ...makeProject("Zed"), storage: "linked" as const, linkedProjectIds: ["a", "b"] };
    const sorted = sortProjectsByName([makeProject("Alpha"), linked]);
    expect(sorted[1]).toBe(linked);
    expect(sorted[1].storage).toBe("linked");
    expect(sorted[1].linkedProjectIds).toEqual(["a", "b"]);
  });
});

describe("compareProjectsByName", () => {
  it("départage par la casse deux noms équivalents en base (ordre déterministe)", () => {
    // Même nom à la casse près : la comparaison « base » vaut 0, mais le
    // départage strict rend l'ordre reproductible d'une exécution à l'autre.
    expect(compareProjectsByName(makeProject("aikore"), makeProject("Aikore"))).not.toBe(0);
    expect(compareProjectsByName(makeProject("Aikore"), makeProject("Aikore"))).toBe(0);
  });
});

describe("projectNamesMatch — détection de doublon de renommage", () => {
  it("ignore la casse et les accents", () => {
    expect(projectNamesMatch("AI-Helper", "ai-helper")).toBe(true);
    expect(projectNamesMatch("Édyn", "edyn")).toBe(true);
  });

  it("distingue les noms réellement différents", () => {
    expect(projectNamesMatch("Yuki", "Yuki 2")).toBe(false);
    expect(projectNamesMatch("Alpha", "Beta")).toBe(false);
  });
});
