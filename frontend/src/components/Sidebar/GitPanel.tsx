import { useState, useEffect, useCallback } from "react";
import { GitBranch, ArrowDown, ArrowUp, RefreshCw, AlertTriangle, Check, Clock, Download, PlusSquare } from "lucide-react";
import type { Project } from "../../types";

interface GitStatusFull {
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

interface GitStatusNotRepo {
  notRepo: true;
  isEmpty: boolean;
}

type GitStatus = GitStatusFull | GitStatusNotRepo;

type ActionType = "pull" | "push" | "commit-push" | "clone" | "init";

interface Props {
  project: Project;
}

export function GitPanel({ project }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<ActionType | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [commitMessage, setCommitMessage] = useState<{ subject: string; body: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!project.git?.remote) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/status`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to get git status");
      }
      const data: GitStatus = await res.json();
      setStatus(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [project.id, project.git?.remote]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const doAction = async (action: ActionType, url: string) => {
    setActionLoading(action);
    setError("");
    setMessage("");
    setCommitMessage(null);
    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `${action} failed`);
      }
      const data = await res.json();

      if (action === "commit-push") {
        // commit-push returns a structured result
        if (data.commitMessage) {
          setCommitMessage(data.commitMessage);
        }
        const parts: string[] = [];
        if (data.staged) parts.push(`${data.staged} staged`);
        if (data.commitResult) parts.push(data.commitResult);
        if (data.pushResult) parts.push(data.pushResult);
        setMessage(parts.join(" → ") || "Done");
      } else {
        setMessage(data.result || `${action} successful`);
      }

      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  if (!project.git?.remote) return null;

  // ── notRepo state ──
  const isNotRepo = status && "notRepo" in status;
  const dirIsEmpty = status && "notRepo" in status && status.isEmpty;

  // ── Normal state ──
  const normalStatus = isNotRepo ? null : (status as GitStatusFull);
  const totalChanges = normalStatus
    ? normalStatus.staged.length + normalStatus.modified.length + normalStatus.deleted.length + normalStatus.created.length
    : 0;

  const providerIcon = project.git.provider === "github" ? "🐙" : project.git.provider === "gitlab" ? "🦊" : "📦";

  return (
    <div className="p-2 border-b border-hacker-border">
      <div className="text-hacker-accent text-[10px] tracking-widest mb-2 flex items-center gap-1">
        <GitBranch size={12} />
        GIT {providerIcon}
      </div>

      {loading && !status && (
        <div className="text-hacker-text-dim italic text-[10px] flex items-center gap-1">
          <RefreshCw size={10} className="animate-spin" />
          Loading...
        </div>
      )}

      {error && (
        <div className="text-hacker-error text-[10px] mb-1.5 flex items-center gap-1">
          <AlertTriangle size={10} />
          {error}
        </div>
      )}

      {message && (
        <div className="text-hacker-accent text-[10px] mb-1.5 flex items-center gap-1">
          <Check size={10} />
          {message}
        </div>
      )}

      {/* ── Not a repo yet ── */}
      {isNotRepo && (
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Remote</span>
            <span className="text-hacker-text-bright text-[9px] truncate max-w-[100px] text-right">
              {project.git.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Branch</span>
            <span className="text-hacker-info">{project.git.branch || "main"}</span>
          </div>

          {dirIsEmpty ? (
            <>
              <div className="text-hacker-text-dim text-[10px] flex items-center gap-1">
                <Download size={10} />
                Directory is empty — ready to clone
              </div>
              <button
                onClick={() => doAction("clone", `/api/projects/${project.id}/git/clone`)}
                disabled={actionLoading !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-accent/50 text-hacker-accent text-[10px] hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
              >
                {actionLoading === "clone" ? (
                  <RefreshCw size={10} className="animate-spin" />
                ) : (
                  <Download size={12} />
                )}
                Clone Repository
              </button>
            </>
          ) : (
            <>
              <div className="text-hacker-warn text-[10px] flex items-start gap-1 bg-hacker-bg/30 border border-hacker-warn/20 p-1.5">
                <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                <span>Directory not empty — cannot clone. Initialize git + add remote instead.</span>
              </div>
              <button
                onClick={() => doAction("init", `/api/projects/${project.id}/git/init`)}
                disabled={actionLoading !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-border text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent text-[10px] transition-colors disabled:opacity-40"
              >
                {actionLoading === "init" ? (
                  <RefreshCw size={10} className="animate-spin" />
                ) : (
                  <PlusSquare size={12} />
                )}
                git init + Add Remote
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Normal repo ── */}
      {normalStatus && (
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Branch</span>
            <span className="text-hacker-info">{normalStatus.branch}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Remote</span>
            <span className="text-hacker-text-bright text-[9px] truncate max-w-[100px] text-right">
              {project.git.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
            </span>
          </div>

          {(normalStatus.ahead > 0 || normalStatus.behind > 0) && (
            <div className="flex items-center gap-2">
              {normalStatus.behind > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-warn text-[10px]">
                  <ArrowDown size={10} />
                  {normalStatus.behind} behind
                </span>
              )}
              {normalStatus.ahead > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-info text-[10px]">
                  <ArrowUp size={10} />
                  {normalStatus.ahead} ahead
                </span>
              )}
            </div>
          )}

          {!normalStatus.isClean && (
            <div className="text-[10px] space-y-0.5 bg-hacker-bg/30 border border-hacker-border p-1.5">
              {normalStatus.staged.length > 0 && (
                <div className="text-hacker-accent">✓ {normalStatus.staged.length} staged</div>
              )}
              {normalStatus.modified.length > 0 && (
                <div className="text-hacker-warn">~ {normalStatus.modified.length} modified</div>
              )}
              {normalStatus.created.length > 0 && (
                <div className="text-hacker-info">+ {normalStatus.created.length} new</div>
              )}
              {normalStatus.deleted.length > 0 && (
                <div className="text-hacker-error">- {normalStatus.deleted.length} deleted</div>
              )}
              {normalStatus.conflict.length > 0 && (
                <div className="text-hacker-error font-bold">! {normalStatus.conflict.length} conflicts</div>
              )}

              <div className="mt-1 max-h-[60px] overflow-y-auto">
                {normalStatus.files.slice(0, 5).map((f) => (
                  <div key={f.path} className="flex gap-1 text-hacker-text-dim/70 truncate">
                    <span className="text-hacker-accent text-[9px] w-5 shrink-0">{f.status}</span>
                    <span className="truncate">{f.path}</span>
                  </div>
                ))}
                {normalStatus.files.length > 5 && (
                  <div className="text-hacker-text-dim/50">
                    +{normalStatus.files.length - 5} more files
                  </div>
                )}
              </div>
            </div>
          )}

          {normalStatus.isClean && totalChanges === 0 && !normalStatus.ahead && !normalStatus.behind && (
            <div className="text-hacker-text-dim text-[10px] flex items-center gap-1">
              <Check size={10} className="text-hacker-accent" />
              Up to date
            </div>
          )}

          {project.git.lastSync && (
            <div className="text-hacker-text-dim text-[9px] flex items-center gap-1">
              <Clock size={9} />
              {formatTimeAgo(project.git.lastSync)}
            </div>
          )}

          {/* Commit message preview */}
          {commitMessage && (
            <div className="mt-1 text-[9px] bg-hacker-bg/30 border border-hacker-accent/20 p-1.5">
              <div className="text-hacker-accent font-bold mb-0.5">🚀 {commitMessage.subject}</div>
              {commitMessage.body && (
                <div className="text-hacker-text-dim whitespace-pre-wrap mt-0.5">{commitMessage.body}</div>
              )}
            </div>
          )}

          <div className="flex gap-1 pt-1">
            <button
              onClick={() => doAction("pull", `/api/projects/${project.id}/git/pull`)}
              disabled={actionLoading !== null}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-border text-[10px] text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent transition-colors disabled:opacity-40"
              title="git pull"
            >
              {actionLoading === "pull" ? (
                <RefreshCw size={10} className="animate-spin" />
              ) : (
                <ArrowDown size={10} />
              )}
              Pull
            </button>
            <button
              onClick={() => doAction("commit-push", `/api/projects/${project.id}/git/commit-push`)}
              disabled={actionLoading !== null}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-accent/50 text-[10px] text-hacker-accent hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
              title="git add -A → commit → push"
            >
              {actionLoading === "commit-push" ? (
                <RefreshCw size={10} className="animate-spin" />
              ) : (
                <ArrowUp size={10} />
              )}
              Commit \u0026 Push
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
