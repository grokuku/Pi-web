/**
 * skills-store.test.ts — tests du stockage des skills du panneau SKILLS
 * (backend/src/pi/skills-store.ts).
 *
 * Tout se passe dans des dossiers TEMPORAIRES (le vrai ~/.pi/agent/skills et le
 * vrai dépôt ne sont jamais touchés) : chaque test injecte `skillsDir`,
 * `bundledDir` et `ecosystemDirs` dans les options du store.
 *
 * Couvre :
 *  - validation des noms (spec Agent Skills + anti-traversée de chemin) ;
 *  - parse du front-matter (guillemets, blocs `|`/`>`, absent) ;
 *  - statuts : livrée / écosystème / générée (verrouillée) / personnelle, et
 *    détection « modifiée » par empreinte d'arbre ;
 *  - état activé/désactivé dérivé de settings.skills (`!<nom>`) ;
 *  - écriture atomique + refus (générée, front-matter invalide, name mismatch) ;
 *  - restauration depuis la référence (livrée/écosystème) et refus sans référence ;
 *  - création (front-matter généré, doublons, validation).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createSkill,
  findSkillReference,
  hashSkillDir,
  isInsideDir,
  isSkillEnabled,
  listSkills,
  parseSkillFrontMatter,
  readSkill,
  restoreSkill,
  validateSkillName,
  writeSkill,
  type SkillsStoreOptions,
} from "./skills-store.js";

// ── Bac à sable ─────────────────────────────────────────

const tmpRoots: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "piweb-skills-store-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Écrit une fiche de skill dans `root/<name>/SKILL.md` (retourne le dossier). */
function writeSkillFile(
  root: string,
  name: string,
  { description = `description de ${name}`, body = "corps de la fiche", extra = "" } = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${description}"\n${extra}---\n\n${body}\n`,
  );
  return dir;
}

/** Environnement isolé : skills installées + livrées + écosystème. */
function makeEnv(): {
  opts: SkillsStoreOptions & { skillsDir: string; bundledDir: string; ecosystemDirs: string[] };
  skillsDir: string;
  bundledDir: string;
  ecosystemDir: string;
} {
  const root = makeTmpDir();
  const skillsDir = join(root, "installed");
  const bundledDir = join(root, "bundled");
  const ecosystemDir = join(root, "ecosystem");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(bundledDir, { recursive: true });
  mkdirSync(ecosystemDir, { recursive: true });
  return { opts: { skillsDir, bundledDir, ecosystemDirs: [ecosystemDir] }, skillsDir, bundledDir, ecosystemDir };
}

// ── Validation des noms ─────────────────────────────────

describe("validateSkillName", () => {
  it("accepte les noms du spec (minuscules, chiffres, tirets simples)", () => {
    for (const name of ["pi-web-ui", "a1", "codebase-memory", "x"]) {
      const res = validateSkillName(name);
      expect(res.ok, name).toBe(true);
      if (res.ok) expect(res.value).toBe(name);
    }
  });

  it("rejette les traversées de chemin et les noms hors spec", () => {
    const invalid = ["", "  ", "../evil", "a/b", "/etc/passwd", "A", "Été", ".", "..", "-a", "a-", "a--b", "a b", "a_1"];
    for (const name of invalid) {
      const res = validateSkillName(name);
      expect(res.ok, `devrait être refusé : ${JSON.stringify(name)}`).toBe(false);
      if (!res.ok) expect(res.code).toBe("invalid-name");
    }
  });

  it("rejette un nom de plus de 64 caractères", () => {
    const res = validateSkillName("a".repeat(65));
    expect(res.ok).toBe(false);
  });

  it("isInsideDir confine un candidat sous une racine", () => {
    expect(isInsideDir("/tmp/skills", "/tmp/skills/abc")).toBe(true);
    expect(isInsideDir("/tmp/skills", "/tmp/skills/../evil")).toBe(false);
    expect(isInsideDir("/tmp/skills", "/tmp/skills")).toBe(false);
  });
});

// ── Front-matter ────────────────────────────────────────

