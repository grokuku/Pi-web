/**
 * prompt-snapshots.test.ts — FILET SUR LES TEXTES DE PROMPT (le seul fichier de ce type).
 *
 * PROBLÈME VERROUILLÉ
 * Le comportement de l'agent est décidé en grande partie par des TEXTES : consignes
 * de mode, descriptions de rôles, garde-fou git, guidelines d'outils. Ces textes
 * vivaient en littéraux dispersés (backend/src/pi/*.ts et
 * extensions/harness-orchestrator/index.ts), donc AUCUN test ne bougeait quand l'un
 * d'eux changeait. Deux bugs réels en sont nés :
 *   - BUG01 : le prompt `code` autorisait « commit si l'utilisateur le demande »
 *     alors que GIT_SAFETY_RULES dit « JAMAIS » → l'agent bouclait sur un refus ;
 *   - AMEL17 : GIT_SAFETY_RULES annonçait 6 lectures git autorisées alors que le
 *     garde-fou en accepte ~30 (corrigé en GÉNÉRANT le texte depuis la liste).
 *
 * COMMENT VALIDER UN CHANGEMENT VOLONTAIRE DE PROMPT
 *   1. `cd backend && npx vitest run src/pi/prompt-snapshots.test.ts` → le test
 *      échoue et le diff montre, ligne à ligne, CE QUI a changé dans le texte
 *      réellement envoyé au modèle (le `.snap` est la référence gelée).
 *   2. Relire ce diff : est-ce exactement le changement voulu ? Rien d'autre n'a
 *      bougé ? (Un changement non voulu = régression : corriger le code, pas le .snap.)
 *   3. Seulement si le changement est VOULU : `npx vitest run src/pi/prompt-snapshots.test.ts -u`
 *      réécrit `src/pi/__snapshots__/prompt-snapshots.test.ts.snap` → à commiter
 *      avec le changement de code.
 *   Jamais de `-u` « pour faire passer » un test : le but est précisément qu'un
 *   prompt ne puisse plus changer en silence.
 *
 * PÉRIMÈTRE (textes gelés — uniquement ce qui part VRAIMENT au modèle)
 *   - GIT_SAFETY_RULES et REFUSAL_HINT (backend/src/pi/bash-guard.ts) ;
 *   - le prompt système Pi-Web par MODE, tel qu'assemblé par
 *     buildPiWebSystemPrompt (bannière + instructions de mode + GIT_SAFETY_RULES) ;
 *   - les consignes communes des sous-agents, les corps des 4 rôles et le texte
 *     composé par buildHarnessRolePrompt (backend/src/pi/harness-prompts.ts) ;
 *   - le rappel HARNESS, les champs prompt du tool `delegate` (description /
 *     promptSnippet / promptGuidelines) et son SCHÉMA (descriptions de paramètres,
 *     dont le libellé des 4 rôles) ;
 *   - les champs prompt des tools custom de la session principale
 *     (librarian_*, memory_*, render_design/get_design, log_commit_note).
 *
 * EXCLUS (et pourquoi)
 *   - les COMMENTAIRES de code des fichiers de prompt : le modèle ne les lit pas ;
 *   - les champs `description`/`label` du tableau FUNCTIONS de l'extension : ce sont
 *     des libellés d'INTERFACE (delegateParams ne les envoie pas — seuls `name` et
 *     `label` apparaissent, dans le schéma du tool `delegate`, lui gelé ci-dessous) ;
 *   - les schémas des tools d'administration de l'extension (`exploration_note`,
 *     `exploration_notes`, `delegate_list`, `delegate_steer`, `delegate_stop`) :
 *     descriptions de paramètres sans consigne de comportement, hors du chemin
 *     critique verrouillé ici (voir « ce qui reste » dans le rapport) ;
 *   - les blocs dépendants de l'ENVIRONNEMENT que l'extension ajoute au run (carte
 *     du repo, carnet d'exploration, skills installées, section <cwd>, id de projet) :
 *     ils varient par machine/projet/session — voir la note de normalisation plus bas ;
 *   - les noms d'outils (CBM_TOOLS / LIBRARY_TOOLS / EXPLORATION_TOOLS) : ce ne sont
 *     pas des textes mais des listes de noms, vérifiées par
 *     harness-role-tools.test.ts (quelle liste chaque rôle reçoit) ;
 *   - `open_preview` / `preview_html` et `web_screenshot` : leurs descriptions sont
 *     déjà verrouillées par preview-tools-description.test.ts et
 *     web-screenshot-description.test.ts (faits + bornes), et importer preview-tools.ts
 *     tirerait le gestionnaire de projets dans ce test.
 *
 * NORMALISATION (robustesse)
 * Un prompt qui contiendrait un chemin absolu (racine du dépôt, HOME, cwd d'un
 * projet), des fins de ligne Windows ou une version de plateforme casserait le
 * snapshot à chaque déploiement. `normalize()` remplace ces éléments par des
 * jetons stables avant comparaison : les textes actuels n'en contiennent pas,
 * mais la règle est explicite pour qu'un ajout futur ne rende pas le filet fragile.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { GIT_SAFETY_RULES, REFUSAL_HINT } from "./bash-guard.js";
import {
  buildDelegateParams,
  buildHarnessRolePrompt,
  CBM_EXPLORATION_GUIDE,
  DELEGATE_TOOL_DESCRIPTION,
  DELEGATE_TOOL_PROMPT_GUIDELINES,
  DELEGATE_TOOL_PROMPT_SNIPPET,
  HARNESS_ROLE_REMINDER,
  LIBRARY_GUIDE,
  ROLE_PROMPT_BODIES,
  SCRATCHPAD_GUIDE,
  type HarnessRole,
} from "./harness-prompts.js";
import { buildPiWebSystemPrompt } from "./system-prompt.js";
import { librarianTools } from "./librarian-tools.js";
import { memoryTools } from "./memory-tools.js";
import { createDesignTools } from "./design-tools.js";
import { createCommitDraftTool } from "./commit-draft-tool.js";

/** Racine du dépôt (…/Pi-Web) : neutralisée si elle apparaît dans un texte. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/**
 * Neutralise ce qui dépend de l'environnement avant de geler le texte :
 * chemins absolus (dépôt, HOME, cwd), séparateurs Windows, fins de ligne CRLF.
 * Sans cela, le snapshot casserait au premier déploiement ou changement de machine.
 */
