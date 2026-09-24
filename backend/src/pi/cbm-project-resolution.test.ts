import { describe, it, expect } from "vitest";
import {
  parseProjectList,
  resolveCbmProjectName,
  normalizeRootPath,
  type IndexedProject,
} from "./cbm-project-resolution.js";

const INDEXED: IndexedProject[] = [
  { name: "projects-Pi-Web", rootPath: "/projects/Pi-Web" },
  { name: "projects-Yuki", rootPath: "/projects/Yuki" },
  { name: "projects-holaf-lib", rootPath: "/projects/holaf-lib" },
  { name: "projects-AI-Helper", rootPath: "/projects/AI-Helper" },
  { name: "projects-ComfyUI-AI-Helper", rootPath: "/projects/ComfyUI-AI-Helper" },
  { name: "projects-Homy", rootPath: "/projects/Homy" },
];

describe("normalizeRootPath", () => {
  it("retire les slashs finaux et retombe sur / pour une chaîne vide", () => {
    expect(normalizeRootPath("/projects/Yuki/")).toBe("/projects/Yuki");
    expect(normalizeRootPath("  /a/b//  ")).toBe("/a/b");
    expect(normalizeRootPath("")).toBe("/");
  });
});

describe("resolveCbmProjectName", () => {
  it("cwd indexé directement → nom inchangé (cas nominal)", () => {
    expect(resolveCbmProjectName("/projects/Pi-Web", INDEXED)).toBe("projects-Pi-Web");
  });

  it("cwd sous-dossier d'un projet indexé → projet ancêtre", () => {
    expect(resolveCbmProjectName("/projects/Pi-Web/backend/src", INDEXED)).toBe(
      "projects-Pi-Web",
    );
  });

  it("workspace composite sous un projet indexé → ancêtre le plus proche", () => {
    // « Yuki and Libs » n'a pas de graphe propre : on retombe sur /projects/Yuki.
    expect(resolveCbmProjectName("/projects/Yuki/Yuki and Libs", INDEXED)).toBe(
      "projects-Yuki",
    );
  });

  it("workspace lié sans ancêtre indexé → cible d'un symlink indexée", () => {
    expect(
      resolveCbmProjectName("/projects/LINKED AI Helper", INDEXED, {
        linkedTargets: ["/projects/AI-Helper", "/projects/ComfyUI-AI-Helper"],
      }),
    ).toBe("projects-AI-Helper");
  });

  it("workspace lié dont les cibles ont elles-mêmes un ancêtre indexé", () => {
    expect(
      resolveCbmProjectName("/projects/Linked Homy et libs", INDEXED, {
        linkedTargets: ["/projects/Homy", "/projects/holaf-lib"],
      }),
    ).toBe("projects-Homy");
  });

  it("cwd inconnu → null (l'appelant garde son repli)", () => {
    expect(resolveCbmProjectName("/tmp/nowhere", INDEXED)).toBeNull();
  });

  it("cwd vide → null", () => {
    expect(resolveCbmProjectName("", INDEXED)).toBeNull();
  });

  it("préfixe voisin mais pas enfant (Pi-Web2) → pas de faux match", () => {
    expect(resolveCbmProjectName("/projects/Pi-Web2", INDEXED)).toBeNull();
  });
});

describe("parseProjectList", () => {
  it("parse la table texte de list_projects (chemins avec espaces entre guillemets)", () => {
    const raw =
      "projects: 3  (cols: name root_path branch)\n" +
      "  projects-AI-Helper /projects/AI-Helper main\n" +
      '  projects-DSN-Test "/projects/DSN Test" -\n' +
      "  projects-Yuki /projects/Yuki main\n" +
      "total: 3\nreturned: 3\n";
    expect(parseProjectList(raw)).toEqual([
      { name: "projects-AI-Helper", rootPath: "/projects/AI-Helper" },
      { name: "projects-DSN-Test", rootPath: "/projects/DSN Test" },
      { name: "projects-Yuki", rootPath: "/projects/Yuki" },
    ]);
  });

  it("parse aussi le format JSON { projects: [...] }", () => {
    const raw = JSON.stringify({ projects: [{ name: "p", root_path: "/x" }] });
    expect(parseProjectList(raw)).toEqual([{ name: "p", rootPath: "/x" }]);
  });

  it("tolère une entrée illisible (ne jette jamais)", () => {
    expect(parseProjectList("garbage")).toEqual([]);
  });
});
