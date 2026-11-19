/**
 * harness-tool-whitelist.test.ts — LISTE BLANCHE D'OUTILS DU MODE HARNESS (BUG10).
 *
 * Problème verrouillé ici : `toolsForMode(session, [])` renvoyait TOUS les tools
 * d'extension → l'orchestrateur recevait ~20 outils (`cbm_*`, `librarian_*`,
 * `web_screenshot`, `memory_*`, `render_design`, `open_preview`,
 * `log_commit_note`…) alors que sa bannière lui interdit d'agir, et que la
 * vérification runtime ne contrôlait que les `BASE_TOOLS`.
 *
 * Deux verrous :
 *  1. STATIQUE : le mode harness n'utilise plus `toolsForMode` (qui ajoute
 *     inconditionnellement tous les tools d'extension) mais une liste blanche
 *     explicite, et la vérification runtime filtre sur cette liste.
 *  2. DYNAMIQUE : `activeToolsForMode(session, "harness")` sur un registre
 *     VOLONTAIREMENT large ne renvoie QUE la liste blanche (+ les `mcp__…`
 *     dynamiques) — et le mode code reste inchangé.
 *
 * ⚠️ CE FICHIER N'IMPORTE PLUS `session.ts` (2026-11) : il expirait de façon
 * intermittente (2 fois signalé : 08/11 et 19/11). MESURÉ : le premier import
 * dynamique de `session.js` coûte ~3,0 s isolé et ~4,8 à 5,0 s pendant la suite
 * complète (charge parallèle) — soit le timeout PAR DÉFAUT de vitest (5 s) ;
 * reproduit en lançant deux suites en parallèle (5022 ms / 5044 ms).
 * La liste blanche et `activeToolsForMode` sont des fonctions PURES : elles
 * vivent désormais dans `tool-whitelist.ts` (aucune dépendance lourde), chargé
 * en quelques ms. Le timeout global reste à 5 s (ne JAMAIS le relever : cela
 * masquerait les vrais blocages).
 * Les verrous STATIQUES continuent, eux, de lire `session.ts` sur disque
 * (gratuit) : ils vérifient que la branche harness de `applyModeToSession`
 * utilise bien la liste blanche.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SESSION_SOURCE = readFileSync(
  fileURLToPath(new URL("./session.ts", import.meta.url)),
  "utf8",
);

/** Source du module PUR testé ici (garde-fou « il doit rester léger »). */
const WHITELIST_SOURCE = readFileSync(
  fileURLToPath(new URL("./tool-whitelist.ts", import.meta.url)),
  "utf8",
);

/** Registre de tools LARGE : tout ce qu'une session peut porter aujourd'hui. */
const ALL_TOOL_NAMES = [
  // tools de base du SDK
  "read", "bash", "edit", "write", "grep", "find", "ls", "powershell",
  // extension codebase-memory
  "cbm_search", "cbm_trace", "cbm_code", "cbm_search_code",
  "cbm_diff", "cbm_arch", "cbm_cypher", "cbm_schema",
  // extension harness-orchestrator
  "delegate", "delegate_list", "delegate_steer", "delegate_stop",
  "exploration_note", "exploration_notes",
  // customTools de la session principale
  "librarian_search", "librarian_archive",
  "memory_store", "memory_search", "memory_delete",
  "render_design", "get_design", "log_commit_note",
  "open_preview", "preview_html",
  // extensions annexes
  "web_screenshot", "analyze_file",
  // serveur MCP utilisateur (nom DYNAMIQUE)
  "mcp__docs__search",
];

/** Faux session : registre large, setActiveToolsByName fidèle au SDK (filtre). */
function fakeSession() {
  let active: string[] = [];
  return {
    getAllTools: () => ALL_TOOL_NAMES.map((name) => ({ name })),
    setActiveToolsByName: (names: string[]) => {
      const known = new Set(ALL_TOOL_NAMES);
      active = names.filter((n) => known.has(n)); // le SDK ignore les inconnus
    },
    getActiveToolNames: () => active,
  };
}

const FORBIDDEN_IN_HARNESS = [
  // tools d'exécution (déjà retirés avant BUG10)
  "read", "bash", "edit", "write", "grep", "find", "ls", "powershell",
  // tools sans usage pour un orchestrateur qui ne fait qu'orchestrer
  "memory_store", "memory_search", "memory_delete",
  "render_design", "get_design", "log_commit_note",
  "open_preview", "preview_html",
];

const REQUIRED_IN_HARNESS = [
  "delegate", "delegate_list", "delegate_steer", "delegate_stop",
  "cbm_search", "cbm_trace", "cbm_code", "cbm_search_code",
  "cbm_diff", "cbm_arch", "cbm_cypher", "cbm_schema",
  "librarian_search", "librarian_archive",
  "exploration_note", "exploration_notes",
];

