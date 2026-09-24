/**
 * repo-map.ts — « Carte du Repo » compacte pour les sous-agents (P1, étude
 * tokens/contexte des sous-agents : docs/etude-tokens-contexte-sous-agents.md).
 *
 * Problème : chaque sous-agent démarre dans une tempSession à contexte VIDE et
 * re-paie l'exploration (read/grep/find) que l'orchestrateur ou un autre
 * sous-agent a déjà payée. L'état de l'art (Aider) montre qu'il ne faut pas
 * compter sur le réflexe de l'agent : on lui INJECTE d'office une vue compacte
 * de la structure du dépôt (fichiers + symboles hubs + routes), et il lit
 * ensuite en ciblé.
 *
 * Ce module est PUR (aucun I/O, aucun accès au graphe, aucune dépendance
 * Express/SDK) : il reçoit les données brutes extraites du graphe CBM
 * (extensions/codebase-memory) et rend un texte borné. Testé dans
 * repo-map.test.ts (budget, boost de la tâche, dégradation ordonnée).
 *
 * Dégradation ordonnée : on essaie les paliers dans l'ordre
 *   signatures → noms seuls → arborescence
 * et on retient le PREMIER qui tient dans le budget. Si AUCUN ne tient, on
 * conserve le palier le plus riche et on le réduit SECTION par section : seules
 * des entrées ENTIÈRES sont retirées (jamais au milieu d'une ligne), chaque
 * section vidée disparaît entièrement et les entrées écartées sont signalées
 * par « … (N … de plus) ». Une section n'est donc jamais coupée en silence.
 * L'absence de données (graphe non indexé) rend une chaîne vide → le
 * appelant n'injecte rien et le sous-agent démarre normalement.
 */

// ── Constantes ──────────────────────────────────────────

/** Budget par défaut de la carte injectée (~1k tokens ≈ 4000 chars). */
export const REPO_MAP_BUDGET_CHARS = 4000;
/** Marqueur de début du bloc injecté dans le prompt système du sous-agent. */
export const REPO_MAP_MARKER_START = "<!-- PI_REPO_MAP -->";
/** Marqueur de fin du bloc injecté dans le prompt système du sous-agent. */
export const REPO_MAP_MARKER_END = "<!-- /PI_REPO_MAP -->";
/** Largeur max d'une ligne rendue (au-delà : troncature avec « … »). */
export const REPO_MAP_LINE_MAX = 200;
/** Nombre max de dossiers listés dans les paliers signatures/noms. */
export const REPO_MAP_MAX_DIRS = 16;
/** Nombre max d'entrées d'arborescence (palier le plus dégradé). */
export const REPO_MAP_MAX_TREE_FILES = 60;
/** Nombre max de symboles hubs listés. */
export const REPO_MAP_MAX_HUBS = 28;
/** Nombre max de routes listées. */
export const REPO_MAP_MAX_ROUTES = 12;
/** Nombre max de « hints » retenus depuis la tâche pour le boost. */
export const REPO_MAP_MAX_HINTS = 40;
/** Longueur max d'une signature avant troncature dans un symbole. */
export const REPO_MAP_SIGNATURE_MAX = 30;

// ── Types ───────────────────────────────────────────────

/** Symbole présent dans la carte (fonction hub, classe…). */
export interface RepoMapSymbol {
  /** Nom du symbole (ex. « loadModelLibrary »). */
  name: string;
  /** Fichier qui définit le symbole (relatif au projet), "" si inconnu. */
  file: string;
  /** Signature éventuelle (ex. « (id: string) »), absente = pas de signature. */
  signature?: string;
  /** Nombre d'appelants (CALLS entrants) — score de centralité. */
  inbound?: number;
}

/** Route HTTP compacte (méthode + chemin). */
export interface RepoMapRoute {
  /** Méthode HTTP (GET/POST/…). */
  method: string;
  /** Chemin de la route (ex. « /projects/:id »). */
  path: string;
}

/** Données brutes extraites du graphe CBM, avant rendu/budget. */
export interface RepoMapData {
  /** Chemins de fichiers (relatifs au projet). */
  files: string[];
  /** Symboles hubs (les plus référencés en premier). */
  hubs: RepoMapSymbol[];
  /** Routes HTTP exposées par le projet. */
  routes: RepoMapRoute[];
}

