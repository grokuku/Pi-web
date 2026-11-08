import { readFileSync, unlinkSync, chmodSync, existsSync, mkdirSync } from "fs";
import { writeFileAtomicSync } from "../utils/atomic-store.js";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
 *
 * CHANGELOG (sécurité) : le plaintext ne touche PLUS le disque du tout. Le
 * « temp file GIT_ASKPASS » (user\ntoken en clair dans /tmp) a été supprimé :
 * il n'était lu par personne, l'authentification passant par le token injecté
 * dans l'URL du remote. Le seul artefact sur disque est `credentials.enc`
 * (AES-256-GCM).
 */
class CredentialStore {
  private entries = new Map<string, { username: string; password: string }>();
  private tmpDir: string;
  private masterKey: Buffer | null = null;
  // Raison de l'échec de chargement de `credentials.enc` (null = chargement OK).
  // Bloque toute écriture : voir persistToDisk().
  private loadFailure: string | null = null;

  constructor() {
    this.tmpDir = path.join(os.tmpdir(), "pi-web-creds");
    if (!existsSync(this.tmpDir)) {
      mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    }

    console.log(`[CredentialStore] DATA_DIR=${DATA_DIR}, tmpDir=${this.tmpDir}`);

    // Load or generate master key, then decrypt any persisted credentials
    this.initializeMasterKey();
    this.loadPersistedCredentials();
    
    if (this.masterKey) {
      console.log(`[CredentialStore] Master key loaded (${this.masterKey.length} bytes), ${this.entries.size} credentials`);
    } else {
      console.warn("[CredentialStore] No master key — credentials will NOT be persisted!");
    }
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
    // Écriture atomique : une clé tronquée rendrait `credentials.enc` DÉFINITIVEMENT
    // indéchiffrable (donc tous les jetons perdus).
    writeFileAtomicSync(SECRET_KEY_PATH, key.toString("hex"), { mode: 0o600 });
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

      // Load into memory (le plaintext n'est jamais réécrit sur disque)
      for (const [hostname, creds] of Object.entries(data)) {
        this.entries.set(hostname, creds);
      }

      console.log(`[CredentialStore] Loaded ${this.entries.size} persisted credential(s)`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[CredentialStore] Failed to load persisted credentials:", reason);
      // Ne PAS crasher le démarrage (le serveur doit rester debout), mais ne
      // JAMAIS repartir comme si le fichier n'existait pas : toute écriture qui
      // suivrait écraserait des jetons encore récupérables (cf. persistToDisk).
      this.loadFailure = reason;
    }
  }

  private persistToDisk(): void {
    if (!this.masterKey) return;

    // ⚠️ Garde-fou : le fichier existe mais on n'a pas su le déchiffrer/le
    // parser au démarrage. Réécrire maintenant détruirait DÉFINITIVEMENT tous
    // les jetons qu'il contient encore (clé maître remplacée, fichier tronqué).
    // On refuse tant que l'utilisateur n'a pas tranché.
    if (this.loadFailure !== null) {
      throw new Error(
        `Refusing to overwrite "${ENCRYPTED_CREDENTIALS_PATH}": it could not be read at startup ` +
          `(${this.loadFailure}). Move it away (or restore it) before saving new credentials.`
      );
    }

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

    // Écriture ATOMIQUE (tmp + rename) : un crash en cours d'écriture laissait
    // sinon un `credentials.enc` tronqué → tous les jetons perdus au démarrage
    // suivant. Le fichier final garde 0600.
    writeFileAtomicSync(ENCRYPTED_CREDENTIALS_PATH, encrypted, { mode: 0o600 });
    chmodSync(ENCRYPTED_CREDENTIALS_PATH, 0o600);
  }

  // ─── Public API ────────────────────────────────────

  /**
   * Store credentials for a given hostname.
   * Persists to encrypted disk storage automatically.
   */
  set(hostname: string, username: string, password: string): void {
    this.entries.set(hostname, { username, password });
    // NOTE sécurité : le plaintext n'est JAMAIS écrit ailleurs que dans le
    // fichier chiffré. Plus de temp file d'identifiants (cf. cleanUp).
    this.persistToDisk();
    console.log(`[CredentialStore] Stored credentials for ${hostname} (persisted=${!!this.masterKey})`);
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
   * Liste les hôtes qui ont un jeton enregistré (JAMAIS les valeurs).
   * Sert à l'UI pour savoir s'il y a quelque chose à « oublier ».
   */
  listHosts(): string[] {
    return [...this.entries.keys()];
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

  // ─── Nettoyage des fichiers résiduels d'anciennes versions ────────

  /**
   * Supprime le fichier transitoire d'un hostname.
   *
   * ⚠️ Plus AUCUN chemin n'écrit ce fichier : il n'était lu par personne
   * (Pi-Web n'assigne jamais GIT_ASKPASS, refusé par git >= 2.36 sans
   * allowUnsafeAskPass ; l'authentification passe par le token injecté dans
   * l'URL du remote). `writeTempFile()`/`withTempFile()` et leurs 3 appelants
   * (gitPull / gitPush / gitClone) ont donc été supprimés : ils ne faisaient
   * qu'écrire le token EN CLAIR sur disque le temps d'une opération.
   *
   * Cette méthode reste indispensable pour EFFACER les fichiers laissés par
   * une version antérieure (ou un conteneur arrêté brutalement). Ne PAS
   * rebrancher un helper ASKPASS sur ce chemin sans aligner le format.
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
   * Get the temp file path for a hostname (legacy leftovers).
   * Uses a truncated SHA-256 hash of the hostname to avoid collisions.
   */
  tmpPath(hostname: string): string {
    const hash = crypto.createHash("sha256").update(hostname).digest("hex").slice(0, 16);
    return path.join(this.tmpDir, hash);
  }
}

// Singleton — credentials live for the lifetime of the Node.js process
export const credentialStore = new CredentialStore();