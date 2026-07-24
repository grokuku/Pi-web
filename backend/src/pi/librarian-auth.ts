import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { type Request, type Response, type NextFunction } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", ".data");
const KEYS_FILE = path.join(DATA_DIR, "librarian-keys.json");

// ── Types ──

export interface LibrarianKey {
  key: string;
  name: string;
  createdAt: string;
}

// ── Persistence ──

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadKeys(): LibrarianKey[] {
  try {
    ensureDataDir();
    if (existsSync(KEYS_FILE)) {
      return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[librarian-auth] Failed to load keys:", e);
  }
  return [];
}

export function saveKeys(keys: LibrarianKey[]): void {
  ensureDataDir();
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

/** Generate a new API key string: lib- + 32 random hex chars */
function generateKeyString(): string {
  return "lib-" + crypto.randomBytes(16).toString("hex");
}

/** Create and persist a new API key */
export function createKey(name: string): LibrarianKey {
  const keys = loadKeys();
  const newKey: LibrarianKey = {
    key: generateKeyString(),
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
  keys.push(newKey);
  saveKeys(keys);
  return newKey;
}

/** Revoke (delete) an API key by its value */
export function revokeKey(key: string): boolean {
  const keys = loadKeys();
  const before = keys.length;
  const filtered = keys.filter(k => k.key !== key);
  if (filtered.length === before) return false;
  saveKeys(filtered);
  return true;
}

/** Validate an API key string against stored keys */
export function validateKey(key: string): boolean {
  const keys = loadKeys();
  return keys.some(k => k.key === key);
}

// ── Localhost detection ──

function isLocalhost(req: Request): boolean {
  const remoteIp = req.ip || req.socket.remoteAddress;
  return (
    remoteIp === "127.0.0.1" ||
    remoteIp === "::1" ||
    remoteIp === "::ffff:127.0.0.1"
  );
}

// ── Middleware ──

/**
 * Librarian API auth middleware.
 * - Localhost requests (Pi-Web internal) → bypass
 * - External requests → require valid X-API-Key header
 */
export function librarianAuth(req: Request, res: Response, next: NextFunction): void {
  if (isLocalhost(req)) {
    next();
    return;
  }

  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey || !validateKey(apiKey)) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }

  next();
}

/**
 * Admin-only middleware for key management routes.
 * Only localhost requests are allowed (no librarianAuth needed).
 */
export function librarianAdminOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: "Key management is only available from localhost" });
    return;
  }
  next();
}