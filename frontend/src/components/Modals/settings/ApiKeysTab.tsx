import { useState, useCallback, useEffect } from "react";
import { copyToClipboard } from "../../../utils/clipboard";
import LibrarianKeysSection from "./LibrarianKeysSection";
import DockerHubSection from "./DockerHubSection";

// ── API Keys Tab ──────────────────────────────────────

interface ApiKey {
  id: string;
  name: string;
  tokenPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// copyToClipboard est extrait dans src/utils/clipboard.ts (helper robuste
// navigator.clipboard + fallback execCommand pour le http LAN non sécurisé).

function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newName, setNewName] = useState("");
  const [revealedTokens, setRevealedTokens] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-keys");
      setKeys((await res.json()).keys || []);
    } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setError("");
    try {
      const res = await fetch("/api/agent-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const created = await res.json();
      setRevealedTokens(prev => ({ ...prev, [created.id]: created.token }));
      setNewName("");
      await loadKeys();
    } catch (e: any) { setError(e.message); }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/agent-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
      setRevealedTokens(prev => { const n = { ...prev }; delete n[id]; return n; });
      await loadKeys();
    } catch (e: any) { setError(e.message); }
  };

  const handleReveal = async (id: string) => {
    try {
      const res = await fetch(`/api/agent-keys/${encodeURIComponent(id)}/token`);
      const data = await res.json();
      setRevealedTokens(prev => ({ ...prev, [id]: data.token }));
    } catch (e: any) { setError(e.message); }
  };

  const handleCopy = async (token: string, id: string) => {
    const ok = await copyToClipboard(token);
    if (!ok) return;
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="p-3 space-y-3">
      <div className="text-xs text-hacker-text-dim">
        API keys allow external agents (OpenClaw, Hermes, custom scripts) to interact with Pi-Web.
        Use the token in the <code className="text-hacker-accent">Authorization: Bearer &lt;token&gt;</code> header.
      </div>

      {error && (
        <div className="text-hacker-error text-xs border border-hacker-error/30 p-2">
          {error}
          <button onClick={() => setError("")} className="ml-2 text-hacker-text-dim hover:text-hacker-error">✕</button>
        </div>
      )}

      {/* Create new key */}
      <div className="flex gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleCreate()}
          placeholder="Key name (e.g. My Agent)"
          className="flex-1 bg-hacker-bg border border-hacker-border px-3 py-1.5 text-xs text-hacker-text-bright focus:outline-none focus:border-hacker-accent"
        />
        <button
          onClick={handleCreate}
          disabled={!newName.trim()}
          className="btn-hacker text-xs px-4 py-1.5 disabled:opacity-30"
        >
          + Create
        </button>
      </div>

      {/* Key list */}
      {keys.length === 0 ? (
        <div className="text-hacker-text-dim text-xs italic py-4 text-center border border-hacker-border">
          No API keys yet. Create one to enable the agent API.
        </div>
      ) : (
        <div className="space-y-1.5">
          {keys.map(k => (
            <div key={k.id} className="border border-hacker-border bg-hacker-bg/30 px-3 py-2">

              <div className="flex items-center justify-between mb-1">
                <span className="text-hacker-accent text-xs font-bold">{k.name}</span>
                <button
                  onClick={() => handleDelete(k.id)}
                  className="text-hacker-text-dim hover:text-hacker-error text-xs"
                  title="Delete key"
                >
                  🗑
                </button>
              </div>

              <div className="flex items-center gap-2">
                {revealedTokens[k.id] ? (
                  <>
                    {/* select-text : surcharge le user-select:none du .modal-inner pour permettre la sélection manuelle */}
                    <code className="text-hacker-text-bright text-xs bg-hacker-bg px-2 py-0.5 flex-1 truncate select-text">
                      {revealedTokens[k.id]}
                    </code>
                    <button
                      onClick={() => handleCopy(revealedTokens[k.id], k.id)}
                      className="text-xs text-hacker-accent hover:text-hacker-text-bright shrink-0"
                    >
                      {copiedId === k.id ? "✓ Copied" : "📋"}
                    </button>
                  </>
                ) : (
                  <>
                    <code className="text-hacker-text-dim text-xs bg-hacker-bg px-2 py-0.5 flex-1 select-text">
                      {k.tokenPreview}
                    </code>
                    <button
                      onClick={() => handleReveal(k.id)}
                      className="text-xs text-hacker-text-dim hover:text-hacker-accent shrink-0"
                    >
                      👁 Reveal
                    </button>
                  </>
                )}
              </div>

              <div className="flex gap-4 mt-1 text-[11px] text-hacker-text-dim">
                <span>Created: {new Date(k.createdAt).toLocaleDateString()}</span>
                {k.lastUsedAt && (
                  <span>Last used: {new Date(k.lastUsedAt).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Clés de l'agent libraire (recherche web + bibliothèque partagée) */}
      <LibrarianKeysSection />

      {/* Compte Docker Hub (auth persistante pour les pulls du container) */}
      <DockerHubSection />
    </div>
  );
}

export default ApiKeysTab;
