// ── API du panneau SKILLS (frontend) ─────────────────────
// Enveloppe fetch des routes /api/skills (liste, lecture, écriture,
// restauration, création) + le toggle activé/désactivé qui reste sur le
// mécanisme existant POST /api/pi/toggle (motif `!<nom>` — ne pas dupliquer).
//
// Les erreurs serveur (JSON { error }) sont remontées telles quelles ; le
// parsing blindé anti-HTML passe par parseJsonResponse (utils/api.ts).

import { parseJsonResponse, type ApiErrorLabels } from "../../utils/api";

export type SkillStatus = "bundled" | "ecosystem" | "generated" | "custom";

/** Entrée de la liste : SkillEntry backend + enabled (dérivé de settings.skills). */
export interface SkillInfo {
  name: string;
  description: string;
  status: SkillStatus;
  /** false uniquement pour les skills générées (verrouillées). */
  editable: boolean;
  /** La copie locale diffère de sa version de référence. */
  modified: boolean;
  /** Référence de comparaison/restauration (livrée ou écosystème), sinon null. */
  reference: { kind: "bundled" | "ecosystem"; dir: string } | null;
  /** false si settings.skills contient `!<nom>` ou `-<nom>`. */
  enabled: boolean;
  /** Fiche illisible ou front-matter invalide (affiché en avertissement). */
  invalid?: string;
  dir: string;
  file: string;
}

export interface SkillDetailResponse {
  skill: SkillInfo;
  content: string;
  referenceContent: string | null;
}

/**
 * Valide un nom de skill côté client (mêmes règles que le backend / le spec
 * Agent Skills) : minuscules a-z, chiffres, tirets, ≤ 64, pas de tiret en
 * début/fin ni de « -- ». Sert au retour immédiat du formulaire de création ;
 * le backend reste l'autorité.
 */
export function isSkillNameValid(name: string): boolean {
  const raw = name.trim();
  if (!raw || raw.length > 64) return false;
  if (!/^[a-z0-9-]+$/.test(raw)) return false;
  if (raw.startsWith("-") || raw.endsWith("-")) return false;
  return !raw.includes("--");
}

/** État activé dérivé d'une liste settings.skills (miroir du backend). */
export function isSkillEnabledInList(settingsSkills: readonly string[] | undefined, name: string): boolean {
  const list = Array.isArray(settingsSkills) ? settingsSkills : [];
  return !list.some((entry) => entry === `!${name}` || entry === `-${name}`);
}

function skillUrl(name: string): string {
  return `/api/skills/${encodeURIComponent(name)}`;
}

export async function fetchSkills(labels: ApiErrorLabels): Promise<SkillInfo[]> {
  const res = await fetch("/api/skills");
  const data = await parseJsonResponse<{ skills?: SkillInfo[] }>(res, labels);
  return Array.isArray(data.skills) ? data.skills : [];
}

export async function fetchSkill(name: string, labels: ApiErrorLabels): Promise<SkillDetailResponse> {
  const res = await fetch(skillUrl(name));
  return parseJsonResponse<SkillDetailResponse>(res, labels);
}

export async function saveSkill(
  name: string,
  content: string,
  labels: ApiErrorLabels,
): Promise<SkillDetailResponse> {
  const res = await fetch(skillUrl(name), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return parseJsonResponse<SkillDetailResponse>(res, labels);
}

export async function restoreSkill(name: string, labels: ApiErrorLabels): Promise<SkillDetailResponse> {
  const res = await fetch(`${skillUrl(name)}/restore`, { method: "POST" });
  return parseJsonResponse<SkillDetailResponse>(res, labels);
}

export async function createSkill(
  name: string,
  description: string,
  labels: ApiErrorLabels,
): Promise<SkillDetailResponse> {
  const res = await fetch("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  return parseJsonResponse<SkillDetailResponse>(res, labels);
}

/** Active/désactive via le mécanisme existant (`!<nom>`). Retourne settings.skills. */
export async function toggleSkill(
  name: string,
  enabled: boolean,
  labels: ApiErrorLabels,
): Promise<string[]> {
  const res = await fetch("/api/pi/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "skills", source: name, enabled }),
  });
  const data = await parseJsonResponse<{ skills?: string[] }>(res, labels);
  return Array.isArray(data.skills) ? data.skills : [];
}
