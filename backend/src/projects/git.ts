import { simpleGit, type SimpleGit, type LogResult } from "simple-git";
import { existsSync, readdirSync, mkdirSync, statSync, unlinkSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Project } from "./manager.js";
import { Mutex } from "../utils/mutex.js";
import { updateProjectGit } from "./manager.js";
import { credentialStore } from "./credential-store.js";
import { sanitizeRemoteUrl } from "./remote-url.js";

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
 * Per-project mutex to prevent concurrent git operations
 * from racing on credential injection/restoration.
 */
const gitMutexByCwd = new Map<string, Mutex>();
function getGitMutex(cwd: string): Mutex {
  let m = gitMutexByCwd.get(cwd);
  if (!m) {
    m = new Mutex();
    gitMutexByCwd.set(cwd, m);
  }
  return m;
}

/**
 * Wrap a promise with a timeout that rejects with a clear error message.
 * Also attempts to abort the underlying simple-git process on timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string, git?: SimpleGit): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Attempt to kill the underlying git process
      if (git) {
        try {
          const childProc = (git as any)._executor?.childProcess;
          if (childProc && typeof childProc.kill === "function") {
            childProc.kill("SIGTERM");
          }
        } catch {}
      }
      reject(new Error(`${label} timed out after ${ms / 1000}s — this usually means authentication is required or the remote is unreachable`));
    }, ms);
    promise
      .then((v) => { if (!settled) { clearTimeout(timer); settled = true; resolve(v); } })
      .catch((e) => { if (!settled) { clearTimeout(timer); settled = true; reject(e); } });
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
/**
 * Get the list of files changed (staged + unstaged) relative to HEAD.
 * Returns an array of file paths. Empty if no changes or not a git repo.
 */
export async function getChangedFiles(cwd: string): Promise<string[]> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    const status = await git.status();
    const files: string[] = [];
    for (const f of status.files) {
      // status.files includes staged, unstaged, untracked, etc.
      if (f.path) files.push(f.path);
    }
    return [...new Set(files)]; // dedup
  } catch {
    return [];
  }
}

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
  return getGitMutex(cwd).run(async () => {
    cleanupGitLock(cwd);
    const git: SimpleGit = await gitWithAuth(cwd);
    try {
      const result = await withTimeout(git.pull(), GIT_NETWORK_TIMEOUT_MS, "git pull", git);
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
      try {
        await restoreRemoteUrl(cwd);
      } catch (e: any) {
        console.error(`[git] CRITICAL: Failed to restore remote URL after pull. Credentials may be leaked! cwd=${cwd}`, e.message);
      }
    }
  });
}

