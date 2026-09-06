import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { isCwdAllowed, isPathAllowed, getAllowedRoots } from "./path-security.js";

// Mock du gestionnaire de projets pour contrôler les cwd sans dépendre du disque.
const { getAllProjectsMock } = vi.hoisted(() => ({ getAllProjectsMock: vi.fn() }));
vi.mock("../projects/manager.js", () => ({
  getAllProjects: getAllProjectsMock,
}));

// Racine de test sous /projects (racine autorisée par défaut).
const TEST_ROOT = "/projects/__piweb_test__";
const PROJ = path.join(TEST_ROOT, "projA");

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJ, { recursive: true });
  getAllProjectsMock.mockReset();
  getAllProjectsMock.mockReturnValue([]);
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("isCwdAllowed", () => {
  it("autorise un cwd strictement sous une racine par défaut", () => {
    expect(isCwdAllowed(PROJ)).toBe(true);
  });

  it("refuse la racine elle-même (doit être strictement sous)", () => {
    expect(isCwdAllowed("/projects")).toBe(false);
  });

  it("refuse un chemin hors racines (/etc)", () => {
    expect(isCwdAllowed("/etc")).toBe(false);
  });

  it("refuse un composant sensible (.git)", () => {
    expect(isCwdAllowed(path.join(PROJ, ".git"))).toBe(false);
  });

  it("refuse un composant sensible (.env)", () => {
    expect(isCwdAllowed(path.join(PROJ, ".env"))).toBe(false);
  });

  it("neutralise la traversée ../", () => {
    expect(isCwdAllowed(path.join(PROJ, "..", "..", "..", "etc"))).toBe(false);
  });

  it("refuse un symlink pointant hors racine", () => {
    fs.symlinkSync("/etc", path.join(PROJ, "link"));
    expect(isCwdAllowed(path.join(PROJ, "link"))).toBe(false);
  });

  it("autorise un symlink pointant vers l'intérieur", () => {
    fs.mkdirSync(path.join(PROJ, "sub"));
    fs.symlinkSync(path.join(PROJ, "sub"), path.join(PROJ, "link"));
    expect(isCwdAllowed(path.join(PROJ, "link"))).toBe(true);
  });
});

describe("isPathAllowed", () => {
  it("autorise un fichier dans une racine autorisée", () => {
    expect(isPathAllowed(path.join(PROJ, "file.txt"))).toBe(true);
  });

  it("refuse un fichier hors racines (/etc/passwd)", () => {
    expect(isPathAllowed("/etc/passwd")).toBe(false);
  });

  it("refuse un composant sensible (.ssh)", () => {
    expect(isPathAllowed(path.join(PROJ, ".ssh", "id_rsa"))).toBe(false);
  });

  it("refuse un composant sensible (.env.local)", () => {
    expect(isPathAllowed(path.join(PROJ, ".env.local"))).toBe(false);
  });

  it("neutralise la traversée ../", () => {
    expect(isPathAllowed(path.join(PROJ, "..", "..", "..", "etc", "passwd"))).toBe(false);
  });

  it("traite %2e%2e comme un nom littéral (pas de décodage URL)", () => {
    // La fonction ne décode pas l'encodage URL : %2e%2e reste un nom de dossier.
    expect(isPathAllowed(path.join(PROJ, "%2e%2e", "x"))).toBe(true);
  });

  it("refuse un symlink pointant hors racine", () => {
    fs.symlinkSync("/etc/passwd", path.join(PROJ, "leak"));
    expect(isPathAllowed(path.join(PROJ, "leak"))).toBe(false);
  });

  describe("avec allowedRoot (confinement projet)", () => {
    it("autorise un fichier dans le sous-dossier confiné", () => {
      expect(isPathAllowed(path.join(PROJ, "file.txt"), PROJ)).toBe(true);
    });

    it("refuse un fichier hors du sous-dossier confiné", () => {
      const other = path.join(TEST_ROOT, "other");
      fs.mkdirSync(other, { recursive: true });
      expect(isPathAllowed(path.join(other, "file.txt"), PROJ)).toBe(false);
    });

    it("refuse si allowedRoot n'est pas un cwd valide", () => {
      expect(isPathAllowed(path.join(PROJ, "file.txt"), "/etc")).toBe(false);
    });
  });
});

describe("getAllowedRoots", () => {
  it("inclut les racines par défaut", () => {
    const roots = getAllowedRoots();
    expect(roots).toContain("/projects");
    expect(roots).toContain("/mnt/smb");
  });

  it("ajoute le cwd d'un projet valide", () => {
    getAllProjectsMock.mockReturnValue([{ cwd: PROJ } as any]);
    const roots = getAllowedRoots();
    expect(roots).toContain(PROJ);
  });

  it("ignore un projet dont le cwd est invalide (/etc)", () => {
    getAllProjectsMock.mockReturnValue([{ cwd: "/etc" } as any]);
    const roots = getAllowedRoots();
    expect(roots).not.toContain("/etc");
  });
});