/**
 * Mode de classement de la carte (P3, prompt caching) :
 *  - "task"   : boost par les hints de la tâche (comportement historique),
 *               réservé au PREMIER MESSAGE USER (contenu variable par tâche) ;
 *  - "stable" : AUCUN hint de tâche — tri par centralité seule. Le texte ne
 *               dépend QUE du projet → injectable dans le PROMPT SYSTÈME sans
 *               casser le cache cross-délégation (même projet + même rôle).
 */
export type RepoMapRank = "task" | "stable";

/** Options de rendu de la carte. */
export interface BuildRepoMapOptions {
  /** Budget en caractères (défaut : REPO_MAP_BUDGET_CHARS). */
  budget?: number;
  /** Tâche déléguée : sert à booster les fichiers/symboles cités (rank "task"). */
  task?: string;
  /** Contexte additionnel (même rôle que task pour le boost). */
  context?: string;
  /** Largeur max d'une ligne (défaut : REPO_MAP_LINE_MAX). */
  lineMax?: number;
  /** Mode de classement (défaut : "task" — rétrocompatible). */
  rank?: RepoMapRank;
}

/** Palier de rendu, du plus riche au plus dégradé. */
export type RepoMapTier = "signatures" | "names" | "tree";

/** Ordre de dégradation : premier palier qui tient dans le budget. */
export const REPO_MAP_TIER_ORDER: readonly RepoMapTier[] = ["signatures", "names", "tree"];

// ── Boost de la tâche (pur) ──────────────────────────────

/**
 * Mots vides ignorés lors de l'extraction des hints (FR + EN + vocabulaire
 * de tâche trop générique pour discriminer un fichier).
 */
const STOPWORDS = new Set<string>([
  "the", "and", "for", "with", "from", "that", "this", "you", "are", "not",
  "but", "all", "any", "use", "using", "into", "your", "have", "has", "was",
  "were", "will", "would", "should", "could", "than", "then", "when", "where",
  "which", "what", "why", "how", "code", "test", "tests", "file", "files",
  "add", "new", "fix", "bug", "update", "change", "changes", "make", "made",
  "sur", "dans", "avec", "sans", "pour", "tout", "tous", "toute", "toutes",
  "cette", "cela", "leur", "leurs", "mais", "donc", "alors", "ainsi", "puis",
  "être", "avoir", "faire", "plus", "moins", "aussi", "comme", "entre", "vers",
  "task", "tâche", "carte", "repo", "map", "sous", "agent", "agents", "projet",
  "fichier", "fichiers", "codebase", "graph", "graphe", "fonction", "rôle",
]);

/**
 * Détecte un token qui « ressemble à un identifiant » (camelCase, snake_case,
 * $…) — plus discriminant qu'un simple mot. Reçoit le token en casse ORIGINALE.
 */
function looksLikeIdentifier(token: string): boolean {
  return token.includes("_") || token.includes("$") || /[a-z][A-Z]/.test(token);
}

/**
 * Extrait les hints utiles d'un texte (tâche + contexte) pour booster la
 * pertinence de la carte : chemins cités (ex. « backend/src/pi/session.ts »)
 * et identifiants (ex. « buildExplorationReminder »). Pur, borné, dédupliqué.
 */
export function extractTaskHints(text: string): string[] {
  const out = new Set<string>();
  if (!text || typeof text !== "string") return [];

  // 1. Chemins explicites (au moins un « / ») — signal le plus fort.
  const pathRe = /(?:[\w.-]+\/)+[\w.-]+/g;
  for (const m of text.matchAll(pathRe)) {
    const p = m[0].replace(/^[./]+/, "").toLowerCase();
    if (p && !STOPWORDS.has(p)) out.add(p);
  }

  // 2. Identifiants / tokens discriminants (camelCase, snake_case, ou ≥ 6 chars).
  const tokRe = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
  for (const m of text.matchAll(tokRe)) {
    const tok = m[0];
    const low = tok.toLowerCase();
    if (STOPWORDS.has(low)) continue;
    if (looksLikeIdentifier(tok) || low.length >= 6) out.add(low);
  }

  return [...out].slice(0, REPO_MAP_MAX_HINTS);
}

/** Nombre de hints contenus dans `value` (insensible à la casse). */
function hintBoost(value: string, hints: string[]): number {
  if (!value || hints.length === 0) return 0;
  const v = value.toLowerCase();
  let n = 0;
  for (const h of hints) {
    if (h && v.includes(h)) n += 1;
  }
  return n;
}

/**
 * Tri stable par score décroissant (le rang d'origine casse les égalités, donc
 * la sortie reste déterministe même sans hint).
 */
function stableSortByScore<T>(items: T[], score: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, s: score(item) }))
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((x) => x.item);
}

