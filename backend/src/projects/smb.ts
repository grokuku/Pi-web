import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import crypto from "crypto";

/**
 * SMB/CIFS mount manager for Pi-Web.
 *
 * Mounts Windows shares (or any SMB share) into the container so
 * Pi can work on files stored on remote machines.
 *
 * Passwords are encrypted at rest using AES-256-GCM with a
 * server-derived key. The key is generated once and stored in
 * /app/.data/.smb-key — never exposed via API.
 *
 * Mount point convention: /mnt/smb/<sanitized-name>
 *
 * Requires:
 *  - cifs-utils installed in the container
 *  - privileged mode for mount operations
 */

const SMB_BASE = "/mnt/smb";
const SMB_KEY_FILE = path.join(process.env.HOME || "/root", ".pi", "agent", ".smb-key");
const SMB_KEY_ENV = process.env.SMB_ENCRYPTION_KEY; // Hex-encoded 32-byte key

// ── Password encryption ───────────────────────────

function getEncryptionKey(): Buffer {
  // Prefer environment variable if set
  if (process.env.SMB_ENCRYPTION_KEY) {
    try {
      const key = Buffer.from(process.env.SMB_ENCRYPTION_KEY, "hex");
      if (key.length === 32) {
        console.log("[SMB] Using encryption key from SMB_ENCRYPTION_KEY env var");
        return key;
      } else {
        console.warn("[SMB] SMB_ENCRYPTION_KEY is not 32 bytes (64 hex chars), ignoring");
      }
    } catch (e) {
      console.warn("[SMB] Failed to parse SMB_ENCRYPTION_KEY, falling back to file", e);
    }
  }

  // Fall back to file-based key
  try {
    if (existsSync(SMB_KEY_FILE)) {
      return Buffer.from(readFileSync(SMB_KEY_FILE, "utf-8"), "hex");
    }
  } catch {}
  // Generate new key
  const key = crypto.randomBytes(32);
  const dir = path.dirname(SMB_KEY_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SMB_KEY_FILE, key.toString("hex"), { mode: 0o600 });
  console.log(`[SMB] Generated new encryption key, stored in ${SMB_KEY_FILE}`);
  return key;
}

const encryptionKey = getEncryptionKey();

/** Encrypt a plaintext string. Returns "enc:<iv>:<ciphertext>:<authTag>" */
export function encryptSmbPassword(plaintext: string): string {
  if (!plaintext) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  let encrypted = cipher.update(plaintext, "utf-8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:${iv.toString("hex")}:${encrypted}:${authTag}`;
}

/** Decrypt an encrypted password string. Returns plaintext. */
export function decryptSmbPassword(encoded: string): string {
  if (!encoded) return "";
  if (!encoded.startsWith("enc:")) return encoded; // plaintext for backward compat
  try {
    const parts = encoded.split(":");
    if (parts.length !== 4) return encoded; // malformed, return as-is
    const iv = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];
    const authTag = Buffer.from(parts[3], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  } catch {
    return ""; // Decryption failed — password unusable
  }
}

// ── Mount management ──────────────────────────────

/** Ensure the base mount directory exists */
function ensureBaseDir() {
  if (!existsSync(SMB_BASE)) {
    mkdirSync(SMB_BASE, { recursive: true });
  }
}

/** Sanitize a project name for use as mount directory name */
function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Build the mount point path for a project */
export function getMountPoint(projectId: string, projectName?: string): string {
  if (projectName) return path.join(SMB_BASE, sanitizeName(projectName));
  return path.join(SMB_BASE, projectId);
}

/** Check if a path is already mounted */
export async function isMounted(mountPoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("mountpoint", ["-q", mountPoint], (err) => {
      resolve(!err);
    });
  });
}

/** Build the cifs mount options string. Password is passed via a credentials file to avoid shell escaping issues. */
async function buildCredentialsFile(username: string, password: string, domain?: string): Promise<string> {
  const { mkdtempSync, writeFileSync, unlinkSync } = await import("fs");
  const { tmpdir } = await import("os");
  const tmpDir = mkdtempSync(path.join(tmpdir(), "smb-"));
  const credFile = path.join(tmpDir, ".credentials");
  let content = "";
  if (domain) content += `domain=${domain}\n`;
  content += `username=${username}\n`;
  content += `password=${password}\n`;
  writeFileSync(credFile, content, { mode: 0o600 });
  return credFile;
}

function cleanupCredentialsFile(credFile: string) {
  try {
    const { unlinkSync, rmdirSync } = require("fs");
    unlinkSync(credFile);
    rmdirSync(path.dirname(credFile));
  } catch {}
}

/**
 * Mount an SMB share.
 *
 * Uses a credentials file instead of passing password via -o option.
 * This avoids shell escaping issues (e.g. $ in passwords or usernames).
 */
