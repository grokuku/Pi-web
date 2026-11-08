/**
 * web-screenshot-project-id.test.ts — RATTACHEMENT DU SCREENSHOT AU BON PROJET (BUG12).
 *
 * Problème verrouillé ici : l'extension web-screenshot dérivait le `projectId`
 * de l'attachement du BASENAME du cwd (`cwd.split("/").pop()`), alors que tout
 * le backend manipule l'UUID du projet. Conséquence : screenshots rangés sous un
 * projet inexistant (invisibles dans la galerie) ou, en cas d'homonymie de
 * dossiers, rattachés au MAUVAIS projet.
 *
 * Correctif attendu : réutiliser le pont `__piWebResolveProjectIdByCwd__`
 * (publié par backend/src/pi/session.ts, déjà consommé par
 * harness-orchestrator) ; si le pont est absent ou échoue, NE RIEN inventer :
 * on n'enregistre pas l'attachement et on le signale.
 *
 * L'extension n'est pas importable depuis le backend (elle dépend du SDK) : le
 * câblage est verrouillé par lecture STATIQUE de sa source (fs, aucun réseau),
 * comme web-screenshot-description.test.ts / harness-role-tools.test.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../../extensions/web-screenshot/index.ts", import.meta.url)),
  "utf8",
);

/** Corps d'une fonction `function name(...) { ... }` (accolades équilibrées). */
function functionBody(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Fonction ${name} introuvable dans l'extension`);
  return balancedFrom(SOURCE.indexOf("{", start));
}

/** Bloc `pi.registerTool({ ... })` (accolades équilibrées). */
function toolRegistrationBody(): string {
  const start = SOURCE.indexOf("pi.registerTool({");
  if (start < 0) throw new Error("registerTool introuvable dans l'extension");
  return balancedFrom(SOURCE.indexOf("{", start));
}

/** Tranche `source[open..]` jusqu'à l'accolade fermante équilibrée. */
function balancedFrom(open: number): string {
  let depth = 0;
  for (let i = open; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}") {
      depth--;
      if (depth === 0) return SOURCE.slice(open, i + 1);
    }
  }
  throw new Error("Bloc non fermé");
}

describe("BUG12 — le projectId de l'attachement vient du pont, pas du cwd", () => {
  it("le basename du cwd n'est plus utilisé comme projectId", () => {
    // `cwd.split("/").pop()` reste légitime pour un chemin, JAMAIS pour un id.
    expect(SOURCE).not.toMatch(/const projectId = cwd \? cwd\.split\("\/"\)\.pop\(\)/);
    expect(SOURCE).not.toMatch(/projectId\s*=\s*cwd\.split\("\/"\)\.pop\(\)/);
  });

  it("un résolveur dédié lit le pont global __piWebResolveProjectIdByCwd__", () => {
    expect(SOURCE).toContain("__piWebResolveProjectIdByCwd__");
    const body = functionBody("resolveProjectIdFromCwd");
    expect(body).toMatch(/globalThis/);
    // Le pont est SYNCHRONE ; un échec renvoie null, jamais un id inventé.
    expect(body).toMatch(/return null/);
  });

  it("pont indisponible ou en échec → aucun attachement enregistré (et un log clair)", () => {
    const body = toolRegistrationBody();
    // Le garde : upload conditionné à une résolution réussie.
    expect(body).toMatch(/const projectId = resolveProjectIdFromCwd\(/);
    expect(body).toMatch(/projectId\s*\?[\s\S]{0,160}uploadScreenshotAsAttachment\(/);
    // Message de journal explicite (l'attachement non enregistré doit être dit).
    expect(body).toMatch(/console\.warn\(/);
    // Le tool doit le DIRE dans son résultat (pas de « upload échoué » muet).
    expect(body).toMatch(/attachment non enregistré/);
  });

  it("defense en profondeur : l'upload refuse un projectId vide", () => {
    // Recherche par fenêtre : la signature porte un type de retour littéral
    // (`{ id: string; url: string } | null`), donc slice directe.
    const start = SOURCE.indexOf("function uploadScreenshotAsAttachment(");
    expect(start).toBeGreaterThan(-1);
    const window = SOURCE.slice(start, start + 700);
    expect(window).toMatch(/if \(!projectId\)/);
    expect(window).toMatch(/return null/);
  });
});
