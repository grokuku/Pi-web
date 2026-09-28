/**
 * cbm-project-resolution.ts — Résolution du nom de projet CBM depuis un cwd.
 *
 * PROBLÈME (cause racine du blocage CBM en workspaces composites) :
 *   CBM identifie chaque projet indexé par son `root_path` (voir list_projects).
 *   Or le pont `extensions/codebase-memory` dérivait le nom de projet du NOM DE
 *   DOSSIER du cwd (`cwd.split("/").pop()`). C'est correct quand le cwd EST la
 *   racine d'un dépôt indexé (« /projects/Pi-Web » → « Pi-Web », que CBM accepte
 *   en plus du nom complet « projects-Pi-Web »), mais faux dès que :
 *     - le cwd est un SOUS-DOSSIER d'un dépôt indexé ;
 *     - le cwd est un workspace COMPOSITE (fichier `.pi-web-linked`) jamais
 *       indexé (ex. « Yuki and Libs », « LINKED AI Helper »).
 *   Dans ces cas le nom envoyé (« Yuki and Libs ») ne correspond à aucun projet
 *   → ``{"error":"project not found or not indexed"}`` et le sous-agent
 *   abandonne CBM au profit de read/grep.
 *
 * RÈGLE RETENUE (du plus au moins précis) :
 *   1. racine de cwd == racine d'un projet indexé  → cas nominal INCHANGÉ ;
 *   2. sinon, projet indexé dont la racine est l'ANCÊTRE le plus proche du cwd
 *      (sous-dossier d'un dépôt, ou composite qui contient un sous-projet) ;
 *   3. sinon, pour un workspace lié, la cible d'un symlink qui est elle-même
 *      un projet indexé (le workspace composite n'a pas de graphe propre) ;
 *   4. sinon → null : l'appelant garde son repli historique (nom de dossier).
 *
 * Ce module est PUR (aucun I/O, aucun état, aucune dépendance SDK) : les
 * symlinks du workspace lié sont résolus par l'appelant et passés via
 * `linkedTargets`. Testé dans cbm-project-resolution.test.ts.
 */

export interface IndexedProject {
  /** Chemin racine absolu tel que renvoyé par list_projects. */
  rootPath: string;
  /** Nom du projet côté CBM (préfixe « projects-… »). */
  name: string;
}

export interface ResolveCbmProjectOptions {
  /**
   * Chemins réels des symlinks d'un workspace lié (déjà résolus par
   * l'appelant via realpathSync). Utilisés seulement si aucune règle
   * cwd/ancêtre ne matche.
   */
  linkedTargets?: string[];
}

/** Normalise un chemin racine : trim + suppression des « / » finaux. */
export function normalizeRootPath(p: string): string {
  const trimmed = (p || "").trim().replace(/\/+$/, "");
  return trimmed || "/";
}

/**
 * Parse la réponse de `list_projects` dans les deux formats connus :
 *   - JSON (ancienne hypothèse du code, conservée par sécurité) ;
 *   - table texte : en-tête « projects: N  (cols: name root_path branch) »
 *     puis une ligne par projet « nom chemin [branche] », le chemin pouvant
 *     être entre guillemets s'il contient des espaces.
 * Ignore silencieusement ce qu'il ne comprend pas (best-effort).
 */
export function parseProjectList(raw: string): IndexedProject[] {
  // 1) JSON : tableau brut ou { projects | results: [...] }
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed?.projects || parsed?.results || [];
    if (Array.isArray(arr) && arr.every((p: any) => p && typeof p === "object")) {
      return arr
        .map((p: any) => ({
          name: String(p.name ?? ""),
          rootPath: String(p.root_path || p.path || p.repo_path || p.repo || ""),
        }))
        .filter((p: IndexedProject) => p.name && p.rootPath);
    }
  } catch {
    /* pas du JSON → on tente la table texte */
  }

  // 2) Table texte : « nom chemin [branche] ».
  const out: IndexedProject[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\S+)\s+("(?:[^"\\]|\\.)*"|\S+)/);
    if (!m) continue;
    // En-tête « projects: » et pieds de page « total: » / « returned: » /
    // « has_more: » / « truncated: » : libellés terminés par « : ».
    if (m[1].endsWith(":")) continue;
    let rootPath = m[2];
    if (rootPath.startsWith('"') && rootPath.endsWith('"')) {
      rootPath = rootPath.slice(1, -1).replace(/\\"/g, '"');
    }
    if (!rootPath) continue;
    out.push({ name: m[1], rootPath });
  }
  return out;
}

/** Projet indexé dont la racine est l'ancêtre STRICT le plus profond du chemin. */
function closestAncestor(target: string, indexed: IndexedProject[]): IndexedProject | null {
  let best: IndexedProject | null = null;
  let bestLen = -1;
  for (const project of indexed) {
    const root = normalizeRootPath(project.rootPath);
    // La racine du système de fichiers n'est jamais un projet « pertinent ».
    if (root === "/") continue;
    if (target.startsWith(root + "/") && root.length > bestLen) {
      best = project;
      bestLen = root.length;
    }
  }
  return best;
}

/**
 * Applique la règle de résolution et renvoie le nom CBM, ou null si aucun
 * projet indexé ne correspond (l'appelant décide du repli).
 */