export async function mountSmb(
  share: string,
  mountPoint: string,
  options?: { username?: string; password?: string; domain?: string }
): Promise<{ ok: boolean; error?: string }> {
  // Normalize share path: smb:// → //
  let normalizedShare = share.replace(/^smb:\/\//, "//");

  // Ensure mount point exists
  if (!existsSync(mountPoint)) {
    mkdirSync(mountPoint, { recursive: true });
  }

  // Already mounted?
  if (await isMounted(mountPoint)) {
    return { ok: true };
  }

  // Decrypt password if encrypted
  const decryptedPassword = options?.password ? decryptSmbPassword(options.password) : "";
  const username = options?.username || "guest";
  const domain = options?.domain;

  // Build mount args
  const mountArgs = ["-t", "cifs", normalizedShare, mountPoint];

  if (username && decryptedPassword) {
    // Use credentials file to avoid escaping issues with $, spaces, etc.
    let credFile = "";
    try {
      credFile = await buildCredentialsFile(username, decryptedPassword, domain);
      mountArgs.push("-o", `credentials=${credFile},iocharset=utf8,file_mode=0666,dir_mode=0777,vers=3.0,actimeo=30`);
    } catch (e: any) {
      // Fallback to inline options if cred file fails
      console.warn("[SMB] Credentials file failed, using inline options:", e.message);
      const parts = [`username=${username}`, `password=${decryptedPassword}`];
      if (domain) parts.push(`domain=${domain}`);
      parts.push("iocharset=utf8", "file_mode=0666", "dir_mode=0777", "vers=3.0", "actimeo=30");
      mountArgs.push("-o", parts.join(","));
    }

    const result = await doMount(mountArgs, credFile);
    if (!result.ok && credFile) {
      // Try SMBv2 (some Windows servers don't support v3)
      console.warn("[SMB] SMBv3 failed, trying v2...");
      const v2Args = [...mountArgs];
      // Replace vers=3.0 with vers=2.0
      const lastIdx = v2Args.length - 1;
      v2Args[lastIdx] = v2Args[lastIdx].replace("vers=3.0", "vers=2.0");
      const v2Result = await doMount(v2Args, credFile);
      if (!v2Result.ok) {
        // Try SMBv1
        console.warn("[SMB] SMBv2 failed, trying v1...");
        const v1Args = [...mountArgs];
        v1Args[lastIdx] = v1Args[lastIdx].replace("vers=3.0", "vers=1.0");
        return doMount(v1Args, credFile);
      }
      return v2Result;
    }
    return result;
  } else {
    // Guest/anonymous access
    mountArgs.push("-o", "guest,iocharset=utf8,file_mode=0666,dir_mode=0777,vers=3.0,actimeo=30");
    const result = await doMount(mountArgs, "");
    if (!result.ok) {
      const v2Args = [...mountArgs];
      v2Args[v2Args.length - 1] = v2Args[v2Args.length - 1].replace("vers=3.0", "vers=2.0");
      return doMount(v2Args, "");
    }
    return result;
  }
}

function doMount(args: string[], credFile: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile("mount", args, { timeout: 15000 }, (err, _stdout, stderr) => {
      if (credFile) cleanupCredentialsFile(credFile);
      if (err) {
        console.error(`[SMB] Mount failed: ${err.message}`);
        if (stderr) console.error(`[SMB] stderr: ${stderr.trim()}`);
        resolve({ ok: false, error: `${err.message}${stderr ? ` — ${stderr.trim()}` : ""}` });
      } else {
        console.log(`[SMB] Mounted successfully`);
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Unmount an SMB share.
 */
export async function unmountSmb(mountPoint: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isMounted(mountPoint))) {
    return { ok: true };
  }

  return new Promise((resolve) => {
    execFile("umount", [mountPoint], { timeout: 10000 }, (err, _stdout, stderr) => {
      if (err) {
        console.warn(`[SMB] Lazy unmount ${mountPoint}: ${stderr?.trim() || err.message}`);
        execFile("umount", ["-l", mountPoint], { timeout: 10000 }, (err2) => {
          if (err2) {
            console.error(`[SMB] Lazy unmount also failed: ${err2.message}`);
            resolve({ ok: false, error: `Failed to unmount ${mountPoint}: ${err2.message}` });
          } else {
            console.log(`[SMB] Lazy unmounted ${mountPoint}`);
            resolve({ ok: true });
          }
        });
      } else {
        console.log(`[SMB] Unmounted ${mountPoint}`);
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Mount all SMB projects that have SMB config.
 * Called at startup.
 */
export async function mountAllSmbProjects(projects: { id: string; name?: string; storage: string; smb?: { share: string; mountPoint: string; username?: string; password?: string; domain?: string } }[]): Promise<void> {
  ensureBaseDir();
  for (const project of projects) {
    if (project.storage === "smb" && project.smb?.share) {
      const mountPoint = project.smb.mountPoint || getMountPoint(project.id, project.name);
      console.log(`[SMB] Auto-mounting ${project.smb.share} → ${mountPoint}`);
      const result = await mountSmb(project.smb.share, mountPoint, {
        username: project.smb.username,
        password: project.smb.password, // Will be decrypted inside mountSmb
        domain: project.smb.domain,
      });
      if (!result.ok) {
        console.error(`[SMB] Failed to mount ${project.smb.share}: ${result.error}`);
      }
    }
  }
}

/**
 * Unmount all SMB mounts.
 * Called at shutdown.
 */
export async function unmountAllSmb(): Promise<void> {
  if (!existsSync(SMB_BASE)) return;

  const { readdirSync } = await import("fs");
  const entries = readdirSync(SMB_BASE);
  for (const entry of entries) {
    const mountPoint = path.join(SMB_BASE, entry);
    if (await isMounted(mountPoint)) {
      console.log(`[SMB] Unmounting ${mountPoint}`);
      await unmountSmb(mountPoint);
    }
  }
}