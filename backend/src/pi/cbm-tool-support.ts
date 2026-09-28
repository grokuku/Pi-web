/**
 * cbm-tool-support.ts — Logique PURE de support des tools CBM.
 *
 * L'extension `extensions/codebase-memory` (chargée par jiti, non couverte par
 * vitest) importe ce module comme les autres helpers backend (repo-map,
 * cbm-project-resolution, cbm-stats). Tout ce qui est testable sans I/O vit ici :
 *   - « search_graph » refuse `query` ET `semantic_query` ensemble
 *     (« query and semantic_query are mutually exclusive », vérifié en direct
 *     sur le serveur CBM) → construction des arguments sans jamais les deux ;
 *   - repli « symbol not found » de `get_code_snippet` → parsing de la table
 *     texte de `search_graph` et choix du `qualified_name` à retenter ;
 *   - politique de re-tentative du registre des projets CBM (registre vide au
 *     moment d'un appel = daemon probablement en respawn).
 */

export interface CbmSearchParams {
  query?: unknown;
  labels?: unknown;
  name_pattern?: unknown;
  semantic_query?: unknown;
  limit?: unknown;
  file_pattern?: unknown;
}

/**
 * Construit les arguments MCP de `search_graph` pour le tool `cbm_search`.
 *
 * RÈGLE SERVEUR (vérifiée en direct) : `query` (BM25) et `semantic_query`
 * (vectoriel) sont MUTUELLEMENT EXCLUSIFS — les envoyer ensemble échoue avec
 * « query and semantic_query are mutually exclusive » (13 échecs cumulés).
 * Quand le modèle fournit les deux, `semantic_query` (l'intention la plus
 * explicite) gagne et `query` n'est PAS envoyé. `query` seul reste le chemin
 * nominal, strictement inchangé (mêmes clés, mêmes valeurs).
 */
export function buildSearchGraphArgs(params: CbmSearchParams): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const semantic =
    Array.isArray(params.semantic_query) && params.semantic_query.length > 0
      ? params.semantic_query
      : null;
  if (semantic) {
    args.semantic_query = semantic;
  } else {
    args.query = params.query;
  }
  // Le serveur attend `label` (string), pas `labels` (array), et n'en gère
  // qu'un seul par appel → on envoie le premier élément.
  if (Array.isArray(params.labels) && params.labels.length > 0) {
    args.label = String(params.labels[0]);
  }
  if (params.name_pattern) args.name_pattern = params.name_pattern;
  if (params.limit) args.limit = params.limit;
  if (params.file_pattern) args.file_pattern = params.file_pattern;
  return args;
}

/** Échappe les métacaractères d'un littéral pour le moteur regex de CBM. */
export function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extrait un nom de symbole exploitable depuis un paramètre LLM bruité :
 * « f(x: string) » → « f », « src/a.ts:f » → « f ». Les parenthèses sont
 * retirées AVANT le préfixe « fichier: » pour ne pas couper au premier « : »
 * d'une signature (ex. « f(x: string) »).
 */
export function extractSymbolName(name: string): string {
  let candidate = String(name ?? "").trim();
  if (!candidate) return "";
  candidate = candidate.replace(/\(.*\)\s*$/, "").trim();
  const colon = candidate.lastIndexOf(":");
  if (colon >= 0) {
    const after = candidate.slice(colon + 1).trim();
    if (after) candidate = after;
  }
  return candidate;
}

/**
 * Pattern `name_pattern` à partir du nom demandé au tool `cbm_code` : nettoie
 * les formes fréquentes (`fichier.ts:nom`, `nom(args)`) puis échappe le
 * littéral. Volontairement NON ancré : on cherche des candidats proches, comme
 * le recommande le serveur (« Use search_graph(name_pattern="...") first »).
 */
export function buildQualifiedNamePattern(name: string): string {
  const candidate = extractSymbolName(name);
  return candidate ? escapeRegExp(candidate) : "";
}

/** Une ligne de la table texte renvoyée par `search_graph`. */
export interface SearchGraphRow {
  /** Première colonne de la table : le nom qualifié CBM. */
  qualifiedName: string;
  label: string;
  file: string;
}

/** Découpe une ligne de table en cellules, en respectant les cellules citées. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === " ") i++;
    if (i >= line.length) break;
    let value = "";
    if (line[i] === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === "\\" && i + 1 < line.length) {
          value += line[i + 1];
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i++;
          break;
        }
        value += line[i];
        i++;
      }
    } else {
      const start = i;
      while (i < line.length && line[i] !== " ") i++;
      value = line.slice(start, i);
    }
    cells.push(value);
  }
  return cells;
}

/**
 * Parse la PREMIÈRE table de données d'une réponse texte de `search_graph` :
 *   results: 2  (cols: qn label file lines in out)
 *     <qn> <label> <file> …
 *   total: 2
 * La position des colonnes est lue dans l'en-tête `cols:` (le jeu de colonnes
 * varie selon le mode : `in/out`, `rank`…). On s'arrête au premier pied de
 * page (ligne non indentée, ex. `total:` / `semantic_total:`) pour ignorer une
 * éventuelle seconde section. Tolérant : ignore ce qu'il ne comprend pas.
 */
