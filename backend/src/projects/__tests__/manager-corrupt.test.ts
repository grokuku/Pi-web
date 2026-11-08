/**
 * B5 (intégrité) — `projects.json` : écriture atomique, et REFUS de repartir
 * sur une liste vide quand le fichier existe mais est illisible.
 *
 * Avant : `loadProjects()` loguait « Failed to load projects file, starting
 * fresh » puis renvoyait `[]` → l'app affichait « aucun projet » et le premier
 * enregistrement suivant écrasait DÉFINITIVEMENT le fichier de l'utilisateur.
 *
 * `fs` n'est intercepté QUE pour `projects.json`.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { StorageCorruptError } from "../../utils/atomic-store.js";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const p = await import("path");
  const isProjectsFile = (candidate: unknown): boolean =>
    typeof candidate === "string" && candidate.endsWith(p.join(".data", "projects.json"));
  return {
    ...actual,
    readFileSync: ((candidate: any, ...rest: any[]) =>
      isProjectsFile(candidate)
        ? '[{ "id": "p1", "name": "demo"'
        : (actual.readFileSync as any)(candidate, ...rest)) as typeof actual.readFileSync,
  };
});

const { getAllProjects } = await import("../manager.js");

describe("manager — projects.json corrompu : erreur claire, jamais une liste vide", () => {
  it("getAllProjects() lève StorageCorruptError (503 STORAGE_CORRUPT)", () => {
    let caught: any;
    try {
      getAllProjects();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageCorruptError);
    expect(caught.status).toBe(503);
    expect(caught.code).toBe("STORAGE_CORRUPT");
    expect(caught.message).toContain("projects.json");
  });

  it("ne renvoie jamais `[]` sur un fichier existant mais illisible", () => {
    // Garde-fou : si le bug revenait, getAllProjects() rendrait [] (pas de throw).
    expect(() => getAllProjects()).toThrow(StorageCorruptError);
  });
});

describe("manager — écriture atomique (tmp + rename)", () => {
  it("saveProjects passe par writeFileAtomicSync, plus par writeFileSync direct", () => {
    const src = readFileSync(fileURLToPath(new URL("../manager.ts", import.meta.url)), "utf-8");
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/?\*)/.test(line))
      .join("\n");
    expect(code).toContain("writeFileAtomicSync(PROJECTS_FILE");
    expect(code).not.toMatch(/writeFileSync\(\s*PROJECTS_FILE/);
  });

  it("loadProjects ne contient plus de repli silencieux sur []", () => {
    const src = readFileSync(fileURLToPath(new URL("../manager.ts", import.meta.url)), "utf-8");
    expect(src).not.toContain("Failed to load projects file, starting fresh");
    expect(src).toContain("readStateJson(PROJECTS_FILE)");
  });
});
