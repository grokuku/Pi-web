/**
 * harness-role-tools.test.ts — OUTILLAGE DES 4 RÔLES DU HARNESS (extension).
 *
 * Objectif produit : un sous-agent doit pouvoir LIRE une page/un doc avec Libry
 * (texte : indexé, citable, archivable) et ne garder la capture (`web_screenshot`)
 * que pour VÉRIFIER UN RENDU. Deux régressions à verrouiller :
 *   1. `librarian_search`/`librarian_archive` étaient ABSENTS des 4 rôles, alors
 *      que ces tools sont des `customTools` de la session PRINCIPALE
 *      (backend/src/pi/librarian-tools.ts) — la tempSession ne les hérite pas :
 *      l'extension doit les injecter (`customTools` de createAgentSession), sinon
 *      `setActiveToolsByName` ignore silencieusement les noms.
 *   2. `web_screenshot` est LÉGITIME (execute et review montrent/vérifient un
 *      rendu) mais ne doit pas être le moyen de lire du texte.
 *
 * L'extension n'est pas importable depuis le backend (elle dépend du SDK — cf.
 * prompt-stability.test.ts) : le câblage est verrouillé par une lecture STATIQUE
 * de sa source (fs, aucun réseau) + un import PUR du registre des tools backend.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { librarianTools } from "./librarian-tools.js";

const EXTENSION_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../extensions/harness-orchestrator/index.ts", import.meta.url)),
  "utf8",
);
const SESSION_SOURCE = readFileSync(
  fileURLToPath(new URL("./session.ts", import.meta.url)),
  "utf8",
);

const ROLES = ["planning", "execute", "review", "integrate"] as const;
type Role = (typeof ROLES)[number];

/** Extrait les littéraux d'un tableau `const NAME: string[] = [ ... ];`. */
function readStringArrayConstant(name: string): string[] {
  const start = EXTENSION_SOURCE.indexOf(`const ${name}: string[] = [`);
  if (start < 0) throw new Error(`Constante ${name} introuvable dans l'extension`);
  const end = EXTENSION_SOURCE.indexOf("];", start);
  const body = EXTENSION_SOURCE.slice(start, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// Constantes partagées de l'extension (spreads utilisés par les 4 rôles).
const CBM_TOOLS = readStringArrayConstant("CBM_TOOLS");
const EXPLORATION_TOOLS = readStringArrayConstant("EXPLORATION_TOOLS");
const LIBRARY_TOOLS = readStringArrayConstant("LIBRARY_TOOLS");
const SPREADS: Record<string, string[]> = {
  LIBRARY_TOOLS,
  CBM_TOOLS,
  EXPLORATION_TOOLS,
};

/** Bloc source de chaque rôle (`name: "<role>"` → rôle suivant). */
function roleSource(role: Role): string {
  const start = EXTENSION_SOURCE.indexOf(`name: "${role}"`);
  if (start < 0) throw new Error(`Rôle ${role} introuvable dans l'extension`);
  const nextIndexes = ROLES.map((r) => EXTENSION_SOURCE.indexOf(`name: "${r}"`)).filter(
    (i) => i > start,
  );
  const end = nextIndexes.length > 0 ? Math.min(...nextIndexes) : EXTENSION_SOURCE.length;
  return EXTENSION_SOURCE.slice(start, end);
}

/** Liste `tools: [...]` du rôle, spreads développés (ordre source préservé). */
function roleTools(role: Role): string[] {
  const block = roleSource(role);
  const match = block.match(/tools: \[([\s\S]*?)\],/);
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
    const literal = token.match(/^"([^"]+)"$/);
    if (!literal) throw new Error(`Jeton d'outil non reconnu dans ${role} : ${token}`);
    tools.push(literal[1]);
  }
  return tools;
}