function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replaceAll(REPO_ROOT, "<repo>")
    .replaceAll(process.cwd(), "<cwd>")
    .replaceAll(os.homedir(), "<home>")
    .replace(/\\/g, "/");
}

/**
 * Texte d'en-tête gelé DANS le snapshot (première entrée du .snap) : la procédure
 * de validation reste ainsi lisible au même endroit que la référence gelée.
 */
const SNAPSHOT_HEADER = [
  "RÉFÉRENCE GELÉE DES PROMPTS Pi-Web",
  "",
  "Chaque entrée ci-dessous est le TEXTE EXACT envoyé au modèle (aucun commentaire de code).",
  "Un prompt a changé ?",
  "  1. npx vitest run src/pi/prompt-snapshots.test.ts  → échec + diff (ce qui a changé) ;",
  "  2. relire le diff : est-ce le changement VOULU, et rien d'autre ?",
  "  3. si oui : npx vitest run src/pi/prompt-snapshots.test.ts -u, puis commiter le .snap.",
  "Ne jamais faire -u « pour faire passer » : le but est qu'un prompt ne change plus en silence.",
].join("\n");

/** Prompt système de base : imité du SDK pour ne dépendre d'aucune version installée. */
const BASE_PROMPT_FIXTURE = [
  "You are an expert coding assistant. Be helpful and precise.",
  "",
  "Available tools:",
  "- read",
  "- bash",
].join("\n");

/** Liste d'outils FIXE : la vraie dépend du registre de la session (environnement). */
const TOOLS_FIXTURE = ["read", "bash", "edit", "delegate"];

/** Id de projet factice (les tools de design/commit sont créés par projet). */
const FAKE_PROJECT_ID = "00000000-0000-4000-8000-000000000000";

const ROLES: HarnessRole[] = ["planning", "execute", "review", "integrate"];