describe("parseSkillFrontMatter", () => {
  it("lit name et description entre guillemets doubles (avec échappements YAML)", () => {
    const fm = parseSkillFrontMatter('---\nname: demo\ndescription: "Il dit \\"oui\\" fort"\n---\n\ncorps');
    expect(fm.hasFrontMatter).toBe(true);
    expect(fm.name).toBe("demo");
    expect(fm.description).toBe('Il dit "oui" fort');
  });

  it("lit une description en guillemets simples", () => {
    const fm = parseSkillFrontMatter("---\nname: demo\ndescription: 'l''essentiel'\n---\n");
    expect(fm.description).toBe("l'essentiel");
  });

  it("lit les scalaires de bloc « > » (fusionné) et « | » (lignes)", () => {
    const folded = parseSkillFrontMatter("---\nname: demo\ndescription: >\n  première ligne\n  seconde ligne\n---\n");
    expect(folded.description).toBe("première ligne seconde ligne");
    const literal = parseSkillFrontMatter("---\nname: demo\ndescription: |\n  ligne 1\n  ligne 2\n---\n");
    expect(literal.description).toBe("ligne 1\nligne 2");
  });

  it("signale l'absence de front-matter (et un bloc non fermé)", () => {
    expect(parseSkillFrontMatter("juste du texte").hasFrontMatter).toBe(false);
    expect(parseSkillFrontMatter("---\nname: demo\n").hasFrontMatter).toBe(false);
  });
});

// ── Statuts + état activé ───────────────────────────────

describe("listSkills — statuts et détection « modifiée »", () => {
  it("distingue livrée, écosystème, générée et personnelle ; signale les fiches modifiées", () => {
    const { opts, skillsDir, bundledDir, ecosystemDir } = makeEnv();
    // Livrée intacte : copie identique à la référence.
    writeSkillFile(bundledDir, "pi-web-ui");
    writeSkillFile(skillsDir, "pi-web-ui");
    // Livrée modifiée : description divergente côté copie installée.
    writeSkillFile(bundledDir, "pi-web-cbm");
    writeSkillFile(skillsDir, "pi-web-cbm", { description: "version personnalisée" });
    // Écosystème.
    writeSkillFile(ecosystemDir, "holaf-briques");
    writeSkillFile(skillsDir, "holaf-briques");
    // Générée (binaire CBM).
    writeSkillFile(skillsDir, "codebase-memory");
    // Personnelle (aucune référence).
    writeSkillFile(skillsDir, "ma-skill");
    // Dossier sans SKILL.md : ignoré.
    mkdirSync(join(skillsDir, "sans-fiche"));

    const skills = listSkills(opts);
    expect(skills.map((s) => s.name)).toEqual(["codebase-memory", "holaf-briques", "ma-skill", "pi-web-cbm", "pi-web-ui"]);

    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get("pi-web-ui")).toMatchObject({ status: "bundled", modified: false, editable: true });
    expect(byName.get("pi-web-cbm")).toMatchObject({ status: "bundled", modified: true, editable: true });
    expect(byName.get("holaf-briques")).toMatchObject({ status: "ecosystem", modified: false });
    expect(byName.get("codebase-memory")).toMatchObject({ status: "generated", editable: false, reference: null });
    expect(byName.get("ma-skill")).toMatchObject({ status: "custom", modified: false, reference: null });
  });

  it("signale une fiche au front-matter invalide sans casser la liste", () => {
    const { opts, skillsDir } = makeEnv();
    mkdirSync(join(skillsDir, "casse"), { recursive: true });
    writeFileSync(join(skillsDir, "casse", "SKILL.md"), "pas de front-matter");
    const [entry] = listSkills(opts);
    expect(entry.name).toBe("casse");
    expect(entry.invalid).toMatch(/front-matter/);
  });

  it("retourne une liste vide si le dossier des skills n'existe pas", () => {
    const { opts, skillsDir } = makeEnv();
    rmSync(skillsDir, { recursive: true, force: true });
    expect(listSkills(opts)).toEqual([]);
  });

  it("findSkillReference résout livrée puis écosystème, sinon null", () => {
    const { opts, bundledDir, ecosystemDir } = makeEnv();
    writeSkillFile(bundledDir, "pi-web-ui");
    writeSkillFile(ecosystemDir, "holaf-briques");
    expect(findSkillReference("pi-web-ui", opts)).toMatchObject({ kind: "bundled" });
    expect(findSkillReference("holaf-briques", opts)).toMatchObject({ kind: "ecosystem" });
    expect(findSkillReference("inconnue", opts)).toBeNull();
  });
});

