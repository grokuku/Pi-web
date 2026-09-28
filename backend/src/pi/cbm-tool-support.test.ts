import { describe, it, expect } from "vitest";
import {
  buildProjectUnresolvedError,
  buildQualifiedNamePattern,
  buildSearchGraphArgs,
  buildSnippetAmbiguityMessage,
  escapeRegExp,
  extractSymbolName,
  parseSearchGraphRows,
  pickSearchGraphCandidate,
  shouldRetryEmptyRegistry,
} from "./cbm-tool-support.js";

// Sorties RÉELLES du serveur CBM (capturées en direct, v0.10.5).
const SEARCH_QUERY_OUTPUT = `results: 1  (cols: qn label file lines rank)
  projects-Pi-Web.extensions.codebase-memory.resolveProjectForCwd Function extensions/codebase-memory/index.ts 1093-1096 -17.5
total: 1
total_relation: eq
search_mode: bm25
returned: 1
has_more: false
truncated: false
`;

const SEARCH_PATTERN_OUTPUT = `results: 2  (cols: qn label file lines in out)
  projects-Pi-Web.extensions.codebase-memory.getProjectName Function extensions/codebase-memory/index.ts 1030-1045 4 5
  projects-Pi-Web.extensions.compaction-checkpoint.getProjectName Function extensions/compaction-checkpoint/index.ts 40-46 1 2
total: 2
returned: 2
has_more: false
truncated: false
`;

const SEARCH_MIXED_OUTPUT = `results: 2  (cols: qn label file lines in out)
  projects-Pi-Web.extensions.codebase-memory.getProjectName Function extensions/codebase-memory/index.ts 1030-1045 4 5
  projects-Pi-Web.extensions.compaction-checkpoint.getProjectName Function extensions/compaction-checkpoint/index.ts 40-46 1 2
semantic_total: 51
semantic_total_relation: gte
semantic_returned: 50
semantic_has_more: true
semantic: 50  (cols: qn label file score)
  projects-Pi-Web.frontend.src.utils.subagent-partial.overlaps Function frontend/src/utils/subagent-partial.ts 0.03261
`;

const SEARCH_EMPTY_OUTPUT = `results: 0  (cols: qn label file lines rank)
total: 0
total_relation: eq
search_mode: bm25
returned: 0
has_more: false
truncated: false
`;

describe("buildSearchGraphArgs (search_graph : query XOR semantic_query)", () => {
  it("query seul → arguments nominaux inchangés", () => {
    expect(buildSearchGraphArgs({ query: "resolveProjectForCwd" })).toEqual({
      query: "resolveProjectForCwd",
    });
  });

  it("semantic_query seul → jamais de query", () => {
    expect(buildSearchGraphArgs({ semantic_query: ["retry backoff"] })).toEqual({
      semantic_query: ["retry backoff"],
    });
  });

  it("les DEUX fournis → semantic_query gagne, query n'est PAS envoyé", () => {
    const args = buildSearchGraphArgs({
      query: "resolveProjectForCwd",
      semantic_query: ["resolution projet"],
    });
    expect(args).not.toHaveProperty("query");
    expect(args.semantic_query).toEqual(["resolution projet"]);
  });

  it("semantic_query vide → ignoré (query seul)", () => {
    expect(buildSearchGraphArgs({ query: "x", semantic_query: [] })).toEqual({ query: "x" });
  });

  it("filtres et limite transmis, labels → label (premier élément)", () => {
    expect(
      buildSearchGraphArgs({
        query: "x",
        labels: ["Function", "Class"],
        name_pattern: "^foo",
        limit: 5,
        file_pattern: "src/pi",
      }),
    ).toEqual({
      query: "x",
      label: "Function",
      name_pattern: "^foo",
      limit: 5,
      file_pattern: "src/pi",
    });
  });
});

describe("extractSymbolName / buildQualifiedNamePattern", () => {
  it("nom simple inchangé", () => {
    expect(extractSymbolName("getProjectName")).toBe("getProjectName");
  });

  it("signature terminale retirée", () => {
    expect(extractSymbolName("getProjectName(cwd: string)")).toBe("getProjectName");
  });

  it("préfixe fichier: retiré", () => {
    expect(extractSymbolName("extensions/codebase-memory/index.ts:getProjectName")).toBe(
      "getProjectName",
    );
  });

  it("pattern échappé (littéral regex)", () => {
    expect(buildQualifiedNamePattern("a.b(c)")).toBe("a\\.b");
    expect(escapeRegExp("f(x)")).toBe("f\\(x\\)");
  });
});

