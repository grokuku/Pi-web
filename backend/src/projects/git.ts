import { simpleGit, type SimpleGit, type LogResult, ResetMode } from "simple-git";
import { existsSync, readdirSync, mkdirSync, statSync, unlinkSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Project } from "./manager.js";
import { updateProjectGit } from "./manager.js";
import { credentialStore } from "./credential-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prevent git from prompting for credentials on stdin (which would hang indefinitely
// since simple-git has no interactive terminal). With this env var, git fails immediately
// with an error instead of prompting.
process.env.GIT_TERMINAL_PROMPT = "0";

// ── Lock file cleanup ──────────────────────────
// If a git process crashes, it leaves a stale .git/index.lock.
// This blocks all subsequent git operations. We detect and remove stale locks.
const LOCK_MAX_AGE_MS = 30_000; // 30 seconds — if older, considered stale

function cleanupGitLock(cwd: string): boolean {
  const lockFile = path.join(cwd, ".git", "index.lock");
  if (!existsSync(lockFile)) return false;
  try {
    const stat = statSync(lockFile);
    const age = Date.now() - stat.mtimeMs;
    if (age > LOCK_MAX_AGE_MS) {
      unlinkSync(lockFile);
      console.log(`[git] Removed stale lock file (${Math.round(age / 1000)}s old): ${lockFile}`);
      return true;
    }
    // Lock is recent — another git process might be genuinely running
    console.log(`[git] Lock file is recent (${Math.round(age / 1000)}s), leaving it`);
  } catch {
    // If we can't even stat it, it's probably corrupted
    try { unlinkSync(lockFile); console.log(`[git] Removed corrupt lock file: ${lockFile}`); return true; } catch {}
  }
  return false;
}

/** Check if an error is a git lock conflict */
function isLockError(msg: string): boolean {
  return msg.includes("index.lock") || msg.includes("Unable to create");
}

// Default timeout for git operations that may hang (push, pull, clone, etc.)
const GIT_NETWORK_TIMEOUT_MS = 30_000;

/**
 * Wrap a promise with a timeout that rejects with a clear error message.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s — this usually means authentication is required or the remote is unreachable`)),
      ms,
    );
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ── Types ──────────────────────────────────────────────

export interface GitStatusFull {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  deleted: string[];
  created: string[];
  conflict: string[];
  files: Array<{ path: string; status: string }>;
  isClean: boolean;
}

export interface GitStatusNotRepo {
  notRepo: true;
  isEmpty: boolean;
}

export type GitStatusResult = GitStatusFull | GitStatusNotRepo;

// ── Helpers ────────────────────────────────────────────

function isEmptyDir(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath);
    return entries.filter((e: string) => !e.startsWith(".")).length === 0;
  } catch {
    return false;
  }
}

// ── Git operations ─────────────────────────────────────

export async function detectGit(project: Project): Promise<{
  hasGit: boolean;
  remote: string;
  branch: string;
}> {
  const gitPath = path.join(project.cwd, ".git");
  if (!existsSync(gitPath)) {
    return { hasGit: false, remote: "", branch: "" };
  }

  try {
    const git: SimpleGit = simpleGit(project.cwd);
    const remotes = await git.getRemotes(true);
    const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
    const origin = remotes.find((r) => r.name === "origin");

    return {
      hasGit: true,
      remote: origin?.refs?.fetch || "",
      branch: branch.trim(),
    };
  } catch {
    return { hasGit: false, remote: "", branch: "" };
  }
}

export async function getGitHistory(
  cwd: string,
  maxCount: number = 20
): Promise<
  Array<{
    hash: string;
    date: string;
    message: string;
    author: string;
  }>
> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    const log: LogResult = await git.log({ maxCount });
    return log.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name,
    }));
  } catch {
    return [];
  }
}

/**
 * Get unified diff of all changes (staged + unstaged).
 * Used for AI commit message generation. Truncated to ~8KB.
 */
