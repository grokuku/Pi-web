import { simpleGit, type SimpleGit, type LogResult } from "simple-git";
import { existsSync, readdirSync } from "fs";
import path from "path";
import type { Project } from "./manager.js";
import { updateProjectGit } from "./manager.js";

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

export async function gitPull(cwd: string): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    const result = await git.pull();
    return result.summary.changes
      ? `${result.summary.changes} change(s), ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`
      : "Already up to date";
  } catch (error: any) {
    throw new Error(`Git pull failed: ${error.message}`);
  }
}

export async function gitPush(cwd: string): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  try {
    const result = await git.push();
    return result.pushed
      ? `Pushed ${result.pushed.length} ref(s)`
      : "Nothing to push";
  } catch (error: any) {
    throw new Error(`Git push failed: ${error.message}`);
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
  const git: SimpleGit = simpleGit(cwd);
  await git.add("-A");
  const status = await git.status();
  return status.staged.length || status.files.length;
}

export async function gitCommit(
  cwd: string,
  subject: string,
  body?: string
): Promise<string> {
  const git: SimpleGit = simpleGit(cwd);
  const message = body ? `${subject}\n\n${body}` : subject;
  try {
    const result = await git.commit(message);
    if (result.commit === null || result.summary.changes === 0) {
      return "Nothing to commit";
    }
    return `Committed ${result.summary.changes} change(s) as ${result.commit.slice(0, 7)}`;
  } catch (error: any) {
    throw new Error(`Git commit failed: ${error.message}`);
  }
}

export interface CommitPushResult {
  staged: number;
  commitResult?: string;
  pushResult?: string;
  commitMessage?: { subject: string; body: string };
}

export async function gitCommitAndPush(
  cwd: string
): Promise<CommitPushResult> {
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

  // 5. Generate commit message
  const msg = generateCommitMessage(statusAfterStaging);
  result.commitMessage = msg;

  // 6. Commit
  const commitResult = await gitCommit(cwd, msg.subject, msg.body);
  result.commitResult = commitResult;

  // 7. Push
  try {
    const pushResult = await gitPush(cwd);
    result.pushResult = pushResult;
  } catch (error: any) {
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
  const git: SimpleGit = simpleGit(parentDir);
  try {
    await git.clone(remote, repoName, ["--branch", branch]);
    return `Cloned ${remote} (${branch})`;
  } catch (error: any) {
    throw new Error(`Git clone failed: ${error.message}`);
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
