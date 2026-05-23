import { Router, type Request, type Response } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const KEYS_FILE = path.join(DATA_DIR, "agent-keys.json");

const router = Router();

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