export function resolveCbmProjectName(
  cwd: string,
  indexed: IndexedProject[],
  options: ResolveCbmProjectOptions = {},
): string | null {
  if (!cwd) return null;
  const target = normalizeRootPath(cwd);

  // 1) Racine exacte (cas nominal).
  const exact = indexed.find((p) => normalizeRootPath(p.rootPath) === target);
  if (exact) return exact.name;

  // 2) Ancêtre le plus proche (sous-dossier / composite contenant un sous-projet).
  const ancestor = closestAncestor(target, indexed);
  if (ancestor) return ancestor.name;

  // 3) Workspace lié : cible exacte d'un symlink.
  const linked = options.linkedTargets ?? [];
  for (const raw of linked) {
    const t = normalizeRootPath(raw);
    const match = indexed.find((p) => normalizeRootPath(p.rootPath) === t);
    if (match) return match.name;
  }
  // 4) Workspace lié : ancêtre d'une cible de symlink.
  for (const raw of linked) {
    const match = closestAncestor(normalizeRootPath(raw), indexed);
    if (match) return match.name;
  }

  return null;
}

/**
 * Sous-projet d'un workspace LIÉ (« composite ») : nom lisible (nom de dossier
 * du symlink dans le composite) + racine RÉELLE du dépôt.
 *
 * La racine RÉELLE (realpath du symlink) est le SEUL chemin qui identifie le
 * projet CBM : CBM n'indexe PAS les symlinks (prouvé en direct, un dossier de
 * symlinks donne un graphe vide), donc interroger/indexer le chemin du symlink
 * est inopérant. `name` sert uniquement d'étiquette de provenance (en-têtes
 * « ## [nom] »).
 */
export interface LinkedSubprojectRef {
  /** Nom du sous-projet (nom de dossier du symlink dans le composite). */
  name: string;
  /** Racine RÉELLE du dépôt (chemin absolu, symlink résolu via realpath). */
  rootPath: string;
}

/**
 * Nom CBM du projet indexé correspondant à la racine d'un SOUS-PROJET : racine
 * EXACTE, sinon ancêtre indexé le plus proche (tolérance : un sous-projet
 * imbriqué dans un dépôt lui-même indexé). null si rien ne correspond.
 */
export function resolveCbmProjectNameForRoot(
  rootPath: string,
  indexed: IndexedProject[],
): string | null {
  const target = normalizeRootPath(rootPath);
  const exact = indexed.find((p) => normalizeRootPath(p.rootPath) === target);
  if (exact) return exact.name;
  const ancestor = closestAncestor(target, indexed);
  return ancestor ? ancestor.name : null;
}

/**
 * Cible fédérée : un sous-projet résolu, avec son étiquette de provenance
 * (`name`) et son nom CBM (`project`).
 */
export interface LinkedTarget {
  /** Nom du sous-projet (nom de dossier du symlink), pour les en-têtes. */
  name: string;
  /** Nom CBM du projet indexé à interroger. */
  project: string;
}

/**
 * Résout les sous-projets d'un composite en CIBLES interrogeables : pour chaque
 * sous-projet, le nom CBM du projet indexé correspondant ; les sous-projets non
 * résolus sont EXCLUS, et les doublons (deux symlinks vers le même graphe)
 * dédupliqués. L'ORDRE D'ENTRÉE est conservé (déterminisme de la fusion).
 */
export function resolveLinkedTargets(
  indexed: IndexedProject[],
  linkedSubprojects: LinkedSubprojectRef[],
): LinkedTarget[] {
  const out: LinkedTarget[] = [];
  const seen = new Set<string>();
  for (const sub of linkedSubprojects) {
    const project = resolveCbmProjectNameForRoot(sub.rootPath, indexed);
    if (!project || seen.has(project)) continue;
    seen.add(project);
    out.push({ name: sub.name, project });
  }
  return out;
}

/**
 * Liste ORDONNÉE et DÉDUPLIQUÉE des noms de projets CBM à interroger pour un
 * cwd — base de la FÉDÉRATION des workspaces liés.
 *
 * RÈGLE :
 *  - `linkedSubprojects` NON VIDE → le cwd est un workspace COMPOSITE ; on
 *    résout CHAQUE sous-projet (les non-résolus sont exclus) et on renvoie
 *    leurs noms dans l'ORDRE D'ENTRÉE, sans doublon. La détection de composite
 *    PRIME sur la règle « ancêtre le plus proche » : sinon un composite IMBRIQUÉ
 *    dans un dossier lui-même indexé (ex. « Yuki and Libs » dans /projects/Yuki)
 *    résoudrait vers le parent au lieu des sous-projets.
 *  - `linkedSubprojects` VIDE → comportement à cible UNIQUE STRICTEMENT
 *    inchangé : `[resolveCbmProjectName(...)]`, ou `[]` si non résolu.
 */
export function resolveCbmProjectNames(
  cwd: string,
  indexed: IndexedProject[],
  linkedSubprojects: LinkedSubprojectRef[] = [],
): string[] {
  if (linkedSubprojects.length > 0) {
    return resolveLinkedTargets(indexed, linkedSubprojects).map((t) => t.project);
  }
  const single = resolveCbmProjectName(cwd, indexed);
  return single ? [single] : [];
}
