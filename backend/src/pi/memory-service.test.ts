/**
 * memory-service.test.ts — nouvelles clés de dossier mémoire (BUG-02).
 *
 * Vérifie la règle hybride "slug-<12 hex sha256(chemin absolu)>" :
 *  - stabilité et format ;
 *  - fin des collisions (a-b vs a_b, basename long borné, repli « project ») ;
 *  - non-collision avec la mémoire globale "_global_" ;
 *  - NON-DIVERGENCE avec l'extension compaction-checkpoint (getProjectName DOIT
 *    produire exactement la même clé, sinon deux dossiers mémoire distincts).
 *
 * Aucune écriture disque réelle : HOME est redirigé vers un dossier temporaire
 * AVANT l'import du module (MEMORY_ROOT est calculé au chargement du module).
 */
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let tmpHome: string;
let originalHome: string | undefined;
let svc: typeof import("./memory-service.js");
// Import VOLONTAIREMENT par spécificateur variable : évite que tsc backend
// enrôle le fichier d'extension (hors rootDir) dans son programme.
let ext: { getProjectName: (cwd: string) => string };

beforeAll(async () => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "pi-memory-service-"));
  process.env.HOME = tmpHome;
  // HOME est posé AVANT le premier import → MEMORY_ROOT pointe vers le tmp.
  vi.resetModules();
  svc = await import("./memory-service.js");
  // Chemin ABSOLU : un spécificateur relatif serait résolu depuis la racine du
  // projet Vitest, pas depuis ce fichier.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const extPath = path.resolve(here, "../../../extensions/compaction-checkpoint/index.ts");
  ext = (await import(extPath)) as { getProjectName: (cwd: string) => string };
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // nettoyage best-effort
  }
});

const HASH_SUFFIX = /^[\w]+-[0-9a-f]{12}$/;

describe("getProjectDirName — règle hybride", () => {
  it("a un format slug + empreinte 12 hex et reste stable", () => {
    const name = svc.getProjectDirName("/projects/monprojet");
    expect(name).toMatch(HASH_SUFFIX);
    expect(svc.getProjectDirName("/projects/monprojet")).toBe(name);
  });

  it("ne collisionne plus entre /projects/a-b et /projects/a_b", () => {
    const dashed = svc.getProjectDirName("/projects/a-b");
    const underscored = svc.getProjectDirName("/projects/a_b");
    expect(dashed).not.toBe(underscored);
    // Le slug redevient identique, c'est l'empreinte qui distingue.
    expect(dashed.startsWith("a_b-")).toBe(true);
    expect(underscored.startsWith("a_b-")).toBe(true);
  });

  it("utilise le basename (chemin imbriqué) et borne le slug à 40 chars", () => {
    expect(svc.getProjectDirName("/x/a/b")).toMatch(/^b-[0-9a-f]{12}$/);
    const longName = svc.getProjectDirName("/" + "z".repeat(100));
    const slug = longName.split("-")[0];
    expect(slug).toBe("z".repeat(40));
    expect(longName).toMatch(HASH_SUFFIX);
  });

  it("replie sur \"project\" quand le basename est vide (ex. racine)", () => {
    expect(svc.getProjectDirName("/")).toMatch(/^project-[0-9a-f]{12}$/);
  });

  it("élimine la collision avec la mémoire globale (\"_global_\" reste sans suffixe)", () => {
    const project = svc.getProjectDirName("/projets/_global_");
    expect(project).not.toBe("_global_");
    expect(project).toMatch(/^_global_-[0-9a-f]{12}$/);
    // getGlobalMemoryDir reste inchangé.
    expect(svc.getGlobalMemoryDir()).toBe(path.join(tmpHome, ".unipi", "memory", "_global_"));
  });

  it("getProjectMemoryDir combine MEMORY_ROOT et la clé", () => {
    const cwd = "/projects/autre";
    expect(svc.getProjectMemoryDir(cwd)).toBe(
      path.join(tmpHome, ".unipi", "memory", svc.getProjectDirName(cwd))
    );
  });
});

describe("non-divergence service ↔ extension compaction-checkpoint", () => {
  it("produit EXACTEMENT la même clé que getProjectName", () => {
    const cases = [
      "/projects/a-b",
      "/projects/a_b",
      "/projets/_global_",
      "/",
      "/x/y/z/projet avec espaces",
      "/tmp/projet.avec.points",
    ];
    for (const cwd of cases) {
      expect(svc.getProjectDirName(cwd)).toBe(ext.getProjectName(cwd));
    }
  });
});
