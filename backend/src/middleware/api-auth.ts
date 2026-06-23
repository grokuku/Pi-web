import { type Request, type Response, type NextFunction } from "express";
import { validateToken, isAgentEnabled } from "../routes/agent-keys.js";

/**
 * Global API authentication middleware (BUG-29 fix).
 *
 * Strategy:
 *   1. Public endpoints (health, status) → always allowed
 *   2. Same-origin requests (web UI on the same server) → allowed
 *      Detected via Sec-Fetch-Site: same-origin (modern browsers)
 *      or Origin/Host hostname match (fallback)
 *   3. External requests (curl, other sites) → require valid Bearer token
 *
 * This has ZERO impact on the web UI experience: browser requests from
 * the same Express server are automatically same-origin and pass through.
 * Only external/non-browser access requires a token.
 *
 * Route-specific middlewares (agentAuth, adminAuth) run AFTER this one
 * and may add additional restrictions (e.g. agent API requires Bearer
 * even for same-origin).
 */

// Endpoints that must remain publicly accessible (no auth at all)
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/agent/health",
  "/api/status",
  "/api/status/update",
]);

function isSameOrigin(req: Request): boolean {
  // Modern browsers send Sec-Fetch-Site.
  const fetchSite = req.headers["sec-fetch-site"] as string | undefined;
  if (fetchSite === "same-origin") return true;
  if (fetchSite === "cross-site" || fetchSite === "none") return false;

  // Fallback for older browsers: compare Origin header against Host
  const origin = req.headers.origin as string | undefined;
  const host = req.headers.host as string | undefined;
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      // Allow if Origin hostname matches Host hostname
      // (ignores port differences, useful for Vite dev proxy: localhost:5173 → localhost:3000)
      return originUrl.hostname === host.split(":")[0];
    } catch {}
  }

  // No Origin and no Sec-Fetch-Site: non-browser request (curl, Postman, etc.)
  return false;
}

export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  // Allow public endpoints
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  // Same-origin requests from the web UI are allowed
  if (isSameOrigin(req)) {
    next();
    return;
  }

  // External requests require a valid Bearer token
  if (!isAgentEnabled()) {
    res.status(401).json({
      error:
        "Authentication required. No API keys configured. Create one from the web UI (Settings → API Keys).",
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Authentication required for external access. Use: Bearer <agent-token>",
    });
    return;
  }

  const token = authHeader.slice(7);
  const key = validateToken(token);
  if (!key) {
    res.status(403).json({ error: "Invalid token" });
    return;
  }

  next();
}