describe("isSkillEnabled", () => {
  it("désactivée seulement avec un motif !<nom> ou -<nom>", () => {
    expect(isSkillEnabled([], "pi-web-ui")).toBe(true);
    expect(isSkillEnabled(["pi-web-ui"], "pi-web-ui")).toBe(true);
    expect(isSkillEnabled(["!pi-web-ui"], "pi-web-ui")).toBe(false);
    expect(isSkillEnabled(["-pi-web-ui"], "pi-web-ui")).toBe(false);
    expect(isSkillEnabled(["!autre"], "pi-web-ui")).toBe(true);
    expect(isSkillEnabled(undefined, "pi-web-ui")).toBe(true);
  });
});

// ── Lecture / écriture ──────────────────────────────────

describe("readSkill", () => {
  it("lit la fiche et la référence (contenu livré) pour comparaison", () => {
    const { opts, skillsDir, bundledDir } = makeEnv();
    writeSkillFile(bundledDir, "pi-web-ui");
    writeSkillFile(skillsDir, "pi-web-ui", { description: "ma version" });
    const res = readSkill("pi-web-ui", opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.entry.modified).toBe(true);
    expect(res.value.content).toContain("ma version");
    expect(res.value.referenceContent).toContain("description de pi-web-ui");
  });

  it("refuse un nom invalide et une skill absente", () => {
    const { opts } = makeEnv();
    expect(readSkill("../evil", opts)).toMatchObject({ ok: false, code: "invalid-name" });
    expect(readSkill("inconnue", opts)).toMatchObject({ ok: false, code: "not-found" });
  });
});

