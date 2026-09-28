import { describe, expect, it } from "vitest";
import { selectLinkedSubprojects } from "./linked-subprojects.js";
import type { Project } from "./manager.js";

/** Fabrique un projet minimal pour les tests de sélection. */
function mk(id: string, name: string, cwd: string, storage: Project["storage"] = "local"): Project {
  return {
    id,
    name,
    storage,
    versioning: "standalone",
    cwd,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("selectLinkedSubprojects", () => {
  const a = mk("a", "AI-Helper", "/projects/AI-Helper");
  const b = mk("b", "ComfyUI-AI-Helper", "/projects/ComfyUI-AI-Helper");
  const h = mk("h", "holaf-lib", "/projects/holaf-lib");

  it("respecte l'ORDRE de linkedProjectIds", () => {
    const linked = { ...mk("L", "AI Helper (Linked)", "/projects/LINKED AI Helper", "linked"), linkedProjectIds: ["h", "a", "b"] };
    expect(selectLinkedSubprojects(linked, [a, b, h, linked])).toEqual([
      { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
      { name: "AI-Helper", rootPath: "/projects/AI-Helper" },
      { name: "ComfyUI-AI-Helper", rootPath: "/projects/ComfyUI-AI-Helper" },
    ]);
  });

  it("filtre les ids inconnus et les doublons", () => {
    const linked = { ...mk("L", "X", "/projects/X", "linked"), linkedProjectIds: ["a", "zzz", "a", "h"] };
    expect(selectLinkedSubprojects(linked, [a, h])).toEqual([
      { name: "AI-Helper", rootPath: "/projects/AI-Helper" },
      { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
    ]);
  });

  it("projet NON lié → []", () => {
    expect(selectLinkedSubprojects(a, [a, b, h])).toEqual([]);
  });

  it("projet absent ou sans linkedProjectIds → []", () => {
    expect(selectLinkedSubprojects(undefined, [a])).toEqual([]);
    expect(selectLinkedSubprojects(mk("L", "X", "/x", "linked"), [a])).toEqual([]);
  });

  it("filtré : sous-projet sans cwd écarté", () => {
    const noCwd = { ...mk("n", "sans-cwd", ""), cwd: "" };
    const linked = { ...mk("L", "X", "/x", "linked"), linkedProjectIds: ["n", "a"] };
    expect(selectLinkedSubprojects(linked, [noCwd, a])).toEqual([
      { name: "AI-Helper", rootPath: "/projects/AI-Helper" },
    ]);
  });
});