describe("tools Libry exposés aux 4 rôles du harness", () => {
  // Le registre réel : on ne teste pas un nom fantôme.
  it("le registre backend expose librarian_search et librarian_archive", () => {
    expect(librarianTools.map((t) => t.name).sort()).toEqual([
      "librarian_archive",
      "librarian_search",
    ]);
    expect(LIBRARY_TOOLS.slice().sort()).toEqual(["librarian_archive", "librarian_search"]);
  });

  it("chaque rôle reçoit librarian_search ET librarian_archive", () => {
    for (const role of ROLES) {
      const tools = roleTools(role);
      expect(tools, role).toContain("librarian_search");
      expect(tools, role).toContain("librarian_archive");
    }
  });

  it("les tools Libry sont INJECTÉS dans la tempSession (sinon setActiveToolsByName les ignore)", () => {
    // Une tempSession sans `customTools` n'a pas ces tools dans son registre.
    expect(EXTENSION_SOURCE).toContain("backend/src/pi/librarian-tools.js");
    expect(EXTENSION_SOURCE).toContain("librarianTools");
    // L'option est bien transmise au createAgentSession de la tempSession.
    const createCall = EXTENSION_SOURCE.slice(
      EXTENSION_SOURCE.indexOf("const result = await createAgentSession({"),
    ).slice(0, 600);
    expect(createCall).toContain("customTools");
    expect(createCall).toContain("tempCustomTools");
    // Et l'échec d'injection est journalisé (dégradation visible, pas silencieuse).
    expect(EXTENSION_SOURCE).toContain("Tools Libry indisponibles dans la tempSession");
    expect(EXTENSION_SOURCE).toContain("tools Libry absents du registre");
  });

  it("la session PRINCIPALE garde son injection customTools inchangée", () => {
    expect(SESSION_SOURCE).toContain("...librarianTools");
    expect(SESSION_SOURCE).toContain(
      "customTools: [...createDesignTools(projectId), ...librarianTools, ...memoryTools, createCommitDraftTool(projectId), ...previewTools]",
    );
  });
});

describe("web_screenshot : usage ciblé (rendu), pas la lecture de texte", () => {
  it("présent dans execute et review (montrer / vérifier un rendu)", () => {
    expect(roleTools("execute")).toContain("web_screenshot");
    expect(roleTools("review")).toContain("web_screenshot");
  });

  it("absent de planning et integrate (aucun rendu à y vérifier)", () => {
    expect(roleTools("planning")).not.toContain("web_screenshot");
    expect(roleTools("integrate")).not.toContain("web_screenshot");
  });

  it("la consigne distingue LIRE (Libry) et VÉRIFIER UN RENDU (screenshot)", () => {
    const guide = EXTENSION_SOURCE.match(/const LIBRARY_GUIDE = `([\s\S]*?)`;/);
    expect(guide).not.toBeNull();
    const text = guide![1];
    expect(text).toContain("librarian_search");
    expect(text).toContain("librarian_archive");
    expect(text).toContain("web_screenshot");
    // « jamais un screenshot » pour le TEXTE : c'est la règle anti-détournement.
    expect(text).toMatch(/jamais un screenshot/i);
  });
});

describe("non-régression : les autres tools de chaque rôle sont inchangés", () => {
  const CBM = [
    "cbm_search",
    "cbm_trace",
    "cbm_code",
    "cbm_search_code",
    "cbm_diff",
    "cbm_arch",
    "cbm_cypher",
    "cbm_schema",
  ];
  const EXPLORATION = ["exploration_note", "exploration_notes"];
  const LIBRARY = ["librarian_search", "librarian_archive"];

  it("planning", () => {
    expect(roleTools("planning")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "analyze_file",
      ...LIBRARY,
      ...CBM,
      ...EXPLORATION,
    ]);
  });

  it("execute", () => {
    expect(roleTools("execute")).toEqual([
      "read",
      "edit",
      "write",
      "bash",
      "grep",
      "find",
      "ls",
      "analyze_file",
      "web_screenshot",
      ...LIBRARY,
      ...CBM,
      ...EXPLORATION,
    ]);
  });

  it("review (read-only strict : ni edit/write/bash)", () => {
    expect(roleTools("review")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "analyze_file",
      "web_screenshot",
      ...LIBRARY,
      ...CBM,
      ...EXPLORATION,
    ]);
  });

  it("integrate", () => {
    expect(roleTools("integrate")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "analyze_file",
      ...LIBRARY,
      ...CBM,
      ...EXPLORATION,
    ]);
  });

  it("les constantes partagées ne dérivent pas", () => {
    expect(CBM_TOOLS).toEqual(CBM);
    expect(EXPLORATION_TOOLS).toEqual(EXPLORATION);
    expect(LIBRARY_TOOLS).toEqual(LIBRARY);
  });
});

describe("la consigne Libry/Rendu est présente dans les 4 rôles", () => {
  it("chaque prompt de rôle concatène LIBRARY_GUIDE", () => {
    for (const role of ROLES) {
      expect(roleSource(role), role).toMatch(/`\s*\+\s*LIBRARY_GUIDE\s*\+/);
    }
  });

  it("la chaîne de guides reste complète (4 occurrences identiques)", () => {
    const injections =
      EXTENSION_SOURCE.match(
        /\+ LIBRARY_GUIDE \+ CBM_EXPLORATION_GUIDE \+ SCRATCHPAD_GUIDE \+ GIT_SAFETY_RULES/g,
      ) ?? [];
    expect(injections).toHaveLength(4);
  });
});