describe("writeSkill", () => {
  it("écrit la fiche de façon atomique (tmp consommé) et rend le détail à jour", () => {
    const { opts, skillsDir } = makeEnv();
    writeSkillFile(skillsDir, "ma-skill");
    const next = '---\nname: ma-skill\ndescription: "après édition"\n---\n\nnouveau corps\n';
    const res = writeSkill("ma-skill", next, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readFileSync(join(skillsDir, "ma-skill", "SKILL.md"), "utf-8")).toBe(next);
    expect(res.value.entry.description).toBe("après édition");
    const leftovers = readdirSync(join(skillsDir, "ma-skill")) as string[];
    expect(leftovers.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("refuse l'édition d'une skill générée (verrouillée)", () => {
    const { opts, skillsDir } = makeEnv();
    writeSkillFile(skillsDir, "codebase-memory");
    const res = writeSkill("codebase-memory", '---\nname: codebase-memory\ndescription: "x"\n---\n', opts);
    expect(res).toMatchObject({ ok: false, code: "generated" });
    // Le fichier n'a pas bougé.
    expect(readFileSync(join(skillsDir, "codebase-memory", "SKILL.md"), "utf-8")).toContain("codebase-memory");
  });

  it("refuse les contenus invalides (nom, front-matter, description, taille)", () => {
    const { opts, skillsDir } = makeEnv();
    writeSkillFile(skillsDir, "ma-skill");
    expect(writeSkill("../evil", "x", opts)).toMatchObject({ ok: false, code: "invalid-name" });
    expect(writeSkill("ma-skill", "pas de front-matter", opts)).toMatchObject({ ok: false, code: "invalid-content" });
    expect(writeSkill("ma-skill", "---\ndescription: \"x\"\n---\n", opts)).toMatchObject({ ok: false, code: "invalid-content" });
    expect(writeSkill("ma-skill", '---\nname: autre\ndescription: "x"\n---\n', opts)).toMatchObject({ ok: false, code: "invalid-content" });
    expect(writeSkill("ma-skill", '---\nname: ma-skill\n---\n', opts)).toMatchObject({ ok: false, code: "invalid-content" });
    expect(
      writeSkill("ma-skill", `---\nname: ma-skill\ndescription: "${"d".repeat(1025)}"\n---\n`, opts),
    ).toMatchObject({ ok: false, code: "invalid-content" });
    expect(writeSkill("ma-skill", "---\nname: ma-skill\ndescription: \"x\"\n---\n" + "a".repeat(200 * 1024), opts)).toMatchObject({
      ok: false,
      code: "invalid-content",
    });
    // Skill inexistante.
    expect(writeSkill("inconnue", '---\nname: inconnue\ndescription: "x"\n---\n', opts)).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });
});

// ── Restauration ────────────────────────────────────────

describe("restoreSkill", () => {
  it("remplace la copie locale par la version livrée (modifiée → intacte)", () => {
    const { opts, skillsDir, bundledDir } = makeEnv();
    writeSkillFile(bundledDir, "pi-web-ui", { body: "version livrée" });
    writeSkillFile(skillsDir, "pi-web-ui", { body: "version personnalisée" });
    const res = restoreSkill("pi-web-ui", opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.entry.modified).toBe(false);
    expect(readFileSync(join(skillsDir, "pi-web-ui", "SKILL.md"), "utf-8")).toContain("version livrée");
  });

  it("restaure aussi une skill d'écosystème depuis sa racine", () => {
    const { opts, skillsDir, ecosystemDir } = makeEnv();
    writeSkillFile(ecosystemDir, "holaf-briques", { body: "origine holaf" });
    writeSkillFile(skillsDir, "holaf-briques", { body: "copie retouchée" });
    const res = restoreSkill("holaf-briques", opts);
    expect(res.ok).toBe(true);
    if (res.ok) expect(readFileSync(join(skillsDir, "holaf-briques", "SKILL.md"), "utf-8")).toContain("origine holaf");
  });

  it("refuse une skill sans référence (personnelle ou générée)", () => {
    const { opts, skillsDir } = makeEnv();
    writeSkillFile(skillsDir, "ma-skill");
    writeSkillFile(skillsDir, "codebase-memory");
    expect(restoreSkill("ma-skill", opts)).toMatchObject({ ok: false, code: "no-reference" });
    expect(restoreSkill("codebase-memory", opts)).toMatchObject({ ok: false, code: "no-reference" });
  });
});

// ── Création ────────────────────────────────────────────

describe("createSkill", () => {
  it("crée le dossier + SKILL.md avec un front-matter conforme", () => {
    const { opts, skillsDir } = makeEnv();
    const res = createSkill("ma-nouvelle", 'Pour "tester" la création', opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.entry).toMatchObject({ name: "ma-nouvelle", status: "custom", modified: false });
    const raw = readFileSync(join(skillsDir, "ma-nouvelle", "SKILL.md"), "utf-8");
    expect(raw).toContain("name: ma-nouvelle");
    expect(raw).toContain('description: "Pour \\"tester\\" la création"');
    // Relisible et listée.
    expect(readSkill("ma-nouvelle", opts).ok).toBe(true);
    expect(listSkills(opts).map((s) => s.name)).toContain("ma-nouvelle");
  });

  it("refuse les doublons (installée ou livrée), les noms invalides et les descriptions vides", () => {
    const { opts, skillsDir, bundledDir } = makeEnv();
    writeSkillFile(skillsDir, "existante");
    writeSkillFile(bundledDir, "pi-web-ui");
    expect(createSkill("existante", "d", opts)).toMatchObject({ ok: false, code: "already-exists" });
    expect(createSkill("pi-web-ui", "d", opts)).toMatchObject({ ok: false, code: "already-exists" });
    expect(createSkill("../evil", "d", opts)).toMatchObject({ ok: false, code: "invalid-name" });
    expect(createSkill("valide", "   ", opts)).toMatchObject({ ok: false, code: "invalid-content" });
  });
});

// ── Empreinte ───────────────────────────────────────────

describe("hashSkillDir", () => {
  it("stable pour deux dossiers identiques, différente après modification", () => {
    const { skillsDir, bundledDir } = makeEnv();
    writeSkillFile(bundledDir, "x");
    writeSkillFile(skillsDir, "x");
    expect(hashSkillDir(join(bundledDir, "x"))).toBe(hashSkillDir(join(skillsDir, "x")));
    writeFileSync(join(skillsDir, "x", "extra.md"), "asset");
    expect(hashSkillDir(join(skillsDir, "x"))).not.toBe(hashSkillDir(join(bundledDir, "x")));
    expect(hashSkillDir(join(bundledDir, "absent"))).toBeNull();
  });
});