export async function getGitDiff(cwd: string): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    // Get staged and unstaged diffs. Use HEAD for staged if there are commits.
    let staged = "";
    let unstaged = "";

    // staged diff: git diff --staged (or --cached HEAD for newer repos)
    try {
      staged = await git.diff(["--staged"]);
    } catch {
      // Repo may not have any commits yet
      try {
        staged = await git.diff(["--cached"]);
      } catch {
        // silent — no staged changes
      }
    }

    // unstaged working tree diff
    try {
      unstaged = await git.diff();
    } catch {
      // silent — no unstaged changes
    }

    let combined = "";
    if (staged && staged.trim()) combined += "Staged changes:\n" + staged + "\n";
    if (unstaged && unstaged.trim()) combined += "Unstaged changes:\n" + unstaged;

    if (!combined.trim()) {
      return "No changes detected in the working tree.";
    }

    if (combined.length > 8000) {
      combined = combined.slice(0, 8000) + "\n... (truncated)";
    }
    return combined;
  } catch {
    return "Unable to retrieve git diff (repository error).";
  }
}

export async function gitPull(cwd: string): Promise<string> {
  cleanupGitLock(cwd);
  const git: SimpleGit = await gitWithAuth(cwd);
  try {
    const result = await withTimeout(git.pull(), GIT_NETWORK_TIMEOUT_MS, "git pull");
    return result.summary.changes
      ? `${result.summary.changes} change(s), ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`
      : "Already up to date";
  } catch (error: any) {
    const msg = error.message || "";
    if (isAuthError(msg)) {
      throw new GitAuthError(`Git pull authentication failed: ${msg}`);
    }
    throw new Error(`Git pull failed: ${msg}`);
  } finally {
    await restoreRemoteUrl(cwd).catch(() => {});
  }
}

export async function gitPush(cwd: string): Promise<string> {
  cleanupGitLock(cwd);
  const git: SimpleGit = await gitWithAuth(cwd);
  try {
    const result = await withTimeout(git.push(), GIT_NETWORK_TIMEOUT_MS, "git push");
    return result.pushed
      ? `Pushed ${result.pushed.length} ref(s)`
      : "Nothing to push";
  } catch (error: any) {
    const msg = error.message || "";
    if (isAuthError(msg)) {
      throw new GitAuthError(`Git push authentication failed: ${msg}`);
    }
    throw new Error(`Git push failed: ${msg}`);
  } finally {
    await restoreRemoteUrl(cwd).catch(() => {});
  }
}

// ── Commit message generation ─────────────────────────

function generateCommitMessage(status: GitStatusFull): { subject: string; body: string } {
  const { created, modified, deleted, staged, files } = status;

  const allChanged = [...new Set([...staged, ...modified, ...created, ...deleted])];
  if (allChanged.length === 0) {
    return { subject: "chore: no changes", body: "No changes to commit." };
  }

  // ── Build changelog body ──
  const lines: string[] = [];
  if (created.length > 0) {
    lines.push("Added:");
    for (const f of created) lines.push(`  + ${f}`);
  }
  if (modified.length > 0 || staged.length > 0) {
    lines.push("Modified:");
    for (const f of [...new Set([...staged, ...modified])]) lines.push(`  ~ ${f}`);
  }
  if (deleted.length > 0) {
    lines.push("Removed:");
    for (const f of deleted) lines.push(`  - ${f}`);
  }

  const body = lines.join("\n");

  // ── Generate short subject ──
  // Heuristic: find common directory prefix of changed files
  const allFiles = files.map((f) => f.path);
  const dirs = allFiles
    .map((f) => {
      const parts = f.split("/");
      return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    })
    .filter((d, i, arr) => arr.indexOf(d) === i);

  // Derive a concise area name
  const area =
    dirs.length === 1 && dirs[0] !== "."
      ? dirs[0].split("/").pop()!
      : dirs.length <= 2
        ? dirs.map((d) => d === "." ? "root" : d.split("/").pop()).join(", ")
        : `${allFiles.length} files across ${dirs.length} dirs`;

  // Choose action verb
  let verb: string;
  if (created.length > 0 && modified.length === 0 && deleted.length === 0) {
    verb = "Add";
  } else if (deleted.length > 0 && modified.length === 0 && created.length === 0) {
    verb = "Remove";
  } else {
    verb = "Update";
  }

  const total = allChanged.length;
  const subject =
    total === 1
      ? `${verb} ${area}: ${allChanged[0].split("/").pop()}`
      : `${verb} ${area}: ${total} changes`;

  return { subject: subject.slice(0, 72), body };
}

export async function gitAddAll(cwd: string): Promise<number> {
  cleanupGitLock(cwd);
  const git: SimpleGit = simpleGit(cwd);
  await git.add("-A");
  const status = await git.status();
  return status.staged.length || status.files.length;
}

