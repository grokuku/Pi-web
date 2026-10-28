/**
 * web-screenshot-description.test.ts — DESCRIPTION de l'outil `web_screenshot`.
 *
 * Objectif produit : les sous-agents ont produit 32 captures de pages web pour
 * LIRE du texte. La cause résiduelle était la DESCRIPTION de l'outil
 * (extensions/web-screenshot/index.ts), qui invitait explicitement à capturer
 * « un mockup HTML ou une page web » : `promptSnippet` et `promptGuidelines`
 * alimentent la liste d'outils et la section « Guidelines: » du prompt système
 * (même canal que preview-tools.ts), donc le modèle lisait cette invitation en
 * premier. La description doit désormais :
 *   - ne plus inviter à capturer un contenu pour le lire ;
 *   - dire que l'outil sert à VÉRIFIER UN RENDU ou à MONTRER une capture ;
 *   - renvoyer explicitement la LECTURE de texte/doc à Libry.
 *
 * L'extension n'est pas importable depuis le backend (elle dépend du SDK — cf.
 * harness-role-tools.test.ts / prompt-stability.test.ts) : on verrouille donc la
 * formulation par une lecture STATIQUE de sa source (fs, aucun réseau), et la
 * non-régression de la SIGNATURE (paramètres, retour image) sur la même source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXTENSION_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../extensions/web-screenshot/index.ts", import.meta.url)),
  "utf8",
);

/** Bloc `pi.registerTool({ ... })` de l'outil. */
const REGISTER_START = EXTENSION_SOURCE.indexOf('name: "web_screenshot"');
if (REGISTER_START < 0) throw new Error("registerTool web_screenshot introuvable");
const REGISTER_BLOCK = EXTENSION_SOURCE.slice(REGISTER_START, EXTENSION_SOURCE.indexOf("parameters,", REGISTER_START));

/** Description déclarée (concaténation de littéraux). */
function extractField(field: "description" | "promptSnippet"): string {
  const start = REGISTER_BLOCK.indexOf(`${field}:`);
  if (start < 0) throw new Error(`Champ ${field} introuvable dans le registerTool`);
  const rest = REGISTER_BLOCK.slice(start + field.length + 1);
  const stop = rest.search(/\n\s*(promptSnippet|promptGuidelines|parameters)\b/);
  const body = stop < 0 ? rest : rest.slice(0, stop);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
}

