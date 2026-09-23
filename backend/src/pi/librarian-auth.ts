import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { type Request, type Response, type NextFunction } from "express";
import { isBrowserRequest } from "../middleware/api-auth.js";
import { hashSecret, verifySecretHash, safeEqualSecret } from "../utils/secret-hash.js";
import { isTrustedLocalRequest } from "../utils/request-identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// SEC-08 (Lot A) : 3 niveaux depuis pi/ — convention du repo (cf. providers.ts).
// En production : /app/.data (volume docker-compose persistant). L'ancien
// chemin à 2 niveaux (backend/.data) était PERDU à chaque rebuild du conteneur.
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const KEYS_FILE = path.join(DATA_DIR, "librarian-keys.json");
// Ancien emplacement (2 niveaux) — conservé uniquement pour la migration à chaud.
const LEGACY_KEYS_FILE = path.join(__dirname, "..", "..", ".data", "librarian-keys.json");

// ── Types ──

export interface LibrarianKey {
  /** Identifiant NON secret et stable (exposé par l'API, utilisé pour la suppression — BUG-01). */
  id: string;
  name: string;
  createdAt: string;
  /** Aperçu non secret du secret (préfixe + "…"), figé à la création / migration. */
  keyPreview: string;
  /** Hash scrypt du secret — format de stockage courant (SEC-08). */
  keyHash?: string;
  /** Secret en clair — héritage uniquement (pré-SEC-08) ; re-haché puis retiré à la 1re validation. */
  key?: string;
}

// ── Persistence ──

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  try {
    chmodSync(DATA_DIR, 0o700); // permissions restrictives sur le répertoire de clés
  } catch {}
}

/**
 * Migration de l'ANCIEN emplacement (backend/.data, non persistant) vers le
 * volume persistant. Exécutée au premier chargement : les clés existantes
 * survivent à la correction de chemin (le fichier source est renommé, pas
 * supprimé, pour conserver une trace et éviter une ré-importation obsolète).
 */
function migrateLegacyKeysFile(): void {
  if (existsSync(KEYS_FILE) || !existsSync(LEGACY_KEYS_FILE)) return;
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_KEYS_FILE, "utf-8")) as LibrarianKey[];
    const normalized = Array.isArray(legacy) ? legacy.map(normalizeKey) : [];
    saveKeys(normalized);
    try { renameSync(LEGACY_KEYS_FILE, LEGACY_KEYS_FILE + ".migrated"); } catch {}
    console.log(`[librarian-auth] Migrated ${normalized.length} key(s) from ${LEGACY_KEYS_FILE} to ${KEYS_FILE}`);
  } catch (e) {
    console.error("[librarian-auth] Legacy keys migration failed:", e);
  }
}

export function loadKeys(): LibrarianKey[] {
  try {
    ensureDataDir();
    migrateLegacyKeysFile();
    if (existsSync(KEYS_FILE)) {
      // Invalidité le cache mémo si le fichier a changé hors du process (édit externe).
      const stat = statSync(KEYS_FILE);
      if (stat.mtimeMs !== keysFileMtimeMs) {
        validationCache.clear();
        keysFileMtimeMs = stat.mtimeMs;
      }
      const raw = JSON.parse(readFileSync(KEYS_FILE, "utf-8")) as LibrarianKey[];
      return Array.isArray(raw) ? raw.map(normalizeKey) : [];
    }
  } catch (e) {
    console.error("[librarian-auth] Failed to load keys:", e);
  }
  return [];
}

/**
 * Écriture atomique (tmp + rename) et permissions restrictives (0600).
 * NB : les secrets hérités encore en clair (champ `key`) restent tels quels
 * jusqu'à leur première validation réussie, puis sont remplacés par keyHash.
 */
