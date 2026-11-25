/**
 * subagent-preview-tools.test.ts — `open_preview` / `preview_html` DANS LES SOUS-AGENTS.
 *
 * PROBLÈME VERROUILLÉ
 * La session principale (mode code) a `open_preview` + `preview_html` : c'est le SEUL
 * moyen de faire VOIR une page à l'utilisateur (fenêtre de rendu du frontend). Les 4
 * rôles de sous-agent ne les avaient pas — or `execute` écrit le HTML et ne pouvait
 * pas le montrer : il ne lui restait que `web_screenshot`, une IMAGE pour le modèle,
 * pas une fenêtre pour l'utilisateur.
 *
 * DEUX BARRIÈRES (les deux doivent être levées, sinon le tool est silencieusement
 * inactif — `setActiveToolsByName` ignore un nom absent du registre) :
 *   (a) la LISTE D'OUTILS DU RÔLE dans extensions/harness-orchestrator/index.ts ;
 *   (b) les `customTools` de la tempSession : `open_preview`/`preview_html` sont des
 *       `customTools` de la session principale (backend/src/pi/preview-tools.ts),
 *       une tempSession créée sans eux ne les a pas dans son registre.
 *
 * DÉCISION (tranchée) : `open_preview` + `preview_html` pour `execute` (il produit les
 * pages) et `review` (il vérifie un rendu) ; PAS pour `planning` (il ne produit rien)
 * ni `integrate` (il synthétise). Et PAS dans HARNESS_TOOL_WHITELIST : l'orchestrateur
 * ne produit ni ne vérifie de rendu, l'y ajouter élargirait sa surface sans usage.
 *
 * L'extension n'est pas importable depuis le backend (dépendance SDK — cf.
 * prompt-stability.test.ts / harness-role-tools.test.ts) : son câblage est verrouillé
 * par une lecture STATIQUE de sa source (fs, aucun réseau). Les textes de prompt, eux,
 * sont importés du module PUR backend/src/pi/harness-prompts.ts (le texte réel).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { previewTools } from "./preview-tools.js";
import { buildHarnessRolePrompt, buildSubagentProjectIdBlock, type HarnessRole } from "./harness-prompts.js";
import { HARNESS_TOOL_WHITELIST } from "./tool-whitelist.js";

const EXTENSION_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../extensions/harness-orchestrator/index.ts", import.meta.url)),
  "utf8",
);

const PREVIEW_TOOL_NAMES = ["open_preview", "preview_html"];

/** Rôles qui DOIVENT pouvoir montrer un rendu à l'utilisateur. */
const ROLES_WITH_PREVIEW: HarnessRole[] = ["execute", "review"];
/** Rôles qui ne doivent PAS les recevoir (ils ne produisent ni ne vérifient de rendu). */
const ROLES_WITHOUT_PREVIEW: HarnessRole[] = ["planning", "integrate"];

const ROLES: HarnessRole[] = ["planning", "execute", "review", "integrate"];