describe("parseSearchGraphRows", () => {
  it("lit la table qn/label/file d'un mode par pattern", () => {
    const rows = parseSearchGraphRows(SEARCH_PATTERN_OUTPUT);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      qualifiedName: "projects-Pi-Web.extensions.codebase-memory.getProjectName",
      label: "Function",
      file: "extensions/codebase-memory/index.ts",
    });
    expect(rows[1].file).toBe("extensions/compaction-checkpoint/index.ts");
  });

  it("lit la table d'un mode BM25 (colonnes rank)", () => {
    const rows = parseSearchGraphRows(SEARCH_QUERY_OUTPUT);
    expect(rows).toHaveLength(1);
    expect(rows[0].qualifiedName).toBe(
      "projects-Pi-Web.extensions.codebase-memory.resolveProjectForCwd",
    );
  });

  it("s'arrête au pied de table (n'ingère pas la section semantic)", () => {
    const rows = parseSearchGraphRows(SEARCH_MIXED_OUTPUT);
    expect(rows).toHaveLength(2);
  });

  it("réponse vide → []", () => {
    expect(parseSearchGraphRows(SEARCH_EMPTY_OUTPUT)).toEqual([]);
    expect(parseSearchGraphRows("No nodes found")).toEqual([]);
  });

  it("gère les cellules citées (chemins avec espaces)", () => {
    const raw = `results: 1  (cols: qn label file score)
  projects-DSN-Test.src.a-b.foo Function "src/a b.ts" 0.5
total: 1
`;
    expect(parseSearchGraphRows(raw)[0].file).toBe("src/a b.ts");
  });
});

describe("pickSearchGraphCandidate", () => {
  const rows = parseSearchGraphRows(SEARCH_PATTERN_OUTPUT);

  it("candidat unique → choisi", () => {
    expect(pickSearchGraphCandidate([rows[0]])?.qualifiedName).toBe(rows[0].qualifiedName);
  });

  it("plusieurs candidats + file → filtré par fichier", () => {
    expect(
      pickSearchGraphCandidate(rows, { file: "extensions/compaction-checkpoint/index.ts" })
        ?.qualifiedName,
    ).toBe("projects-Pi-Web.extensions.compaction-checkpoint.getProjectName");
  });

  it("file absolu → suffixe accepté", () => {
    expect(
      pickSearchGraphCandidate(rows, {
        file: "/projects/Pi-Web/extensions/codebase-memory/index.ts",
      })?.qualifiedName,
    ).toBe("projects-Pi-Web.extensions.codebase-memory.getProjectName");
  });

  it("plusieurs candidats, un seul composant final exact → choisi", () => {
    const raw = `results: 2  (cols: qn label file lines in out)
  projects-Pi-Web.a.fooBar Function a.ts 1-2 0 0
  projects-Pi-Web.b.foo Function b.ts 3-4 0 0
total: 2
`;
    expect(pickSearchGraphCandidate(parseSearchGraphRows(raw), { name: "foo" })?.file).toBe("b.ts");
  });

  it("ambigu → null", () => {
    expect(pickSearchGraphCandidate(rows)).toBeNull();
  });

  it("file demandé sans correspondance → null", () => {
    expect(pickSearchGraphCandidate(rows, { file: "introuvable.ts" })).toBeNull();
  });
});

describe("buildSnippetAmbiguityMessage", () => {
  it("liste des suggestions actionnables", () => {
    const rows = parseSearchGraphRows(SEARCH_PATTERN_OUTPUT);
    const msg = buildSnippetAmbiguityMessage("getProjectName", rows);
    expect(msg).toContain("2 symboles");
    expect(msg).toContain("projects-Pi-Web.extensions.codebase-memory.getProjectName");
    expect(msg).toContain("file");
  });
});

describe("registre CBM vide (BUG #2)", () => {
  it("re-tentative uniquement quand le registre est vide", () => {
    expect(shouldRetryEmptyRegistry(0)).toBe(true);
    expect(shouldRetryEmptyRegistry(1)).toBe(false);
    expect(shouldRetryEmptyRegistry(45)).toBe(false);
  });

  it("erreur explicite et actionnable (jamais de nom de dossier silencieux)", () => {
    const err = buildProjectUnresolvedError("/projects/BxRGB Linked");
    expect(err.name).toBe("CbmProjectUnresolvedError");
    expect(err.message).toContain("/projects/BxRGB Linked");
    expect(err.message).toContain("redémarrage");
    expect(err.message).toContain("Réessayez");
  });
});
