import { Router, type Request, type Response, type NextFunction } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { isBrowserRequest } from "../middleware/api-auth.js";
import { hashSecret, verifySecretHash, safeEqualSecret } from "../utils/secret-hash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const KEYS_FILE = path.join(DATA_DIR, "agent-keys.json");

const router = Router();

// ── Admin auth middleware ───────────────────────────
// Agent key management routes need authentication.
// Strategy:
//   1. Bootstrap: if NO agent keys exist yet → allow POST / to create the first key
//   2. Requêtes navigateur (web UI) : on réutilise isBrowserRequest() de
//      api-auth.ts — même logique que le reste de l'API, qui respecte le mode
//      allow-all (`*`) et la liste effective des origines (env + réglage UI).
//      On ne compare jamais Origin à Host.
//   3. External requests (curl, other websites, etc.) → require a valid Bearer token
//
// This prevents unauthenticated external access to key management while allowing
// the web UI to work without additional configuration.
// If you lose your only key, delete agent-keys.json and restart to re-bootstrap.

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  // Bootstrap: if no keys exist, allow POST / to create the first one
  if (!isAgentEnabled() && req.method === "POST" && req.path === "/") {
    next();
    return;
  }

  // Requêtes navigateur (same-origin / cross-origin autorisées) : on réutilise
  // isBrowserRequest() de api-auth.ts, qui gère le mode allow-all (`*`) de façon
  // cohérente avec le reste de l'API (sinon l'UI renverrait un 401 en mode `*`).
  if (isBrowserRequest(req)) {
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
  createdAt: string;
  lastUsedAt: string | null;
  /** Hash scrypt du token — format de stockage courant (SEC-08), jamais le secret lui-même. */
  tokenHash?: string;
  /** Token en clair — héritage uniquement (pré-SEC-08) ; re-haché puis retiré à la 1re validation. */
  token?: string;
  /** Aperçu non secret (8 premiers caractères + "…"), figé à la création. */
  tokenPreview?: string;
}

interface KeysStore {
  keys: AgentKey[];
}

// ── Persistence ─────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  try {
    chmodSync(DATA_DIR, 0o700); // permissions restrictives sur le répertoire de clés
  } catch {}
}

function loadKeys(): KeysStore {
  try {
    ensureDataDir();
    if (existsSync(KEYS_FILE)) {
      // Invalidité le cache mémo si le fichier a changé hors du process (édit externe).
      const stat = statSync(KEYS_FILE);
      if (stat.mtimeMs !== keysFileMtimeMs) {
        tokenCache.clear();
        keysFileMtimeMs = stat.mtimeMs;
      }
      return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[agent-keys] Failed to load:", e);
  }
  return { keys: [] };
}

/** Écriture atomique (tmp + rename) et permissions restrictives (0600). */
function saveKeys(store: KeysStore): void {
  ensureDataDir();
  const tmpFile = `${KEYS_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmpFile, KEYS_FILE);
}

// ── Validation (hash courant + héritage en clair) ──────────────

/** Cache mémo (mémoire vive uniquement) : token présenté → id de clé validée. */
const tokenCache = new Map<string, string>();
const TOKEN_CACHE_MAX = 500;
let keysFileMtimeMs = -1;

/** Retrouve la clé correspondant à un token présenté (hash scrypt ou héritage en clair). */
function matchToken(token: string, keys: AgentKey[]): AgentKey | null {
  for (const k of keys) {
    if (k.tokenHash && verifySecretHash(token, k.tokenHash)) return k;
    if (k.token && safeEqualSecret(token, k.token)) return k; // héritage en clair (pré-SEC-08)
  }
  return null;
}

/**
 * Migration transparente d'une clé héritée en clair vers le format hashé :
 * le token en clair est retiré du disque à la première validation réussie.
 * L'aperçu est figé avant destruction du secret (le hash ne permet pas de le
 * recalculer) ; le token reste VALIDE après migration (même secret accepté).
 * Retourne true si une migration a été écrite (l'appelant ne doit PAS
 * réécrire le store contenant encore le plaintext).
 */
function migrateToHash(key: AgentKey): boolean {
  if (key.tokenHash || !key.token) return false;
  const updated: AgentKey = {
    id: key.id,
    name: key.name,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    tokenHash: hashSecret(key.token),
    tokenPreview: key.tokenPreview || key.token.slice(0, 8) + "…",
  };
  const store = loadKeys();
  const idx = store.keys.findIndex(k => k.id === key.id);
  if (idx < 0) return false;
  store.keys[idx] = updated;
  saveKeys(store);
  console.log(`[agent-keys] Legacy key "${key.name}" migrated to hashed storage (plaintext removed).`);
  return true;
}

/** Check if a token is valid. Returns the matching key or null. */
export function validateToken(token: string): AgentKey | null {
  const store = loadKeys();
  // Cache mémo : le scrypt (~100 ms) n'est payé qu'une fois par token et par process.
  const cachedId = tokenCache.get(token);
  if (cachedId) {
    const cached = store.keys.find(k => k.id === cachedId);
    if (cached) {
      cached.lastUsedAt = new Date().toISOString();
      saveKeys(store);
      return cached;
    }
    tokenCache.delete(token); // clé révoquée entre-temps
  }
  const key = matchToken(token, store.keys);
  if (!key) return null;
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(token, key.id);
  key.lastUsedAt = new Date().toISOString();
  // Héritage en clair → hash (écriture unique, à la 1re utilisation). Si la
  // migration a écrit, on NE réécrit PAS le store mémoire (il contient encore
  // le token en clair) — migrateToHash a déjà persisté la version hashée.
  if (!migrateToHash(key)) saveKeys(store);
  return key;
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
      tokenPreview: k.tokenPreview ?? (k.token ? k.token.slice(0, 8) + "…" : "…"),
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      // SEC-08 : la révélation n'est possible que pour une clé héritée encore
      // en clair (non encore migrée) ; l'UI masque le bouton sinon.
      canReveal: typeof k.token === "string",
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
    const token = `pia_${crypto.randomBytes(24).toString("hex")}`;
    const key: AgentKey = {
      id: `key_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      name: name.trim(),
      // SEC-08 : seul le HASH est persisté. Le token en clair n'est retourné
      // qu'ICI (affiché une fois dans l'UI), jamais écrit sur disque.
      tokenHash: hashSecret(token),
      tokenPreview: token.slice(0, 8) + "…",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    store.keys.push(key);
    saveKeys(store);

    // Return the FULL token only on creation
    res.status(201).json({
      id: key.id,
      name: key.name,
      token,
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

// GET: reveal full token of a specific key (legacy plaintext keys only)
router.get("/:id/token", (req: Request, res: Response) => {
  try {
    const store = loadKeys();
    const key = store.keys.find(k => k.id === req.params.id);
    if (!key) return res.status(404).json({ error: "Key not found" });
    // SEC-08 : les tokens hachés ne peuvent plus être révélés — le secret
    // n'existe en clair qu'à la création (affiché une fois) et en mémoire vive.
    if (!key.token) {
      return res.status(410).json({
        error: "Token is stored hashed and cannot be revealed again. It was shown once at creation.",
      });
    }
    res.json({ token: key.token });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