// ── Rendu (pur) ─────────────────────────────────────────

/** Réduit les espaces/retours ligne d'une chaîne (signatures multi-lignes). */
function collapseWs(s: string): string {
  // Les signatures du graphe contiennent parfois des séquences ÉCHAPPÉES
  // littérales (« \\n », « \\t », « \\" ») issues de la sérialisation JSON :
  // on les normalise avant de réduire les vrais espaces.
  return s
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

/** Tronque une ligne (au plus `max` caractères, suffixe « … »). */
function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  if (max <= 1) return line.slice(0, max);
  return line.slice(0, max - 1) + "…";
}

/** Libellé FR d'un palier de dégradation (apparaît dans l'en-tête). */
const TIER_LABEL: Record<RepoMapTier, string> = {
  signatures: "signatures",
  names: "noms seuls",
  tree: "arborescence",
};

/** En-tête de la carte : palier + compteurs + rappel d'usage des tools cbm_*. */
function renderHeader(data: RepoMapData, tier: RepoMapTier): string {
  const counts = `${data.files.length} fichiers · ${data.hubs.length} hubs · ${data.routes.length} routes`;
  const label = TIER_LABEL[tier];
  return `Carte du repo (CBM · ${label}) — ${counts}. Interroge cbm_* avant read/grep.`;
}

/** Ligne d'un symbole hub, avec ou sans signature. */
function renderHubLine(hub: RepoMapSymbol, lineMax: number, withSignature: boolean): string {
  let sig = "";
  if (withSignature && hub.signature) {
    const collapsed = collapseWs(hub.signature);
    sig = collapsed.length > REPO_MAP_SIGNATURE_MAX
      ? collapsed.slice(0, REPO_MAP_SIGNATURE_MAX - 1) + "…"
      : collapsed;
  }
  const label = sig ? `${hub.name}${sig}` : hub.name;
  const inbound = Number.isFinite(hub.inbound) ? ` (${hub.inbound}↩)` : "";
  const file = hub.file ? ` — ${hub.file}` : "";
  return truncateLine(`${label}${inbound}${file}`, lineMax);
}

/**
 * Dossiers distincts dérivés des chemins de fichiers (section « CHEMINS »).
 * Compact : un dossier parent par ligne, trié, NON borné ici — la borne
 * REPO_MAP_MAX_DIRS est appliquée par le découpage en sections, qui peut en plus
 * signaler les entrées non affichées (« … (N dossiers de plus) »).
 */
function distinctDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = String(f).split("/");
    parts.pop();
    if (parts.length > 0) dirs.add(parts.join("/"));
  }
  return [...dirs].sort();
}

/** Arborescence (dossiers + fichiers) compacte — palier le plus dégradé. */
function renderTree(files: string[], lineMax: number): string[] {
  const limited = files.slice(0, REPO_MAP_MAX_TREE_FILES);
  interface DirNode {
    dirs: Map<string, DirNode>;
    files: string[];
  }
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const f of limited) {
    const parts = String(f).split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts[i];
      let child = node.dirs.get(d);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(d, child);
      }
      node = child;
    }
    node.files.push(parts[parts.length - 1]);
  }
  const lines: string[] = [];
  const walk = (node: DirNode, prefix: string): void => {
    // Ordre alphabétique : l'arborescence est un repère de navigation, pas un
    // classement par pertinence (contrairement aux hubs/fichiers clés).
    for (const dirName of [...node.dirs.keys()].sort()) {
      lines.push(truncateLine(`${prefix}${dirName}/`, lineMax));
      walk(node.dirs.get(dirName)!, prefix + "  ");
    }
    for (const f of [...node.files].sort()) {
      lines.push(truncateLine(`${prefix}${f}`, lineMax));
    }
  };
  walk(root, "");
  return lines;
}

// ── Sections (base de la troncature par section) ─────────
// Une section = un titre + des entrées ENTIÈRES. Le rendu budgété ne retire que
// des entrées entières (jamais un milieu de ligne) et signale explicitement les
// entrées non affichées par « … (N … de plus) » : une section ne doit JAMAIS
// paraître coupée en silence par le mécanisme d'injection.
interface RepoMapSection {
  /** Titre affiché (ex. « ROUTES: »). */
  title: string;
  /** Entrées affichables (déjà tronquées à `lineMax`, déjà bornées par MAX). */
  entries: string[];
  /** Nombre TOTAL d'entrées disponibles (≥ entries.length). */
  total: number;
  /** Libellé des entrées écartées (« routes », « hubs », « dossiers »). */
  label: string;
}

