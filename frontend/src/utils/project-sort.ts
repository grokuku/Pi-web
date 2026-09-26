// ── Tri alphabétique des listes de projets ────────────────────────────
// Toutes les listes de projets de l'interface (sélecteur de sidebar, menu des
// projets liés, modale d'ajout, écran d'accueil, statistiques CBM…) doivent
// s'afficher par ordre alphabétique INSENSIBLE à la casse et aux accents.
//
// Choix : `localeCompare` avec
//   - `sensitivity: "base"` → « aikore », « Aikore » et « Áikore » sont
//     équivalents (ni casse ni accents ne changent l'ordre) ;
//   - `numeric: true`       → tri NUMÉRIQUE naturel : « Yuki 2 » avant
//     « Yuki 10 » (au lieu de l'ordre lexicographique « Yuki 10 » < « Yuki 2 »).
// La locale "fr" est utilisée pour un ordre stable et cohérent avec l'UI
// principalement francophone ; casse/accents étant neutralisés, le résultat
// reste identique pour des noms anglophones.
//
// Le tri s'applique APRÈS les filtres métier (recherche, case « masquer les
// projets déjà liés ») : il ne change pas l'ensemble des éléments affichés.

import type { Project } from "../types";

/** Sous-ensemble minimal lu pour le tri (nom seul). */
export type NamedProject = Pick<Project, "name">;

const NAME_OPTIONS: Intl.CollatorOptions = { sensitivity: "base", numeric: true };

/**
 * Compare deux noms de projets pour l'affichage (insensible casse/accents,
 * numérique naturel).
 *
 * En cas d'égalité « base » (noms ne différant que par la casse/accents), un
 * second passage PLUS STRICT (casse départage) garantit un ordre déterministe
 * — donc un tri stable d'une exécution à l'autre.
 */
export function compareProjectsByName(a: NamedProject, b: NamedProject): number {
  const primary = a.name.localeCompare(b.name, "fr", NAME_OPTIONS);
  if (primary !== 0) return primary;
  // Départage déterministe quand la comparaison « base » considère les noms égaux.
  return a.name.localeCompare(b.name, "fr", { numeric: true });
}

/**
 * Renvoie une COPIE de `projects` triée par nom (jamais de mutation de l'entrée :
 * l'ordre renvoyé par le backend, utilisé ailleurs, doit rester intact).
 */
export function sortProjectsByName<T extends NamedProject>(projects: T[]): T[] {
  return [...projects].sort(compareProjectsByName);
}

/**
 * true si deux noms désignent « le même » projet pour l'utilisateur (casse et
 * accents neutralisés) — sert à refuser un renommage créant un doublon
 * visuellement trompeur (ex. « AI-Helper » vs « ai-helper »).
 */
export function projectNamesMatch(a: string, b: string): boolean {
  return a.localeCompare(b, "fr", { sensitivity: "base" }) === 0;
}