/** Bloc source de la branche harness d'`applyModeToSession`. */
function harnessBranchSource(): string {
  // On se limite à la FONCTION `applyModeToSession` : c'est elle qui APPLIQUE
  // la liste blanche à la session (les RÈGLES, elles, vivent dans
  // `tool-whitelist.ts`, testées dynamiquement plus bas).
  const fnStart = SESSION_SOURCE.indexOf("export async function applyModeToSession");
  if (fnStart < 0) throw new Error("applyModeToSession introuvable dans session.ts");
  const start = SESSION_SOURCE.indexOf('if (mode === "harness") {', fnStart);
  if (start < 0) throw new Error('Branche `if (mode === "harness")` introuvable dans session.ts');
  const end = SESSION_SOURCE.indexOf("} else {", start);
  if (end < 0) throw new Error("Bloc `else` du filtrage de tools introuvable");
  return SESSION_SOURCE.slice(start, end);
}

describe("BUG10 — verrou statique : le mode harness n'injecte plus tous les tools", () => {
  it("n'appelle plus toolsForMode (qui ajoute inconditionnellement les tools d'extension)", () => {
    const branch = harnessBranchSource();
    expect(branch).not.toMatch(/setActiveToolsByName\(\s*filterPlatformTools\(\s*toolsForMode\(/);
    expect(branch).toMatch(/setActiveToolsByName\(/);
  });

  it("la vérification runtime filtre sur la liste blanche, plus seulement sur BASE_TOOLS", () => {
    const branch = harnessBranchSource();
    expect(branch).toMatch(/isHarnessToolAllowed/);
    expect(branch).not.toMatch(/active\.filter\(\(t\) => BASE_TOOLS\.includes\(t\)\)/);
  });
});

describe("BUG10 — comportement : activeToolsForMode", () => {
  it("mode harness : liste blanche seule (+ mcp__ dynamiques), aucun tool d'exécution", async () => {
    const { activeToolsForMode } = await import("./tool-whitelist.js");
    const session = fakeSession();
    const harness = activeToolsForMode(session, "harness");

    for (const name of REQUIRED_IN_HARNESS) expect(harness, name).toContain(name);
    for (const name of FORBIDDEN_IN_HARNESS) expect(harness, name).not.toContain(name);
    // Registre large : le total reste borné (avant correctif : tous les tools).
    expect(harness.length).toBeLessThan(ALL_TOOL_NAMES.length - 5);
  });

  it("mode harness : les outils « en cas de doute » restent disponibles", async () => {
    const { activeToolsForMode } = await import("./tool-whitelist.js");
    const harness = activeToolsForMode(fakeSession(), "harness");
    // Conservés volontairement (cf. rapport) : pièce jointe de l'utilisateur,
    // vérification/montrée d'un rendu, serveurs MCP configurés par l'utilisateur.
    expect(harness).toContain("analyze_file");
    expect(harness).toContain("web_screenshot");
    expect(harness).toContain("mcp__docs__search");
  });

  it("mode code : inchangé (base + extensions, hors tools d'orchestration)", async () => {
    const { activeToolsForMode } = await import("./tool-whitelist.js");
    const code = activeToolsForMode(fakeSession(), "code");
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(code, name).toContain(name);
    }
    expect(code).toContain("memory_store");
    expect(code).toContain("librarian_search");
    expect(code).not.toContain("powershell"); // bloqué par plateforme (Linux)
    for (const name of ["delegate", "delegate_list", "delegate_steer", "delegate_stop"]) {
      expect(code, name).not.toContain(name);
    }
  });

  it("le prédicat isHarnessToolAllowed est cohérent avec la liste appliquée", async () => {
    const { activeToolsForMode, isHarnessToolAllowed } = await import("./tool-whitelist.js");
    const harness = activeToolsForMode(fakeSession(), "harness");
    for (const name of harness) expect(isHarnessToolAllowed(name), name).toBe(true);
    for (const name of FORBIDDEN_IN_HARNESS) expect(isHarnessToolAllowed(name), name).toBe(false);
    expect(isHarnessToolAllowed("outil_totalement_inconnu")).toBe(false);
  });
});

// ── Garde-fou de CHARGE : la liste blanche doit rester importable sans le SDK ──
// Le test dynamique ci-dessus expirait parce qu'il chargeait `session.ts` (~3 s à
// froid, ~5 s sous charge). Si quelqu'un ré-introduit un import lourd dans
// `tool-whitelist.ts`, la fragilité revient sans se voir : on la verrouille ici.
describe("BUG10 — le module de liste blanche reste PUR (importable sans le SDK)", () => {
  it("n'importe ni session.js ni le SDK ni les extensions (imports runtime)", () => {
    const runtimeImports = [...WHITELIST_SOURCE.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)]
      .map((m) => m[1]);
    for (const spec of runtimeImports) {
      expect(spec, spec).not.toContain("session.js");
      expect(spec, spec).not.toContain("@earendil-works");
      expect(spec, spec).not.toContain("extension");
    }
  });

  it("les règles ne sont plus dupliquées dans session.ts (source unique)", () => {
    // session.ts RÉ-EXPORTE le module au lieu de redéfinir la liste blanche.
    expect(SESSION_SOURCE).toMatch(
      /export\s*\{[^}]*activeToolsForMode[^}]*\}\s*from\s*"\.\/tool-whitelist\.js"/,
    );
    expect(SESSION_SOURCE).not.toMatch(/const HARNESS_TOOL_WHITELIST\s*[:=]/);
    expect(SESSION_SOURCE).not.toMatch(/function activeToolsForMode\b/);
  });
});