export function parseSearchGraphRows(raw: string): SearchGraphRow[] {
  const lines = String(raw ?? "").split("\n");
  const headerIdx = lines.findIndex((l) => /\(cols:\s/.test(l));
  if (headerIdx < 0) return [];
  const colsMatch = lines[headerIdx].match(/\(cols:\s*([^)]+)\)/);
  if (!colsMatch) return [];
  const cols = colsMatch[1].trim().split(/\s+/);
  const qnIdx = cols.indexOf("qn");
  if (qnIdx < 0) return [];
  const labelIdx = cols.indexOf("label");
  const fileIdx = cols.indexOf("file");

  const rows: SearchGraphRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) break; // pied de page → fin de la table
    const cells = splitTableRow(line.trim());
    const qualifiedName = cells[qnIdx];
    if (!qualifiedName) continue;
    rows.push({
      qualifiedName,
      label: labelIdx >= 0 ? cells[labelIdx] ?? "" : "",
      file: fileIdx >= 0 ? cells[fileIdx] ?? "" : "",
    });
  }
  return rows;
}

/** Un fichier de ligne correspond-il au `file` demandé (chemin relatif/absolu) ? */
function fileMatches(rowFile: string, requested: string): boolean {
  const f = (rowFile || "").trim();
  const req = (requested || "").trim().replace(/^\.\//, "");
  if (!req) return true;
  if (f === req) return true;
  if (f.endsWith("/" + req)) return true;
  if (req.startsWith("/") && f.endsWith(req)) return true;
  // Candidat relatif (« extensions/a.ts ») vs `file` absolu demandé.
  if (req.startsWith("/") && f && req.endsWith("/" + f)) return true;
  return false;
}

/**
 * Choisit le candidat à retenter pour `get_code_snippet` : unique, ou unique
 * après filtrage par `file`, ou unique correspondance EXACTE du dernier
 * composant du qn avec le nom demandé. null = ambigu (l'appelant produit alors
 * une erreur listant les candidats plutôt que de deviner).
 */
export function pickSearchGraphCandidate(
  rows: SearchGraphRow[],
  opts: { name?: string; file?: string } = {},
): SearchGraphRow | null {
  if (rows.length === 0) return null;
  let candidates = rows;
  const file = (opts.file || "").trim();
  if (file) {
    candidates = rows.filter((r) => fileMatches(r.file, file));
    if (candidates.length === 0) return null; // le fichier demandé ne matche rien
  }
  if (candidates.length === 1) return candidates[0];
  const wanted = extractSymbolName(String(opts.name ?? ""));
  if (wanted) {
    const exact = candidates.filter((r) => r.qualifiedName.split(".").pop() === wanted);
    if (exact.length === 1) return exact[0];
  }
  return null;
}

/** Message EXPLICITE quand plusieurs homonymes empêchent le repli automatique. */
export function buildSnippetAmbiguityMessage(name: string, rows: SearchGraphRow[]): string {
  const suggestions = rows
    .slice(0, 5)
    .map((r) => `  - ${r.qualifiedName}${r.file ? ` (${r.file})` : ""}`)
    .join("\n");
  return (
    `get_code_snippet : « ${name} » correspond à ${rows.length} symboles — impossible de choisir ` +
    `sans ambiguïté. Précisez le paramètre \`file\`, ou passez le qualified_name complet :\n${suggestions}`
  );
}

/**
 * Faut-il forcer UNE re-tentative de `list_projects` avant de résoudre un
 * projet ? Uniquement quand le registre est VIDE : aucune liste n'a abouti
 * depuis le démarrage, typiquement parce que le daemon CBM redémarre
 * (« last_committed_client_disconnected »). Registre déjà rempli → aucune
 * latence ajoutée (BUG #2).
 */
export function shouldRetryEmptyRegistry(registrySize: number): boolean {
  return registrySize === 0;
}

/**
 * Erreur EXPLICITE et actionnable (BUG #2) renvoyée à la place de l'ancien
 * repli silencieux sur le nom de dossier (qui produisait un `project_not_found`
 * opaque côté serveur, 14 échecs cumulés). `name` est lu par l'extension pour
 * classer l'échec (`server_unavailable`).
 */
export function buildProjectUnresolvedError(cwd: string): Error {
  const error = new Error(
    `CBM : impossible de résoudre le projet indexé pour « ${cwd} » — le registre des projets est vide ` +
      `(list_projects n'a rien renvoyé ; le serveur codebase-memory-mcp est probablement en cours de redémarrage). ` +
      `Réessayez dans quelques secondes ; si l'échec persiste, vérifiez l'état du serveur via /api/cbm/status.`,
  );
  error.name = "CbmProjectUnresolvedError";
  return error;
}