/** Éléments du tableau `promptGuidelines: [ ... ]`. */
function extractGuidelines(): string[] {
  const start = REGISTER_BLOCK.indexOf("promptGuidelines:");
  if (start < 0) throw new Error("promptGuidelines introuvable");
  const rest = REGISTER_BLOCK.slice(start);
  const end = rest.indexOf("],");
  return [...rest.slice(0, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

const DESCRIPTION = extractField("description");
const SNIPPET = extractField("promptSnippet");
const GUIDELINES = extractGuidelines();
const PROMPT_TEXT = [DESCRIPTION, SNIPPET, ...GUIDELINES].join("\n");

describe("web_screenshot : la description n'invite plus à LIRE une page web", () => {
  it("extrait bien les champs de prompt du tool", () => {
    expect(DESCRIPTION.length).toBeGreaterThan(80);
    expect(SNIPPET.length).toBeGreaterThan(20);
    expect(GUIDELINES.length).toBeGreaterThanOrEqual(4);
  });

  it("ne contient plus la formulation « ou une page web »", () => {
    // Formulation historique exacte (cause des 32 captures de texte).
    expect(PROMPT_TEXT).not.toMatch(/ou une page web/i);
    expect(PROMPT_TEXT).not.toMatch(/ou d'une page web/i);
    expect(PROMPT_TEXT).not.toMatch(/d'un mockup ou d'une page/i);
    // Équivalent anglais de l'ancien promptSnippet.
    expect(PROMPT_TEXT).not.toMatch(/web page or html mockup/i);
    expect(PROMPT_TEXT).not.toMatch(/\bweb page\b/i);
  });

  it("aucune occurrence de « page web » dans tout le fichier de l'extension", () => {
    expect(EXTENSION_SOURCE).not.toMatch(/page web/i);
    expect(EXTENSION_SOURCE).not.toMatch(/\bweb page\b/i);
  });

  it("dit que l'outil sert à VÉRIFIER un RENDU ou à MONTRER la capture", () => {
    expect(DESCRIPTION).toMatch(/VÉRIFIER (CE )?RENDU/);
    expect(DESCRIPTION).toMatch(/MONTRER/);
    expect(DESCRIPTION).toMatch(/mockup/i);
    expect(DESCRIPTION).toMatch(/page\s+locale du projet|page locale/i);
    expect(DESCRIPTION).toMatch(/URL/);
    // Une capture reste utilisable pour montrer un résultat à l'utilisateur.
    expect(GUIDELINES.some((g) => /MONTRER/i.test(g))).toBe(true);
  });

  it("renvoie explicitement la LECTURE de texte/doc à Libry", () => {
    // Règle dans la DESCRIPTION elle-même (là où le modèle la lit en premier).
    expect(DESCRIPTION).toMatch(/Libry/);
    expect(DESCRIPTION).toMatch(/librarian_search/);
    expect(DESCRIPTION).toMatch(/librarian_archive/);
    expect(DESCRIPTION).toMatch(/PAS un moyen de LECTURE/i);
    // Et dans les guidelines (section « Guidelines: » du prompt système).
    expect(GUIDELINES.some((g) => /Pour LIRE/i.test(g) && /Libry/.test(g))).toBe(true);
    expect(GUIDELINES.some((g) => /jamais web_screenshot/i.test(g))).toBe(true);
  });
});

describe("web_screenshot : NON-RÉGRESSION (signature et comportement)", () => {
  it("nom, label et enregistrement inchangés", () => {
    expect(EXTENSION_SOURCE).toContain('name: "web_screenshot"');
    expect(EXTENSION_SOURCE).toContain('label: "Web Screenshot"');
    expect(EXTENSION_SOURCE).toContain("pi.registerTool({");
  });

  it("schéma de paramètres inchangé (mêmes noms, mêmes types)", () => {
    const schemaStart = EXTENSION_SOURCE.indexOf("const parameters = {");
    expect(schemaStart).toBeGreaterThan(-1);
    const schema = EXTENSION_SOURCE.slice(schemaStart, EXTENSION_SOURCE.indexOf("} satisfies JSONSchema;"));
    const expected: Array<[string, string]> = [
      ["url", "string"],
      ["html", "string"],
      ["htmlPath", "string"],
      ["width", "number"],
      ["height", "number"],
      ["timeoutMs", "number"],
    ];
    for (const [name, type] of expected) {
      expect(schema, name).toMatch(new RegExp(`${name}: \\{\\s*type: "${type}"`));
    }
    // Aucun paramètre ajouté/retiré : 6 propriétés exactement.
    expect((schema.match(/^\s{4}\w+: \{/gm) ?? []).length).toBe(expected.length);
  });

  it("exécution inchangée : capture, attachement et retour image/png", () => {
    expect(EXTENSION_SOURCE).toContain("async function captureScreenshot(");
    expect(EXTENSION_SOURCE).toContain('"--headless=new"');
    expect(EXTENSION_SOURCE).toContain("captureScreenshot(bin, target, outPath, width, height, timeoutMs)");
    expect(EXTENSION_SOURCE).toContain('{ type: "image" as const, data: base64, mimeType: "image/png" }');
    expect(EXTENSION_SOURCE).toContain("uploadScreenshotAsAttachment(outPath, projectId)");
    // Message d'erreur actionnable conservé (binaire Chromium absent).
    expect(EXTENSION_SOURCE).toContain("Chromium not found — add to Dockerfile");
  });
});
