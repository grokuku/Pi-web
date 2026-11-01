// ── API partagée : gestion des modèles (Model Library) ──
// Contexte : SettingsModal et ModelLibraryModal dupliquaient la logique
// handleAddModels / handleUpdateModel / handleRemoveModel / handleSetDefault,
// avec des res.json().catch(() => …) non gardés (réponse HTML SSO → erreur
// illisible). Ce module centralise ces appels et blinde le parsing via
// parseJsonResponse (utils/api.ts), comme GitPanel.
//
// Les libellés i18n sont passés par l'appelant (ce module n'a pas accès au
// hook useTranslation) : voir apiErrorLabels() ci-dessous.

import { parseJsonResponse, type ApiErrorLabels } from "./api";
import type { ModelLibrary, RegisteredModel, RoutingConfig } from "../types";
import type { TFunction } from "../i18n";

/**
 * Libellés i18n pré-traduits pour parseJsonResponse (même pattern que GitPanel).
 * Réutilise les clés git.sessionExpired / git.serverError déjà présentes.
 */
export function apiErrorLabels(t: TFunction): ApiErrorLabels {
  return {
    sessionExpired: t("git.sessionExpired"),
    serverError: (status: number) => t("git.serverError", status),
  };
}

/**
 * Ajoute des modèles à la bibliothèque (POST /api/model-library/models).
 * Retourne la bibliothèque mise à jour.
 */
export async function addModels(
  models: Omit<RegisteredModel, "id">[],
  labels: ApiErrorLabels
): Promise<ModelLibrary> {
  const res = await fetch("/api/model-library/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models }),
  });
  return parseJsonResponse<ModelLibrary>(res, labels);
}

/**
 * Met à jour un modèle (PUT /api/model-library/models/:id).
 * Retourne la bibliothèque mise à jour.
 */
export async function updateModel(
  id: string,
  updates: Partial<RegisteredModel>,
  labels: ApiErrorLabels
): Promise<ModelLibrary> {
  const res = await fetch(`/api/model-library/models/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  return parseJsonResponse<ModelLibrary>(res, labels);
}

/**
 * Supprime un modèle (DELETE /api/model-library/models/:id).
 * Retourne la bibliothèque mise à jour.
 */
export async function removeModel(
  id: string,
  labels: ApiErrorLabels
): Promise<ModelLibrary> {
  const res = await fetch(`/api/model-library/models/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return parseJsonResponse<ModelLibrary>(res, labels);
}

/**
 * Définit le modèle par défaut (PUT /api/model-library/models/:id/default).
 * Retourne la bibliothèque mise à jour.
 */
export async function setDefaultModel(
  id: string,
  labels: ApiErrorLabels
): Promise<ModelLibrary> {
  const res = await fetch(`/api/model-library/models/${encodeURIComponent(id)}/default`, {
    method: "PUT",
  });
  return parseJsonResponse<ModelLibrary>(res, labels);
}

// ── « Appliquer ce routage à d'autres projets » ───────────────────────────
// Le routage est stocké PAR PROJET (projectModes[<id>].harness.routing) : rien
// n'est partagé ni hérité, pas même entre un projet lié et ses sous-projets.
// La copie passe donc par UNE route dédiée, en deux temps : `dryRun` pour la
// prévisualisation (aucune écriture), puis l'application réelle.

export type RoutingCopyScope = "all" | "all-except-current" | "linked-subprojects" | "selected";

/** Champs de routage porteurs d'un id de modèle (pour les avertissements). */
export type RoutingModelField =
  | "trivial"
  | "standard"
  | "complex"
  | "review"
  | "classifierModelId"
  | "systemOneModelId";

export interface RoutingCopyCandidate {
  id: string;
  name: string;
  storage: string;
  isSource: boolean;
  isLinkedSubproject: boolean;
}

export interface RoutingCopySkipped {
  id: string;
  name: string;
  reason: "source" | "unknown-project";
}

export interface RoutingCopyWarning {
  field: RoutingModelField;
  /** Id de modèle configuré qui n'existe PAS dans la bibliothèque. */
  modelId: string;
  projectIds: string[];
  projectNames: string[];
}

/** Réponse de POST /api/model-library/routing/apply (prévisualisation ou application). */
export interface RoutingCopyPlan {
  dryRun: boolean;
  sourceProjectId: string;
  scope: string;
  targets: { id: string; name: string; storage: string }[];
  skipped: RoutingCopySkipped[];
  warnings: RoutingCopyWarning[];
  totalProjects: number;
  otherProjects: number;
  sourceIsLinked: boolean;
  candidates: RoutingCopyCandidate[];
  linkedSubprojectIds: string[];
  /** Ids réellement écrits (vide en prévisualisation). */
  applied: string[];
  /** Bibliothèque à jour (absente en prévisualisation). */
  library?: ModelLibrary;
}

export interface RoutingCopyRequest {
  sourceProjectId: string;
  scope: RoutingCopyScope;
  /** Config à recopier (celle de la modale, pas forcément enregistrée). */
  routing: RoutingConfig;
  /** Portée `selected` uniquement. */
  selectedProjectIds?: string[];
}

async function postRoutingCopy(
  body: RoutingCopyRequest,
  dryRun: boolean,
  labels: ApiErrorLabels
): Promise<RoutingCopyPlan> {
  const res = await fetch("/api/model-library/routing/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, dryRun }),
  });
  return parseJsonResponse<RoutingCopyPlan>(res, labels);
}

/**
 * Prévisualisation (aucune écriture) : cibles, projets inchangés et
 * avertissements « modèle absent de la bibliothèque ». Même calcul que
 * l'application réelle → ce qui est affiché est exactement ce qui sera fait.
 */
export function previewRoutingCopy(
  body: RoutingCopyRequest,
  labels: ApiErrorLabels
): Promise<RoutingCopyPlan> {
  return postRoutingCopy(body, true, labels);
}

/** Application réelle (écrase le routage des projets ciblés). */
export function applyRoutingCopy(
  body: RoutingCopyRequest,
  labels: ApiErrorLabels
): Promise<RoutingCopyPlan> {
  return postRoutingCopy(body, false, labels);
}