export class GitIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitIdentityError";
  }
}

export class GitAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitAuthError";
  }
}

function isAuthError(msg: string): boolean {
  return (
    msg.includes("could not read Username") ||
    msg.includes("Authentication failed") ||
    msg.includes("403") ||
    msg.includes("credential") ||
    msg.includes("Permission denied") ||
    msg.includes("fatal: could not read") ||
    msg.includes("timed out") // timeout often means auth needed
  );
}

/**
 * Extract the hostname from the git remote URL.
 */
export async function getRemoteHost(cwd: string): Promise<string> {
  try {
    const git: SimpleGit = simpleGit(cwd);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    if (!origin?.refs?.fetch) {
      console.log(`[git] getRemoteHost: no origin remote, defaulting to github.com`);
      return "github.com";
    }
    const url = origin.refs.fetch;
    // SSH: git@host:path or ssh://git@host/path
    const sshMatch = url.match(/^(?:ssh:\/\/)?git@([^:/]+)/);
    if (sshMatch) {
      console.log(`[git] getRemoteHost: SSH host=${sshMatch[1]}`);
      return sshMatch[1];
    }
    // HTTPS: https://host/path
    try {
      const hostname = new URL(url).hostname;
      console.log(`[git] getRemoteHost: HTTPS host=${hostname}`);
      return hostname;
    } catch {
      console.log(`[git] getRemoteHost: could not parse URL, defaulting to github.com`);
      return "github.com";
    }
  } catch {
    console.log(`[git] getRemoteHost: not a git repo (no .git), defaulting to github.com`);
    return "github.com";
  }
}

/**
 * Create a simple-git instance with credentials embedded in the remote URL.
 *
 * Instead of GIT_ASKPASS (blocked by git >=2.36 unless allowUnsafeAskPass
 * is set), we rewrite the remote URL to include the token:
 *
 *   https://x-access-token:TOKEN@github.com/user/repo.git
 *
 * This works with GitHub, GitLab, Bitbucket personal access tokens.
 */
async function gitWithAuth(cwd: string): Promise<SimpleGit> {
  const git = simpleGit(cwd);

  try {
    const remoteUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
    const host = extractHost(remoteUrl);
    console.log(`[git] gitWithAuth: remoteUrl=${remoteUrl.replace(/:[^@]+@/, ":****@")}, host=${host}, hasCreds=${host ? credentialStore.has(host) : false}`);

    if (host && credentialStore.has(host)) {
      const creds = credentialStore.get(host)!;
      const authUrl = injectCredentialsInUrl(remoteUrl, creds.username, creds.password);
      console.log(`[git] gitWithAuth: injecting credentials, result=${authUrl.replace(/:[^@]+@/, ":****@")}`);
      // Temporarily set the remote URL with credentials for this operation
      await git.raw(["remote", "set-url", "origin", authUrl]);
      // Git 2.38+ may reject credentials in URLs — explicitly allow it
      try {
        await git.raw(["config", "transfer.credentialsInUrl", "allow"]);
      } catch {
        // config may not support this option (older git), ignore
      }
      // Return the git instance (caller will use it for pull/push/etc)
      return git;
    }
  } catch (e: any) {
    console.log(`[git] gitWithAuth: error (will proceed without auth): ${e?.message || e}`);
    // Not a git repo or no remote — proceed without auth
  }

  // No credentials stored — use default (will fail on auth-required remotes)
  return git;
}

/**
 * Extract hostname from a git remote URL.
 * Handles both HTTPS and SSH URLs.
 */
function extractHost(url: string): string | null {
  // HTTPS: https://github.com/user/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)/);
  if (httpsMatch) return httpsMatch[1];

  // SSH: git@github.com:user/repo.git
  const sshMatch = url.match(/^git@([^:]+):/);
  if (sshMatch) return sshMatch[1];

  // ssh://git@github.com/user/repo.git
  const sshUrlMatch = url.match(/^ssh:\/\/git@([^/]+)/);
  if (sshUrlMatch) return sshUrlMatch[1];

  return null;
}

/**
 * Inject credentials into a git remote URL.
 *
 * For GitHub tokens, the username is typically "x-access-token" or the actual username,
 * and the password/token goes in the password field.
 *
 * Examples:
 *   https://github.com/user/repo.git → https://x-access-token:TOKEN@github.com/user/repo.git
 *   https://user@github.com/user/repo.git → https://user:TOKEN@github.com/user/repo.git
 */