/** Lignes d'une section pour `keep` entrées conservées (marqueur inclus). */
function sectionLines(section: RepoMapSection, keep: number): string[] {
  const lines = [section.title];
  const k = Math.max(0, Math.min(keep, section.entries.length));
  for (let i = 0; i < k; i++) lines.push(section.entries[i]);
  if (k < section.total) lines.push(`… (${section.total - k} ${section.label} de plus)`);
  return lines;
}

/** Assemble l'en-tête + les sections conservées (entrées ENTIÈRES uniquement). */
function joinSections(
  header: string,
  sections: Array<{ section: RepoMapSection; keep: number }>,
): string {
  const parts = [header];
  for (const { section, keep } of sections) {
    if (keep <= 0) continue;
    parts.push(sectionLines(section, keep).join("\n"));
  }
  return parts.join("\n");
}

/**
 * Découpe un palier en sections (CHEMINS / HUBS / ROUTES, ou ARBRE au palier le
 * plus dégradé). Les bornes MAX sont appliquées ici ; `total` mémorise la taille
 * réelle pour que le rendu signale explicitement les entrées non affichées.
 */
function buildSections(tier: RepoMapTier, data: RepoMapData, lineMax: number): RepoMapSection[] {
  if (tier === "tree") {
    if (data.files.length > 0) {
      const entries = renderTree(data.files, lineMax);
      return [{ title: "ARBRE:", entries, total: entries.length, label: "fichiers" }];
    }
    if (data.hubs.length > 0) {
      // Repli : pas de fichiers connus, on liste au moins les noms de hubs.
      const entries = data.hubs.slice(0, REPO_MAP_MAX_HUBS).map((h) => truncateLine(h.name, lineMax));
      return [{ title: "HUBS (noms):", entries, total: data.hubs.length, label: "hubs" }];
    }
    return [];
  }
  const sections: RepoMapSection[] = [];
  if (data.files.length > 0) {
    const all = distinctDirs(data.files);
    const entries = all.slice(0, REPO_MAP_MAX_DIRS).map((d) => truncateLine(d, lineMax));
    sections.push({ title: "CHEMINS:", entries, total: all.length, label: "dossiers" });
  }
  if (data.hubs.length > 0) {
    const entries = data.hubs
      .slice(0, REPO_MAP_MAX_HUBS)
      .map((h) => renderHubLine(h, lineMax, tier === "signatures"));
    sections.push({
      title: tier === "signatures" ? "HUBS:" : "HUBS (noms):",
      entries,
      total: data.hubs.length,
      label: "hubs",
    });
  }
  if (data.routes.length > 0) {
    const entries = data.routes
      .slice(0, REPO_MAP_MAX_ROUTES)
      .map((r) => truncateLine(`${(r.method || "?").toUpperCase()} ${r.path}`, lineMax));
    sections.push({ title: "ROUTES:", entries, total: data.routes.length, label: "routes" });
  }
  return sections;
}

/** Rend un palier SANS appliquer le budget (le budget est décidé par l'appelant). */
function renderTier(tier: RepoMapTier, data: RepoMapData, lineMax: number): string {
  const sections = buildSections(tier, data, lineMax);
  return joinSections(
    renderHeader(data, tier),
    sections.map((section) => ({ section, keep: section.entries.length })),
  );
}

/** Prépare (classement + boost) une copie des données, sans mutation. */
function prepareRanked(data: RepoMapData, options: BuildRepoMapOptions): {
  ranked: RepoMapData;
  lineMax: number;
} {
  // Mode stable (P3) : aucun hint de tâche → le classement ne dépend que du
  // projet (centralité `inbound` pour les hubs, ordre naturel pour les
  // fichiers). C'est la condition du prompt caching cross-délégation.
  const hints =
    options.rank === "stable"
      ? []
      : extractTaskHints(`${options.task ?? ""}\n${options.context ?? ""}`);
  const files = Array.isArray(data?.files) ? data.files.filter((f) => typeof f === "string" && f) : [];
  const hubs = Array.isArray(data?.hubs) ? data.hubs.filter((h) => h && h.name) : [];
  const routes = Array.isArray(data?.routes) ? data.routes.filter((r) => r && r.path) : [];

  const rankedFiles = stableSortByScore(files, (f) => hintBoost(f, hints));
  const rankedHubs = stableSortByScore(
    hubs,
    (h) => hintBoost(h.name, hints) * 1_000_000 + hintBoost(h.file, hints) * 1_000 + (Number(h.inbound) || 0),
  );
  // Routes : tri déterministe par (méthode, chemin) — les routes ne sont jamais
  // boostées, et un ordre explicite garantit un rendu stable (P3) même si
  // l'extraction amont ne garantit pas son ordre.
  const rankedRoutes = [...routes].sort((a, b) =>
    `${(a.method || "").toUpperCase()}\u0000${a.path}`.localeCompare(
      `${(b.method || "").toUpperCase()}\u0000${b.path}`,
    ),
  );
  return {
    ranked: { files: rankedFiles, hubs: rankedHubs, routes: rankedRoutes },
    lineMax: options?.lineMax && options.lineMax > 0 ? options.lineMax : REPO_MAP_LINE_MAX,
  };
}