export async function gitPush(cwd: string): Promise<string> {
  return getGitMutex(cwd).run(async () => {
    cleanupGitLock(cwd);
    const git: SimpleGit = await gitWithAuth(cwd);
    try {
      const result = await withTimeout(git.push(), GIT_NETWORK_TIMEOUT_MS, "git push", git);
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
      try {
        await restoreRemoteUrl(cwd);
      } catch (e: any) {
        console.error(`[git] CRITICAL: Failed to restore remote URL after push. Credentials may be leaked! cwd=${cwd}`, e.message);
      }
    }
  });
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
    console.log(`[git] gitWithAuth: remoteUrl=${redactUrl(remoteUrl)}, host=${host}, hasCreds=${host ? credentialStore.has(host) : false}`);

    if (host && credentialStore.has(host)) {
      const creds = credentialStore.get(host)!;
      const authUrl = injectCredentialsInUrl(remoteUrl, creds.username, creds.password);
      console.log(`[git] gitWithAuth: injecting credentials, result=${redactUrl(authUrl)}`);
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

// BUG-15 fix: regex robuste qui matche du : jusqu'au DERNIER @ (pas le premier)
// Si le password contient un @, l'ancien regex /:[^@]+@/ laissait une partie du credential
function redactUrl(url: string): string {
  return url.replace(/:[^@]*@(?=[^@]*$)/, ":****@");
}
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
    const cleanUrl = sanitizeRemoteUrl(remoteUrl);
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
  // Check repo-local config first, then global
  for (const scope of ["local", "global"] as const) {
    try {
      const scopeFlag = scope === "global" ? ["--global"] : [];
      const name = (await git.raw([...scopeFlag, "config", "user.name"])).trim();
      const email = (await git.raw([...scopeFlag, "config", "user.email"])).trim();
      if (name && email) return { name, email };
    } catch {}
  }
  return null;
}

export async function setGitIdentity(cwd: string, name: string, email: string): Promise<void> {
  // BUG-13 fix: ne configurer QUE le repo local, pas le global.
  // L'ancien code écrivait aussi dans --global, ce qui causait des conflits
  // quand plusieurs projets avaient des identités git différentes.
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
      // Try to inherit identity from global git config
      try {
        const globalIdentity = await getGitIdentity(cwd);
        if (globalIdentity) {
          await setGitIdentity(cwd, globalIdentity.name, globalIdentity.email);
          const result = await git.commit(message);
          if (result.commit === null || result.summary.changes === 0) return "Nothing to commit";
          return `Committed ${result.summary.changes} change(s) as ${result.commit.slice(0, 7)}`;
        }
      } catch {}
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

/**
 * Construit un statut "comme après `git add -A`" sans toucher au dépôt.
 * Utilisé par l'aperçu de commit pour montrer ce qui serait commité sans modifier
 * l'état du staging de l'utilisateur (l'ancien `git add -A` + `git reset` était
 * destructeur). On reste sur l'état réel si le dépôt est propre ou en conflit.
 */
function simulateCommitAllStatus(status: GitStatusFull): GitStatusFull {
  // On ne simule que lorsqu'un `git add -A` apporterait réellement un changement
  // (fichiers non suivis, modifiés ou supprimés hors index). Sinon, le statut réel
  // est déjà celui qui serait commité. En cas de conflit, on ne touche à rien et on
  // renvoie le statut réel pour ne surtout pas altérer l'état du merge.
  const hasUnstaged =
    status.modified.length > 0 || status.created.length > 0 || status.deleted.length > 0;
  if (status.isClean || status.conflict.length > 0 || !hasUnstaged) {
    return status;
  }

  // `f.status` est le code porcelain déjà trimé par getGitStatus
  // (ex. "A", "M", "D", "R" ou "??"). On en déduit le code index après add.
  const files = status.files
    .map((f) => {
      const idx = f.status[0] ?? " ";
      const ws = f.status[1] ?? " ";

      let newIdx: string;
      if (idx === "?" && ws === "?") {
        newIdx = "A"; // non-suivi → ajouté
      } else if (idx === "A") {
        newIdx = "A"; // déjà ajouté dans l'index, le restera
      } else if (idx === "D" || ws === "D") {
        newIdx = "D"; // suppression
      } else if (ws !== " " && ws !== "?") {
        newIdx = ws; // modification du worktree stagée telle quelle
      } else {
        newIdx = idx !== " " ? idx : "M";
      }

      return { path: f.path, status: newIdx };
    })
    // `git status` trie par chemin dans ce cas ; on reproduit l'ordre post-add.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Après un `git add -A`, toutes les modifications sont dans l'index.
  // getGitStatus range les suppressions dans `deleted` et le reste dans `staged`.
  const staged: string[] = [];
  const deleted: string[] = [];
  for (const f of files) {
    if (f.status === "D") deleted.push(f.path);
    else staged.push(f.path);
  }

  return {
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    staged,
    modified: [],
    deleted,
    created: [],
    conflict: status.conflict,
    files,
    isClean: false,
  };
}

export async function gitCommitPushPreview(
  cwd: string
): Promise<{ status: GitStatusFull; proposedMessage: { subject: string; body: string } }> {
  cleanupGitLock(cwd);
  const status = await getGitStatus(cwd);
  if ("notRepo" in status) {
    throw new Error("Not a git repository");
  }

  // Fix aperçu de commit : ne plus faire `git add -A` + `git reset` ici, car cela
  // dé-stage les modifications préalablement stagées par l'utilisateur. On simule
  // le statut "tout stagé" à partir du statut réel, sans effet de bord sur l'index.
  const effectiveStatus = simulateCommitAllStatus(status);

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
    console.log(`[git-clone] Auth URL (redacted): ${redactUrl(authUrl)}`);
    try {
      // Git 2.38+ may reject credentials in URLs — explicitly allow it
      await withTimeout(
        git.raw(["-c", "transfer.credentialsInUrl=allow", "clone", authUrl, repoName, "--branch", branch]),
        GIT_NETWORK_TIMEOUT_MS,
        "git clone"
      );
      console.log(`[git-clone] Clone succeeded!`);
      // Sécurité : git clone persiste l'URL fournie (avec token) dans le
      // .git/config du nouveau dépôt. On la remplace immédiatement par l'URL
      // nettoyée pour ne jamais laisser le token sur disque.
      try {
        const clonedGit = simpleGit(cwd);
        await clonedGit.raw(["remote", "set-url", "origin", sanitizeRemoteUrl(remote)]);
      } catch (e: any) {
        console.error(`[git-clone] Failed to sanitize cloned remote URL: ${e?.message || e}`);
      }
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
    // BUG-37 fix: utiliser git.raw() comme la branche avec auth pour cohérence
    await withTimeout(
      git.raw(["clone", remote, repoName, "--branch", branch]),
      GIT_NETWORK_TIMEOUT_MS, "git clone"
    );
    console.log(`[git-clone] Clone succeeded (no auth)!`);
    // Sécurité : même sans auth, l'URL fournie peut contenir un token collé par
    // l'utilisateur. On nettoie le remote persisté dans le .git/config.
    try {
      const clonedGit = simpleGit(cwd);
      await clonedGit.raw(["remote", "set-url", "origin", sanitizeRemoteUrl(remote)]);
    } catch (e: any) {
      console.error(`[git-clone] Failed to sanitize cloned remote URL: ${e?.message || e}`);
    }
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

/**
 * Vérifie qu'une référence git existe sans lever d'erreur.
 * Utilisé par gitInit pour ne définir l'upstream que si c'est possible.
 */
async function gitRefExists(git: SimpleGit, ref: string): Promise<boolean> {
  try {
    await git.raw(["rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

export async function gitInit(cwd: string, remote: string, branch: string = "main"): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    await git.init();
    // Sécurité : ne jamais persister de credentials dans le remote.
    await git.addRemote("origin", sanitizeRemoteUrl(remote));
    await git.checkoutLocalBranch(branch);

    // Fix gitInit : ne configurer l'upstream que si le dépôt a au moins un commit
    // ET que la ref distante existe. Sinon `git branch --set-upstream-to` échoue
    // sur un dépôt fraîchement initialisé (aucun commit) ou sans ref distante.
    const hasCommit = await gitRefExists(git, "HEAD");
    const hasRemoteRef = await gitRefExists(git, `origin/${branch}`);
    if (hasCommit && hasRemoteRef) {
      await git.raw(["branch", "--set-upstream-to", `origin/${branch}`, branch]);
    }

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

/**
 * Purge de sécurité au boot : retire tout credential embarqué des URLs de
 * remote git, à la fois dans projects.json (remote stocké) et dans le
 * .git/config de chaque dépôt. Log un warning par remote nettoyé.
 *
 * Couvre :
 *  - les projets enregistrés (projects.json + .git/config de leur cwd) ;
 *  - les dépôts git présents sous les racines de travail (/projects) même s'ils
 *    ne sont pas enregistrés comme projets (ex: un clone fait hors Pi-Web).
 */
export async function purgeEmbeddedCredentialsFromRemotes(): Promise<void> {
  const { getAllProjects } = await import("./manager.js");
  const projects = getAllProjects();

  const cleanOnDisk = async (cwd: string, label: string): Promise<void> => {
    try {
      const git = simpleGit(cwd);
      const current = (await git.raw(["remote", "get-url", "origin"])).trim();
      const clean = sanitizeRemoteUrl(current);
      if (clean !== current) {
        console.warn(`[git] SECURITY: stripped embedded credentials from ${label} remote (${cwd})`);
        await git.raw(["remote", "set-url", "origin", clean]);
      }
    } catch {
      // pas un dépôt git ou pas de remote origin — ignorer
    }
  };

  // 1. Projets enregistrés
  for (const project of projects) {
    if (project.versioning !== "git" || !project.git?.remote) continue;
    const clean = sanitizeRemoteUrl(project.git.remote);
    if (clean !== project.git.remote) {
      console.warn(`[git] SECURITY: stripped embedded credentials from stored remote of project "${project.name}" (${project.id})`);
      await updateProjectGit(project.id, { remote: clean });
    }
    await cleanOnDisk(project.cwd, "project");
  }

  // 2. Dépôts sous /projects non enregistrés (ex: /projects/Talky)
  try {
    const roots = ["/projects", "/mnt/smb"];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const repoDir = path.join(root, entry.name);
        if (existsSync(path.join(repoDir, ".git"))) {
          await cleanOnDisk(repoDir, "unregistered");
        }
      }
    }
  } catch (e: any) {
    console.error(`[git] SECURITY purge: error scanning project roots: ${e?.message || e}`);
  }
}
