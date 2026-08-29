import { type Request, type Response, type NextFunction } from "express";
import { validateToken, isAgentEnabled } from "../routes/agent-keys.js";
import { resolveEffectiveAllowedOrigins, isAllowedOrigin } from "../utils/origins.js";

/**
 * Middleware d'authentification globale de l'API.
 *
 * Stratégie (correctif sécurité) :
 *   1. Endpoints publics (health, status) → toujours autorisés.
 *   2. Jeton valide (Bearer ou ?token=) → autorisé quel que soit l'Origin.
 *      C'est le seul mode d'accès fiable pour les clients non-navigateur.
 *   3. Appels internes depuis localhost (extensions, proxy Vite en dev) → autorisés.
 *   4. Requêtes navigateur :
 *        - GET/HEAD same-origin sans Origin → autorisées si Sec-Fetch-Site
 *          vaut "same-origin" (comportement standard des navigateurs modernes).
 *        - Requêtes avec Origin → autorisées si l'Origin est autorisée (liste
 *          explicite, ou `*` en mode allow-all) ET si Sec-Fetch-Site est présent
 *          (signature navigateur).
 *   5. Tout le reste → 401/403.
 *
 * On ne compare plus jamais Origin à Host. Sec-Fetch-Site n'est pas une preuve
 * absolue (un client non-navigateur peut le forger) ; pour une protection
 * parfaite des GET same-origin sans Origin, le frontend devrait envoyer le
 * jeton. Avec `*`, l'origine n'est volontairement pas une barrière.
 */

// La liste des origines autorisées est résolue À CHAQUE REQUÊTE (et non plus
// figée au démarrage) : les changements via les variables d'environnement ou le
// réglage UI « Sécurité » (cf. utils/origins.ts) s'appliquent immédiatement.

// Endpoints publics (aucune authentification requise).
// NB: le middleware est monté sur /api, donc req.path est relatif au montage
// (ex: /api/health → /health).
const PUBLIC_PATHS = new Set([
  "/health",
  "/agent/health",
  "/status",
  "/status/update",
]);

function getBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

function getQueryToken(req: Request): string | null {
  const token = req.query.token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function hasValidToken(req: Request): boolean {
  const token = getBearerToken(req) || getQueryToken(req);
  return token !== null && validateToken(token) !== null;
}

function isLocalhost(req: Request): boolean {
  const remoteIp = req.ip || req.socket.remoteAddress;
  return remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
}

/**
 * Détecte une requête navigateur légitime.
 *
 * - Les navigateurs modernes envoient Sec-Fetch-Site sur les requêtes same-site
 *   et cross-site. On l'exige en complément d'une Origin autorisée, afin qu'un
 *   client non-navigateur qui envoie un Origin autorisé ne suffise pas à passer.
 * - Les GET/HEAD same-origin n'envoient pas d'Origin : on se rabat sur
 *   Sec-Fetch-Site: same-origin (limite documentée : en-tête forgeable par un
 *   client non-navigateur).
 */
export function isBrowserRequest(req: Request): boolean {
  // Liste effective résolue à chaque requête (env + réglage UI, hot-reload).
  const effective = resolveEffectiveAllowedOrigins();

  // Mode allow-all (`*`) : permissivité assumée par l'admin (ex. serveur
  // interne/privé). L'API est ouverte, toute requête est considérée navigateur,
  // sans exiger Sec-Fetch-Site — comportement « allow-all historique ».
  // La protection Sec-Fetch-Site reste active pour les listes d'origines
  // explicites (pas de `*`), où le comportement strict est conservé.
  if (effective.allowAll) {
    return true;
  }

  const fetchSite = req.headers["sec-fetch-site"] as string | undefined;
  const hasFetchSite = typeof fetchSite === "string" && fetchSite.trim().length > 0;
  const origin = req.headers.origin as string | undefined;

  if ((req.method === "GET" || req.method === "HEAD") && !origin) {
    return hasFetchSite && fetchSite!.toLowerCase() === "same-origin";
  }

  return !!origin && isAllowedOrigin(origin, effective.origins) && hasFetchSite;
}

export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  // Endpoints publics
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  // Jeton valide : prioritaire, fonctionne quel que soit l'Origin envoyé.
  if (hasValidToken(req)) {
    next();
    return;
  }

  // Appels internes serveur-à-serveur (extensions appelant l'API en localhost).
  // Le file-analyzer fait un fetch HTTP interne pour analyser les fichiers,
  // et le proxy Vite de dev arrive également depuis 127.0.0.1.
  if (isLocalhost(req)) {
    next();
    return;
  }

  // Requêtes navigateur same-origin / cross-origin explicitement autorisées.
  if (isBrowserRequest(req)) {
    next();
    return;
  }

  if (!isAgentEnabled()) {
    res.status(401).json({
      error:
        "Authentication required. No API keys configured. Create one from the web UI (Settings → API Keys).",
    });
    return;
  }

  const token = getBearerToken(req) || getQueryToken(req);
  if (!token) {
    res.status(401).json({
      error: "Authentication required for external access. Use: Bearer <agent-token>",
    });
    return;
  }

  const key = validateToken(token);
  if (!key) {
    res.status(403).json({ error: "Invalid token" });
    return;
  }

  next();
}
