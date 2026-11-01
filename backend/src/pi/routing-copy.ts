/**
 * routing-copy.ts — « appliquer ce routage à d'autres projets ».
 *
 * Le routage est stocké PAR PROJET (`.data/model-library.json` →
 * `projectModes[<projectId>].harness.routing`, cf. model-library.ts:487 et
 * `getProjectRoutingConfig`). Un projet « lié » (`storage === "linked"`) est un
 * PLACEHOLDER qui regroupe des sous-projets par symlinks : il a son PROPRE
 * routage, et chacun de ses sous-projets a AUSSI le sien — rien n'est hérité ni
 * partagé. D'où la nécessité d'une portée EXPLICITE quand on veut « tout
 * remettre au propre d'un coup ».
 *
 * Ce module est PUR (aucune I/O, aucun accès disque) :
 *  - `selectRoutingTargets` décide QUELS projets recevraient la config ;
 *  - `routingCopyWarnings` calcule CE QUI risque de ne pas s'appliquer.
 * L'écriture elle-même est faite par la route via `applyRoutingToLibrary`
 * (mémoire) + `saveModelLibrary` (UNE écriture → atomique).
 *
 * ⚠️ Les modèles sont GLOBAUX : `ModelLibrary.models` est une liste unique
 * partagée par tous les projets (model-library.ts:113). Un `modelId` valide
 * pour le projet courant est donc en principe valide partout — sauf id
 * PÉRIMÉ (modèle supprimé, fichier recopié d'une autre instance). C'est ce cas
 * que `routingCopyWarnings` signale : la config reste écrite telle quelle et la
 * résolution retombe sur le modèle par défaut (`pickModel`, routing.ts:583-590),
 * il n'y a pas de config cassée.
 */

import type { Project } from "../projects/manager.js";
import type { ModelLibrary } from "./model-library.js";
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "./routing-types.js";

/**
 * Portée de la copie — TOUJOURS un choix explicite de l'utilisateur :
 *  - `all`                 : tous les projets (projet courant inclus) ;
 *  - `all-except-current`  : tous les projets SAUF le projet courant ;
 *  - `linked-subprojects`  : le projet courant + ses sous-projets liés (si lié) ;
 *  - `selected`            : la sélection cochée (`selectedProjectIds`).
 */
export type RoutingCopyScope = "all" | "all-except-current" | "linked-subprojects" | "selected";

export const ROUTING_COPY_SCOPES: readonly RoutingCopyScope[] = [
  "all",
  "all-except-current",
  "linked-subprojects",
  "selected",
];

export function isRoutingCopyScope(value: unknown): value is RoutingCopyScope {
  return typeof value === "string" && (ROUTING_COPY_SCOPES as readonly string[]).includes(value);
}

/** Raison pour laquelle un projet n'est PAS cible (affichée à l'utilisateur). */
export type RoutingCopySkipReason =
  /** Le projet courant, exclu par la portée `all-except-current`. */
  | "source"
  /** Id demandé qui ne correspond à aucun projet connu. */
  | "unknown-project";

export interface RoutingCopySkipped {
  id: string;
  name: string;
  reason: RoutingCopySkipReason;
}

export interface RoutingCopyTargets {
  /** Projets qui RECEVRONT la config, dans l'ordre d'affichage des projets. */
  targets: Project[];
  /** Projets explicitement écartés (traçabilité de la prévisualisation). */
  skipped: RoutingCopySkipped[];
  /**
   * `false` quand la portée est `linked-subprojects` mais que le projet courant
   * n'est pas un projet lié : aucun sous-projet à cibler (cas à expliquer à
   * l'utilisateur plutôt qu'à échouer silencieusement).
   */
  sourceIsLinked: boolean;
}

export interface SelectRoutingTargetsOptions {
  scope: unknown;
  sourceProjectId: string;
  /** Tous les projets connus (`loadProjects()`). */
  projects: readonly Project[];
  /** Ids cochés — utilisé seulement pour la portée `selected`. */
  selectedProjectIds?: unknown;
}

/**
 * Sélectionne les projets cibles d'une copie de routage.
 *
 * Fonction TOTALE sur les entrées utilisateur : une portée inconnue ou un
 * projet source absent lève une erreur EXPLICITE (`Error`) que la route traduit
 * en 400 — on ne devine jamais une portée, une action qui écrase N configs ne
 * doit pas partir d'un défaut implicite.
 */
export function selectRoutingTargets(options: SelectRoutingTargetsOptions): RoutingCopyTargets {
  const { scope, sourceProjectId, projects } = options;
  if (!isRoutingCopyScope(scope)) {
    throw new Error(`Portée invalide : ${String(scope)}`);
  }
  const all = Array.isArray(projects) ? projects.filter((p): p is Project => !!p && typeof p.id === "string") : [];
  const source = all.find((p) => p.id === sourceProjectId);
  if (!source) throw new Error(`Projet introuvable : ${sourceProjectId}`);

  const sourceIsLinked = source.storage === "linked" && Array.isArray(source.linkedProjectIds);

  if (scope === "linked-subprojects") {
    // Le projet lié est ciblé AVEC ses sous-projets : son propre routage peut
    // être celui qui est édité, et ses sous-projets ne l'héritent pas.
    const wanted = new Set<string>([source.id]);
    for (const id of source.linkedProjectIds || []) {
      if (typeof id === "string" && id) wanted.add(id);
    }
    const targets = all.filter((p) => wanted.has(p.id));
    return { targets, skipped: [], sourceIsLinked };
  }

  if (scope === "all") {
    return { targets: all.slice(), skipped: [], sourceIsLinked };
  }

  if (scope === "all-except-current") {
    return {
      targets: all.filter((p) => p.id !== source.id),
      skipped: [{ id: source.id, name: source.name, reason: "source" }],
      sourceIsLinked,
    };
  }

  // scope === "selected" : ids fournis, dans l'ordre de la liste des projets
  // (ordre d'affichage stable) ; les ids inconnus sont rapportés, pas devinés.
  const rawIds = Array.isArray(options.selectedProjectIds) ? options.selectedProjectIds : [];
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const id of rawIds) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    requested.push(id);
  }
  const requestedSet = new Set(requested);
  const known = new Set(all.map((p) => p.id));
  const skipped: RoutingCopySkipped[] = requested
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, reason: "unknown-project" as const }));
  return {
    targets: all.filter((p) => requestedSet.has(p.id)),
    skipped,
    sourceIsLinked,
  };
}

