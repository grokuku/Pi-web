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
import type { ModelLibrary, RegisteredModel } from "../types";
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
