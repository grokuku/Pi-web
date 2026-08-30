import { useState, useEffect, useCallback } from "react";
import { GitBranch, ArrowDown, ArrowUp, RefreshCw, AlertTriangle, Check, Clock, Download, PlusSquare } from "lucide-react";
import type { Project } from "../../types";
import { CommitPushModal } from "../Modals/CommitPushModal";
import { GitAuthModal } from "../Modals/GitAuthModal";
import { useTranslation } from "../../i18n";

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
  onRefresh?: () => void;
}

export function GitPanel({ project, onRefresh }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<ActionType | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [commitMessage, setCommitMessage] = useState<{ subject: string; body: string } | null>(null);
  const [pendingAuthAction, setPendingAuthAction] = useState<{ url: string; action: ActionType } | null>(null);
  const [showPushModal, setShowPushModal] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

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
        // Auth required → show the credentials modal, remember what we were doing
        if (data.code === "GIT_AUTH_REQUIRED") {
          setPendingAuthAction({ url, action });
          setShowAuthModal(true);
          setActionLoading(null);
          return;
        }
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

  if (!project.git?.remote) return project.storage === "linked" ? <LinkedGitPanel project={project} onRefresh={onRefresh} /> : null;

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
      <div className="text-hacker-accent text-[0.75rem] tracking-widest mb-2 flex items-center gap-1">
        <GitBranch size={12} />
        GIT {providerIcon}
        <div className="flex-1" />
        <button
          onClick={() => { fetchStatus(); onRefresh?.(); }}
          className="text-hacker-text-dim hover:text-hacker-accent transition-colors"
          title="Refresh git status"
        >
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {loading && !status && (
        <div className="text-hacker-text-dim italic text-[0.75rem] flex items-center gap-1">
          <RefreshCw size={10} className="animate-spin" />
          Loading...
        </div>
      )}

      {error && (
        <div className="text-hacker-error text-[0.75rem] mb-1.5 flex items-center gap-1">
          <AlertTriangle size={10} />
          {error}
        </div>
      )}

      {message && (
        <div className="text-hacker-accent text-[0.75rem] mb-1.5 flex items-center gap-1">
          <Check size={10} />
          {message}
        </div>
      )}

      {/* ── Not a repo yet ── */}
      {isNotRepo && (
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Remote</span>
            <span className="text-hacker-text-bright text-[0.6875rem] truncate max-w-[100px] text-right">
              {project.git.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Branch</span>
            <span className="text-hacker-info">{project.git.branch || "main"}</span>
          </div>

          {dirIsEmpty ? (
            <>
              <div className="text-hacker-text-dim text-[0.75rem] flex items-center gap-1">
                <Download size={10} />
                Directory is empty — ready to clone
              </div>
              <button
                onClick={() => doAction("clone", `/api/projects/${project.id}/git/clone`)}
                disabled={actionLoading !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-accent/50 text-hacker-accent text-[0.75rem] hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
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
              <div className="text-hacker-warn text-[0.75rem] flex items-start gap-1 bg-hacker-bg/30 border border-hacker-warn/20 p-1.5">
                <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                <span>Directory not empty — cannot clone. Initialize git + add remote instead.</span>
              </div>
              <button
                onClick={() => doAction("init", `/api/projects/${project.id}/git/init`)}
                disabled={actionLoading !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-border text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent text-[0.75rem] transition-colors disabled:opacity-40"
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
            <span className="text-hacker-text-bright text-[0.6875rem] truncate max-w-[100px] text-right">
              {project.git.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
            </span>
          </div>

          {(normalStatus.ahead > 0 || normalStatus.behind > 0) && (
            <div className="flex items-center gap-2">
              {normalStatus.behind > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-warn text-[0.75rem]">
                  <ArrowDown size={10} />
                  {normalStatus.behind} behind
                </span>
              )}
              {normalStatus.ahead > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-info text-[0.75rem]">
                  <ArrowUp size={10} />
                  {normalStatus.ahead} ahead
                </span>
              )}
            </div>
          )}

          {!normalStatus.isClean && (
            <div className="text-[0.75rem] space-y-0.5 bg-hacker-bg/30 border border-hacker-border p-1.5">
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
                    <span className="text-hacker-accent text-[0.6875rem] w-5 shrink-0">{f.status}</span>
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
            <div className="text-hacker-text-dim text-[0.75rem] flex items-center gap-1">
              <Check size={10} className="text-hacker-accent" />
              Up to date
            </div>
          )}

          {project.git.lastSync && (
            <div className="text-hacker-text-dim text-[0.6875rem] flex items-center gap-1">
              <Clock size={9} />
              {formatTimeAgo(project.git.lastSync)}
            </div>
          )}

          {/* Commit message preview */}
          {commitMessage && (
            <div className="mt-1 text-[0.6875rem] bg-hacker-bg/30 border border-hacker-accent/20 p-1.5">
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
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-border text-[0.75rem] text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent transition-colors disabled:opacity-40"
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
              onClick={() => setShowPushModal(true)}
              disabled={actionLoading !== null}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-accent/50 text-[0.75rem] text-hacker-accent hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
              title="Stage all → commit → push"
            >
              {actionLoading === "commit-push" ? (
                <RefreshCw size={10} className="animate-spin" />
              ) : (
                <ArrowUp size={10} />
              )}
              Push
            </button>
          </div>
        </div>
      )}

      {/* ── Push modal ── */}
      {showPushModal && (
        <CommitPushModal
          project={project}
          onClose={() => setShowPushModal(false)}
          onDone={() => {
            fetchStatus();
            setTimeout(() => setShowPushModal(false), 1200);
          }}
        />
      )}

      {/* ── Auth modal ── */}
      {showAuthModal && (
        <GitAuthModal
          project={project}
          onClose={() => setShowAuthModal(false)}
          onConfigured={() => {
            setShowAuthModal(false);
            setError("");
            // Retry the pending git operation that required auth
            if (pendingAuthAction) {
              const { url, action } = pendingAuthAction;
              setPendingAuthAction(null);
              doAction(action, url);
            } else {
              fetchStatus();
            }
          }}
        />
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

// ── GitPanel pour projets LIÉS (placeholder multi-repos) ──
// Un placeholder n'a pas de remote ; le panel montre l'état PAR sous-projet
// (reçu via l'endpoint de preview linked) et ouvre le CommitPushModal,
// qui fait un commit + push séparaément pour chaque dépôt.

interface LinkedRepoView {
  name: string;
  projectId: string;
  cwd?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  preview?: {
    status?: {
      branch: string;
      ahead: number;
      behind: number;
      isClean: boolean;
      staged: Array<{ path: string; status: string }>;
      modified: Array<{ path: string; status: string }>;
      created: Array<{ path: string; status: string }>;
      deleted: Array<{ path: string; status: string }>;
      conflict: Array<{ path: string; status: string }>;
      files: Array<{ path: string; status: string }>;
    };
  };
}

function LinkedGitPanel({ project, onRefresh }: { project: Project; onRefresh?: () => void }) {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<LinkedRepoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showPushModal, setShowPushModal] = useState(false);

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/commit-push/preview`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to analyze linked repos");
      }
      const data = await res.json();
      setRepos(data.linked ? data.repos : []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    fetchPreview();
    const interval = setInterval(fetchPreview, 30_000);
    return () => clearInterval(interval);
  }, [fetchPreview]);

  const totalChanges = repos.reduce((sum, r) => {
    const st = r.preview?.status;
    return sum + (st ? st.staged.length + st.modified.length + st.created.length + st.deleted.length : 0);
  }, 0);
  const repoErrors = repos.filter((r) => r.error);
  const cleanCount = repos.filter((r) => !r.error && (!r.preview || (r.preview.status ? (r.preview.status.files.length === 0) : false) && (r.preview.status?.ahead ?? 0) === 0)).length;

  return (
    <div className="p-2 border-b border-hacker-border">
      <div className="text-hacker-accent text-[0.75rem] tracking-widest mb-2 flex items-center gap-1">
        <GitBranch size={12} />
        GIT 🔗
        <div className="flex-1" />
        <button
          onClick={() => { fetchPreview(); onRefresh?.(); }}
          className="text-hacker-text-dim hover:text-hacker-accent transition-colors"
          title="Refresh linked repos status"
        >
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {loading && repos.length === 0 && (
        <div className="text-hacker-text-dim italic text-[0.75rem] flex items-center gap-1">
          <RefreshCw size={10} className="animate-spin" />
          Analyzing sub-repositories...
        </div>
      )}

      {error && (
        <div className="text-hacker-error text-[0.75rem] mb-1.5 flex items-center gap-1">
          <AlertTriangle size={10} />
          {error}
        </div>
      )}

      {repos.length > 0 && (
        <div className="space-y-1.5">
          {repos.map((r) => {
            const st = r.preview?.status;
            const count = st ? st.staged.length + st.modified.length + st.created.length + st.deleted.length : 0;
            return (
              <div key={r.projectId} className="border border-hacker-border bg-hacker-bg/30 px-2 py-1.5">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-hacker-accent text-[0.75rem] font-bold truncate">{r.name}</span>
                  {r.error ? (
                    <span className="text-hacker-error text-[0.6875rem]">⚠ {t('commitPush.linkedError')}</span>
                  ) : (r.preview === undefined) ? (
                    <span className="text-hacker-warn text-[0.6875rem]">{t('commitPush.linkedError')}</span>
                  ) : count > 0 ? (
                    <span className="text-hacker-warn text-[0.6875rem]">{count} change(s)</span>
                  ) : (st?.ahead ?? 0) > 0 ? (
                    <span className="text-hacker-info text-[0.6875rem]">↑ {st?.ahead} to push</span>
                  ) : (
                    <Check size={10} className="text-hacker-accent" />
                  )}
                </div>
                {st && st.files.length > 0 && (
                  <div className="max-h-[50px] overflow-y-auto">
                    {st.files.slice(0, 4).map((f) => (
                      <div key={f.path} className="flex gap-1 text-hacker-text-dim/70 truncate text-[0.625rem]">
                        <span className="text-hacker-accent w-4 shrink-0">{f.status}</span>
                        <span className="truncate">{f.path}</span>
                      </div>
                    ))}
                    {st.files.length > 4 && (
                      <div className="text-hacker-text-dim/50 text-[0.625rem]">+{st.files.length - 4} more</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <div className="text-hacker-text-dim text-[0.6875rem] flex items-center justify-between pt-0.5">
            <span>{repos.length} sub-repos</span>
            <span>{cleanCount} clean</span>
          </div>

          <div className="flex gap-1 pt-1">
            <button
              onClick={() => { fetchPreview(); onRefresh?.(); }}
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-border text-[0.75rem] text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent transition-colors disabled:opacity-40"
              title="Refresh"
            >
              {loading ? <RefreshCw size={10} className="animate-spin" /> : <RefreshCw size={10} />}
              Refresh
            </button>
            <button
              onClick={() => setShowPushModal(true)}
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-accent/50 text-[0.75rem] text-hacker-accent hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
              title="Commit & push every sub-repository (AI messages per repo)"
            >
              {loading ? <RefreshCw size={10} className="animate-spin" /> : <ArrowUp size={10} />}
              Push All
            </button>
          </div>
        </div>
      )}

      {showPushModal && (
        <CommitPushModal
          project={project}
          onClose={() => setShowPushModal(false)}
          onDone={() => {
            fetchPreview();
            onRefresh?.();
            setTimeout(() => setShowPushModal(false), 1200);
          }}
        />
      )}
    </div>
  );
}