/** Champs d'un ToolDefinition qui partent dans le prompt système. */
interface PromptFacingTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/** Rendu stable et lisible d'un outil : uniquement ce que le modèle peut lire. */
function renderToolPromptFields(tool: PromptFacingTool): string {
  const lines = [`### ${tool.name}`, "", tool.description?.trim() ?? "(pas de description)"];
  if (tool.promptSnippet) lines.push("", `- snippet : ${tool.promptSnippet.trim()}`);
  if (tool.promptGuidelines?.length) {
    lines.push("", "- guidelines :");
    for (const guideline of tool.promptGuidelines) lines.push(`  - ${guideline.trim()}`);
  }
  return lines.join("\n");
}

describe("filet des prompts — en-tête", () => {
  it("procédure de validation d'un changement volontaire", () => {
    expect(normalize(SNAPSHOT_HEADER)).toMatchSnapshot();
  });
});

describe("garde-fou git (bash-guard.ts)", () => {
  it("GIT_SAFETY_RULES — consigne injectée dans les prompts (code + 4 rôles)", () => {
    expect(normalize(GIT_SAFETY_RULES)).toMatchSnapshot();
  });

  it("REFUSAL_HINT — texte renvoyé au modèle quand un appel git est bloqué", () => {
    expect(normalize(REFUSAL_HINT)).toMatchSnapshot();
  });

  /**
   * AMEL17 : les deux textes sont DÉRIVÉS des mêmes constantes. Ce test vérifie
   * qu'ils annoncent le MÊME ensemble de lectures git, dans le même ordre — une
   * divergence rendrait l'un des deux mensonger pour le modèle, alors qu'il est
   * censé décrire exactement ce que le garde-fou accepte.
   */
  it("annonce exactement les mêmes lectures git que REFUSAL_HINT", () => {
    const markdownList = GIT_SAFETY_RULES.match(/Seules les lectures sont autorisées : ([^\n]+)\./)?.[1];
    const refusalList = REFUSAL_HINT.match(/Seules les lectures sont autorisées : ([^.]*)\.$/)?.[1];
    expect(markdownList, "liste markdown des lectures git absente de GIT_SAFETY_RULES").toBeTruthy();
    expect(refusalList, "liste des lectures git absente de REFUSAL_HINT").toBeTruthy();

    const fromMarkdown = markdownList!.split(", ").map((item) => item.replace(/`/g, "").replace(/^git /, "").trim());
    const fromRefusal = refusalList!.split(", ").map((item) => item.replace(/^git /, "").trim());
    expect(fromMarkdown).toEqual(fromRefusal);

    // Garde-fou de volume : un effondrement de la liste (ex. retour à « 6 lectures »)
    // se verrait aussi ici, sans dépendre de la lecture du snapshot.
    expect(fromMarkdown.length).toBeGreaterThanOrEqual(30);
  });
});

describe("prompt système Pi-Web (system-prompt.ts)", () => {
  it("mode code — bannière + instructions + garde-fou git", () => {
    const prompt = buildPiWebSystemPrompt(BASE_PROMPT_FIXTURE, "code", TOOLS_FIXTURE, {
      projectContext: "",
      memoryContext: "",
    });
    expect(normalize(prompt)).toMatchSnapshot();
  });

  it("mode harness — identité de chef de projet + consignes de délégation", () => {
    const prompt = buildPiWebSystemPrompt(BASE_PROMPT_FIXTURE, "harness", TOOLS_FIXTURE, {
      projectContext: "",
      memoryContext: "",
    });
    expect(normalize(prompt)).toMatchSnapshot();
  });
});

describe("sous-agents — consignes communes (harness-prompts.ts)", () => {
  it("LIBRARY_GUIDE", () => {
    expect(normalize(LIBRARY_GUIDE)).toMatchSnapshot();
  });

  it("CBM_EXPLORATION_GUIDE", () => {
    expect(normalize(CBM_EXPLORATION_GUIDE)).toMatchSnapshot();
  });

  it("SCRATCHPAD_GUIDE", () => {
    expect(normalize(SCRATCHPAD_GUIDE)).toMatchSnapshot();
  });
});

describe("sous-agents — prompts de rôle", () => {
  for (const role of ROLES) {
    it(`corps du rôle ${role}`, () => {
      expect(normalize(ROLE_PROMPT_BODIES[role])).toMatchSnapshot();
    });
  }

  /**
   * Le texte RÉELLEMENT envoyé = corps du rôle + consignes communes, dans cet
   * ordre (buildHarnessRolePrompt). Geler aussi un exemplaire composé prouve
   * l'ORDRE de composition, que les entrées séparées ci-dessus ne montrent pas.
   */
  it("prompt composé du rôle execute (preuve de l'ordre de composition)", () => {
    expect(normalize(buildHarnessRolePrompt("execute"))).toMatchSnapshot();
  });
});

describe("sous-agents — rappel HARNESS et tool delegate", () => {
  it("HARNESS_ROLE_REMINDER — bloc PI_HARNESS_ROLE injecté à chaque turn", () => {
    expect(normalize(HARNESS_ROLE_REMINDER)).toMatchSnapshot();
  });

  it("tool delegate — description + snippet + guidelines", () => {
    const rendered = renderToolPromptFields({
      name: "delegate",
      description: DELEGATE_TOOL_DESCRIPTION,
      promptSnippet: DELEGATE_TOOL_PROMPT_SNIPPET,
      promptGuidelines: DELEGATE_TOOL_PROMPT_GUIDELINES,
    });
    expect(normalize(rendered)).toMatchSnapshot();
  });

  /**
   * Descriptions de PARAMÈTRES du tool `delegate` : le modèle les lit à chaque tour
   * en mode harness. Le libellé des 4 fonctions vient du tableau de l'extension → on
   * fournit ici ce tableau tel qu'il y est déclaré (nom + libellé affiché).
   */
  it("tool delegate — schéma et descriptions de paramètres", () => {
    const params = buildDelegateParams([
      { name: "planning", label: "Planification" },
      { name: "execute", label: "Exécution" },
      { name: "review", label: "Relecture" },
      { name: "integrate", label: "Intégration" },
    ]);
    expect(normalize(JSON.stringify(params, null, 2))).toMatchSnapshot();
  });
});

describe("session principale — champs prompt des tools custom", () => {
  it("librarian_* / memory_* / render_design + get_design / log_commit_note", () => {
    // `defineTool` expose ces champs en lecture (même lecture que le SDK).
    const tools: PromptFacingTool[] = [
      ...librarianTools,
      ...memoryTools,
      ...createDesignTools(FAKE_PROJECT_ID),
      createCommitDraftTool(FAKE_PROJECT_ID),
    ] as unknown as PromptFacingTool[];
    const rendered = tools.map((tool) => renderToolPromptFields(tool)).join("\n\n");
    expect(normalize(rendered)).toMatchSnapshot();
  });
});

describe("défenses du filet lui-même", () => {
  /**
   * Les textes gelés ne doivent pas dépendre de l'environnement : si un chemin
   * absolu apparaissait dans un prompt, la normalisation le masquerait — on
   * vérifie donc ici qu'aucun chemin absolu ne s'y trouve réellement.
   */
  it("aucun chemin absolu dans les prompts gelés", () => {
    const texts = [
      GIT_SAFETY_RULES,
      REFUSAL_HINT,
      LIBRARY_GUIDE,
      CBM_EXPLORATION_GUIDE,
      SCRATCHPAD_GUIDE,
      HARNESS_ROLE_REMINDER,
      DELEGATE_TOOL_DESCRIPTION,
      DELEGATE_TOOL_PROMPT_GUIDELINES.join("\n"),
      ...ROLES.map((role) => buildHarnessRolePrompt(role)),
    ];
    for (const text of texts) {
      expect(text).not.toContain(REPO_ROOT);
      expect(text).not.toContain(os.homedir());
      expect(text).not.toMatch(/[A-Za-z]:\\/); // chemin Windows
    }
  });

  /**
   * Le module des prompts doit rester PUR : importable par un test sans SDK, sans
   * I/O et sans état. Un import du SDK ou de Node ferait échouer ce test (et, à
   * terme, le filet lui-même). Lecture statique de la source : pas d'effet de bord.
   */
  it("harness-prompts.ts reste un module pur (aucun import SDK / Node)", () => {
    const source = readFileSync(fileURLToPath(new URL("./harness-prompts.ts", import.meta.url)), "utf8");
    const imports = [...source.matchAll(/^import .*$/gm)].map((match) => match[0]);
    expect(imports).toEqual(['import { GIT_SAFETY_RULES } from "./bash-guard.js";']);
  });
});
