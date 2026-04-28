import { simpleGit, type SimpleGit, type LogResult } from "simple-git";
import { existsSync } from "fs";
import path from "path";
import type { Project } from "./manager.js";
import { updateProjectGit } from "./manager.js";

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

export async function syncGitInfo(project: Project): Promise<Project> {
  const info = await detectGit(project);
  if (info.hasGit) {
    return updateProjectGit(project.id, {
      remote: info.remote,
      branch: info.branch,
      lastSync: new Date().toISOString(),
    });
  }
  return project;
}
