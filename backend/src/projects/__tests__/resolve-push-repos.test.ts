/**
 * Tests unitaires de la résolution des cibles de commit+push.
 *
 * Contrat clé du GitPanel : pousser un SOUS-PROJET ≠ pousser le GROUPE.
 *   - un projet normal / sous-projet local → sa résolution vaut [lui-même] :
 *     le backend ne pousse QUE son dépôt (son cwd), jamais le groupe ;
 *   - un placeholder LIÉ (storage === "linked") → la liste de SES sous-projets
 *     locaux (mode agrégateur, utilisé par le bouton « Push All ») ;
 *     les sous-projets n'existant plus / non-locaux sont exclus.
 *
 * On contrôle loadProjects() en écrivant temporairement une fixture dans
 * .data/projects.json (restaurée après chaque test), façon isolée du disque.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolvePushRepos, type Project } from "../manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_FILE = path.join(__dirname, "..", "..", "..", "..", ".data", "projects.json");

let original: string;
const now = new Date().toISOString();

const subA: Project = {
  id: "subA", name: "Alpha", storage: "local", versioning: "git",
  cwd: "/projects/SubAlpha", createdAt: now, updatedAt: now,
};
const subB: Project = {
  id: "subB", name: "Beta", storage: "local", versioning: "git",
  cwd: "/projects/SubBeta", createdAt: now, updatedAt: now,
};
// Sous-projet SMB : le mode agrégateur linked ne pousse QUE les locaux.
const subSMB: Project = {
  id: "subSMB", name: "SmbSub", storage: "smb", versioning: "git",
  cwd: "/projects/SmbSub", smb: { share: "//share/s", mountPoint: "/mnt/smb/s", username: "u" },
  createdAt: now, updatedAt: now,
};
// id référencé mais inexistant dans projects.json → exclu.
const group: Project = {
  id: "grp", name: "Group", storage: "linked", versioning: "standalone",
  cwd: "/projects/Group", linkedProjectIds: ["subA", "subB", "subSMB", "ghost"],
  createdAt: now, updatedAt: now,
};

beforeEach(() => {
  original = fs.existsSync(PROJECTS_FILE) ? fs.readFileSync(PROJECTS_FILE, "utf-8") : "[]";
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify([group, subA, subB, subSMB], null, 2), "utf-8");
});

afterEach(() => {
  fs.writeFileSync(PROJECTS_FILE, original, "utf-8");
});

describe("resolvePushRepos — push d'un sous-projet ≠ push du groupe", () => {
  it("projet local simple → résolution [lui-même] (push de SEUL son cwd)", () => {
    const target = resolvePushRepos(subA);
    expect(target.map((p) => p.id)).toEqual(["subA"]);
  });

  it("placeholder LIÉ → résout SES sous-projets locaux (mode agrégateur)", () => {
    const target = resolvePushRepos(group);
    // Alpha + Beta : locaux ; SmbSub exclu (non-local) ; ghost exclu (introuvable).
    expect(target.map((p) => p.id).sort()).toEqual(["subA", "subB"]);
  });

  it("placeholder LIÉ sans lien → résolution vide", () => {
    const emptyGroup: Project = {
      ...group, linkedProjectIds: [],
    };
    expect(resolvePushRepos(emptyGroup)).toEqual([]);
  });

  it("ne confond jamais un sous-projet avec le placeholder (id distincts)", () => {
    // Si le frontend passait par erreur le placeholder pour un push individuel,
    // on obtiendrait le groupe. Un sous-projet donne toujours [lui-même].
    const one = resolvePushRepos(subB);
    const groupTargets = resolvePushRepos(group);
    expect(one[0].id).toBe("subB");
    expect(groupTargets.some((p) => p.id === "subB")).toBe(true);
  });
});
