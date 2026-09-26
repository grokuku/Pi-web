/**
 * Tests de mergeProjectUpdate — cœur de PUT /api/projects/:id (renommage).
 *
 * Contrat clé : un renommage d'un projet de type `linked` (patch `{ name }`)
 * est ACCEPTÉ et ne doit toucher NI le cwd NI les linkedProjectIds (le
 * placeholder et ses symlinks restent intacts) ; id/createdAt restent
 * immuables et updatedAt est réécrit.
 */
import { describe, it, expect } from "vitest";
import { mergeProjectUpdate, type Project } from "../manager.js";

function makeLinked(): Project {
  return {
    id: "grp-1",
    name: "LINKED AI Helper",
    storage: "linked",
    versioning: "standalone",
    cwd: "/projects/LINKED AI Helper",
    linkedProjectIds: ["a1", "a2"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mergeProjectUpdate — renommage", () => {
  it("accepte le renommage d'un projet linked sans altérer cwd ni linkedProjectIds", () => {
    const current = makeLinked();
    const merged = mergeProjectUpdate(current, { name: "Mon Groupe Renommé" }, "2026-02-02T00:00:00.000Z");

    expect(merged.name).toBe("Mon Groupe Renommé");
    // Structurellement intact : même cwd, mêmes sous-projets, même stockage.
    expect(merged.cwd).toBe("/projects/LINKED AI Helper");
    expect(merged.linkedProjectIds).toEqual(["a1", "a2"]);
    expect(merged.storage).toBe("linked");
    // Champs immuables préservés, updatedAt réécrit.
    expect(merged.id).toBe("grp-1");
    expect(merged.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(merged.updatedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("ne mute pas le projet source", () => {
    const current = makeLinked();
    mergeProjectUpdate(current, { name: "Autre" }, "2026-03-03T00:00:00.000Z");
    expect(current.name).toBe("LINKED AI Helper");
    expect(current.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("conserve les champs non cités dans le patch (merging partiel)", () => {
    const current: Project = {
      ...makeLinked(),
      storage: "local",
      linkedProjectIds: undefined,
      git: { remote: "git@github.com:o/r.git", branch: "main", lastSync: null },
    };
    const merged = mergeProjectUpdate(current, { name: "Renamed" }, "2026-04-04T00:00:00.000Z");
    expect(merged.git).toEqual(current.git);
    expect(merged.cwd).toBe(current.cwd);
  });

  it("ignore une tentative de modification de id/createdAt via le patch", () => {
    const current = makeLinked();
    const merged = mergeProjectUpdate(
      current,
      // `any` volontaire : on simule un corps de requête malveillant.
      { id: "pwned", createdAt: "1999-01-01T00:00:00.000Z", name: "X" } as any,
      "2026-05-05T00:00:00.000Z"
    );
    expect(merged.id).toBe("grp-1");
    expect(merged.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