function injectCredentialsInUrl(url: string, username: string, password: string): string {
  // Already has credentials — replace them
  const withCredsReplaced = url.replace(
    /^(https?:\/\/)([^@]+@)?(.+)/,
    (_, protocol, _oldCreds, rest) => {
      const encodedPassword = encodeURIComponent(password);
      return `${protocol}${encodeURIComponent(username)}:${encodedPassword}@${rest}`;
    }
  );
  if (withCredsReplaced !== url) return withCredsReplaced;

  // No existing credentials — inject them
  const encodedPassword = encodeURIComponent(password);
  return url.replace(
    /^(https?:\/\/)(.+)/,
    (_, protocol, rest) => `${protocol}${encodeURIComponent(username)}:${encodedPassword}@${rest}`
  );
}

/**
 * Remove credentials from a git remote URL (restore original).
 * Call this after any authenticated git operation.
 */
export async function restoreRemoteUrl(cwd: string): Promise<void> {
  const git = simpleGit(cwd);
  try {
    const remoteUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
    // Strip credentials: https://user:pass@host → https://host
    const cleanUrl = remoteUrl.replace(
      /^(https?:\/\/)([^@]+@)?(.+)/,
      (_, protocol, _creds, rest) => `${protocol}${rest}`
    );
    if (cleanUrl !== remoteUrl) {
      await git.raw(["remote", "set-url", "origin", cleanUrl]);
    }
  } catch {
    // Not a git repo — ignore
  }
}

/**
 * Store git credentials for HTTPS auth in memory (not on disk).
 * Credentials are written to a per-host temp file (0600) that the
 * GIT_ASKPASS helper reads during git operations. These temp files
 * are cleaned up when credentials are removed or on process exit.
 *
 * No credential.helper store or ~/.git-credentials is used — this avoids
 * the allowUnsafeCredentialHelper restriction entirely.
 */
export async function setGitCredentials(
  cwd: string,
  username: string,
  password: string
): Promise<void> {
  const host = await getRemoteHost(cwd);
  console.log(`[git] setGitCredentials: host=${host}, username=${username}, password=${password.length} chars`);
  credentialStore.set(host, username, password);
  // Credentials are now injected into remote URLs at operation time
  // (no ASKPASS script needed with git >= 2.36)
}

export async function getGitIdentity(cwd: string): Promise<{ name: string; email: string } | null> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    const name = (await git.raw(["config", "user.name"])).trim();
    const email = (await git.raw(["config", "user.email"])).trim();
    if (!name || !email) return null;
    return { name, email };
  } catch {
    return null;
  }
}

export async function setGitIdentity(cwd: string, name: string, email: string): Promise<void> {
  const git: SimpleGit = simpleGit(cwd);
  await git.raw(["config", "user.name", name]);
  await git.raw(["config", "user.email", email]);
}

export async function gitCommit(
  cwd: string,
  subject: string,
  body?: string
): Promise<string> {
  cleanupGitLock(cwd);
  const git: SimpleGit = simpleGit(cwd);
  const message = body ? `${subject}\n\n${body}` : subject;
  try {
    const result = await git.commit(message);
    if (result.commit === null || result.summary.changes === 0) {
      return "Nothing to commit";
    }
    return `Committed ${result.summary.changes} change(s) as ${result.commit.slice(0, 7)}`;
  } catch (error: any) {
    const msg = error.message || "";
    if (isLockError(msg)) {
      cleanupGitLock(cwd);
      try {
        const result = await git.commit(message);
        if (result.commit === null || result.summary.changes === 0) return "Nothing to commit";
        return `Committed ${result.summary.changes} change(s) as ${result.commit.slice(0, 7)} (lock cleared)`;
      } catch (e2: any) {
        throw new Error(`Git commit failed (lock persisted): ${e2.message || e2}`);
      }
    }
    if (msg.includes("author identity") || msg.includes("Please tell me who you are") || msg.includes("unable to auto-detect email address")) {
      throw new GitIdentityError(msg);
    }
    throw new Error(`Git commit failed: ${msg}`);
  }
}

export interface CommitPushResult {
  staged: number;
  commitResult?: string;
  pushResult?: string;
  commitMessage?: { subject: string; body: string };
  commitHash?: string;
  remoteUrl?: string;
}

