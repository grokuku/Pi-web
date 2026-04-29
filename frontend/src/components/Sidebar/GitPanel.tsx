import { useState, useEffect, useCallback } from "react";
import { GitBranch, GitPullRequest, ArrowDown, ArrowUp, RefreshCw, AlertTriangle, Check, Clock } from "lucide-react";
import type { Project } from "../../types";

interface GitStatus {
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

interface Props {
  project: Project;
}

export function GitPanel({ project }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<"pull" | "push" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

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
    // Auto-refresh every 30s
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handlePull = async () => {
    setActionLoading("pull");
    setError("");
    setMessage("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/pull`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Pull failed");
      }
      const data = await res.json();
      setMessage(data.result || "Pull successful");
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handlePush = async () => {
    setActionLoading("push");
    setError("");
    setMessage("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/push`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Push failed");
      }
      const data = await res.json();
      setMessage(data.result || "Push successful");
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  if (!project.git?.remote) return null;

  const totalChanges = status
    ? status.staged.length + status.modified.length + status.deleted.length + status.created.length
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

      {/* Error */}
      {error && (
        <div className="text-hacker-error text-[10px] mb-1.5 flex items-center gap-1">
          <AlertTriangle size={10} />
          {error}
        </div>
      )}

      {/* Success message */}
      {message && (
        <div className="text-hacker-accent text-[10px] mb-1.5 flex items-center gap-1">
          <Check size={10} />
          {message}
        </div>
      )}

      {status && (
        <div className="space-y-1.5">
          {/* Branch */}
          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Branch</span>
            <span className="text-hacker-info">{status.branch}</span>
          </div>

          {/* Remote indicator */}
          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Remote</span>
            <span className="text-hacker-text-bright text-[9px] truncate max-w-[100px] text-right">
              {project.git.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
            </span>
          </div>

          {/* Ahead / Behind */}
          {(status.ahead > 0 || status.behind > 0) && (
            <div className="flex items-center gap-2">
              {status.behind > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-warn text-[10px]">
                  <ArrowDown size={10} />
                  {status.behind} behind
                </span>
              )}
              {status.ahead > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-info text-[10px]">
                  <ArrowUp size={10} />
                  {status.ahead} ahead
                </span>
              )}
            </div>
          )}

          {/* File changes */}
          {!status.isClean && (
            <div className="text-[10px] space-y-0.5 bg-hacker-bg/30 border border-hacker-border p-1.5">
              {status.staged.length > 0 && (
                <div className="text-hacker-accent">✓ {status.staged.length} staged</div>
              )}
              {status.modified.length > 0 && (
                <div className="text-hacker-warn">~ {status.modified.length} modified</div>
              )}
              {status.created.length > 0 && (
                <div className="text-hacker-info">+ {status.created.length} new</div>
              )}
              {status.deleted.length > 0 && (
                <div className="text-hacker-error">- {status.deleted.length} deleted</div>
              )}
              {status.conflict.length > 0 && (
                <div className="text-hacker-error font-bold">! {status.conflict.length} conflicts</div>
              )}

              {/* File list (collapsed, max 5) */}
              <div className="mt-1 max-h-[60px] overflow-y-auto">
                {status.files.slice(0, 5).map((f) => (
                  <div key={f.path} className="flex gap-1 text-hacker-text-dim/70 truncate">
                    <span className="text-hacker-accent text-[9px] w-5 shrink-0">{f.status}</span>
                    <span className="truncate">{f.path}</span>
                  </div>
                ))}
                {status.files.length > 5 && (
                  <div className="text-hacker-text-dim/50">
                    +{status.files.length - 5} more files
                  </div>
                )}
              </div>
            </div>
          )}

          {status.isClean && totalChanges === 0 && !status.ahead && !status.behind && (
            <div className="text-hacker-text-dim text-[10px] flex items-center gap-1">
              <Check size={10} className="text-hacker-accent" />
              Up to date
            </div>
          )}

          {/* Last sync */}
          {project.git.lastSync && (
            <div className="text-hacker-text-dim text-[9px] flex items-center gap-1">
              <Clock size={9} />
              {formatTimeAgo(project.git.lastSync)}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-1 pt-1">
            <button
              onClick={handlePull}
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
              onClick={handlePush}
              disabled={actionLoading !== null}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-border text-[10px] text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent transition-colors disabled:opacity-40"
              title="git push"
            >
              {actionLoading === "push" ? (
                <RefreshCw size={10} className="animate-spin" />
              ) : (
                <ArrowUp size={10} />
              )}
              Push
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
