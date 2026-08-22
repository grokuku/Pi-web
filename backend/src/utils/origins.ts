/**
 * Gestion des origines autorisées (HTTP CORS + WebSocket).
 *
 * `*` est accepté et signifie « autoriser toutes les origines » (comportement
 * allow-all historique). Dans ce mode, l'origine n'est volontairement pas une
 * barrière : la vraie protection repose sur les chemins (path-security.ts), les
 * jetons d'agent et les autres correctifs non liés aux origines.
 *
 * Si une liste explicite est fournie (autre que `*`), chaque origine est
 * normalisée puis comparée de façon stricte scheme://host:port. On ne compare
 * plus jamais l'en-tête Origin au Host, tous deux étant contrôlables par le
 * client.
 *
 * La liste EFFECTIVE est l'union des variables d'environnement (ALLOWED_ORIGINS,
 * WS_ALLOWED_ORIGINS, PUBLIC_BASE_URL) et de la configuration UI (réglage
 * « Sécurité » persisté dans .data/allowed-origins.json). Si aucune source ne
 * définit quoi que ce soit, on retombe sur `*` (comportement historique).
 * La config UI est lue via un cache invalidé à l'écriture : les changements
 * prennent effet immédiatement (hot-reload), sans redémarrage du serveur,
 * pour les checks HTTP (CORS/apiAuth) comme WebSocket.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Même convention que les autres modules de config (webclaw.ts, agent-keys.ts) :
// stockage sous <racine projet>/.data (3 niveaux depuis backend/dist/utils).
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const ORIGINS_CONFIG_FILE = path.join(DATA_DIR, "allowed-origins.json");

/** Cache de la liste d'origines configurée via l'UI (invalidé au PUT). */
let uiOriginsCache: string[] | null = null;

/** Marqueur interne représentant le mode « toutes les origines ». */
export const ALLOW_ALL_ORIGINS = "*";

/** Vérifie si une valeur brute d'environnement correspond au mode allow-all. */
export function isWildcardOrigins(raw: string | undefined): boolean {
  return typeof raw === "string" && raw.trim() === "*";
}

/** Normalise une origine pour une comparaison exacte scheme://host:port. */
export function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // url.origin est canonique (ex: http://localhost:5173, https://pi.holaf.fr).
    return url.origin;
  } catch {
    return null;
  }
}

/** Parse une variable d'environnement d'origines séparées par des virgules. */
export function parseAllowedOrigins(raw: string | undefined, envName: string): string[] {
  if (!raw) return [];

  // `*` : autoriser toutes les origines (allow-all). C'est le comportement
  // historique attendu par l'utilisateur ; on le représente par le marqueur.
  if (isWildcardOrigins(raw)) {
    return [ALLOW_ALL_ORIGINS];
  }

  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalizeOrigin)
        .filter((o): o is string => o !== null)
    ),
  ];
}

/** Origines autorisées pour l'API HTTP (ALLOWED_ORIGINS + PUBLIC_BASE_URL). */
export function getAllowedOrigins(): string[] {
  const origins = new Set<string>(parseAllowedOrigins(process.env.ALLOWED_ORIGINS, "ALLOWED_ORIGINS"));
  if (process.env.PUBLIC_BASE_URL) {
    const base = normalizeOrigin(process.env.PUBLIC_BASE_URL);
    if (base) origins.add(base);
  }
  return [...origins];
}

/** Indique si une liste autorisée est en mode allow-all (`*`). */
export function isAllOriginsAllowed(allowed: string[]): boolean {
  return allowed.includes(ALLOW_ALL_ORIGINS);
}

/**
 * Vérifie qu'une origine fait partie d'une liste autorisée.
 *
 * En mode allow-all (liste contenant `*`), toute origine est acceptée.
 * Une origine absente n'est jamais acceptée par cette fonction : les appels
 * concernés (CORS, navigateur) ont de toute façon besoin d'un en-tête Origin.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  if (isAllOriginsAllowed(allowed)) return true;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowed.includes(normalized);
}

// ── Configuration UI (réglage « Sécurité ») ────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Valide strictement une origine saisie dans l'UI (ou relue depuis le fichier
 * de config). Une origine = protocole + host (+ port optionnel) : pas de
 * chemin, ni query, ni hash, ni identifiants embarqués. Les wildcards
 * partielles (ex. https://*.example.com) sont refusées ; seul `*` explicite
 * est accepté (allow-all). Retourne la forme normalisée (minuscules, sans
 * slash final) ou null si l'entrée est invalide.
 */