export async function gitCommitPushPreview(
  cwd: string
): Promise<{ status: GitStatusFull; proposedMessage: { subject: string; body: string } }> {
  cleanupGitLock(cwd);
  const status = await getGitStatus(cwd);
  if ("notRepo" in status) {
    throw new Error("Not a git repository");
  }

  // If clean, re-read to get accurate staged state
  let effectiveStatus = status;
  if (!status.isClean && (status.modified.length > 0 || status.created.length > 0 || status.deleted.length > 0)) {
    try {
      const git: SimpleGit = simpleGit(cwd);
      await git.add("-A");
      const stagedStatus = await getGitStatus(cwd);
      await git.reset(ResetMode.MIXED);
      if (!("notRepo" in stagedStatus)) {
        effectiveStatus = stagedStatus;
      }
    } catch (err: any) {
      if (isLockError(err?.message || "")) {
        cleanupGitLock(cwd);
        // Retry once after clearing lock
        try {
          const git: SimpleGit = simpleGit(cwd);
          await git.add("-A");
          const stagedStatus = await getGitStatus(cwd);
          await git.reset(ResetMode.MIXED);
          if (!("notRepo" in stagedStatus)) {
            effectiveStatus = stagedStatus;
          }
        } catch {
          // Still failed — use the original status as fallback
        }
      }
    }
  }

  const proposedMessage = generateCommitMessage(effectiveStatus);
  return { status: effectiveStatus, proposedMessage };
}

export async function gitCommitAndPush(
  cwd: string,
  subject?: string,
  body?: string
): Promise<CommitPushResult> {
  cleanupGitLock(cwd);
  const result: CommitPushResult = { staged: 0 };

  // 1. Get current status
  const status = await getGitStatus(cwd);
  if ("notRepo" in status) {
    throw new Error("Not a git repository");
  }

  // 2. If clean, just try to push existing commits
  if (status.isClean && status.staged.length === 0 &&
      status.modified.length === 0 && status.created.length === 0 &&
      status.deleted.length === 0) {
    // Nothing to commit, but maybe we have unpushed commits
    if (status.ahead > 0) {
      const pushResult = await gitPush(cwd);
      result.pushResult = pushResult;
      return result;
    }
    result.commitResult = "Nothing to commit";
    return result;
  }

  // 3. Stage all changes
  const stagedCount = await gitAddAll(cwd);
  result.staged = stagedCount;

  // 4. Re-read status after staging (now files are in the index)
  const statusAfterStaging = await getGitStatus(cwd);
  if ("notRepo" in statusAfterStaging) {
    throw new Error("Not a git repository");
  }

  // 5. Generate commit message (use custom if provided)
  const msg = subject
    ? { subject, body: body || "" }
    : generateCommitMessage(statusAfterStaging);
  result.commitMessage = msg;

  // 6. Commit
  const commitResult = await gitCommit(cwd, msg.subject, msg.body || undefined);
  result.commitResult = commitResult;

  // 6b. Get commit hash and remote URL
  try {
    const git: SimpleGit = simpleGit(cwd);
    const hashResult = await git.raw(["rev-parse", "--short", "HEAD"]);
    result.commitHash = hashResult.trim();
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r: any) => r.name === "origin");
    if (origin?.refs?.push) {
      result.remoteUrl = origin.refs.push;
    }
  } catch {
    // Non-critical
  }

  // 7. Push
  try {
    const pushResult = await gitPush(cwd);
    result.pushResult = pushResult;
  } catch (error: any) {
    // If it's an auth error, propagate it so the caller can ask for credentials
    if (error instanceof GitAuthError) {
      throw error;
    }
    result.pushResult = `Push failed: ${error.message}`;
  }

  return result;
}

export async function gitCheckout(
  cwd: string,
  ref: string
): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    await git.checkout(ref);
    return `Checked out ${ref}`;
  } catch (error: any) {
    throw new Error(`Git checkout failed: ${error.message}`);
  }
}

