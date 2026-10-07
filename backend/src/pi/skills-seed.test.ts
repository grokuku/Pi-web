/**
 * skills-seed.test.ts — tests du seed « seulement si absent » des skills
 * maison livrées avec Pi-Web (backend/src/pi/skills-seed.ts).
 *
 * Couvre :
 *  - listBundledSkills : seuls les dossiers contenant un SKILL.md comptent
 *    (fichiers, dossiers cachés et dossiers incomplets ignorés ; source
 *    absente → liste vide) ;
 *  - selectSkillsToSeed : décision pure (livrées non présentes dans la cible) ;
 *  - seedBundledSkills : installation dans une cible vide avec contenu
 *    identique, JAMAIS d'écrasement d'une copie locale (modifiée ou non),
 *    idempotence (2e passage sans copie), best-effort (source absente → no-op,
 *    cible illisible → failed sans exception).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  defaultAgentSkillsDir,
  listBundledSkills,
  seedBundledSkills,
  selectSkillsToSeed,
} from "./skills-seed.js";

// ── Bac à sable ─────────────────────────────────────────

const tmpRoots: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "piweb-skills-seed-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Écrit une fiche de skill minimale (format Agent Skills) dans `root/<name>/SKILL.md`. */
function writeSkill(root: string, name: string, body = "corps de la fiche"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "description de test"\n---\n\n${body}\n`);
  return dir;
}

// ── Découverte des fiches livrées ───────────────────────

describe("listBundledSkills", () => {
  it("ne retient que les dossiers contenant un SKILL.md (fichiers et entrées cachées ignorés)", () => {
    const source = makeTmpDir();
    writeSkill(source, "holaf-a");
    writeSkill(source, "holaf-b");
    mkdirSync(join(source, "sans-fiche")); // dossier sans SKILL.md
    writeFileSync(join(source, "readme.md"), "pas une skill");
    mkdirSync(join(source, ".cache"));
    writeFileSync(join(source, ".cache", "SKILL.md"), "---\nname: cachée\n---");
    expect(listBundledSkills(source)).toEqual(["holaf-a", "holaf-b"]);
  });

  it("source absente → liste vide (pas d'exception)", () => {
    expect(listBundledSkills(join(makeTmpDir(), "absent"))).toEqual([]);
  });
});

// ── Décision pure ──────────────────────────────────────

describe("selectSkillsToSeed", () => {
  it("garde les skills livrées absentes de la cible", () => {
    expect(selectSkillsToSeed(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });

  it("cible vide → toutes les livrées ; tout présent → aucune", () => {
    expect(selectSkillsToSeed(["a", "b"], [])).toEqual(["a", "b"]);
    expect(selectSkillsToSeed(["a", "b"], ["a", "b", "autre"])).toEqual([]);
  });
});

// ── Seed I/O ────────────────────────────────────────────

describe("seedBundledSkills", () => {
  it("installe les skills livrées dans une cible vide, contenu identique", () => {
    const source = makeTmpDir();
    writeSkill(source, "alpha", "corps alpha");
    writeSkill(source, "beta", "corps beta");
    const target = join(makeTmpDir(), "skills"); // cible inexistante au départ

    const res = seedBundledSkills({ sourceDir: source, targetDir: target });

    expect(res.copied).toEqual(["alpha", "beta"]);
    expect(res.skipped).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(readFileSync(join(target, "alpha", "SKILL.md"), "utf-8")).toBe(
      readFileSync(join(source, "alpha", "SKILL.md"), "utf-8"),
    );
    expect(readFileSync(join(target, "beta", "SKILL.md"), "utf-8")).toBe(
      readFileSync(join(source, "beta", "SKILL.md"), "utf-8"),
    );
  });

  it("idempotent : le 2e passage ne copie rien et préserve une copie locale modifiée", () => {
    const source = makeTmpDir();
    writeSkill(source, "alpha");
    writeSkill(source, "beta");
    const target = join(makeTmpDir(), "skills");

    const first = seedBundledSkills({ sourceDir: source, targetDir: target });
    expect(first.copied).toEqual(["alpha", "beta"]);

    // L'utilisateur personnalise sa copie locale de « alpha ».
    const localFiche = join(target, "alpha", "SKILL.md");
    writeFileSync(localFiche, "--- MODIFIÉ PAR L'UTILISATEUR ---\n");

    const second = seedBundledSkills({ sourceDir: source, targetDir: target });
    expect(second.copied).toEqual([]);
    expect(second.skipped).toEqual(["alpha", "beta"]);
    expect(second.failed).toEqual([]);
    // La modification locale n'a PAS été écrasée par la fiche livrée.
    expect(readFileSync(localFiche, "utf-8")).toBe("--- MODIFIÉ PAR L'UTILISATEUR ---\n");
  });

  it("copie uniquement les absentes quand la cible en contient déjà une", () => {
    const source = makeTmpDir();
    writeSkill(source, "alpha", "version livrée");
    writeSkill(source, "beta", "corps beta");
    const target = makeTmpDir();
    writeSkill(target, "alpha", "version locale personnalisée");

    const res = seedBundledSkills({ sourceDir: source, targetDir: target });

    expect(res.copied).toEqual(["beta"]);
    expect(res.skipped).toEqual(["alpha"]);
    expect(readFileSync(join(target, "alpha", "SKILL.md"), "utf-8")).toContain("version locale personnalisée");
  });

  it("source absente → no-op silencieux (cible non créée)", () => {
    const target = join(makeTmpDir(), "skills");
    const res = seedBundledSkills({ sourceDir: join(makeTmpDir(), "absent"), targetDir: target });
    expect(res.copied).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.failed).toEqual([]);
    // La cible n'a pas été créée inutilement (aucune skill à semer).
    expect(existsSync(target)).toBe(false);
  });

  it("cible illisible (fichier au lieu d'un dossier) → failed, aucun crash", () => {
    const source = makeTmpDir();
    writeSkill(source, "alpha");
    writeSkill(source, "beta");
    const bogus = join(makeTmpDir(), "pas-un-dossier");
    writeFileSync(bogus, "fichier occupant la place du dossier");

    const res = seedBundledSkills({ sourceDir: source, targetDir: bogus });

    expect(res.copied).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.failed).toEqual(["alpha", "beta"]);
  });
});

describe("defaultAgentSkillsDir", () => {
  it("vise le dossier skills global de l'agent (~/.pi/agent/skills)", () => {
    expect(defaultAgentSkillsDir()).toBe(join(homedir(), ".pi", "agent", "skills"));
  });
});