/** Extrait les littéraux d'un tableau `const NAME: string[] = [ ... ];`. */
function readStringArrayConstant(name: string): string[] {
  const start = EXTENSION_SOURCE.indexOf(`const ${name}: string[] = [`);
  if (start < 0) throw new Error(`Constante ${name} introuvable dans l'extension`);
  const end = EXTENSION_SOURCE.indexOf("];", start);
  return [...EXTENSION_SOURCE.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const SPREADS: Record<string, string[]> = {
  LIBRARY_TOOLS: readStringArrayConstant("LIBRARY_TOOLS"),
  CBM_TOOLS: readStringArrayConstant("CBM_TOOLS"),
  EXPLORATION_TOOLS: readStringArrayConstant("EXPLORATION_TOOLS"),
  // Barrière (a) : la constante peut ne pas exister avant le correctif → liste vide,
  // ce qui fait échouer les assertions de présence ci-dessous (comportement voulu).
  PREVIEW_TOOLS: EXTENSION_SOURCE.includes("const PREVIEW_TOOLS: string[] = [")
    ? readStringArrayConstant("PREVIEW_TOOLS")
    : [],
};

/** Bloc source d'un rôle (`name: "<role>"` → rôle suivant). */
function roleSource(role: HarnessRole): string {
  const start = EXTENSION_SOURCE.indexOf(`name: "${role}"`);
  if (start < 0) throw new Error(`Rôle ${role} introuvable dans l'extension`);
  const nextIndexes = ROLES.map((r) => EXTENSION_SOURCE.indexOf(`name: "${r}"`)).filter((index) => index > start);
  const end = nextIndexes.length > 0 ? Math.min(...nextIndexes) : EXTENSION_SOURCE.length;
  return EXTENSION_SOURCE.slice(start, end);
}

/** Liste `tools: [...]` du rôle, spreads développés (ordre source préservé). */
function roleTools(role: HarnessRole): string[] {
  const match = roleSource(role).match(/tools: \[([\s\S]*?)\],/);
  if (!match) throw new Error(`Liste tools introuvable pour le rôle ${role}`);
  const tools: string[] = [];
  for (const part of match[1].split(",")) {
    const token = part.trim();
    if (!token) continue;
    const spread = token.match(/^\.\.\.([A-Z_]+)$/);
    if (spread) {
      const names = SPREADS[spread[1]];
      if (!names) throw new Error(`Spread inconnu dans le rôle ${role} : ${token}`);
      tools.push(...names);
      continue;
    }
    tools.push(token.replace(/^"|"$/g, ""));
  }
  return tools;
}

describe("sous-agents — les tools de preview existent dans le registre backend", () => {
  it("previewTools expose exactement open_preview et preview_html", () => {
    const names = previewTools.map((tool) => tool.name);
    expect(names).toEqual(PREVIEW_TOOL_NAMES);
  });
});

describe("barrière (a) — liste d'outils des rôles (extension)", () => {
  for (const role of ROLES_WITH_PREVIEW) {
    it(`le rôle ${role} reçoit open_preview ET preview_html`, () => {
      const tools = roleTools(role);
      for (const name of PREVIEW_TOOL_NAMES) {
        expect(tools, `${role} doit avoir ${name} (il produit ou vérifie un rendu)`).toContain(name);
      }
    });
  }

  for (const role of ROLES_WITHOUT_PREVIEW) {
    it(`le rôle ${role} ne reçoit PAS les tools de preview (décision)`, () => {
      const tools = roleTools(role);
      for (const name of PREVIEW_TOOL_NAMES) {
        expect(tools, `${role} ne produit ni ne vérifie de rendu : ${name} hors périmètre`).not.toContain(name);
      }
    });
  }
});

describe("barrière (b) — registre de la tempSession (customTools)", () => {
  it("l'extension injecte previewTools dans les customTools de la tempSession", () => {
    // Import dynamique du module des tools (aucune closure projet : projectId est
    // un paramètre du tool) + fusion dans tempCustomTools avant createAgentSession.
    expect(EXTENSION_SOURCE).toContain('await import("../../backend/src/pi/preview-tools.js")');
    const customToolsLine = EXTENSION_SOURCE.split("\n").find((line) => line.includes("customTools: tempCustomTools"));
    expect(customToolsLine, "createAgentSession doit recevoir tempCustomTools").toBeTruthy();
    expect(EXTENSION_SOURCE).toMatch(/tempCustomTools\s*=\s*\[[^\]]*previewTools/s);
  });

  it("la vérification d'allowlist couvre les tools de preview (au lieu de supposer)", () => {
    // Même point de contrôle que pour CBM/Libry : absent du registre = loggé.
    expect(EXTENSION_SOURCE).toMatch(/PREVIEW_TOOLS\.filter/);
  });
});

describe("l'outil est ANNONCÉ dans le prompt du rôle (sinon le modèle ignore qu'il l'a)", () => {
  for (const role of ROLES_WITH_PREVIEW) {
    it(`le prompt du rôle ${role} cite open_preview`, () => {
      const prompt = buildHarnessRolePrompt(role);
      expect(prompt).toContain("open_preview");
      expect(prompt).toContain("preview_html");
    });
  }

  for (const role of ROLES_WITHOUT_PREVIEW) {
    it(`le prompt du rôle ${role} ne promet pas open_preview`, () => {
      const prompt = buildHarnessRolePrompt(role);
      expect(prompt).not.toContain("open_preview");
    });
  }
});

describe("projectId — paramètre requis d'open_preview, donc fourni au sous-agent", () => {
  it("le bloc d'id est stable, marqué, et contient l'UUID", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const block = buildSubagentProjectIdBlock(id);
    expect(block).toContain(id);
    expect(block).toContain("<!-- PI_PROJECT_ID -->");
    expect(block).toContain("<!-- /PI_PROJECT_ID -->");
    // Stable : deux appels identiques produisent le même texte (préfixe cachable).
    expect(buildSubagentProjectIdBlock(id)).toBe(block);
  });

  it("l'extension ajoute ce bloc au prompt système du sous-agent", () => {
    expect(EXTENSION_SOURCE).toMatch(/buildSubagentProjectIdBlock/);
    // Le bloc doit être CONCATÉNÉ à subagentPromptState.systemPrompt (sinon l'id
    // n'atteint jamais le modèle et open_preview est inutilisable en pratique).
    expect(EXTENSION_SOURCE).toMatch(/subagentPromptState\.systemPrompt\s*=[\s\S]{0,400}buildSubagentProjectIdBlock\(/);
  });
});

describe("HARNESS_TOOL_WHITELIST — décision : rien à ajouter", () => {
  it("l'orchestrateur ne reçoit PAS les tools de preview", () => {
    for (const name of PREVIEW_TOOL_NAMES) {
      expect(HARNESS_TOOL_WHITELIST as readonly string[]).not.toContain(name);
    }
  });
});
