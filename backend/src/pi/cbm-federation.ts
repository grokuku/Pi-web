/**
 * cbm-federation.ts — logique PURE de la FÉDÉRATION CBM (workspaces liés).
 *
 * Un workspace LIÉ (marqueur `.pi-web-linked`) est un COMPOSITE de plusieurs
 * dépôts (symlinks) jamais indexé comme un tout (CBM n'indexe pas les symlinks).
 * Depuis une session ouverte sur le composite, les tools cbm_* doivent donc
 * interroger CHAQUE sous-projet puis FUSIONNER les réponses en annotant leur
 * provenance.
 *
 * Ce module ne fait AUCUN I/O et ne connaît ni l'extension ni le serveur : il
 * reçoit des parts déjà collectées et rend le texte final. Il vit ici (backend)
 * pour être couvert par vitest — l'extension `extensions/codebase-memory` n'est
 * typecheckée que par `npm run typecheck:extensions`, pas testée.
 *
 * GARANTIE DE NON-RÉGRESSION : une FÉDÉRATION À UNE SEULE PART rend le texte
 * BRUT (sans en-tête), donc byte-identique au comportement historique des
 * projets non liés. Les en-têtes `## [nom]` n'apparaissent qu'à partir de DEUX
 * parts.
 */

import { normalizeRootPath, type LinkedSubprojectRef } from "./cbm-project-resolution.js";

/** Une part de résultat fédéré : un sous-projet, son texte ou son erreur. */
export interface FederatedPart {
  /** Nom du sous-projet (étiquette de provenance, ex. « holaf-lib »). */
  name: string;
  /** Texte brut renvoyé par CBM (vide si erreur). */
  text: string;
  /** Message d'erreur de CETTE part (les autres parts restent affichées). */
  error?: string;
}

/** En-tête de provenance d'une part : `## [nom]`. */
function header(name: string): string {
  return `## [${name}]`;
}

/**
 * Une réponse CBM est-elle « vide » (aucun résultat) ?
 *
 * CBM renvoie TOUJOURS un en-tête/pied de table, même sans résultat
 * (« results: 0 … », « total: 0 … ») : la seule chaîne vide ne suffit donc pas.
 * On considère qu'une part est vide si elle n'a ni ligne de DONNÉES indentée
 * (les lignes de table CBM le sont) ni marqueur explicite de zéro.
 */
export function isNoResultsPart(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return true;
  // Une ligne de données CBM est indentée (2 espaces) ; son absence + un
  // compteur à zéro signe une réponse vide.
  const hasDataRow = /^\s+\S/m.test(t);
  if (hasDataRow) return false;
  if (/^\s*(results|total|matches|nodes|edges|returned):\s*0\b/im.test(t)) return true;
  if (/no (nodes|results|matches) found/i.test(t)) return true;
  return false;
}

/**
 * Fusionne les parts fédérées.
 *
 *  - 0 part → "" (rien à afficher) ;
 *  - 1 part → texte BRUT (ou `## [nom]\nCBM error: …`) — byte-identique à
 *    l'existant pour les projets non liés ;
 *  - N parts → un bloc par part, dans l'ordre fourni :
 *      part peuplée   → `## [nom]\n<texte>` ;
 *      part vide      → `## [nom]\n(no results)` ;
 *      part en erreur → `## [nom]\nCBM error: <msg>` (les autres restent) ;
 *  - toutes les parts en erreur → une ligne d'aide actionnable + le détail.
 */
export function mergeFederatedParts(parts: FederatedPart[]): string {
  const list = Array.isArray(parts) ? parts.filter((p): p is FederatedPart => !!p) : [];
  if (list.length === 0) return "";
  if (list.length === 1) {
    const p = list[0];
    if (p.error) return `${header(p.name)}\nCBM error: ${p.error}`;
    return p.text ?? "";
  }
  const allErrors = list.every((p) => !!p.error);
  if (allErrors) {
    const details = list.map((p) => `- ${p.name} : CBM error: ${p.error}`).join("\n");
    return (
      "CBM fédéré : aucun sous-projet n'a répondu (tous en erreur). " +
      "Vérifiez que les index des sous-projets sont à jour (l'indexation se fait " +
      "automatiquement à l'ouverture de la session), puis réessayez.\n" +
      details
    );
  }
  return list
    .map((p) => {
      if (p.error) return `${header(p.name)}\nCBM error: ${p.error}`;
      if (isNoResultsPart(p.text)) return `${header(p.name)}\n(no results)`;
      return `${header(p.name)}\n${String(p.text ?? "").trim()}`;
    })
    .join("\n\n");
}

/** Normalise un chemin POSIX (résout `.`/`..`/`//`) sans toucher au disque. */
function normalizePosix(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(part);
    }
  }
  const joined = out.join("/");
  if (absolute) return "/" + joined;
  return joined || ".";
}

/** Résout `rawPath` (relatif → contre `cwd`) en chemin POSIX normalisé. */
function resolveAgainst(rawPath: string, cwd: string): string {
  const raw = String(rawPath ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("/")) return normalizePosix(raw);
  const base = normalizePosix(String(cwd ?? "").trim() || "/");
  return normalizePosix(base === "/" ? "/" + raw : base + "/" + raw);
}

/** `path` est-il égal à `root` ou situé sous `root` (dossiers, pas de faux préfixe) ? */
function isInside(path: string, root: string): boolean {
  const r = normalizeRootPath(root);
  if (!r || r === "/") return false;
  return path === r || path.startsWith(r + "/");
}

/**
 * Déduit le sous-projet VISÉ par un chemin (relatif au cwd ou absolu) : sert à
 * router `cbm_diff` (et la ré-indexation ciblée) vers LE sous-projet touché.
 *
 * Un chemin est reconnu s'il pointe sous la racine RÉELLE du sous-projet OU sous
 * l'emplacement de son symlink dans le composite (`<cwd>/<nom>`) — un diff git
 * lancé dans un sous-projet renvoie en effet des chemins relatifs à SA racine,
 * tandis qu'un appelant peut fournir un chemin passant par le symlink.
 *
 * @returns le NOM du sous-projet visé, ou null si aucun / AMBIGU (≥ 2 matchs).
 */
export function inferTargetFromPath(
  rawPath: string,
  cwd: string,
  subs: LinkedSubprojectRef[],
): string | null {
  const resolved = resolveAgainst(rawPath, cwd);
  if (!resolved || !Array.isArray(subs) || subs.length === 0) return null;
  let match: string | null = null;
  for (const sub of subs) {
    const roots = [normalizeRootPath(sub.rootPath), resolveAgainst(sub.name, cwd)];
    const inside = roots.some((r) => isInside(resolved, r));
    if (!inside) continue;
    if (match && match !== sub.name) return null; // ambigu → pas de routage
    match = sub.name;
  }
  return match;
}

/**
 * Message d'erreur ACTIONNABLE quand un paramètre `target` est inconnu : il
 * liste les cibles valides pour que le LLM puisse corriger immédiatement.
 */
export function listTargetsHint(names: string[]): string {
  const valid = (Array.isArray(names) ? names : []).filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
  if (valid.length === 0) {
    return "aucun sous-projet n'est disponible dans ce workspace lié (indexation en cours ?).";
  }
  return `Cibles valides : ${valid.join(", ")} — ou "all" pour interroger tous les sous-projets.`;
}
