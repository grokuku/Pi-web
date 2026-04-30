import { writeFileSync, unlinkSync, chmodSync, existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";

/**
 * In-memory credential store for HTTPS Git authentication.
 *
 * Credentials are held in the Node.js process memory only — they are never
 * persisted to a long-lived file like `~/.git-credentials`.
 *
 * When a git operation needs credentials, the store writes them to a
 * per-host temp file (mode 0600) that the GIT_ASKPASS helper script reads.
 * These temp files are cleaned up automatically after each operation.
 */
class CredentialStore {
  private entries = new Map<string, { username: string; password: string }>();
  private tmpDir: string;

  constructor() {
    this.tmpDir = path.join(os.tmpdir(), "pi-web-creds");
    if (!existsSync(this.tmpDir)) {
      mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Store credentials for a given hostname.
   */
  set(hostname: string, username: string, password: string): void {
    this.entries.set(hostname, { username, password });
    this.writeTempFile(hostname, username, password);
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
  }

  /**
   * Remove all credentials from memory and disk.
   */
  clear(): void {
    for (const hostname of this.entries.keys()) {
      this.cleanUp(hostname);
    }
    this.entries.clear();
  }

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
}

// Singleton — credentials live for the lifetime of the Node.js process
export const credentialStore = new CredentialStore();