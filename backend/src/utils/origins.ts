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
 */

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