export async function gitClone(
  cwd: string,
  remote: string,
  branch: string = "main"
): Promise<string> {
  const parentDir = path.dirname(cwd);
  const repoName = path.basename(cwd);

  console.log(`[git-clone] cwd=${cwd}, parentDir=${parentDir}, repoName=${repoName}`);
  console.log(`[git-clone] remote=${remote}, branch=${branch}`);

  // Extract host from remote URL to check for stored credentials
  let host = "github.com";
  try {
    const sshMatch = remote.match(/^(?:ssh:\/\/)?git@([^:/]+)/);
    if (sshMatch) host = sshMatch[1];
    else host = new URL(remote).hostname;
  } catch (e) {
    console.log(`[git-clone] Could not parse remote URL: ${e}`);
  }

  console.log(`[git-clone] Extracted host: ${host}, hasCredentials: ${credentialStore.has(host)}`);

  const git: SimpleGit = simpleGit(parentDir);

  // Inject credentials into remote URL if available
  if (host && credentialStore.has(host)) {
    const creds = credentialStore.get(host)!;
    console.log(`[git-clone] Found credentials for ${host}, username=${creds.username}, password=${creds.password.length} chars`);
    const authUrl = injectCredentialsInUrl(remote, creds.username, creds.password);
    console.log(`[git-clone] Auth URL (redacted): ${authUrl.replace(/:[^@]+@/, ":****@")}`);
    try {
      // Git 2.38+ may reject credentials in URLs — explicitly allow it
      await withTimeout(
        git.raw(["-c", "transfer.credentialsInUrl=allow", "clone", authUrl, repoName, "--branch", branch]),
        GIT_NETWORK_TIMEOUT_MS,
        "git clone"
      );
      console.log(`[git-clone] Clone succeeded!`);
      return `Cloned ${remote} (${branch})`;
    } catch (error: any) {
      const msg = error.message || "";
      console.error(`[git-clone] Clone WITH auth FAILED: ${msg}`);
      if (isAuthError(msg)) {
        throw new GitAuthError(`Git clone authentication failed: ${msg}`);
      }
      throw new Error(`Git clone failed: ${msg}`);
    }
  }

  // No credentials — try without auth
  console.log(`[git-clone] No credentials for ${host}, trying without auth...`);
  try {
    await withTimeout(git.clone(remote, repoName, ["--branch", branch]), GIT_NETWORK_TIMEOUT_MS, "git clone");
    console.log(`[git-clone] Clone succeeded (no auth)!`);
    return `Cloned ${remote} (${branch})`;
  } catch (error: any) {
    const msg = error.message || "";
    console.error(`[git-clone] Clone WITHOUT auth FAILED: ${msg}`);
    if (isAuthError(msg)) {
      throw new GitAuthError(`Git clone authentication failed: ${msg}`);
    }
    throw new Error(`Git clone failed: ${msg}`);
  }
}

export async function gitInit(cwd: string, remote: string, branch: string = "main"): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    await git.init();
    await git.addRemote("origin", remote);
    await git.checkoutLocalBranch(branch);
    return `Initialized repo, remote set to ${remote}`;
  } catch (error: any) {
    throw new Error(`Git init failed: ${error.message}`);
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  const gitPath = path.join(cwd, ".git");
  if (!existsSync(gitPath)) {
    return { notRepo: true, isEmpty: isEmptyDir(cwd) };
  }

  try {
    const git: SimpleGit = simpleGit(cwd);
    const status = await git.status();

    const staged: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const created: string[] = [];
    const conflict: string[] = [];
    const files: Array<{ path: string; status: string }> = [];

    for (const f of status.files) {
      const ws = f.working_dir;
      const idx = f.index;
      files.push({ path: f.path, status: `${idx}${ws}`.trim() || "?" });

      if (ws === "D" || idx === "D") deleted.push(f.path);
      else if (ws === "?" && idx === "?") created.push(f.path);
      else if (idx !== " " && idx !== "?") staged.push(f.path);
      else if (ws !== " ") modified.push(f.path);

      if (ws === "U" || idx === "U") conflict.push(f.path);
    }

    const unique = (arr: string[]) => [...new Set(arr)];

    return {
      branch: status.current || "unknown",
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      staged: unique(staged),
      modified: unique(modified),
      deleted: unique(deleted),
      created: unique(created),
      conflict: unique(conflict),
      files,
      isClean: status.isClean(),
    };
  } catch {
    return { notRepo: true, isEmpty: false };
  }
}

export async function syncGitInfo(project: Project): Promise<Project> {
  const info = await detectGit(project);
  if (info.hasGit) {
    return await updateProjectGit(project.id, {
      remote: info.remote,
      branch: info.branch,
      lastSync: new Date().toISOString(),
    });
  }
  return project;
}
