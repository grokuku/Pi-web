import { useState, useEffect, useCallback } from "react";
import {
  X, RefreshCw, Check, AlertTriangle, ArrowUp, FileText, GitCommit,
} from "lucide-react";
import type { Project } from "../../types";
import { GitIdentityModal } from "./GitIdentityModal";

interface Preview {
  status: {
    staged: string[];
    modified: string[];
    deleted: string[];
    created: string[];
    files: Array<{ path: string; status: string }>;
    isClean: boolean;
    ahead: number;
    behind: number;
  };
  proposedMessage: {
    subject: string;
    body: string;
  };
}

interface Props {
  project: Project;
  onClose: () => void;
  onDone: () => void;
}

export function CommitPushModal({ project, onClose, onDone }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState<"preview" | "push" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const [showIdentityModal, setShowIdentityModal] = useState(false);

  const fetchPreview = useCallback(async () => {
    setLoading("preview");
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/commit-push/preview`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to generate preview");
      }
      const data: Preview = await res.json();
      setPreview(data);
      setSubject(data.proposedMessage.subject);
      setBody(data.proposedMessage.body);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(null);
    }
  }, [project.id]);

  useEffect(() => {
    fetchPreview();
  }, [fetchPreview]);

  const handlePush = async () => {
    if (!subject.trim()) {
      setError("Subject is required");
      return;
    }
    setLoading("push");
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/commit-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          body: body.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        // Check if git identity is missing
        if (data.code === "GIT_IDENTITY_REQUIRED") {
          setShowIdentityModal(true);
          return;
        }
        throw new Error(data.error || "Push failed");
      }
      setDone(true);
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(null);
    }
  };

  // ── Summary stats ──
  const stats = preview?.status;
  const totalChanges = stats
    ? stats.staged.length + stats.modified.length + stats.created.length + stats.deleted.length
    : 0;

  return (
    <div className="modal-overlay">
      <div className="modal-box max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ArrowUp size={16} className="text-hacker-accent" />
            <span className="text-hacker-accent font-bold text-sm tracking-wider">
              PUSH TO REMOTE
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <X size={16} />
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="text-hacker-error text-xs mb-3 border border-hacker-error/30 p-2 flex items-center gap-1.5">
            <AlertTriangle size={12} />
            {error}
          </div>
        )}

        {/* Loading preview state */}
        {loading === "preview" && (
          <div className="text-hacker-text-dim text-xs flex items-center gap-2 py-4 border border-hacker-border p-3 mb-3">
            <RefreshCw size={12} className="animate-spin" />
            Analyzing changes...
          </div>
        )}

        {/* Done state */}
        {done && (
          <div className="text-hacker-accent text-xs mb-3 border border-hacker-accent/30 p-3 flex items-center gap-2 bg-hacker-accent/5">
            <Check size={14} />
            Changes pushed successfully! Closing...
          </div>
        )}

        {/* Preview content */}
        {preview && !done && (
          <div className="space-y-4">
            {/* Changes summary */}
            <div className="text-[10px] space-y-0.5 bg-hacker-bg/30 border border-hacker-border p-2">
              <div className="text-hacker-text-dim flex items-center gap-1.5 mb-1">
                <GitCommit size={12} />
                CHANGES DETECTED
              </div>
              {(stats?.staged.length ?? 0) > 0 && (
                <div className="text-hacker-accent">✓ {stats?.staged.length} staged</div>
              )}
              {(stats?.modified.length ?? 0) > 0 && (
                <div className="text-hacker-warn">~ {stats?.modified.length} modified</div>
              )}
              {(stats?.created.length ?? 0) > 0 && (
                <div className="text-hacker-info">+ {stats?.created.length} new</div>
              )}
              {(stats?.deleted.length ?? 0) > 0 && (
                <div className="text-hacker-error">- {stats?.deleted.length} deleted</div>
              )}
              {totalChanges === 0 && stats && (
                <div className="text-hacker-text-dim">
                  Nothing to commit locally. Will push any existing commits.
                </div>
              )}
              <div className="mt-1 max-h-[80px] overflow-y-auto">
                {stats?.files.slice(0, 8).map((f) => (
                  <div key={f.path} className="flex gap-1 text-hacker-text-dim/70 truncate">
                    <span className="text-hacker-accent text-[9px] w-5 shrink-0">{f.status}</span>
                    <span className="truncate">{f.path}</span>
                  </div>
                ))}
                {stats && stats.files.length > 8 && (
                  <div className="text-hacker-text-dim/50">
                    +{stats.files.length - 8} more files
                  </div>
                )}
              </div>
            </div>

            {/* Commit message form */}
            <div className="space-y-3">
              <div>
                <label className="text-hacker-text-dim text-[10px] block mb-1 flex items-center gap-1.5">
                  <FileText size={10} />
                  SUBJECT
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="input-hacker w-full text-xs"
                  placeholder="Update: changes"
                  maxLength={72}
                  autoFocus
                />
              </div>

              <div>
                <label className="text-hacker-text-dim text-[10px] block mb-1 flex items-center gap-1.5">
                  <FileText size={10} />
                  BODY (optional)
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="input-hacker w-full text-xs min-h-[100px] resize-y"
                  placeholder="Detailed description of changes..."
                  rows={5}
                />
              </div>
            </div>

            {/* Info */}
            <div className="text-hacker-text-dim text-[9px] border border-hacker-border p-2 flex items-center gap-1.5">
              <span className="text-hacker-accent">→</span>
              This will stage all changes, commit, and push to{" "}
              <span className="text-hacker-info truncate max-w-[160px]">
                {project.git?.remote?.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
              </span>
            </div>
          </div>
        )}

        {/* Action buttons */}
        {!done && (
          <div className="flex gap-2 justify-end pt-4">
            <button onClick={onClose} className="btn-hacker text-xs" disabled={loading === "push"}>
              CANCEL
            </button>
            <button
              onClick={handlePush}
              className="btn-hacker text-xs flex items-center gap-1.5"
              disabled={loading !== null}
            >
              {loading === "push" ? (
                <RefreshCw size={12} className="animate-spin" />
              ) : (
                <ArrowUp size={12} />
              )}
              {loading === "push" ? "PUSHING..." : "PUSH"}
            </button>
          </div>
        )}
      </div>
      {/* Identity modal */}
      {showIdentityModal && (
        <GitIdentityModal
          project={project}
          onClose={() => setShowIdentityModal(false)}
          onConfigured={() => {
            setShowIdentityModal(false);
            setError("");
            // Retry the push after identity is configured
            handlePush();
          }}
        />
      )}
    </div>
  );
}
