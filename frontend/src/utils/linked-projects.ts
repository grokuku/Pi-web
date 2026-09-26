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
 * Exclusions INVARIANTES (quel que soit `hideAlreadyLinked`) : le groupe
 * lui-même (auto-lien), les membres du groupe COURANT (doublon refusé par le
 * backend) et les stockages non éligibles (ssh, ou un autre placeholder → pas
 * d'imbrication, donc pas de cycle possible).
 *
 * `hideAlreadyLinked` (case de l'UI, cochée par défaut) : quand il vaut true,
 * exclut EN PLUS les projets déjà membres d'un AUTRE groupe lié. Quand il vaut
 * false (comportement historique du helper), ces projets restent proposés avec
 * leur compte de groupes pour transparence (multi-appartenance autorisée par
 * le backend).
 */
export function buildLinkCandidates(
  group: Project,
  projects: Project[],
  hideAlreadyLinked = false
): LinkCandidate[] {
  const alreadyLinked = new Set(currentLinkedIds(group, projects));
  return projects
    .filter(
      (p) =>
        p.id !== group.id &&
        !alreadyLinked.has(p.id) &&
        isLinkableStorage(p.storage) &&
        !(hideAlreadyLinked && countLinkedGroups(p.id, projects, group.id) > 0)
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

// ── Sélecteur GÉNÉRAL de projets (ProjectSwitcher, sidebar) ────────────────
// Le sélecteur de la sidebar liste TOUS les projets (chaque projet lié est une
// entrée de premier niveau). Sa case « Masquer les projets déjà liés à un
// groupe » (cochée par défaut) retire les projets de BASE regroupés dans un
// projet lié — la multi-appartenance autorisée par le backend allonge d'autant
// la liste. Deux exceptions INVARIANTES, quel que soit l'état de la case :
// les projets liés eux-mêmes et le projet ACTIF (l'utilisateur doit toujours
// voir où il se trouve, même si ce projet est membre d'un groupe).

/** Résultat de `buildSwitcherCandidates` : liste affichée + compteur de masqués. */
export interface SwitcherCandidates {
  /** Projets à afficher, dans l'ordre d'origine. */
  projects: Project[];
  /** Projets retirés par la case (jamais par la recherche). */
  hiddenCount: number;
}

/**
 * Ids des projets membres d'AU MOINS un groupe lié (lus dans `linkedProjectIds`).
 * Calcul en une passe : le sélecteur masque potentiellement chaque projet, un
 * balayage complet par projet (countLinkedGroups) serait quadratique.
 */
export function linkedMemberIds(projects: Project[]): Set<string> {
  const ids = new Set<string>();
  for (const group of projects) {
    if (group.storage !== "linked" || !Array.isArray(group.linkedProjectIds)) continue;
    for (const id of group.linkedProjectIds) ids.add(id);
  }
  return ids;
}

/** true si `projectId` est membre d'au moins un projet lié. */
export function isLinkedMember(projectId: string, projects: Project[]): boolean {
  return countLinkedGroups(projectId, projects) > 0;
}

/**
 * Construit la liste affichée par le sélecteur général de projets.
 *
 * `hideAlreadyLinked` (case de l'UI, cochée par défaut) retire les membres de
 * groupes liés. Sont TOUJOURS conservés, dans les deux états : les projets de
 * type `linked` (entrées de premier niveau) et le projet actif. À false, la
 * liste est renvoyée telle quelle (même référence) et `hiddenCount` vaut 0.
 */
export function buildSwitcherCandidates(
  projects: Project[],
  activeProjectId: string | null | undefined,
  hideAlreadyLinked: boolean
): SwitcherCandidates {
  if (!hideAlreadyLinked) return { projects, hiddenCount: 0 };
  const members = linkedMemberIds(projects);
  const visible = projects.filter((p) => {
    if (p.storage === "linked") return true;
    if (activeProjectId != null && p.id === activeProjectId) return true;
    return !members.has(p.id);
  });
  return { projects: visible, hiddenCount: projects.length - visible.length };
}
