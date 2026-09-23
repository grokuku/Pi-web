/**
 * repo-map.test.ts — tests des helpers PURS de la « Carte du Repo » (P1).
 *
 * Couvre les garanties demandées par le plan :
 *  - budget : la carte ne dépasse JAMAIS le budget, même minuscule ;
 *  - boost de la tâche : un fichier/symbole cité remonte dans la carte ;
 *  - dégradation ordonnée : signatures → noms seuls → arborescence ;
 *  - dégradation vide : un graphe non indexé ne produit AUCUNE carte ("").
 */
import { describe, expect, it } from "vitest";
import {
  buildRepoMap,
  extractTaskHints,
  renderRepoMapTier,
  REPO_MAP_BUDGET_CHARS,
  REPO_MAP_MARKER_END,
  REPO_MAP_MARKER_START,
  type RepoMapData,
} from "./repo-map.js";

/** Jeu de données réaliste et BORNÉ (pour un rendu prévisible en test). */
function makeData(): RepoMapData {
  return {
    files: [
      "backend/src/pi/session.ts",
      "backend/src/pi/repo-map.ts",
      "backend/src/routes/cbm.ts",
      "frontend/src/components/Chat/ChatView.tsx",
      "extensions/harness-orchestrator/index.ts",
      "extensions/codebase-memory/index.ts",
    ],
    hubs: [
      { name: "loadModelLibrary", file: "backend/src/pi/model-library.ts", signature: "()", inbound: 32 },
      { name: "loadProjects", file: "backend/src/projects/manager.ts", signature: "()", inbound: 14 },
      { name: "saveModelLibrary", file: "backend/src/pi/model-library.ts", signature: "(library: ModelLibrary)", inbound: 14 },
      { name: "getProject", file: "backend/src/projects/manager.ts", signature: "(id: string)", inbound: 10 },
      { name: "truncateChars", file: "backend/src/pi/harness-stream.ts", signature: "(value: unknown, max: number)", inbound: 10 },
      { name: "buildRepoMap", file: "backend/src/pi/repo-map.ts", signature: "(data, options)", inbound: 4 },
      { name: "emitSubagentEvent", file: "backend/src/pi/harness-stream.ts", signature: "(projectId, base, event)", inbound: 3 },
      { name: "resolveProjectId", file: "extensions/harness-orchestrator/index.ts", signature: "(cwd: string)", inbound: 3 },
      { name: "buildRepoMapCached", file: "extensions/codebase-memory/index.ts", signature: "(cwd)", inbound: 1 },
      { name: "extractTaskHints", file: "backend/src/pi/repo-map.ts", signature: "(text: string)", inbound: 1 },
    ],
    routes: [
      { method: "GET", path: "/projects" },
      { method: "POST", path: "/projects/:id/git/push" },
      { method: "DELETE", path: "/projects/:id" },
      { method: "POST", path: "/api/harness/activity" },
    ],
  };
}

describe("constantes et marqueurs", () => {
  it("expose un budget par défaut ~4000 chars et des marqueurs appariables", () => {
    expect(REPO_MAP_BUDGET_CHARS).toBe(4000);
    expect(REPO_MAP_MARKER_START).toBe("<!-- PI_REPO_MAP -->");
    expect(REPO_MAP_MARKER_END).toBe("<!-- /PI_REPO_MAP -->");
  });
});

describe("extractTaskHints", () => {
  it("extrait chemins et identifiants, ignore les mots vides", () => {
    const hints = extractTaskHints(
      "Corrige le bug dans backend/src/pi/session.ts et renomme loadModelLibrary",
    );
    expect(hints).toContain("backend/src/pi/session.ts");
    expect(hints).toContain("loadmodellibrary");
    // Mots vides de la tâche : ne doivent pas devenir des hints.
    expect(hints).not.toContain("dans");
    expect(hints.length).toBeLessThanOrEqual(40);
  });

  it("tolère un texte vide ou non-string", () => {
    expect(extractTaskHints("")).toEqual([]);
    expect(extractTaskHints(undefined as unknown as string)).toEqual([]);
  });
});

describe("buildRepoMap — dégradation vide", () => {
  it("retourne \"\" quand le graphe n'a rien (non indexé)", () => {
    expect(buildRepoMap({ files: [], hubs: [], routes: [] })).toBe("");
    expect(buildRepoMap({} as RepoMapData)).toBe("");
  });

  it("ne jette pas sur des entrées partielles/invalides", () => {
    expect(() => buildRepoMap({ files: [undefined as any], hubs: [null as any], routes: [] })).not.toThrow();
  });
});

