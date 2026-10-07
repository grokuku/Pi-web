/**
 * skills-announce.test.ts — tests des helpers PURS de l'annonce des SKILLS
 * (mode HARNESS/ROUTING) + preuve d'intégration avec le DefaultResourceLoader.
 *
 * Couvre :
 *  - cas zéro skill : AUCUNE section vide n'est injectée dans le prompt ;
 *  - format : en-tête français + `<available_skills>` standard (nom,
 *    description, chemin), SANS le contenu de la fiche ;
 *  - exclusions : `disable-model-invocation` (règle SDK) et motifs « !nom »
 *    de settings.skills (désactivation UI Pi-Web) ;
 *  - robustesse : entrées invalides, doublons, échappement XML, plafond ;
 *  - updateSkillSettingsList : un nom nu désactivé devient « !nom » (sinon le
 *    SDK continuerait de charger la skill auto-découverte), chemins inchangés ;
 *  - intégration : un vrai DefaultResourceLoader (bac à sable temporaire) respecte
 *    l'activation par défaut et la désactivation par « !nom ».
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  buildSkillsAnnouncement,
  collectAnnounceableSkills,
  isSkillPathSource,
  renderSkillsBlock,
  SKILLS_MARKER_END,
  SKILLS_MARKER_START,
  SKILLS_MAX,
  updateSkillSettingsList,
  type AnnounceableSkill,
} from "./skills-announce.js";

const CODEBASE_MEMORY: AnnounceableSkill = {
  name: "codebase-memory",
  description:
    "Use the codebase knowledge graph for structural code queries. Triggers on: explore the codebase, who calls this function.",
  filePath: "/root/.pi/agent/skills/codebase-memory/SKILL.md",
  disableModelInvocation: false,
};

describe("collectAnnounceableSkills", () => {
  it("garde les skills valides et normalise la description sur une ligne", () => {
    const out = collectAnnounceableSkills([
      { ...CODEBASE_MEMORY, description: "  Ligne 1\nLigne 2   avec   espaces  " },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe("Ligne 1 Ligne 2 avec espaces");
  });

  it("écarte les entrées invalides (champs manquants ou vides)", () => {
    const out = collectAnnounceableSkills([
      { name: "", description: "d", filePath: "/x/SKILL.md" },
      { name: "a", description: "   ", filePath: "/x/SKILL.md" },
      { name: "b", description: "d", filePath: "" },
      { name: "c", description: "d" } as unknown as AnnounceableSkill,
      null as unknown as AnnounceableSkill,
    ]);
    expect(out).toEqual([]);
  });

  it("écarte disable-model-invocation (comme le SDK : /skill:name indisponible au sous-agent)", () => {
    const out = collectAnnounceableSkills([{ ...CODEBASE_MEMORY, disableModelInvocation: true }]);
    expect(out).toEqual([]);
  });

  it("dédoublonne par nom (le premier gagne)", () => {
    const out = collectAnnounceableSkills([
      { ...CODEBASE_MEMORY, filePath: "/premier/SKILL.md" },
      { ...CODEBASE_MEMORY, filePath: "/second/SKILL.md" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe("/premier/SKILL.md");
  });

  it("tolère null / undefined / non-tableau", () => {
    expect(collectAnnounceableSkills(null)).toEqual([]);
    expect(collectAnnounceableSkills(undefined)).toEqual([]);
    expect(collectAnnounceableSkills("x" as unknown as AnnounceableSkill[])).toEqual([]);
  });
});

describe("buildSkillsAnnouncement / renderSkillsBlock", () => {
  it("cas ZÉRO skill : chaîne vide (aucune section vide dans le prompt)", () => {
    expect(buildSkillsAnnouncement([])).toBe("");
    expect(renderSkillsBlock([])).toBe("");
    expect(renderSkillsBlock(null)).toBe("");
    expect(renderSkillsBlock([{ ...CODEBASE_MEMORY, disableModelInvocation: true }])).toBe("");
    expect(renderSkillsBlock([{ ...CODEBASE_MEMORY, name: "  " }])).toBe("");
  });

  it("annonce nom + description + chemin au format Agent Skills, sans le contenu de la fiche", () => {
    const block = renderSkillsBlock([CODEBASE_MEMORY]);
    expect(block).toContain("## Skills disponibles (Agent Skills)");
    expect(block).toContain("<available_skills>");
    expect(block).toContain("<name>codebase-memory</name>");
    expect(block).toContain("<description>Use the codebase knowledge graph");
    expect(block).toContain("<location>/root/.pi/agent/skills/codebase-memory/SKILL.md</location>");
    expect(block).toContain("</available_skills>");
    // Pas le CONTENU de SKILL.md : annonce seule (lecture à la demande).
    expect(block).not.toContain("Quick Decision Matrix");
  });

  it("encadre le bloc par les marqueurs PI_SKILLS", () => {
    const block = renderSkillsBlock([CODEBASE_MEMORY]);
    expect(block.startsWith(`\n\n${SKILLS_MARKER_START}\n`)).toBe(true);
    expect(block.endsWith(`${SKILLS_MARKER_END}`)).toBe(true);
    expect(block).toContain(SKILLS_MARKER_START);
  });

  it("échappe le XML (délégation au SDK) et n'annonce pas la balise brute", () => {
    const block = buildSkillsAnnouncement([
      { name: "x", description: 'danger <script> & "quotes"', filePath: "/x/SKILL.md" },
    ]);
    expect(block).toContain("&lt;script&gt;");
    expect(block).toContain("&amp;");
    expect(block).not.toContain("<script>");
  });

  it("plafonne à SKILLS_MAX et signale les skills non annoncées", () => {
    const skills: AnnounceableSkill[] = Array.from({ length: SKILLS_MAX + 3 }, (_, i) => ({
      name: `skill-${i}`,
      description: `desc ${i}`,
      filePath: `/s/skill-${i}/SKILL.md`,
    }));
    const block = buildSkillsAnnouncement(skills);
    expect(block).toContain("<name>skill-0</name>");
    expect(block).toContain(`<name>skill-${SKILLS_MAX - 1}</name>`);
    expect(block).not.toContain(`<name>skill-${SKILLS_MAX}</name>`);
    expect(block).toContain("3 autre(s) skill(s) non annoncée(s)");
  });
});

describe("updateSkillSettingsList (état activé/désactivé de l'UI)", () => {
  it("nom nu : activer liste le nom, désactiver écrit le motif « !nom » compris par le SDK", () => {
    expect(updateSkillSettingsList([], "codebase-memory", true)).toEqual(["codebase-memory"]);
    expect(updateSkillSettingsList(["codebase-memory"], "codebase-memory", false)).toEqual([
      "!codebase-memory",
    ]);
    // Ré-activer retire le motif d'exclusion (la skill est active par défaut).
    expect(updateSkillSettingsList(["!codebase-memory"], "codebase-memory", true)).toEqual([
      "codebase-memory",
    ]);
  });

  it("idempotent : re-désactiver ne duplique pas le motif", () => {
    expect(updateSkillSettingsList(["!codebase-memory"], "codebase-memory", false)).toEqual([
      "!codebase-memory",
    ]);
  });

  it("accepte une source déjà préfixée (re-clic UI) et préserve les autres entrées", () => {
    expect(updateSkillSettingsList(["autre", "!codebase-memory"], "!codebase-memory", false)).toEqual([
      "autre",
      "!codebase-memory",
    ]);
    expect(updateSkillSettingsList(["autre", "!codebase-memory"], "!codebase-memory", true)).toEqual([
      "autre",
      "codebase-memory",
    ]);
  });

  it("chemins de skill : comportement historique add/remove", () => {
    const p = "/custom/skills/pdf-tools";
    expect(isSkillPathSource(p)).toBe(true);
    expect(isSkillPathSource("codebase-memory")).toBe(false);
    expect(updateSkillSettingsList([], p, true)).toEqual([p]);
    expect(updateSkillSettingsList([p], p, false)).toEqual([]);
    // « ~ » et chemins relatifs reconnus comme chemins.
    expect(updateSkillSettingsList([], "~/skills/x", true)).toEqual(["~/skills/x"]);
    expect(updateSkillSettingsList([], "./skills/x", true)).toEqual(["./skills/x"]);
  });

  it("source vide : liste recopiée sans modification", () => {
    const list = ["a", "!b"];
    expect(updateSkillSettingsList(list, "  ", true)).toEqual(list);
    expect(list).toEqual(["a", "!b"]); // pas de mutation de l'entrée
  });
});

// ── Intégration : le vrai loader SDK respecte l'activation/désactivation ──
// Source de vérité utilisée par l'extension : tempResourceLoader.getSkills().

describe("intégration DefaultResourceLoader (activation/désactivation réelles)", () => {
  let sandbox: string;
  let agentDir: string;
  let cwd: string;

  const SKILL_MD = [
    "---",
    "name: demo-skill",
    "description: Skill de démonstration pour les tests.",
    "---",
    "",
    "# Demo",
    "",
    "Contenu complet (ne doit PAS apparaître dans l'annonce).",
  ].join("\n");

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "pi-skills-announce-"));
    agentDir = join(sandbox, "agent");
    cwd = join(sandbox, "project");
    mkdirSync(join(agentDir, "skills", "demo-skill"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "skills", "demo-skill", "SKILL.md"), SKILL_MD);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function loadAnnouncedBlock(settings: Record<string, unknown>): Promise<string> {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
    const loader = new DefaultResourceLoader({ cwd, agentDir });
    await loader.reload();
    return renderSkillsBlock(loader.getSkills().skills);
  }

  it("skill auto-découverte → annoncée par défaut (nom + chemin)", async () => {
    const block = await loadAnnouncedBlock({});
    expect(block).toContain("<name>demo-skill</name>");
    expect(block).toContain(join(agentDir, "skills", "demo-skill", "SKILL.md"));
    // Le CONTENU de la fiche n'est jamais recopié.
    expect(block).not.toContain("Contenu complet");
  });

  it("nom nu dans settings.skills → reste annoncée (actif par défaut)", async () => {
    const block = await loadAnnouncedBlock({ skills: ["demo-skill"] });
    expect(block).toContain("<name>demo-skill</name>");
  });

  it("motif « !demo-skill » (désactivation UI) → RETIRÉE de l'annonce", async () => {
    const block = await loadAnnouncedBlock({ skills: ["!demo-skill"] });
    expect(block).toBe("");
  });
});
