import { execFile } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";

/**
 * SMB/CIFS mount manager for Pi-Web.
 * 
 * Mounts Windows shares (or any SMB share) into the container so
 * Pi can work on files stored on remote machines.
 * 
 * Mount point convention: /mnt/smb/<project-id>
 * 
 * Requires:
 *  - cifs-utils installed in the container
 *  - CAP_SYS_ADMIN (or privileged mode) for mount operations
 */

const SMB_BASE = "/mnt/smb";

/** Ensure the base mount directory exists */
function ensureBaseDir() {
  if (!existsSync(SMB_BASE)) {
    mkdirSync(SMB_BASE, { recursive: true });
  }
}

/** Build the mount point path for a project */
export function getMountPoint(projectId: string): string {
  return path.join(SMB_BASE, projectId);
}

/** Check if a path is already mounted */
export async function isMounted(mountPoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("mountpoint", ["-q", mountPoint], (err) => {
      resolve(!err); // mountpoint returns 0 if mounted
    });
  });
}

/** Build the cifs mount options string */
function buildCifsOptions(username?: string, password?: string, domain?: string): string {
  const parts: string[] = [];
  if (username) parts.push(`username=${username}`);
  else parts.push("guest"); // anonymous access if no username

  if (password) parts.push(`password=${password}`);
  else if (!username) parts.push("password="); // empty password for guest

  if (domain) parts.push(`domain=${domain}`);

  // Common options for better compatibility
  parts.push("iocharset=utf8");
  parts.push("file_mode=0666");
  parts.push("dir_mode=0777");
  parts.push("vers=3.0"); // Try SMBv3 first
  parts.push("actimeo=30"); // Cache attributes for 30s

  return parts.join(",");
}

/**
 * Mount an SMB share.
 * 
 * @param share     UNC path like //192.168.1.100/share or smb://server/share
 * @param mountPoint Local directory to mount on
 * @param options   Optional credentials
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

  const mountOpts = buildCifsOptions(options?.username, options?.password, options?.domain);

  return new Promise((resolve) => {
    execFile(
      "mount",
      ["-t", "cifs", normalizedShare, mountPoint, "-o", mountOpts],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`[SMB] Mount failed: ${err.message}`);
          console.error(`[SMB] stderr: ${stderr}`);
          // Try SMBv1 if v3 fails (some older Windows shares)
          const v1Opts = mountOpts.replace("vers=3.0", "vers=1.0");
          execFile(
            "mount",
            ["-t", "cifs", normalizedShare, mountPoint, "-o", v1Opts],
            { timeout: 15000 },
            (err2, _stdout2, stderr2) => {
              if (err2) {
                console.error(`[SMB] Mount v1 also failed: ${err2.message}`);
                console.error(`[SMB] stderr: ${stderr2}`);
                resolve({
                  ok: false,
                  error: `Failed to mount ${normalizedShare}: ${err.message}. SMBv1 fallback also failed: ${err2.message}`,
                });
              } else {
                console.log(`[SMB] Mounted ${normalizedShare} at ${mountPoint} (SMBv1)`);
                resolve({ ok: true });
              }
            }
          );
        } else {
          console.log(`[SMB] Mounted ${normalizedShare} at ${mountPoint}`);
          resolve({ ok: true });
        }
      }
    );
  });
}

/**
 * Unmount an SMB share.
 */
export async function unmountSmb(mountPoint: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isMounted(mountPoint))) {
    return { ok: true }; // Already unmounted
  }

  return new Promise((resolve) => {
    execFile("umount", [mountPoint], { timeout: 10000 }, (err, _stdout, stderr) => {
      if (err) {
        // Try lazy unmount
        console.warn(`[SMB] Lazy unmount ${mountPoint}: ${stderr}`);
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
export async function mountAllSmbProjects(projects: { id: string; storage: string; smb?: { share: string; mountPoint: string; username?: string; password?: string; domain?: string } }[]): Promise<void> {
  ensureBaseDir();
  for (const project of projects) {
    if (project.storage === "smb" && project.smb?.share) {
      const mountPoint = project.smb.mountPoint || getMountPoint(project.id);
      console.log(`[SMB] Auto-mounting ${project.smb.share} → ${mountPoint}`);
      const result = await mountSmb(project.smb.share, mountPoint, {
        username: project.smb.username,
        password: project.smb.password,
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
  const fs = await import("fs");
  const { readdirSync } = fs;

  if (!existsSync(SMB_BASE)) return;

  const entries = readdirSync(SMB_BASE);
  for (const entry of entries) {
    const mountPoint = path.join(SMB_BASE, entry);
    if (await isMounted(mountPoint)) {
      console.log(`[SMB] Unmounting ${mountPoint}`);
      await unmountSmb(mountPoint);
    }
  }
}