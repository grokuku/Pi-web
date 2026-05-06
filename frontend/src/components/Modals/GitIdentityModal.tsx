import { useState } from "react";
import { X, User, Mail, RefreshCw } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";

interface Props {
  project: Project;
  onClose: () => void;
  onConfigured: () => void;
}

import type { Project } from "../../types";

export function GitIdentityModal({ project, onClose, onConfigured }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!name.trim() || !email.trim()) {
      setError("Both name and email are required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to set identity");
      }
      onConfigured();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <ModalDialog id="git-identity" onClose={onClose}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <User size={16} className="text-hacker-warn" />
            <span className="text-hacker-warn font-bold text-sm tracking-wider">
              GIT IDENTITY REQUIRED
            </span>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <X size={16} />
          </button>
        </div>

        <div className="text-hacker-text-dim text-xs mb-4 bg-hacker-bg/30 border border-hacker-border p-2">
          Git needs your name and email to create commits. This will be saved in the repository config.
        </div>

        {error && (
          <div className="text-hacker-error text-xs mb-3 border border-hacker-error/30 p-2 flex items-center gap-1.5">
            <span>⚠</span>
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-hacker-text-dim text-[10px] block mb-1 flex items-center gap-1.5">
              <User size={10} />
              NAME
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-hacker w-full text-xs"
              placeholder="John Doe"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>

          <div>
            <label className="text-hacker-text-dim text-[10px] block mb-1 flex items-center gap-1.5">
              <Mail size={10} />
              EMAIL
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-hacker w-full text-xs"
              placeholder="john@example.com"
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-4">
          <button onClick={onClose} className="btn-hacker text-xs" disabled={loading}>
            CANCEL
          </button>
          <button
            onClick={handleSave}
            className="btn-hacker text-xs flex items-center gap-1.5"
            disabled={loading || !name.trim() || !email.trim()}
          >
            {loading ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <User size={12} />
            )}
            {loading ? "SAVING..." : "SAVE & RETRY"}
          </button>
        </div>
    </ModalDialog>
  );
}