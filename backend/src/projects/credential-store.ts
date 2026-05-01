import { writeFileSync, readFileSync, unlinkSync, chmodSync, existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const SECRET_KEY_PATH = path.join(DATA_DIR, ".secret-key");
const ENCRYPTED_CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.enc");

// AES-256-GCM constants
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * Persistent encrypted credential store for HTTPS Git authentication.
 *
 * Credentials are:
 * 1. Held in the Node.js process memory (for fast access during git ops)
 * 2. Persisted to disk encrypted with AES-256-GCM
 * 3. The encryption key is auto-generated on first run and stored in .data/.secret-key
 *
 * This survives container restarts while keeping credentials protected at rest.
 * An attacker with access to credentials.enc alone cannot read the credentials.
 * An attacker with access to the secret key AND the encrypted file has container-level
 * access anyway, so the threat model is: protect against credential leaks via
 * backup files, git repo accidents, or casual file snooping.
 */
class CredentialStore {
  private entries = new Map<string, { username: string; password: string }>();
  private tmpDir: string;
  private masterKey: Buffer | null = null;

  constructor() {
    this.tmpDir = path.join(os.tmpdir(), "pi-web-creds");
    if (!existsSync(this.tmpDir)) {
      mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    }

    // Load or generate master key, then decrypt any persisted credentials
    this.initializeMasterKey();
    this.loadPersistedCredentials();
  }

  // ─── Master Key Management ─────────────────────────

  private initializeMasterKey(): void {
    this.ensureDataDir();

    if (existsSync(SECRET_KEY_PATH)) {
      // Load existing key
      const keyHex = readFileSync(SECRET_KEY_PATH, "utf-8").trim();
      this.masterKey = Buffer.from(keyHex, "hex");
      // Validate key length
      if (this.masterKey.length !== KEY_LENGTH) {
        console.warn("[CredentialStore] Invalid master key length, regenerating...");
        this.masterKey = this.generateAndSaveMasterKey();
      }
    } else {
      // First run: generate a new random key
      this.masterKey = this.generateAndSaveMasterKey();
    }
  }

  private generateAndSaveMasterKey(): Buffer {
    const key = crypto.randomBytes(KEY_LENGTH);
    writeFileSync(SECRET_KEY_PATH, key.toString("hex"), { mode: 0o600 });
    chmodSync(SECRET_KEY_PATH, 0o600);
    return key;
  }

  private ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    }
  }

  // ─── Encryption / Decryption ───────────────────────

  private encrypt(data: string): string {
    if (!this.masterKey) throw new Error("Master key not initialized");

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);

    let encrypted = cipher.update(data, "utf-8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encryptedData (all hex)
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  }

  private decrypt(encoded: string): string {
    if (!this.masterKey) throw new Error("Master key not initialized");

    const parts = encoded.split(":");
    if (parts.length !== 3) throw new Error("Invalid encrypted credential format");

    const [ivHex, authTagHex, encryptedData] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, "hex", "utf-8");
    decrypted += decipher.final("utf-8");

    return decrypted;
  }

  // ─── Persistence ───────────────────────────────────

  private loadPersistedCredentials(): void {
    if (!existsSync(ENCRYPTED_CREDENTIALS_PATH) || !this.masterKey) return;

    try {
      const encrypted = readFileSync(ENCRYPTED_CREDENTIALS_PATH, "utf-8").trim();
      if (!encrypted) return;

      const decrypted = this.decrypt(encrypted);
      const data = JSON.parse(decrypted) as Record<string, { username: string; password: string }>;

      // Load into memory (skip writeTempFile here — it will be created on demand)
      for (const [hostname, creds] of Object.entries(data)) {
        this.entries.set(hostname, creds);
      }

      console.log(`[CredentialStore] Loaded ${this.entries.size} persisted credential(s)`);
    } catch (e) {
      console.warn("[CredentialStore] Failed to load persisted credentials:", e instanceof Error ? e.message : e);
      // Don't crash — just start with empty store
    }
  }

  private persistToDisk(): void {
    if (!this.masterKey) return;

    this.ensureDataDir();

    if (this.entries.size === 0) {
      // Remove the file if no credentials left
      try {
        unlinkSync(ENCRYPTED_CREDENTIALS_PATH);
      } catch {
        // file may not exist
      }
      return;
    }

    // Serialize all entries
    const data: Record<string, { username: string; password: string }> = {};
    for (const [hostname, creds] of this.entries) {
      data[hostname] = creds;
    }

    const json = JSON.stringify(data);
    const encrypted = this.encrypt(json);

    writeFileSync(ENCRYPTED_CREDENTIALS_PATH, encrypted, { mode: 0o600 });
    chmodSync(ENCRYPTED_CREDENTIALS_PATH, 0o600);
  }

  // ─── Public API ────────────────────────────────────

  /**
   * Store credentials for a given hostname.
   * Persists to encrypted disk storage automatically.
   */
  set(hostname: string, username: string, password: string): void {
    this.entries.set(hostname, { username, password });
    this.writeTempFile(hostname, username, password);
    this.persistToDisk();
  }

  /**
   * Get stored credentials for a hostname.
   */
  get(hostname: string): { username: string; password: string } | undefined {
    return this.entries.get(hostname);
  }

  /**
   * Check if credentials exist for a hostname.
   */
  has(hostname: string): boolean {
    return this.entries.has(hostname);
  }

  /**
   * Remove credentials for a hostname from memory and disk.
   */
  delete(hostname: string): void {
    this.entries.delete(hostname);
    this.cleanUp(hostname);
    this.persistToDisk();
  }

  /**
   * Remove all credentials from memory and disk.
   */
  clear(): void {
    for (const hostname of this.entries.keys()) {
      this.cleanUp(hostname);
    }
    this.entries.clear();
    this.persistToDisk();
  }

  // ─── Temp File Management (for GIT_ASKPASS) ────────

  /**
   * Write credentials to a per-host temp file for the ASKPASS helper.
   * Format: two lines — username on line 1, password on line 2.
   * File permissions: 0600 (owner read/write only).
   */
  private writeTempFile(hostname: string, username: string, password: string): void {
    const filePath = this.tmpPath(hostname);
    writeFileSync(filePath, `${username}\n${password}\n`, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  }

  /**
   * Remove the temp file for a hostname.
   */
  cleanUp(hostname: string): void {
    const filePath = this.tmpPath(hostname);
    try {
      unlinkSync(filePath);
    } catch {
      // file may not exist, ignore
    }
  }

  /**
   * Get the temp file path for a hostname.
   * Uses a safe filename (non-special chars only).
   */
  tmpPath(hostname: string): string {
    const safe = hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    return path.join(this.tmpDir, safe);
  }

  /**
   * Get the ASKPASS helper script path.
   */
  get askpassScript(): string {
    return path.join(this.tmpDir, "git-askpass.sh");
  }

  /**
   * Ensure temp files exist for all entries (called after loading persisted credentials).
   * This is needed because loaded credentials don't have temp files yet.
   */
  ensureTempFiles(): void {
    for (const [hostname, creds] of this.entries) {
      this.writeTempFile(hostname, creds.username, creds.password);
    }
  }
}

// Singleton — credentials live for the lifetime of the Node.js process
export const credentialStore = new CredentialStore();