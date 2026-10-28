import { useState } from "react";
import { HolafIcon } from "../icons/HolafIcon";
import { ModalDialog } from "../common/ModalDialog";
import type { Project } from "../../types";
import { looksLikeSshRemote, suggestedHttpsRemote } from "../../utils/git-errors";

interface Props {
  project: Project;
  onClose: () => void;
  /** Identifiants enregistrés : le parent NE relance PAS l'action automatiquement. */
  onConfigured: () => void;
  /**
   * Message d'erreur RÉEL qui a déclenché l'ouverture (ex. « authentication
   * failed », « timed out »). Affiché tel quel : avant, il était perdu et
   * l'utilisateur ne voyait qu'un formulaire qui revenait en boucle.
   */
  initialError?: string;
}

export function GitAuthModal({ project, onClose, onConfigured, initialError }: Props) {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError ?? "");

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

  const remote = project.git?.remote;
  const sshRemote = looksLikeSshRemote(remote);
  const httpsEquiv = sshRemote ? suggestedHttpsRemote(remote) : null;

  const provider = project.git?.provider;
  const isGitHub = provider === "github";
  const isGitLab = provider === "gitlab";

  return (
    <ModalDialog id="git-auth" onClose={onClose}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <HolafIcon name="key" size={16} className="text-hacker-warn" />
            <span className="text-hacker-warn font-bold text-sm tracking-wider">
              GIT AUTHENTICATION REQUIRED
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <HolafIcon name="x" size={16} />
          </button>
        </div>

        {/* Explanation */}
        <div className="text-hacker-text-dim text-xs mb-4 bg-hacker-bg/30 border border-hacker-border p-3 space-y-2">
          <p>
            The remote repository requires authentication. Enter your credentials to enable push/pull operations.
          </p>
          {isGitHub && (
            <p className="flex items-start gap-1.5">
              <HolafIcon name="alert-triangle" size={12} className="text-hacker-warn shrink-0 mt-0.5" />
              <span>
                GitHub requires a <strong className="text-hacker-accent">Personal Access Token (PAT)</strong> instead of your password.
                Create one at{" "}
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-hacker-info underline inline-flex items-center gap-0.5"
                >
                  github.com/settings/tokens <HolafIcon name="external-link" size={10} />
                </a>
                {" "}(select <em>repo</em> scope).
              </span>
            </p>
          )}
          {isGitLab && (
            <p className="flex items-start gap-1.5">
              <HolafIcon name="alert-triangle" size={12} className="text-hacker-warn shrink-0 mt-0.5" />
              <span>
                GitLab requires an <strong className="text-hacker-accent">Access Token</strong> instead of your password.
                Create one at{" "}
                <a
                  href="https://gitlab.com/-/user_settings/personal_access_tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-hacker-info underline inline-flex items-center gap-0.5"
                >
                  gitlab.com/user_settings/personal_access_tokens <HolafIcon name="external-link" size={10} />
                </a>
                {" "}(select <em>write_repository</em> scope).
              </span>
            </p>
          )}
          {!isGitHub && !isGitLab && (
            <p className="flex items-start gap-1.5">
              <HolafIcon name="alert-triangle" size={12} className="text-hacker-warn shrink-0 mt-0.5" />
              <span>
                Most git hosts require a <strong className="text-hacker-accent">token</strong> instead of your account password for HTTPS authentication.
              </span>
            </p>
          )}
          <p className="text-hacker-text-dim/70 text-[10px]">
            Credentials are saved encrypted (AES-256-GCM) in Pi-Web's data volume
            (<span className="font-mono">.data/credentials.enc</span>) — never in the repository and never in
            the remote URL. Use “Forget credentials” in the Git panel to delete them.
          </p>
        </div>

        {/* Origin en SSH : prévenir AVANT la saisie (le backend refusera avec
            GIT_REMOTE_SCHEME — on ne réécrit pas le remote en silence). */}
        {sshRemote && (
          <div className="text-hacker-warn text-xs mb-3 border border-hacker-warn/40 bg-hacker-warn/5 p-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <HolafIcon name="alert-triangle" size={12} />
              This repository uses an <strong>SSH</strong> remote (<span className="font-mono">{remote}</span>).
            </div>
            <div className="text-hacker-text-dim text-[10px]">
              A token can only be used over HTTPS. Switch the remote first, then save your token:
            </div>
            <code className="block text-[10px] font-mono text-hacker-info break-all">
              {httpsEquiv
                ? `git remote set-url origin ${httpsEquiv}`
                : "git remote set-url origin https://<host>/<owner>/<repo>.git"}
            </code>
          </div>
        )}

        {error && (
          <div className="text-hacker-error text-xs mb-3 border border-hacker-error/30 p-2 flex items-center gap-1.5">
            <HolafIcon name="alert-triangle" size={12} />
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-hacker-text-dim text-[10px] block mb-1 flex items-center gap-1.5">
              <HolafIcon name="user" size={10} />
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
              <HolafIcon name="key" size={10} />
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
              <HolafIcon name="refresh" size={12} className="animate-spin" />
            ) : (
              <HolafIcon name="key" size={12} />
            )}
            {loading ? "SAVING..." : "SAVE"}
          </button>
        </div>
    </ModalDialog>
  );
}