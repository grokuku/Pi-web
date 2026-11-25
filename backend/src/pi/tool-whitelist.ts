/**
 * tool-whitelist.ts — QUELLES tools sont ACTIVES pour un mode donné (BUG10).
 *
 * ⚠️ POURQUOI CE MODULE EXISTE (et pourquoi ce n'est pas cosmétique) :
 * ces règles étaient dans `session.ts`, qui importe le SDK Pi, le registre de
 * modèles, les extensions, les outils maison… `await import("./session.js")`
 * coûte ~3 s à froid (mesuré), jusqu'à ~5 s quand la machine est chargée — soit
 * le timeout PAR DÉFAUT de vitest. Un test qui ne vérifie qu'une LISTE BLANCHE
 * n'a aucune raison de payer ce prix, et `harness-tool-whitelist.test.ts` a
 * expiré deux fois à cause de ça.
 *
 * Ce module est donc SANS dépendance lourde : uniquement `DELEGATE_TOOL_NAME`
 * (chaîne constante de `harness-stream.ts`, qui n'importe que `node:crypto`) et
 * le type `AgentMode` (effacé à la compilation). Ses fonctions sont PURES :
 * la « session » reçue n'est qu'un objet `{ getAllTools() }`.
 */
import type { AgentMode } from "./model-library.js";
import { DELEGATE_TOOL_NAME } from "./harness-stream.js";

/** Tools d'exécution de base du SDK (lecture/écriture du dépôt). */
export const BASE_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// ── Blocage plateforme ──
// Le SDK Pi (>= 0.84.4) expose le tool "powershell" sans garde OS :
// l'heuristique getExtensionToolNames le classe comme tool d'extension et
// l'active dans TOUS les modes. Or il throw à l'exécution sur Linux ("only
// available on Windows"), faisant perdre un tour à l'agent à chaque appel. On le
// bloque donc explicitement sur toute plateforme non-Windows.
export const PLATFORM_BLOCKED_TOOLS: readonly string[] =
  process.platform === "win32" ? [] : ["powershell"];

/** Retire les tools bloqués par plateforme d'une liste de noms de tools. */
export function filterPlatformTools(names: string[]): string[] {
  return names.filter((name) => !PLATFORM_BLOCKED_TOOLS.includes(name));
}

// ── Liste blanche des tools du mode HARNESS (BUG10) ──
// L'orchestrateur ne lit pas le code : il délègue. Il n'a donc AUCUN tool de
// base (read/bash/edit/write/grep/find/ls).
//
// AVANT (BUG10) : `toolsForMode(session, [])` renvoyait TOUS les tools
// d'extension — `memory_*`, `render_design`/`get_design`, `log_commit_note`,
// `open_preview`/`preview_html`, `web_screenshot`… ~20 outils dont l'orchestrateur
// n'a rien à faire, injectés dans le prompt À CHAQUE TOUR (tokens gaspillés),
// en contradiction permanente avec sa bannière (« ne faites jamais… »), et
// élargissant sa surface d'action réelle. Le contrôle runtime ne vérifiait que
// les BASE_TOOLS, donc rien de tout cela n'était détecté.
//
// DÉSORMAIS : liste blanche EXPLICITE. Un tool absent d'ici ne parvient plus à
// l'orchestrateur. Toute addition doit être justifiée par son prompt.
//  - delegate* : la raison d'être du mode (déléguer, lister/relayer/arrêter un run).
//  - cbm_* : exploration structurelle du dépôt (cf. harness-stream.ts : en mode
//    harness l'orchestrateur garde `delegate` + les cbm_* — lecture seule).
//  - librarian_* : lire de la doc/une page (texte) plutôt qu'une capture.
//  - exploration_* : carnet de découvertes (lecture/écriture passive, 0 action).
//  - analyze_file : pièce jointe de l'utilisateur (PDF/texte/image) qu'il peut
//    demander d'identifier SANS délégation — conservé par prudence.
//  - web_screenshot : montrer/vérifier un rendu à la demande explicite de
//    l'utilisateur — conservé par prudence (légitime pour 2 des 4 rôles).
// ÉCARTÉS (aucun n'est cité par le prompt de l'orchestrateur) :
// memory_store/memory_search/memory_delete, render_design/get_design,
// log_commit_note, open_preview/preview_html.
//
// DÉCISION EXPLICITE (outillage des SOUS-AGENTS) : `open_preview`/`preview_html` ont
// été donnés aux rôles `execute` et `review` (extensions/harness-orchestrator/
// index.ts, PREVIEW_TOOLS) parce que l'un ÉCRIT les pages et l'autre VÉRIFIE un
// rendu. Ils ne sont PAS ajoutés ici : l'orchestrateur ne produit ni ne vérifie de
// rendu (il délègue), donc les lui donner élargirait sa surface et son prompt à
// CHAQUE tour sans usage — exactement le BUG10 que cette liste blanche corrige.
// Verrouillé par backend/src/pi/subagent-preview-tools.test.ts.
export const HARNESS_TOOL_WHITELIST: readonly string[] = Object.freeze([
  DELEGATE_TOOL_NAME,
  "delegate_list",
  "delegate_steer",
  "delegate_stop",
  "cbm_search",
  "cbm_trace",
  "cbm_code",
  "cbm_search_code",
  "cbm_diff",
  "cbm_arch",
  "cbm_cypher",
  "cbm_schema",
  "librarian_search",
  "librarian_archive",
  "exploration_note",
  "exploration_notes",
  "analyze_file",
  "web_screenshot",
]);

