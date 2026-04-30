import { useState } from "react";
import { X, Key, User, RefreshCw, AlertTriangle, ExternalLink } from "lucide-react";
import type { Project } from "../../types";

interface Props {
  project: Project;
  onClose: () => void;
  onConfigured: () => void;
}

export function GitAuthModal({ project, onClose, onConfigured }: Props) {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!username.trim() || !token.trim()) {
      setError("Both username and token are required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password: token.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save credentials");
      }
      onConfigured();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const provider = project.git?.provider;
  const isGitHub = provider === "github";
  const isGitLab = provider === "gitlab";

  return (
    <div className="modal-overlay">
      <div className="modal-box max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Key size={16} className="text-hacker-warn" />
            <span className="text-hacker-warn font-bold text-sm tracking-wider">
              GIT AUTHENTICATION REQUIRED
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <X size={16} />
          </button>
        </div>

        {/* Explanation */}
        <div className="text-hacker-text-dim text-xs mb-4 bg-hacker-bg/30 border border-hacker-border p-3 space-y-2">
          <p>
            The remote repository requires authentication. Enter your credentials to enable push/pull operations.
          </p>
          {isGitHub && (
            <p className="flex items-start gap-1.5">
              <AlertTriangle size={12} className="text-hacker-warn shrink-0 mt-0.5" />
              <span>
                GitHub requires a <strong className="text-hacker-accent">Personal Access Token (PAT)</strong> instead of your password.
                Create one at{" "}
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-hacker-info underline inline-flex items-center gap-0.5"
                >
                  github.com/settings/tokens <ExternalLink size={10} />
                </a>
                {" "}(select <em>repo</em> scope).
              </span>
            </p>
          )}
          {isGitLab && (
            <p className="flex items-start gap-1.5">
              <AlertTriangle size={12} className="text-hacker-warn shrink-0 mt-0.5" />
              <span>
                GitLab requires an <strong className="text-hacker-accent">Access Token</strong> instead of your password.
                Create one at{" "}
                <a
                  href="https://gitlab.com/-/user_settings/personal_access_tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-hacker-info underline inline-flex items-center gap-0.5"
                >
                  gitlab.com/user_settings/personal_access_tokens <ExternalLink size={10} />
                </a>
                {" "}(select <em>write_repository</em> scope).
              </span>
            </p>
          )}
          {!isGitHub && !isGitLab && (
            <p className="flex items-start gap-1.5">
              <AlertTriangle size={12} className="text-hacker-warn shrink-0 mt-0.5" />
              <span>
                Most git hosts require a <strong className="text-hacker-accent">token</strong> instead of your account password for HTTPS authentication.
              </span>
            </p>
          )}
          <p className="text-hacker-text-dim/70 text-[10px]">
            Credentials are stored in memory only and never written to disk permanently.
          </p>
        </div>

        {error && (
          <div className="text-hacker-error text-xs mb-3 border border-hacker-error/30 p-2 flex items-center gap-1.5">
            <AlertTriangle size={12} />
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-hacker-text-dim text-[10px] block mb-1 flex items-center gap-1.5">
              <User size={10} />
              USERNAME
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input-hacker w-full text-xs"
              placeholder={isGitHub ? "your-github-username" : isGitLab ? "your-gitlab-username" : "username"}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>

          <div>
            <label className="text-hacker-text-dim text-[10px] block mb-1 flex items-center gap-1.5">
              <Key size={10} />
              PASSWORD / TOKEN
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="input-hacker w-full text-xs font-mono"
              placeholder={isGitHub ? "ghp_xxxxxxxxxxxxxxxxxxxx" : isGitLab ? "glpat-xxxxxxxxxxxxxxxxxxxx" : "token or password"}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
            {isGitHub && (
              <div className="text-hacker-text-dim/60 text-[9px] mt-1">
                Use a PAT with <span className="text-hacker-accent">repo</span> scope — classic or fine-grained.
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-4">
          <button onClick={onClose} className="btn-hacker text-xs" disabled={loading}>
            CANCEL
          </button>
          <button
            onClick={handleSave}
            className="btn-hacker text-xs flex items-center gap-1.5"
            disabled={loading || !username.trim() || !token.trim()}
          >
            {loading ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <Key size={12} />
            )}
            {loading ? "SAVING..." : "SAVE & RETRY"}
          </button>
        </div>
      </div>
    </div>
  );
}