/**
 * Rend un palier donné (classé/boosté) — exporté pour les tests (mesure de
 * taille par palier) et pour d'éventuels usages ciblés.
 */
export function renderRepoMapTier(
  data: RepoMapData,
  tier: RepoMapTier,
  options: BuildRepoMapOptions = {},
): string {
  const { ranked, lineMax } = prepareRanked(data, options);
  return renderTier(tier, ranked, lineMax);
}

/**
 * Ajuste un palier au budget en RETIRANT DES ENTRÉES ENTIÈRES, section par
 * section (jamais au milieu d'une ligne). Déterministe : on réduit toujours la
 * section actuellement la plus volumineuse (à égalité, la plus tardive), ce qui
 * répartit la réduction entre CHEMINS/HUBS/ROUTES au lieu de sacrifier la
 * dernière. Une section vidée disparaît ENTIÈREMENT (titre compris) ; en dernier
 * recours (en-tête seul encore trop long), l'en-tête est tronqué.
 */
function fitSectionsToBudget(header: string, sections: RepoMapSection[], budget: number): string {
  if (budget <= 0) return "";
  const keep = sections.map((s) => s.entries.length);
  const current = (): string =>
    joinSections(header, sections.map((section, i) => ({ section, keep: keep[i] })));

  while (current().length > budget) {
    let pick = -1;
    let best = -1;
    for (let i = 0; i < sections.length; i++) {
      if (keep[i] <= 0) continue;
      const len = sectionLines(sections[i], keep[i]).join("\n").length;
      if (len >= best) {
        best = len;
        pick = i;
      }
    }
    if (pick < 0) break; // plus aucune entrée à retirer
    keep[pick]--;
  }

  const out = current();
  if (out.length <= budget) return out;
  // Même l'en-tête dépasse le budget : on le tronque (jamais une section).
  return truncateLine(header, budget);
}

/**
 * Construit la carte du repo, bornée au budget.
 *
 * Dégradation ordonnée (« signatures » → « noms seuls » → « arborescence ») :
 * le premier palier dont le rendu tient dans le budget est retourné. Si aucun ne
 * tient, le palier le plus riche est réduit SECTION par section (entrées
 * entières retirées, non affichées signalées) — jamais au milieu d'une ligne.
 *
 * `options.rank` (P3) : "stable" ignore les hints de la tâche → le texte ne
 * dépend que du projet, donc réutilisable dans un prompt système cachable.
 *
 * @returns le texte de la carte, ou "" si les données sont vides (graphe non
 *          indexé) — l'appelant n'injecte alors rien.
 */
export function buildRepoMap(data: RepoMapData, options: BuildRepoMapOptions = {}): string {
  if (!data) return "";
  const files = Array.isArray(data.files) ? data.files : [];
  const hubs = Array.isArray(data.hubs) ? data.hubs : [];
  const routes = Array.isArray(data.routes) ? data.routes : [];
  if (files.length === 0 && hubs.length === 0 && routes.length === 0) return "";

  const budget = Number.isFinite(options.budget as number) && (options.budget as number) > 0
    ? (options.budget as number)
    : REPO_MAP_BUDGET_CHARS;
  const { ranked, lineMax } = prepareRanked({ files, hubs, routes }, options);

  // 1. Dégradation ordonnée : premier palier qui tient SANS troncature.
  for (const tier of REPO_MAP_TIER_ORDER) {
    const text = renderTier(tier, ranked, lineMax);
    if (text.length <= budget) return text;
  }
  // 2. Aucun palier ne tient : troncature PAR SECTION du palier le plus riche
  //    (signatures). On préfère conserver un maximum d'information plutôt que
  //    de tout jeter en passant directement à l'arborescence.
  const sections = buildSections("signatures", ranked, lineMax);
  return fitSectionsToBudget(renderHeader(ranked, "signatures"), sections, budget);
}