// Préfixes de tools dont le nom est DYNAMIQUE : les serveurs MCP de
// l'utilisateur (`mcp__<serveur>__<outil>`, cf. ~/.pi/agent/mcp.json). On ne
// peut pas les lister à l'avance ; les retirer priverait l'orchestrateur des
// serveurs MCP configurés sur la machine (régression silencieuse). Conservés
// par prudence (cf. rapport LOT 4b).
export const HARNESS_TOOL_PREFIXES: readonly string[] = Object.freeze(["mcp__"]);

/** Vrai si `name` a le droit d'être actif en mode harness. */
export function isHarnessToolAllowed(name: string): boolean {
  if (typeof name !== "string" || !name) return false;
  if (HARNESS_TOOL_WHITELIST.includes(name)) return true;
  return HARNESS_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Noms des tools MCP (`mcp__…`) enregistrés dans la session, s'il y en a. */
export function getMcpToolNames(session: any): string[] {
  try {
    const allTools = session?.getAllTools?.() ?? [];
    return allTools
      .map((t: any) => t?.name)
      .filter((name: unknown): name is string =>
        typeof name === "string" && HARNESS_TOOL_PREFIXES.some((p) => name.startsWith(p)),
      ); // déjà filtrés plateforme : les mcp_* ne sont pas bloqués
  } catch {
    return [];
  }
}

// Tools d'orchestration à EXCLURE des modes non-harness (BUG-71).
// En mode CODE/REVIEW, le LLM doit travailler directement,
// pas déléguer via delegate ; idem pour les tools de CONTRÔLE des runs
// (LOT 3/4 : delegate_list / delegate_steer / delegate_stop) qui n'ont de sens
// qu'en mode harness — en mode CODE, seuls les tools de base doivent rester.
export const HARNESS_EXCLUDE: readonly string[] = [
  "delegate",
  "delegate_list",
  "delegate_steer",
  "delegate_stop",
];

/** Get extension tool names registered in the session */
export function getExtensionToolNames(session: any, exclude: readonly string[] = []): string[] {
  try {
    const allTools = session.getAllTools?.() ?? [];
    return allTools
      .map((t: any) => t.name)
      .filter((name: string) => !BASE_TOOLS.includes(name))
      .filter((name: string) => !exclude.includes(name))
      // Exclure les tools bloqués par plateforme (ex: powershell sur Linux)
      .filter((name: string) => !PLATFORM_BLOCKED_TOOLS.includes(name));
  } catch {
    return [];
  }
}

/** Merge base tools + extension tools for a given mode */
export function toolsForMode(
  session: any,
  baseTools: readonly string[],
  exclude: readonly string[] = [],
): string[] {
  return [...baseTools, ...getExtensionToolNames(session, exclude)];
}

/**
 * Tools ACTIFS d'un mode — point unique de vérité (BUG10).
 *  - `harness` : liste blanche explicite + tools MCP dynamiques de l'utilisateur.
 *    Jamais `toolsForMode` (qui ajouterait inconditionnellement TOUS les tools
 *    d'extension, donc ~20 outils inutiles à l'orchestrateur).
 *  - `code` : tools de base + tools d'extension, hors tools d'orchestration
 *    (BUG-71) — comportement historique inchangé.
 */
export function activeToolsForMode(session: any, mode: AgentMode): string[] {
  if (mode === "harness") {
    return filterPlatformTools([...HARNESS_TOOL_WHITELIST, ...getMcpToolNames(session)]);
  }
  return filterPlatformTools(toolsForMode(session, BASE_TOOLS, HARNESS_EXCLUDE));
}