export function validateOriginInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // `*` est accepté explicitement (allow-all) ; tout autre joker est refusé.
  if (trimmed === "*") return ALLOW_ALL_ORIGINS;
  if (trimmed.includes("*")) return null;

  try {
    const url = new URL(trimmed.toLowerCase());
    // Une origine ne contient ni chemin, ni query, ni hash, ni userinfo.
    if (url.pathname && url.pathname !== "/") return null;
    if (url.search || url.hash) return null;
    if (url.username || url.password) return null;
    return normalizeOrigin(url.origin);
  } catch {
    return null;
  }
}

/**
 * Liste d'origines configurée via l'UI (réglage « Sécurité »).
 * Lecture via un cache : la config est relue une seule fois puis invalidée
 * par saveUiAllowedOrigins() → hot-reload sans coût à chaque requête.
 */
export function getUiAllowedOrigins(): string[] {
  if (uiOriginsCache) return uiOriginsCache;
  let result: string[] = [];
  try {
    ensureDataDir();
    if (existsSync(ORIGINS_CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(ORIGINS_CONFIG_FILE, "utf-8"));
      if (Array.isArray(data?.origins)) {
        // Re-valider chaque entrée : le fichier peut avoir été édité à la main.
        const entries: unknown[] = data.origins;
        result = [...new Set(
          entries.map(validateOriginInput).filter((o): o is string => o !== null)
        )];
      }
    }
  } catch (e) {
    console.error("[origins] Failed to load UI allowed-origins config:", e);
  }
  uiOriginsCache = result;
  return result;
}

/**
 * Écrit la liste d'origines configurée via l'UI et invalide le cache.
 * Les entrées sont revalidées/normalisées ici (déduplication incluse) afin
 * que le fichier sur disque contienne toujours une liste propre.
 */
export function saveUiAllowedOrigins(origins: string[]): string[] {
  const normalized = [...new Set(
    origins.map(validateOriginInput).filter((o): o is string => o !== null)
  )];
  ensureDataDir();
  writeFileSync(ORIGINS_CONFIG_FILE, JSON.stringify({ origins: normalized }, null, 2));
  // Invalidation du cache : la nouvelle liste prend effet immédiatement
  // (hot-reload) pour les checks HTTP (CORS/apiAuth) et WebSocket.
  uiOriginsCache = normalized;
  return normalized;
}

// ── Résolution EFFECTIVE des origines autorisées ───────

export type AllowedOriginsSource = "env" | "ui";

export interface EffectiveAllowedOrigins {
  /** Liste effective normalisée ; contient `*` en mode allow-all. */
  origins: string[];
  /** true si `*` : toutes les origines sont autorisées. */
  allowAll: boolean;
  /** Sources ayant contribué à la liste (env et/ou UI). */
  sources: AllowedOriginsSource[];
}

/**
 * Résout la liste EFFECTIVE des origines autorisées : union des variables
 * d'environnement (ALLOWED_ORIGINS / WS_ALLOWED_ORIGINS / PUBLIC_BASE_URL)
 * et de la configuration UI. Si aucune source ne définit quoi que ce soit,
 * retourne `*` (comportement historique allow-all). À appeler à chaque check
 * (HTTP et WS) : le cache UI est invalidé au PUT, donc hot-reload garanti.
 */
export function resolveEffectiveAllowedOrigins(): EffectiveAllowedOrigins {
  const httpEnv = getAllowedOrigins();
  const wsEnv = parseAllowedOrigins(process.env.WS_ALLOWED_ORIGINS, "WS_ALLOWED_ORIGINS");
  const ui = getUiAllowedOrigins();

  const origins = [...new Set([...httpEnv, ...wsEnv, ...ui])];
  const sources: AllowedOriginsSource[] = [];
  if (httpEnv.length > 0 || wsEnv.length > 0) sources.push("env");
  if (ui.length > 0) sources.push("ui");

  if (origins.length === 0) {
    // Aucune source ne définit quoi que ce soit → `*` (comportement actuel).
    return { origins: [ALLOW_ALL_ORIGINS], allowAll: true, sources: [] };
  }

  return { origins, allowAll: isAllOriginsAllowed(origins), sources };
}

/**
 * Vérifie une origine contre la liste effective (env + UI), résolue à chaud.
 */
export function isOriginEffectivelyAllowed(origin: string | undefined): boolean {
  return isAllowedOrigin(origin, resolveEffectiveAllowedOrigins().origins);
}
