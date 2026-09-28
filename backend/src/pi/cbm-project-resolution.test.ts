import { describe, it, expect } from "vitest";
import {
  parseProjectList,
  resolveCbmProjectName,
  resolveCbmProjectNameForRoot,
  resolveCbmProjectNames,
  resolveLinkedTargets,
  normalizeRootPath,
  type IndexedProject,
  type LinkedSubprojectRef,
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

describe("resolveCbmProjectNameForRoot", () => {
  it("racine exacte d'un sous-projet → nom CBM", () => {
    expect(resolveCbmProjectNameForRoot("/projects/holaf-lib", INDEXED)).toBe(
      "projects-holaf-lib",
    );
  });

  it("racine sous un projet indexé → ancêtre le plus proche", () => {
    expect(resolveCbmProjectNameForRoot("/projects/Pi-Web/backend", INDEXED)).toBe(
      "projects-Pi-Web",
    );
  });

  it("racine inconnue → null", () => {
    expect(resolveCbmProjectNameForRoot("/tmp/nowhere", INDEXED)).toBeNull();
  });
});

describe("resolveCbmProjectNames (fédération des workspaces liés)", () => {
  it("projet NON lié → [résolution unique] (comportement inchangé)", () => {
    expect(resolveCbmProjectNames("/projects/Pi-Web", INDEXED)).toEqual(["projects-Pi-Web"]);
    expect(resolveCbmProjectNames("/projects/Pi-Web/backend/src", INDEXED)).toEqual([
      "projects-Pi-Web",
    ]);
  });

  it("projet NON lié non résolu → [] (l'appelant garde son repli)", () => {
    expect(resolveCbmProjectNames("/tmp/nowhere", INDEXED)).toEqual([]);
  });

  it("composite → liste ORDONNÉE des noms CBM des sous-projets", () => {
    const subs: LinkedSubprojectRef[] = [
      { name: "AI-Helper", rootPath: "/projects/AI-Helper" },
      { name: "ComfyUI-AI-Helper", rootPath: "/projects/ComfyUI-AI-Helper" },
      { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
    ];
    expect(resolveCbmProjectNames("/projects/LINKED AI Helper", INDEXED, subs)).toEqual([
      "projects-AI-Helper",
      "projects-ComfyUI-AI-Helper",
      "projects-holaf-lib",
    ]);
  });

  it("composite IMBRIQUÉ dans un dossier indexé → sous-projets, PAS le parent", () => {
    // « Yuki and Libs » est sous /projects/Yuki (indexé) : la détection de
    // composite doit primer sur la règle « ancêtre le plus proche ».
    const subs: LinkedSubprojectRef[] = [
      { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
      { name: "Yuki-inner", rootPath: "/projects/Yuki/inner" },
    ];
    expect(
      resolveCbmProjectNames("/projects/Yuki/Yuki and Libs", INDEXED, subs),
    ).toEqual(["projects-holaf-lib", "projects-Yuki"]);
  });

  it("déduplique les sous-projets qui résolvent vers le même projet CBM", () => {
    const subs: LinkedSubprojectRef[] = [
      { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
      { name: "holaf-lib-bis", rootPath: "/projects/holaf-lib" },
    ];
    expect(resolveCbmProjectNames("/projects/LINKED", INDEXED, subs)).toEqual([
      "projects-holaf-lib",
    ]);
  });

  it("sous-projets non résolus exclus, les autres conservés dans l'ordre", () => {
    const subs: LinkedSubprojectRef[] = [
      { name: "inconnu", rootPath: "/tmp/nope" },
      { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
      { name: "AI-Helper", rootPath: "/projects/AI-Helper" },
    ];
    expect(resolveCbmProjectNames("/projects/LINKED", INDEXED, subs)).toEqual([
      "projects-holaf-lib",
      "projects-AI-Helper",
    ]);
  });

  it("registre vide → [] (aucun sous-projet résolu)", () => {
    const subs: LinkedSubprojectRef[] = [
      { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
    ];
    expect(resolveCbmProjectNames("/projects/LINKED", [], subs)).toEqual([]);
  });
});

describe("resolveLinkedTargets", () => {
  it("associe nom lisible + nom CBM, dans l'ordre, sans doublon", () => {
    const subs: LinkedSubprojectRef[] = [
      { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
      { name: "AI-Helper", rootPath: "/projects/AI-Helper" },
      { name: "holaf-lib-bis", rootPath: "/projects/holaf-lib" },
      { name: "absent", rootPath: "/tmp/nope" },
    ];
    expect(resolveLinkedTargets(INDEXED, subs)).toEqual([
      { name: "holaf-lib", project: "projects-holaf-lib" },
      { name: "AI-Helper", project: "projects-AI-Helper" },
    ]);
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