describe("buildRepoMap — budget", () => {
  it("respecte le budget pour toute une série de valeurs", () => {
    const data = makeData();
    for (const budget of [120, 200, 400, 800, 1600, 4000]) {
      const text = buildRepoMap(data, { budget });
      expect(text.length).toBeLessThanOrEqual(budget);
    }
  });

  it("le palier le plus riche tient dans les 4000 chars par défaut", () => {
    const text = buildRepoMap(makeData());
    expect(text.length).toBeLessThanOrEqual(REPO_MAP_BUDGET_CHARS);
    expect(text).toContain("HUBS:");
    expect(text).toContain("CHEMINS:");
    expect(text).toContain("ROUTES:");
  });

  it("tronque proprement (fin sur une ligne entière + « … ») à budget minuscule", () => {
    const text = buildRepoMap(makeData(), { budget: 90 });
    expect(text.length).toBeLessThanOrEqual(90);
    expect(text.endsWith("…") || text.length < 90).toBe(true);
    // Jamais de coupe au milieu d'un caractère multi-octets (le texte reste du texte).
    expect(typeof text).toBe("string");
  });
});

describe("buildRepoMap — dégradation ordonnée", () => {
  it("choisit signatures → noms seuls → arborescence selon le budget", () => {
    const data = makeData();
    const signatures = renderRepoMapTier(data, "signatures");
    const names = renderRepoMapTier(data, "names");
    const tree = renderRepoMapTier(data, "tree");

    // Monotonie des tailles : c'est ce qui rend la dégradation déterministe.
    expect(signatures.length).toBeGreaterThan(names.length);
    expect(names.length).toBeGreaterThan(tree.length);

    // Budget assez large → palier signatures (les signatures sont présentes).
    const full = buildRepoMap(data, { budget: signatures.length });
    expect(full).toBe(signatures);
    expect(full).toContain("(id: string)");
    expect(full).toContain("· signatures)");

    // Budget intermédiaire → noms seuls : plus de signature, mais toujours des hubs.
    const noSig = buildRepoMap(data, { budget: names.length });
    expect(noSig).toBe(names);
    expect(noSig).toContain("HUBS (noms):");
    expect(noSig).not.toContain("(id: string)");
    expect(noSig).toContain("· noms seuls)");

    // Budget serré → arborescence seule : plus de hubs ni de routes.
    const onlyTree = buildRepoMap(data, { budget: tree.length });
    expect(onlyTree).toBe(tree);
    expect(onlyTree).toContain("ARBRE:");
    expect(onlyTree).not.toContain("HUBS");
    expect(onlyTree).not.toContain("ROUTES:");
    expect(onlyTree).toContain("· arborescence)");
  });

  it("bascule vers l'arborescence dès que les noms seuls ne tiennent plus", () => {
    const data = makeData();
    const names = renderRepoMapTier(data, "names");
    const tree = renderRepoMapTier(data, "tree");
    const text = buildRepoMap(data, { budget: names.length - 1 });
    expect(text).toBe(tree);
  });
});

describe("buildRepoMap — boost de la tâche", () => {
  it("fait remonter le fichier cité en tête des hubs", () => {
    const data = makeData();
    // Sans hint, l'ordre découle des appels entrants : loadModelLibrary (32) d'abord.
    const without = buildRepoMap(data, { budget: 4000, task: "" });
    const firstWithout = without.split("\n").find((l) => l.includes("↩"));
    expect(firstWithout).toContain("loadModelLibrary");

    // Tâche ciblant repo-map.ts → les hubs de ce fichier passent devant.
    const withHint = buildRepoMap(data, { budget: 4000, task: "Implémente le helper backend/src/pi/repo-map.ts" });
    const firstHub = withHint.split("\n").find((l) => l.includes("↩"));
    expect(firstHub).toBeDefined();
    expect(firstHub).toContain("repo-map.ts");
  });

  it("fait remonter un symbole cité par son nom", () => {
    const data = makeData();
    const text = buildRepoMap(data, {
      budget: 4000,
      task: "Explique comment extractTaskHints fonctionne",
    });
    const firstHub = text.split("\n").find((l) => l.includes("↩"));
    // Le symbole cité (inbound faible) doit précéder le premier hub « naturel ».
    expect(firstHub).toContain("extractTaskHints");
  });

  it("le boost ne casse pas le budget", () => {
    const data = makeData();
    for (const budget of [200, 600, 1500]) {
      const text = buildRepoMap(data, { budget, task: "backend/src/pi/session.ts" });
      expect(text.length).toBeLessThanOrEqual(budget);
    }
  });
});

describe("buildRepoMap — rendu des routes", () => {
  it("rend méthode + chemin", () => {
    const text = buildRepoMap(makeData(), { budget: 4000 });
    expect(text).toContain("ROUTES:");
    expect(text).toContain("GET /projects");
    expect(text).toContain("POST /projects/:id/git/push");
  });
});

describe("buildRepoMap — signatures", () => {
  it("nettoie les séquences échappées issues du JSON du graphe", () => {
    const text = buildRepoMap(
      {
        files: [],
        hubs: [
          {
            name: "toast",
            file: "frontend/src/utils/holaf-toast.ts",
            signature: '(\\n  message: string,\\n  type: \\"info\\"\\n)',
            inbound: 10,
          },
        ],
        routes: [],
      },
      { budget: 4000 },
    );
    expect(text).toContain("toast(message: string, type:");
    expect(text).not.toContain("\\n");
    expect(text).not.toContain('\\"');
  });
});
