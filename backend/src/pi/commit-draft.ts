import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Même DATA_DIR que model-library.ts : /app/.data en production, .data du repo en dev.
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const DRAFT_DIR = path.join(DATA_DIR, "commit-drafts");

function ensureDraftDir(): void {
  if (!existsSync(DRAFT_DIR)) mkdirSync(DRAFT_DIR, { recursive: true });
}

function draftFilePath(projectId: string): string {
  return path.join(DRAFT_DIR, `${projectId}.md`);
}

function cleanCacheFilePath(projectId: string): string {
  return path.join(DRAFT_DIR, `${projectId}-clean.json`);
}

function formatHHMM(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export interface CleanedCommit {
  signature: string;
  subject: string;
  body: string;
}

/**
 * Lit le draft accumulé d'un projet (lignes horodatées) ou "" si absent.
 */
export function getDraft(projectId: string): string {
  try {
    const file = draftFilePath(projectId);
    if (!existsSync(file)) return "";
    return readFileSync(file, "utf-8");
  } catch (e) {
    console.error(`[commit-draft] Failed to read draft for ${projectId}:`, e);
    return "";
  }
}

/**
 * Ajoute une ligne au draft avec un horodatage `[HH:MM]`.
 * Ex : appendDraft(id, "[auto] edit: src/foo.ts") → "[12:34] [auto] edit: src/foo.ts"
 */
export function appendDraft(projectId: string, line: string): void {
  try {
    ensureDraftDir();
    const stamp = `[${formatHHMM(new Date())}]`;
    appendFileSync(draftFilePath(projectId), `${stamp} ${line}\n`, "utf-8");
  } catch (e) {
    console.error(`[commit-draft] Failed to append draft for ${projectId}:`, e);
  }
}

/**
 * Supprime le fichier .md du draft ET le cache du message nettoyé.
 * Appelé après un commit/push réussi.
 */
export function clearDraft(projectId: string): void {
  try {
    const file = draftFilePath(projectId);
    if (existsSync(file)) unlinkSync(file);
    const cache = cleanCacheFilePath(projectId);
    if (existsSync(cache)) unlinkSync(cache);
  } catch (e) {
    console.error(`[commit-draft] Failed to clear draft for ${projectId}:`, e);
  }
}

/**
 * Lit le cache du message nettoyé pour un projet, ou null s'il n'existe pas
 * ou est invalide. Le cache est invalide si la signature des fichiers modifiés
 * a changé depuis la dernière génération (vérifiée par l'appelant).
 */
export function getCleanedCommit(projectId: string): CleanedCommit | null {
  try {
    const file = cleanCacheFilePath(projectId);
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf-8"));
    if (
      typeof data?.signature === "string" &&
      typeof data?.subject === "string" &&
      typeof data?.body === "string"
    ) {
      return { signature: data.signature, subject: data.subject, body: data.body };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Sauvegarde le message nettoyé avec la signature des fichiers modifiés qui
 * a servi à le générer. Tant que la signature ne change pas, le cache est
 * réutilisé (pas de rappel LLM à chaque ouverture de modale).
 */
export function saveCleanedCommit(projectId: string, signature: string, subject: string, body: string): void {
  try {
    ensureDraftDir();
    const payload: CleanedCommit = { signature, subject, body };
    writeFileSync(cleanCacheFilePath(projectId), JSON.stringify(payload, null, 2), "utf-8");
  } catch (e) {
    console.error(`[commit-draft] Failed to save cleaned commit for ${projectId}:`, e);
  }
}