export function saveKeys(keys: LibrarianKey[]): void {
  ensureDataDir();
  const tmpFile = `${KEYS_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  renameSync(tmpFile, KEYS_FILE);
}

/** Generate a new API key string: lib- + 32 random hex chars */
function generateKeyString(): string {
  return "lib-" + crypto.randomBytes(16).toString("hex");
}

/** Préfixe d'identifiant non secret des clés libraire. */
const ID_PREFIX = "libk_";

/** Masque un secret pour l'affichage (identique au masquage historique de l'API de listage). */
export function maskSecret(secret: string): string {
  return secret.slice(0, 12) + "…";
}

/**
 * Identifiant NON secret dérivé du secret lui-même (SHA-256 tronqué : il est
 * préimage-résistant, l'id n'expose donc rien). Utilisé pour les clés héritées
 * sans `id`, afin que listage et suppression restent stables sans réécriture.
 */
export function deriveIdFromSecret(secret: string): string {
  return ID_PREFIX + crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/**
 * Identifiant stable d'une clé : explicite si présent, sinon dérivé du secret
 * hérité (stable), du hash, sinon aléatoire (cas dégénéré jamais persisté).
 */
export function keyIdOf(k: LibrarianKey): string {
  if (k.id) return k.id;
  if (k.key) return deriveIdFromSecret(k.key);
  if (k.keyHash) return ID_PREFIX + crypto.createHash("sha256").update(k.keyHash).digest("hex").slice(0, 12);
  return ID_PREFIX + crypto.randomBytes(6).toString("hex");
}

/** Garantit un `id` sur une clé chargée depuis le disque (héritage sans id). */
function normalizeKey(k: LibrarianKey): LibrarianKey {
  if (!k.id) k.id = keyIdOf(k);
  return k;
}

/** Create and persist a new API key. Retourne le secret complet (affiché une fois). */
export function createKey(name: string): LibrarianKey & { key: string } {
  const keys = loadKeys();
  const secret = generateKeyString();
  const record: LibrarianKey = {
    id: ID_PREFIX + crypto.randomBytes(6).toString("hex"),
    keyHash: hashSecret(secret), // le secret en clair n'est JAMAIS persisté
    keyPreview: maskSecret(secret),
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
  keys.push(record);
  saveKeys(keys);
  return { ...record, key: secret };
}

// ── Validation (hash courant + héritage en clair) ──

/** Cache mémo (mémoire vive uniquement) : secret présenté → id de clé validée. */
const validationCache = new Map<string, string>();
const VALIDATION_CACHE_MAX = 500;
let keysFileMtimeMs = -1;

/** Retrouve la clé correspondant à un secret présenté (hash scrypt ou héritage en clair). */
function matchKey(secret: string, keys: LibrarianKey[]): LibrarianKey | null {
  for (const k of keys) {
    if (k.keyHash && verifySecretHash(secret, k.keyHash)) return k;
    if (k.key && safeEqualSecret(secret, k.key)) return k; // héritage en clair (pré-SEC-08), comparaison à temps constant
  }
  return null;
}

/**
 * Migration transparente d'une clé héritée en clair vers le format hashé.
 * L'identifiant (dérivé du secret avant destruction) est persisté pour rester stable.
 */
function migrateToHash(found: LibrarianKey): void {
  if (found.keyHash || !found.key) return;
  const updated: LibrarianKey = {
    id: found.id,
    name: found.name,
    createdAt: found.createdAt,
    keyPreview: found.keyPreview || maskSecret(found.key),
    keyHash: hashSecret(found.key),
  };
  const keys = loadKeys();
  const idx = keys.findIndex(k => k.id === found.id);
  if (idx < 0) return;
  keys[idx] = updated;
  saveKeys(keys);
  console.log(`[librarian-auth] Legacy key "${found.name}" migrated to hashed storage (plaintext removed).`);
}

/** Validate an API key string against stored keys */
export function validateKey(key: string): boolean {
  const keys = loadKeys();
  // Cache mémo : le scrypt (~100 ms) n'est payé qu'une fois par secret et par process.
  const cachedId = validationCache.get(key);
  if (cachedId) {
    if (keys.some(k => k.id === cachedId)) return true;
    validationCache.delete(key); // clé révoquée entre-temps
  }
  const found = matchKey(key, keys);
  if (!found) return false;
  if (validationCache.size >= VALIDATION_CACHE_MAX) validationCache.clear();
  validationCache.set(key, found.id);
  migrateToHash(found); // héritage en clair → hash (écriture unique, à la 1re utilisation)
  return true;
}

/**
 * Retrouve le NOM d'une clé API à partir de sa valeur (null si inconnue).
 * Utilisé par la mémoire partagée pour tagger les écritures externes
 * avec "external:<keyName>" (traçabilité de l'origine des entrées).
 */
export function findKeyName(key: string): string | null {
  const keys = loadKeys();
  return matchKey(key, keys)?.name ?? null;
}

/** Revoke (delete) an API key by its NON-secret id (BUG-01 — plus jamais par le secret). */
export function revokeKey(id: string): boolean {
  const keys = loadKeys();
  const filtered = keys.filter(k => keyIdOf(k) !== id);
  if (filtered.length === keys.length) return false;
  saveKeys(filtered);
  return true;
}

// ── Middleware ──

/**
 * Librarian API auth middleware.
 * - Localhost requests (Pi-Web internal) → bypass
 * - External requests → require valid X-API-Key header
 * SEC-02 : la détection locale repose sur l'adresse RÉELLE de la socket
 * (isTrustedLocalRequest), non forgeable, jamais sur req.ip.
 */
export function librarianAuth(req: Request, res: Response, next: NextFunction): void {
  if (isTrustedLocalRequest(req)) {
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
 * Deux origines autorisées (même logique que adminAuth des agent-keys) :
 * - localhost (interne Pi-Web, docker exec)
 * - navigateur same-origin (l'UI Settings → API Keys est rendue par Pi-Web) :
 *   sans ça, l'UI distante recevait 403 "only available from localhost" et
 *   ne pouvait JAMAIS créer de clé libraire.
 */
export function librarianAdminOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isTrustedLocalRequest(req) && !isBrowserRequest(req)) {
    res.status(403).json({ error: "Key management is only available from localhost or the web UI" });
    return;
  }
  next();
}