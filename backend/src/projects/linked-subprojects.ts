/**
 * linked-subprojects.ts — sélection PURE des sous-projets d'un workspace lié.
 *
 * Un projet « lié » (storage === "linked") est un placeholder regroupant des
 * sous-projets (symlinks). Cette sélection est PURE (aucun I/O, aucune lecture
 * disque) : elle reçoit le projet lié et la liste complète des projets, et rend
 * les sous-projets dans l'ORDRE de `linkedProjectIds` (ordre d'ajout choisi par
 * l'utilisateur), en écartant les entrées invalides (id inconnu, sans cwd).
 *
 * Cette fonction est la SOURCE UNIQUE utilisée :
 *  - par le pont backend `__piWebGetLinkedSubprojects__` (manager.ts), lu par
 *    l'extension codebase-memory pour énumérer les sous-projets de façon
 *    DÉTERMINISTE (même ordre pour la fusion, l'indexation et la carte du repo) ;
 *  - dans les tests, sans dépendance au disque.
 */

import type { Project } from "./manager.js";
import type { LinkedSubprojectRef } from "../pi/cbm-project-resolution.js";

/**
 * Sous-projets ordonnés d'un projet lié.
 *
 * @param project    le projet (supposé « linked ») dont on veut les sous-projets.
 * @param allProjects tous les projets connus (table de résolution par id).
 * @returns les sous-projets valides, dans l'ordre de `linkedProjectIds`, dédupliqués.
 */
export function selectLinkedSubprojects(
  project: Project | undefined | null,
  allProjects: Project[],
): LinkedSubprojectRef[] {
  if (!project || project.storage !== "linked" || !Array.isArray(project.linkedProjectIds)) {
    return [];
  }
  const byId = new Map<string, Project>();
  for (const p of allProjects || []) {
    if (p && p.id) byId.set(p.id, p);
  }
  const out: LinkedSubprojectRef[] = [];
  const seen = new Set<string>();
  for (const id of project.linkedProjectIds) {
    const sub = byId.get(id);
    // Entrées invalides filtrées : id inconnu, cwd manquant, ou doublon.
    if (!sub || !sub.cwd || seen.has(sub.id)) continue;
    seen.add(sub.id);
    out.push({ name: sub.name, rootPath: sub.cwd });
  }
  return out;
}