/** Champs de `RoutingConfig` porteurs d'un `modelId` de la bibliothèque. */
export type RoutingModelField =
  | "trivial"
  | "standard"
  | "complex"
  | "review"
  | "classifierModelId"
  | "systemOneModelId";

const MODEL_FIELDS: readonly RoutingModelField[] = [
  "trivial",
  "standard",
  "complex",
  "review",
  "classifierModelId",
  "systemOneModelId",
];

export interface RoutingCopyWarning {
  field: RoutingModelField;
  /** Id de modèle configuré qui n'existe PAS dans la bibliothèque. */
  modelId: string;
  /** Projets cibles concernés par cet id périmé. */
  projectIds: string[];
  projectNames: string[];
}

/** Id de modèle porté par un champ de routage (null si le champ est vide). */
function modelIdOf(routing: Partial<RoutingConfig> | null | undefined, field: RoutingModelField): string | null {
  if (!routing || typeof routing !== "object") return null;
  if (field === "classifierModelId" || field === "systemOneModelId") {
    const id = (routing as any)[field];
    return typeof id === "string" && id ? id : null;
  }
  const id = (routing as any)[field]?.modelId;
  return typeof id === "string" && id ? id : null;
}

/**
 * Avertissements à afficher AVANT l'écriture : ids de modèles configurés qui
 * n'existent pas dans la bibliothèque (modèle supprimé, id recopié d'une autre
 * instance…). Groupés par (champ, id) avec la liste des projets concernés.
 *
 * ⚠️ Ce n'est PAS un blocage : la config est copiée TELLE QUELLE (choix (i) du
 * cahier des charges, cohérent avec `normalizeRoutingConfig`) et la résolution
 * retombe sur le modèle par défaut. On informe, on ne casse rien, on ne
 * « répare » pas silencieusement le choix de l'utilisateur.
 */
export function routingCopyWarnings(
  library: Pick<ModelLibrary, "models">,
  targets: readonly Project[],
  routing: Partial<RoutingConfig> | null | undefined,
): RoutingCopyWarning[] {
  const known = new Set<string>(
    (library?.models || []).map((m) => m?.id).filter((id): id is string => typeof id === "string"),
  );
  const out: RoutingCopyWarning[] = [];
  for (const field of MODEL_FIELDS) {
    const modelId = modelIdOf(routing, field);
    if (!modelId || known.has(modelId)) continue;
    out.push({
      field,
      modelId,
      projectIds: targets.map((p) => p.id),
      projectNames: targets.map((p) => p.name),
    });
  }
  return out;
}

/** Candidat cochable dans l'UI (portée `selected`). */
export interface RoutingCopyCandidate {
  id: string;
  name: string;
  storage: string;
  isSource: boolean;
  isLinkedSubproject: boolean;
}

/**
 * Prévisualisation lisible : « N projets vont recevoir ces réglages ».
 * `totalProjects` permet d'afficher ce qui NE changera PAS (total - cibles).
 */
export interface RoutingCopyPlan {
  targets: { id: string; name: string; storage: string }[];
  skipped: RoutingCopySkipped[];
  warnings: RoutingCopyWarning[];
  totalProjects: number;
  /** Nombre de projets cibles qui ne sont pas le projet source. */
  otherProjects: number;
  sourceIsLinked: boolean;
  /** Tous les projets connus (liste cochable de la portée `selected`). */
  candidates: RoutingCopyCandidate[];
  /** Sous-projets du projet courant (portée `linked-subprojects`). */
  linkedSubprojectIds: string[];
}

/** Assemble le plan de copie (prévisualisation ET exécution utilisent le même). */
export function planRoutingCopy(options: {
  scope: unknown;
  sourceProjectId: string;
  projects: readonly Project[];
  selectedProjectIds?: unknown;
  routing?: Partial<RoutingConfig> | null;
  library: Pick<ModelLibrary, "models">;
}): RoutingCopyPlan {
  const { targets, skipped, sourceIsLinked } = selectRoutingTargets(options);
  const projects: readonly Project[] = Array.isArray(options.projects) ? options.projects : [];
  const source = projects.find((p) => p.id === options.sourceProjectId);
  const linkedSubprojectIds = (source?.linkedProjectIds || []).filter(
    (id): id is string => typeof id === "string" && !!id && id !== options.sourceProjectId,
  );
  const linkedSet = new Set<string>(linkedSubprojectIds);
  return {
    targets: targets.map((p) => ({ id: p.id, name: p.name, storage: String(p.storage || "") })),
    skipped,
    warnings: routingCopyWarnings(options.library, targets, options.routing ?? DEFAULT_ROUTING_CONFIG),
    totalProjects: projects.length,
    otherProjects: targets.filter((p) => p.id !== options.sourceProjectId).length,
    sourceIsLinked,
    candidates: projects.map((p) => ({
      id: p.id,
      name: p.name,
      storage: String(p.storage || ""),
      isSource: p.id === options.sourceProjectId,
      isLinkedSubproject: linkedSet.has(p.id),
    })),
    linkedSubprojectIds,
  };
}
