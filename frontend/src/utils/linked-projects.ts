// ── Projets liés : sélection des candidats à regrouper ──────────────
// Un projet LIÉ (storage "linked") regroupe des sous-projets locaux via un
// placeholder à symlinks. Règle métier RÉELLE (backend/src/projects/manager.ts,
// validateLinkedProject / addLinkedProject) : un sous-projet peut appartenir à
// PLUSIEURS groupes — seuls sont refusés l'absence, les doublons DANS un même
// groupe, l'imbrication (un placeholder ne peut pas être sous-projet) et les
// stockages non locaux (ssh). L'UI ne doit donc exclure QUE le groupe lui-même,
// les membres du groupe COURANT et les non-éligibles (ssh/placeholder) ;
// un projet déjà membre d'un autre groupe reste proposable (et est signalé
// à l'utilisateur, cf. `linkedGroupCount`).

import type { Project } from "../types";

/** Un sous-projet éligible + nombre d'AUTRES groupes le contenant déjà. */
export interface LinkCandidate {
  project: Project;
  /** Nombre de projets liés (hors groupe courant) contenant déjà ce projet. */
  linkedGroupCount: number;
}

/** Contrainte backend : un sous-projet ne peut être que local ou SMB (monté). */
export function isLinkableStorage(storage: Project["storage"]): boolean {
  return storage === "local" || storage === "smb";
}

/**
 * Membres actuels du groupe, lus en priorité dans la liste FRAÎCHE `projects`
 * (état partagé App, rechargé après chaque création/édition) : le prop `group`
 * peut être un instantané périmé si le menu est resté monté pendant qu'un autre
 * projet lié a été modifié.
 */
function currentLinkedIds(group: Project, projects: Project[]): string[] {
  const fresh = projects.find((p) => p.id === group.id);
  const ids = fresh?.linkedProjectIds ?? group.linkedProjectIds;
  return Array.isArray(ids) ? ids : [];
}

/**
 * Construit la liste des projets proposables pour « Lier un projet… ».
 *
 * Exclusions : le groupe lui-même (auto-lien), les membres du groupe COURANT
 * (doublon refusé par le backend) et les stockages non éligibles (ssh, ou un
 * autre placeholder → pas d'imbrication, donc pas de cycle possible).
 * Un projet déjà membre d'AUTRES groupes est proposé, avec son compte de
 * groupes pour transparence (multi-appartenance autorisée par le backend).
 */
export function buildLinkCandidates(group: Project, projects: Project[]): LinkCandidate[] {
  const alreadyLinked = new Set(currentLinkedIds(group, projects));
  return projects
    .filter(
      (p) =>
        p.id !== group.id &&
        !alreadyLinked.has(p.id) &&
        isLinkableStorage(p.storage)
    )
    .map((p) => ({
      project: p,
      linkedGroupCount: countLinkedGroups(p.id, projects, group.id),
    }));
}

/**
 * Nombre de projets LIÉS (hors `excludeGroupId`) qui regroupent déjà `projectId`.
 * Information affichée dans le picker : la multi-appartenance est autorisée,
 * mais l'utilisateur doit savoir qu'un projet est déjà utilisé ailleurs.
 */
export function countLinkedGroups(
  projectId: string,
  projects: Project[],
  excludeGroupId?: string
): number {
  let count = 0;
  for (const p of projects) {
    if (p.storage !== "linked" || p.id === excludeGroupId) continue;
    if (Array.isArray(p.linkedProjectIds) && p.linkedProjectIds.includes(projectId)) {
      count++;
    }
  }
  return count;
}
