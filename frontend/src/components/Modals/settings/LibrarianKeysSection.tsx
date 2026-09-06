import { useState, useCallback, useEffect } from "react";
import { copyToClipboard } from "../../../utils/clipboard";

// ── Librarian API keys — section autonome, rendue dans l'onglet API Keys ──
// (déplacée depuis l'onglet « Modèles d'analyse » : toutes les clés API de
// l'application doivent être gérées au même endroit)
function LibrarianKeysSection() {
  const [libKeys, setLibKeys] = useState<Array<{ key: string; name: string; createdAt: string }>>([]);
  const [libNewKeyName, setLibNewKeyName] = useState("");
  const [libCreatedKey, setLibCreatedKey] = useState<string | null>(null);
  const [libKeyError, setLibKeyError] = useState("");
  const [libKeyCopied, setLibKeyCopied] = useState(false);

  const loadLibKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/librarian/keys");
      if (res.ok) {
        const data = await res.json();
        setLibKeys(data.keys || []);
      }
    } catch {}
  }, []);

  const createLibKey = async () => {
    if (!libNewKeyName.trim()) return;
    setLibKeyError("");
    try {
      const res = await fetch("/api/librarian/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: libNewKeyName.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      const created = await res.json();
      setLibCreatedKey(created.key);
      setLibNewKeyName("");
      await loadLibKeys();
    } catch (e: any) {
      setLibKeyError(e.message);
    }
  };

  const deleteLibKey = async (key: string) => {
    setLibKeyError("");
    try {
      const res = await fetch(`/api/librarian/keys/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      await loadLibKeys();
    } catch (e: any) {
      setLibKeyError(e.message);
    }
  };

  useEffect(() => { loadLibKeys(); }, [loadLibKeys]);

  return (
    <div className="border border-hacker-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
            <span>📚</span> Librarian API Keys
          </div>
          <div className="text-[10px] text-hacker-text-dim mt-0.5">
            API keys for external agents to access the librarian service (search, archive, library).
            Agents must send X-API-Key in ADDITION to their Bearer token on librarian routes.
          </div>
        </div>
      </div>

      {libKeyError && (
        <div className="text-hacker-error text-[11px] border border-hacker-error/30 p-2 mb-2">
          {libKeyError}
          <button onClick={() => setLibKeyError("")} className="ml-2 text-hacker-text-dim hover:text-hacker-error">✕</button>
        </div>
      )}

      {/* Clé fraîchement créée (affichée une seule fois) */}
      {libCreatedKey && (
        <div className="border border-hacker-accent/40 bg-hacker-accent/5 p-2 mb-2 rounded">
          <div className="text-[11px] text-hacker-accent mb-1">✓ New key created — copy it now (shown only once):</div>
          <div className="flex items-center gap-2">
            <code className="text-hacker-text-bright text-xs bg-hacker-bg px-2 py-1 flex-1 truncate select-text">
              {libCreatedKey}
            </code>
            <button
              onClick={async () => {
                if (await copyToClipboard(libCreatedKey)) {
                  setLibKeyCopied(true);
                  setTimeout(() => setLibKeyCopied(false), 2000);
                }
              }}
              className="text-xs text-hacker-accent hover:text-hacker-text-bright shrink-0"
            >
              {libKeyCopied ? "✓ Copied" : "📋 Copy"}
            </button>
            <button
              onClick={() => setLibCreatedKey(null)}
              className="text-xs text-hacker-text-dim hover:text-hacker-text-bright shrink-0"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Création d'une nouvelle clé */}
      <div className="flex gap-2 mb-3">
        <input
          value={libNewKeyName}
          onChange={e => setLibNewKeyName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && createLibKey()}
          placeholder="Agent name (e.g. openclaw)"
          className="flex-1 bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
        />
        <button
          onClick={createLibKey}
          disabled={!libNewKeyName.trim()}
          className="btn-hacker text-xs px-4 py-1.5 disabled:opacity-30"
        >
          + Generate
        </button>
      </div>

      {/* Liste des clés */}
      {libKeys.length === 0 ? (
        <div className="text-hacker-text-dim text-xs italic py-2 text-center border border-hacker-border">
          No librarian API keys yet.
        </div>
      ) : (
        <div className="space-y-1.5">
          {libKeys.map(k => (
            <div key={k.key} className="border border-hacker-border bg-hacker-bg/30 px-3 py-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-hacker-accent text-xs font-bold">{k.name}</span>
                <button
                  onClick={() => deleteLibKey(k.key)}
                  className="text-hacker-text-dim hover:text-hacker-error text-xs"
                  title="Revoke key"
                >
                  🗑
                </button>
              </div>
              <div className="flex items-center gap-2">
                <code className="text-hacker-text-dim text-xs bg-hacker-bg px-2 py-0.5 flex-1 truncate select-text">
                  {k.key}
                </code>
              </div>
              <div className="text-[11px] text-hacker-text-dim mt-1">
                Created: {new Date(k.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default LibrarianKeysSection;
