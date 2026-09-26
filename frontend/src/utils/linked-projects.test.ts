import { describe, it, expect } from "vitest";
import { buildLinkCandidates, countLinkedGroups, isLinkableStorage } from "./linked-projects";
import type { Project } from "../types";

// ── Tests de buildLinkCandidates ──────────────────────────────────────────
// Scénario RÉEL (bug signalé) : holaf-lib appartient déjà à DEUX projets liés
// (« Linked Homy et libs » et « Yuki and Libs »). Il doit rester proposable
// pour un autre groupe — le backend ne limite QUE les doublons du groupe
// courant et l'imbrication (manager.ts:validateLinkedProject).

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    storage: "local",
    versioning: "standalone",
    cwd: `/projects/${overrides.name}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Fixture alignée sur /app/.data/projects.json (ids réels tronqués).
const holafLib = makeProject({ id: "2138ac12", name: "holaf-lib" });
const homy = makeProject({ id: "0cacb405", name: "Homy" });
const yuki = makeProject({ id: "13798040", name: "Yuki" });
const smbProject = makeProject({ id: "smb-1", name: "nas-share", storage: "smb", cwd: "/mnt/nas/proj" });
const sshProject = makeProject({ id: "ssh-1", name: "remote-box", storage: "ssh", cwd: "/srv/remote" });

const linkedHomyEtLibs = makeProject({
  id: "e400d0eb",
  name: "Linked Homy et libs",
  storage: "linked",
  cwd: "/projects/Linked Homy et libs",
  linkedProjectIds: [homy.id, holafLib.id],
});
const yukiAndLibs = makeProject({
  id: "7bca3b30",
  name: "Yuki and Libs",
  storage: "linked",
  cwd: "/projects/Yuki and Libs",
  linkedProjectIds: [yuki.id, holafLib.id],
});
// Groupe cible du bug : ne contient PAS holaf-lib (ex. « LINKED AI Helper »).
const targetGroup = makeProject({
  id: "7b4de4d8",
  name: "LINKED AI Helper",
  storage: "linked",
  cwd: "/projects/LINKED AI Helper",
  linkedProjectIds: [makeProject({ id: "c73f00df", name: "AI-Helper" }).id, makeProject({ id: "8bca5f32", name: "ComfyUI-AI-Helper" }).id],
});

const allProjects = [homy, holafLib, yuki, smbProject, sshProject, linkedHomyEtLibs, yukiAndLibs, targetGroup];

describe("isLinkableStorage", () => {
  it("accepte local et smb, refuse ssh et linked (contrainte backend)", () => {
    expect(isLinkableStorage("local")).toBe(true);
    expect(isLinkableStorage("smb")).toBe(true);
    expect(isLinkableStorage("ssh")).toBe(false);
    expect(isLinkableStorage("linked")).toBe(false);
  });
});

describe("buildLinkCandidates", () => {
  it("propose holaf-lib (déjà membre de 2 AUTRES groupes) pour un groupe qui ne le contient pas encore", () => {
    const candidates = buildLinkCandidates(targetGroup, allProjects);
    const holaf = candidates.find((c) => c.project.id === holafLib.id);
    // Régression du bug : holaf-lib disparaissait car déjà lié ailleurs.
    expect(holaf).toBeDefined();
    expect(holaf?.linkedGroupCount).toBe(2);
  });

  it("n'exclut pas un projet deux fois lié ailleurs (multi-appartenance autorisée)", () => {
    const thirdGroup = makeProject({
      id: "grp-3",
      name: "Third group",
      storage: "linked",
      cwd: "/projects/Third group",
      linkedProjectIds: [homy.id, yuki.id],
    });
    const projects = [...allProjects, thirdGroup];
    const holaf = buildLinkCandidates(thirdGroup, projects).find((c) => c.project.id === holafLib.id);
    expect(holaf).toBeDefined();
    expect(holaf?.linkedGroupCount).toBe(2);
  });

  it("lit l'appartenance au groupe courant dans les données FRAÎCHES (instantané périmé ignoré)", () => {
    // Le prop group est périmé (aucun lien) mais la liste fraîche connaît les membres.
    const staleGroup = makeProject({
      id: linkedHomyEtLibs.id,
      name: linkedHomyEtLibs.name,
      storage: "linked",
      cwd: linkedHomyEtLibs.cwd,
      linkedProjectIds: [],
    });
    const ids = buildLinkCandidates(staleGroup, allProjects).map((c) => c.project.id);
    expect(ids).not.toContain(homy.id);
    expect(ids).not.toContain(holafLib.id);
  });

  it("exclut les membres du groupe COURANT (pas de doublon dans le même groupe)", () => {
    const ids = buildLinkCandidates(linkedHomyEtLibs, allProjects).map((c) => c.project.id);
    expect(ids).not.toContain(homy.id);
    expect(ids).not.toContain(holafLib.id); // déjà membre de CE groupe
    expect(ids).toContain(yuki.id);         // membre d'un AUTRE groupe → proposable
  });

  it("exclut le projet lui-même (auto-lien interdit)", () => {
    const ids = buildLinkCandidates(linkedHomyEtLibs, allProjects).map((c) => c.project.id);
    expect(ids).not.toContain(linkedHomyEtLibs.id);
  });

  it("exclut les placeholders (pas d'imbrication → pas de cycle) et les projets ssh", () => {
    const ids = buildLinkCandidates(linkedHomyEtLibs, allProjects).map((c) => c.project.id);
    expect(ids).not.toContain(yukiAndLibs.id); // autre projet lié
    expect(ids).not.toContain(targetGroup.id); // autre projet lié
    expect(ids).not.toContain(sshProject.id);  // ssh non éligible
  });

  it("conserve les projets SMB montés", () => {
    const ids = buildLinkCandidates(linkedHomyEtLibs, allProjects).map((c) => c.project.id);
    expect(ids).toContain(smbProject.id);
  });

  it("ne propose jamais un doublon (chaque projet au plus une fois)", () => {
    const candidates = buildLinkCandidates(linkedHomyEtLibs, allProjects);
    const ids = candidates.map((c) => c.project.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildLinkCandidates — filtre « masquer les projets déjà liés »", () => {
  it("hideAlreadyLinked=true exclut les projets membres d'un AUTRE groupe", () => {
    const hiddenIds = buildLinkCandidates(targetGroup, allProjects, true).map((c) => c.project.id);
    expect(hiddenIds).not.toContain(holafLib.id); // membre de 2 autres groupes
    // Décochée (false) : les mêmes projets restent proposés (comportement historique).
    const visibleIds = buildLinkCandidates(targetGroup, allProjects, false).map((c) => c.project.id);
    expect(visibleIds).toContain(holafLib.id);
  });

  it("hideAlreadyLinked=false propose le projet déjà lié ailleurs AVEC son compte de groupes", () => {
    const holaf = buildLinkCandidates(targetGroup, allProjects, false).find((c) => c.project.id === holafLib.id);
    expect(holaf).toBeDefined();
    expect(holaf?.linkedGroupCount).toBe(2);
    // Le candidat masqué ne doit plus apparaître du tout quand la case est cochée.
    expect(buildLinkCandidates(targetGroup, allProjects, true).some((c) => c.project.id === holafLib.id)).toBe(false);
  });

  it("les exclusions invariantes restent vraies quel que soit le paramètre", () => {
    for (const hideAlreadyLinked of [true, false]) {
      const ids = buildLinkCandidates(linkedHomyEtLibs, allProjects, hideAlreadyLinked).map((c) => c.project.id);
      expect(ids).not.toContain(linkedHomyEtLibs.id); // le groupe lui-même (auto-lien)
      expect(ids).not.toContain(homy.id);             // membre du groupe COURANT
      expect(ids).not.toContain(holafLib.id);         // membre du groupe COURANT
      expect(ids).not.toContain(yukiAndLibs.id);      // placeholder (pas d'imbrication)
      expect(ids).not.toContain(targetGroup.id);      // placeholder (pas d'imbrication)
      expect(ids).not.toContain(sshProject.id);       // stockage ssh non éligible
      expect(ids).toContain(smbProject.id);           // SMB monté toujours éligible
    }
  });
});

describe("countLinkedGroups", () => {
  it("compte les groupes contenant le projet, en excluant le groupe courant", () => {
    const projects = [linkedHomyEtLibs, yukiAndLibs];
    expect(countLinkedGroups(holafLib.id, projects)).toBe(2);
    expect(countLinkedGroups(holafLib.id, projects, yukiAndLibs.id)).toBe(1);
    expect(countLinkedGroups(yuki.id, projects, yukiAndLibs.id)).toBe(0);
  });

  it("renvoie 0 pour un projet non lié", () => {
    expect(countLinkedGroups(sshProject.id, [linkedHomyEtLibs, yukiAndLibs])).toBe(0);
  });
});
