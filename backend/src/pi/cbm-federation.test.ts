/**
 * cbm-federation.test.ts — tests des helpers PURS de la fédération CBM.
 *
 * Garanties couvertes :
 *  - merge à 1 part = texte brut SANS en-tête (non-régression projets non liés) ;
 *  - merge à N parts = blocs `## [nom]`, part vide → `(no results)`, part en
 *    erreur → `CBM error: …` sans masquer les autres ;
 *  - toutes les parts en erreur → ligne d'aide ;
 *  - inférence du sous-projet depuis un chemin (relative/absolue/ambiguë/hors).
 */
import { describe, expect, it } from "vitest";
import {
  inferTargetFromPath,
  isNoResultsPart,
  listTargetsHint,
  mergeFederatedParts,
} from "./cbm-federation.js";
import type { LinkedSubprojectRef } from "./cbm-project-resolution.js";

const RAW = "results: 1  (cols: qn label file)\n  projects-Pi-Web.x.f Function x.ts\ntotal: 1\n";

describe("mergeFederatedParts", () => {
  it("1 part → texte BRUT, sans en-tête (byte-identique à l'existant)", () => {
    expect(mergeFederatedParts([{ name: "holaf-lib", text: RAW }])).toBe(RAW);
  });

  it("1 part vide → texte brut vide (comportement historique)", () => {
    expect(mergeFederatedParts([{ name: "holaf-lib", text: "" }])).toBe("");
  });

  it("0 part → chaîne vide", () => {
    expect(mergeFederatedParts([])).toBe("");
  });

  it("N parts → blocs nommés dans l'ordre fourni", () => {
    const out = mergeFederatedParts([
      { name: "AI-Helper", text: RAW },
      { name: "holaf-lib", text: "results: 1  (cols: qn)\n  projects-holaf-lib.a.b Function b.ts\ntotal: 1\n" },
    ]);
    expect(out.startsWith("## [AI-Helper]\n")).toBe(true);
    expect(out).toContain("\n\n## [holaf-lib]\n");
    expect(out.indexOf("## [AI-Helper]")).toBeLessThan(out.indexOf("## [holaf-lib]"));
  });

  it("part vide (réponse CBM à zéro) → `(no results)`", () => {
    const empty = "results: 0  (cols: qn label file lines rank)\ntotal: 0\nreturned: 0\n";
    const out = mergeFederatedParts([
      { name: "AI-Helper", text: RAW },
      { name: "holaf-lib", text: empty },
    ]);
    expect(out).toContain("## [holaf-lib]\n(no results)");
  });

  it("part en erreur → `CBM error: …`, les autres parts restent affichées", () => {
    const out = mergeFederatedParts([
      { name: "AI-Helper", text: RAW },
      { name: "holaf-lib", text: "", error: "project not found" },
    ]);
    expect(out).toContain("## [AI-Helper]\n");
    expect(out).toContain("## [holaf-lib]\nCBM error: project not found");
  });

  it("toutes les parts en erreur → ligne d'aide + détail", () => {
    const out = mergeFederatedParts([
      { name: "AI-Helper", text: "", error: "timed out" },
      { name: "holaf-lib", text: "", error: "project not found" },
    ]);
    expect(out).toMatch(/aucun sous-projet n'a répondu/);
    expect(out).toContain("AI-Helper : CBM error: timed out");
    expect(out).toContain("holaf-lib : CBM error: project not found");
  });
});

describe("isNoResultsPart", () => {
  it("détecte la chaîne vide et la table CBM à zéro", () => {
    expect(isNoResultsPart("")).toBe(true);
    expect(isNoResultsPart("   \n")).toBe(true);
    expect(isNoResultsPart("results: 0  (cols: qn)\ntotal: 0\n")).toBe(true);
    expect(isNoResultsPart("No nodes found")).toBe(true);
  });

  it("ne considère PAS une table peuplée comme vide", () => {
    expect(isNoResultsPart(RAW)).toBe(false);
  });
});

describe("inferTargetFromPath", () => {
  const subs: LinkedSubprojectRef[] = [
    { name: "AI-Helper", rootPath: "/projects/AI-Helper" },
    { name: "holaf-lib", rootPath: "/projects/holaf-lib" },
  ];
  const cwd = "/projects/LINKED AI Helper";

  it("chemin ABSOLU sous la racine réelle d'un sous-projet", () => {
    expect(inferTargetFromPath("/projects/holaf-lib/src/x.ts", cwd, subs)).toBe("holaf-lib");
  });

  it("chemin ABSOLU sous le symlink du composite", () => {
    expect(inferTargetFromPath("/projects/LINKED AI Helper/AI-Helper/main.py", cwd, subs)).toBe(
      "AI-Helper",
    );
  });

  it("chemin RELATIF résolu contre le cwd", () => {
    expect(inferTargetFromPath("holaf-lib/src/k.js", cwd, subs)).toBe("holaf-lib");
  });

  it("chemin relatif à la racine d'un sous-projet (diff git) → via nom", () => {
    // Un `git diff` lancé dans le composite produit « holaf-lib/src/… ».
    expect(inferTargetFromPath("holaf-lib/a/b.ts", cwd, subs)).toBe("holaf-lib");
  });

  it("hors de tout sous-projet → null", () => {
    expect(inferTargetFromPath("/tmp/ailleurs/x.ts", cwd, subs)).toBeNull();
    expect(inferTargetFromPath("", cwd, subs)).toBeNull();
  });

  it("sans sous-projet → null", () => {
    expect(inferTargetFromPath("/projects/holaf-lib/x.ts", cwd, [])).toBeNull();
  });

  it("préfixe voisin (holaf-lib2) → pas de faux match", () => {
    expect(inferTargetFromPath("/projects/holaf-lib2/x.ts", cwd, subs)).toBeNull();
  });
});

describe("listTargetsHint", () => {
  it("liste les cibles valides ou signale l'absence de sous-projet", () => {
    expect(listTargetsHint(["holaf-lib", "AI-Helper"])).toContain("holaf-lib, AI-Helper");
    expect(listTargetsHint([])).toContain("aucun sous-projet");
  });
});
