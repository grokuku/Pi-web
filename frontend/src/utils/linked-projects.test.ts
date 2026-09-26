import { describe, it, expect } from "vitest";
import {
  buildLinkCandidates,
  buildSwitcherCandidates,
  countLinkedGroups,
  isLinkedMember,
  isLinkableStorage,
  linkedMemberIds,
} from "./linked-projects";
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

// ── Sélecteur GÉNÉRAL de projets (ProjectSwitcher) ────────────────────────
// La case du sélecteur (cochée par défaut) masque les projets de base
// membres d'un groupe lié. Invariants : les projets liés eux-mêmes et le
// projet actif restent TOUJOURS listés.
describe("buildSwitcherCandidates — sélecteur général de projets", () => {
  it("hideAlreadyLinked=true retire les membres de groupes liés, mais garde les groupes liés", () => {
    const { projects: visible, hiddenCount } = buildSwitcherCandidates(allProjects, null, true);
    const ids = visible.map((p) => p.id);
    expect(ids).not.toContain(homy.id);    // membre de « Linked Homy et libs »
    expect(ids).not.toContain(holafLib.id); // membre de 2 groupes
    expect(ids).not.toContain(yuki.id);    // membre de « Yuki and Libs »
    // Les projets liés sont des entrées de premier niveau : toujours listés.
    expect(ids).toContain(linkedHomyEtLibs.id);
    expect(ids).toContain(yukiAndLibs.id);
    expect(ids).toContain(targetGroup.id);
    // Projets libres et non concernés : toujours listés.
    expect(ids).toContain(smbProject.id);
    expect(ids).toContain(sshProject.id);
    // 3 projets de la liste sont réellement membres (holaf-lib compté 1 fois).
    expect(hiddenCount).toBe(3);
  });

  it("hideAlreadyLinked=false renvoie la liste complète (même référence) et hiddenCount=0", () => {
    const { projects: visible, hiddenCount } = buildSwitcherCandidates(allProjects, null, false);
    expect(visible).toBe(allProjects);
    expect(hiddenCount).toBe(0);
  });

  it("un projet actif membre d'un groupe reste visible, case cochée comme décochée", () => {
    for (const hideAlreadyLinked of [true, false]) {
      const { projects: visible } = buildSwitcherCandidates(allProjects, holafLib.id, hideAlreadyLinked);
      expect(visible.map((p) => p.id)).toContain(holafLib.id);
    }
    // Le projet actif n'est PAS compté comme masqué (il est affiché).
    expect(buildSwitcherCandidates(allProjects, holafLib.id, true).hiddenCount).toBe(2);
  });

  it("ne masque jamais un projet de type linked, même cité dans les linkedProjectIds d'un autre", () => {
    // Donnée anormale (imbrication refusée par le backend) : la règle « les
    // projets liés sont toujours listés » prime.
    const weirdGroup = makeProject({
      id: "grp-nest",
      name: "Weird group",
      storage: "linked",
      cwd: "/projects/Weird group",
      linkedProjectIds: [linkedHomyEtLibs.id],
    });
    const { projects: visible } = buildSwitcherCandidates([...allProjects, weirdGroup], null, true);
    expect(visible.map((p) => p.id)).toContain(linkedHomyEtLibs.id);
  });

  it("préserve l'ordre d'origine de la liste", () => {
    const { projects: visible } = buildSwitcherCandidates(allProjects, null, true);
    const expected = allProjects.filter((p) => visible.includes(p)).map((p) => p.id);
    expect(visible.map((p) => p.id)).toEqual(expected);
  });
});

describe("linkedMemberIds / isLinkedMember", () => {
  it("linkedMemberIds rassemble les membres de tous les groupes, sans doublon", () => {
    const ids = linkedMemberIds(allProjects);
    expect(ids.has(homy.id)).toBe(true);
    expect(ids.has(holafLib.id)).toBe(true);   // 2 groupes → une seule entrée dans le Set
    expect(ids.has(yuki.id)).toBe(true);
    expect(ids.has(smbProject.id)).toBe(false);
    expect(ids.has(linkedHomyEtLibs.id)).toBe(false); // un groupe n'est pas membre
  });

  it("isLinkedMember répond sur un projet précis", () => {
    expect(isLinkedMember(holafLib.id, allProjects)).toBe(true);
    expect(isLinkedMember(smbProject.id, allProjects)).toBe(false);
  });
});
