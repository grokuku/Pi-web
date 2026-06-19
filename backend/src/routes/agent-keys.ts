import { Router, type Request, type Response, type NextFunction } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const KEYS_FILE = path.join(DATA_DIR, "agent-keys.json");

const router = Router();

// ── Admin auth middleware ───────────────────────────
// Agent key management routes need authentication.
// Strategy:
//   1. Bootstrap: if NO agent keys exist yet → allow POST / to create the first key
//   2. Same-origin: requests from the web UI (browser on same server) are allowed
//      via Sec-Fetch-Site: same-origin header (modern browsers) or Origin/Host match
//   3. External requests (curl, other websites, etc.) → require a valid Bearer token
//
// This prevents unauthenticated external access to key management while allowing
// the web UI to work without additional configuration.
// If you lose your only key, delete agent-keys.json and restart to re-bootstrap.
function isSameOrigin(req: Request): boolean {
  // Modern browsers (Chrome 76+, Firefox 90+, Safari 16.1+) send Sec-Fetch-Site.
  // "same-origin" = request comes from the same origin as the target URL.
  // This works in both production (same Express server) and dev (Vite proxy).
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

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  // Bootstrap: if no keys exist, allow POST / to create the first one
  if (!isAgentEnabled() && req.method === "POST" && req.path === "/") {
    next();
    return;
  }

  // Same-origin requests from the web UI are allowed
  if (isSameOrigin(req)) {
    next();
    return;
  }

  // External requests require a valid agent token
  if (!isAgentEnabled()) {
    res.status(503).json({
      error: "No agent keys configured. Create one from the web UI (Settings → API Keys).",
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required for external access. Use: Bearer <agent-token>" });
    return;
  }

  const token = authHeader.slice(7);
  const key = validateToken(token);
  if (!key) {
    res.status(403).json({ error: "Invalid agent token" });
    return;
  }

  next();
}

// Apply admin auth to ALL agent-keys routes
router.use(adminAuth);

// ── Types ──────────────────────────────────────────

interface AgentKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface KeysStore {
  keys: AgentKey[];
}

// ── Persistence ─────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadKeys(): KeysStore {
  try {
    ensureDataDir();
    if (existsSync(KEYS_FILE)) {
      return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[agent-keys] Failed to load:", e);
  }
  return { keys: [] };
}

function saveKeys(store: KeysStore): void {
  ensureDataDir();
  writeFileSync(KEYS_FILE, JSON.stringify(store, null, 2));
}

/** Check if a token is valid. Returns the matching key or null. */
export function validateToken(token: string): AgentKey | null {
  const store = loadKeys();
  const key = store.keys.find(k => k.token === token);
  if (key) {
    key.lastUsedAt = new Date().toISOString();
    saveKeys(store);
    return key;
  }
  return null;
}

/** Check if the agent API has any configured keys. */
export function isAgentEnabled(): boolean {
  const store = loadKeys();
  return store.keys.length > 0;
}

// ── Routes ──────────────────────────────────────────

// GET: list all keys (never expose full token in list)
router.get("/", (_req: Request, res: Response) => {
  try {
    const store = loadKeys();
    const keys = store.keys.map(k => ({
      id: k.id,
      name: k.name,
      tokenPreview: k.token.slice(0, 8) + "…",
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    }));
    res.json({ keys });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST: create a new key
router.post("/", (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const store = loadKeys();
    const key: AgentKey = {
      id: `key_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      name: name.trim(),
      token: `pia_${crypto.randomBytes(24).toString("hex")}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    store.keys.push(key);
    saveKeys(store);

    // Return the FULL token only on creation
    res.status(201).json({
      id: key.id,
      name: key.name,
      token: key.token,
      createdAt: key.createdAt,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE: remove a key
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const store = loadKeys();
    const before = store.keys.length;
    store.keys = store.keys.filter(k => k.id !== req.params.id);
    if (store.keys.length === before) {
      return res.status(404).json({ error: "Key not found" });
    }
    saveKeys(store);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET: reveal full token of a specific key (for copy)
router.get("/:id/token", (req: Request, res: Response) => {
  try {
    const store = loadKeys();
    const key = store.keys.find(k => k.id === req.params.id);
    if (!key) return res.status(404).json({ error: "Key not found" });
    res.json({ token: key.token });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
