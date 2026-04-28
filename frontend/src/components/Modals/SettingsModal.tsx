import { useState, useEffect } from "react";
import { X, Wifi, RefreshCw, Check } from "lucide-react";

interface Props {
  onClose: () => void;
  send: (msg: any) => void;
  session: any;
}

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

export function SettingsModal({ onClose, send, session }: Props) {
  const [tab, setTab] = useState<"general" | "ollama">("general");

  // General settings
  const [provider, setProvider] = useState("anthropic");
  const [modelId, setModelId] = useState("claude-sonnet-4-20250514");
  const [thinkingLevel, setThinkingLevel] = useState("medium");

  // Ollama settings
  const [ollamaUrl, setOllamaUrl] = useState("http://172.17.0.1:11434");
  const [ollamaConnected, setOllamaConnected] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaSelected, setOllamaSelected] = useState("");
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaError, setOllamaError] = useState("");
  const [ollamaStatus, setOllamaStatus] = useState("");

  // Load ollama config on mount
  useEffect(() => {
    fetch("/api/ollama/config")
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg.url) setOllamaUrl(cfg.url);
        if (cfg.enabled) setOllamaConnected(true);
      })
      .catch(() => {});
  }, []);

  // ── General handlers ──
  const handleSetModel = async () => {
    try {
      await fetch("/api/settings/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId }),
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleSetThinking = async () => {
    try {
      await fetch("/api/settings/thinking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: thinkingLevel }),
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleCompact = async () => {
    try {
      await fetch("/api/settings/session/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (e) {
      console.error(e);
    }
  };

  // ── Ollama handlers ──
  const handleOllamaConnect = async () => {
    setOllamaLoading(true);
    setOllamaError("");
    try {
      const res = await fetch("/api/ollama/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: ollamaUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setOllamaModels(data.models);
      setOllamaConnected(true);
      setOllamaStatus(`Connected! ${data.models.length} models found`);
    } catch (e: any) {
      setOllamaError(e.message);
      setOllamaConnected(false);
    } finally {
      setOllamaLoading(false);
    }
  };

  const handleOllamaRefresh = async () => {
    setOllamaLoading(true);
    setOllamaError("");
    try {
      const res = await fetch("/api/ollama/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setOllamaModels(data.models);
      setOllamaStatus(`Refreshed! ${data.models.length} models`);
    } catch (e: any) {
      setOllamaError(e.message);
    } finally {
      setOllamaLoading(false);
    }
  };

  const handleOllamaSelect = async () => {
    if (!ollamaSelected) return;
    setOllamaStatus(`Switching to ${ollamaSelected}...`);
    try {
      await fetch("/api/settings/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "ollama", modelId: ollamaSelected }),
      });
      setOllamaStatus(`✓ Using ${ollamaSelected}`);
    } catch (e: any) {
      setOllamaError(e.message);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            <button
              onClick={() => setTab("general")}
              className={`text-xs px-3 py-1 border ${
                tab === "general"
                  ? "border-hacker-accent text-hacker-accent"
                  : "border-transparent text-hacker-text-dim hover:text-hacker-text"
              }`}
            >
              GENERAL
            </button>
            <button
              onClick={() => setTab("ollama")}
              className={`text-xs px-3 py-1 border ${
                tab === "ollama"
                  ? "border-hacker-accent text-hacker-accent"
                  : "border-transparent text-hacker-text-dim hover:text-hacker-text"
              }`}
            >
              OLLAMA
            </button>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <X size={16} />
          </button>
        </div>

        {tab === "general" && (
          <div className="space-y-4 text-sm">
            <div>
              <div className="text-hacker-accent text-xs mb-2">MODEL CONFIGURATION</div>
              <div className="space-y-2">
                <div>
                  <label className="text-hacker-text-dim text-[10px] block mb-1">Provider</label>
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    className="select-hacker w-full text-xs"
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="google">Google Gemini</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="mistral">Mistral</option>
                    <option value="groq">Groq</option>
                    <option value="xai">xAI</option>
                    <option value="openrouter">OpenRouter</option>
                    {ollamaConnected && <option value="ollama">Ollama (local)</option>}
                  </select>
                </div>
                <div>
                  <label className="text-hacker-text-dim text-[10px] block mb-1">Model ID</label>
                  <input
                    type="text"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="input-hacker w-full text-xs"
                    placeholder="claude-sonnet-4-20250514"
                  />
                </div>
                <button onClick={handleSetModel} className="btn-hacker w-full text-xs">
                  APPLY MODEL
                </button>
              </div>
            </div>

            <div>
              <div className="text-hacker-accent text-xs mb-2">THINKING LEVEL</div>
              <div className="space-y-2">
                <select
                  value={thinkingLevel}
                  onChange={(e) => setThinkingLevel(e.target.value)}
                  className="select-hacker w-full text-xs"
                >
                  <option value="off">Off</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">XHigh (OpenAI Codex only)</option>
                </select>
                <button onClick={handleSetThinking} className="btn-hacker w-full text-xs">
                  APPLY THINKING LEVEL
                </button>
              </div>
            </div>

            {session && (
              <div>
                <div className="text-hacker-accent text-xs mb-2">SESSION</div>
                <div className="bg-hacker-bg/50 border border-hacker-border p-2 text-[10px] space-y-1">
                  <div>ID: {session.sessionId?.slice(0, 16)}...</div>
                  <div>Model: {session.model?.name || "?"}</div>
                  <div>Thinking: {session.thinkingLevel}</div>
                  <div>Messages: {session.messageCount}</div>
                </div>
                <button onClick={handleCompact} className="btn-hacker w-full text-xs mt-2">
                  COMPACT CONTEXT
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "ollama" && (
          <div className="space-y-4 text-sm">
            <div className="text-hacker-accent text-xs mb-2 flex items-center gap-1.5">
              <span>🦙 OLLAMA INTEGRATION</span>
              {ollamaConnected && (
                <span className="flex items-center gap-1 text-hacker-accent">
                  <Check size={12} /> connected
                </span>
              )}
            </div>

            {/* Status / Error */}
            {ollamaStatus && (
              <div className="text-hacker-accent text-xs border border-hacker-accent/30 p-2 bg-hacker-accent/5">
                {ollamaStatus}
              </div>
            )}
            {ollamaError && (
              <div className="text-hacker-error text-xs border border-hacker-error/30 p-2">
                ERROR: {ollamaError}
              </div>
            )}

            {/* URL input */}
            <div>
              <label className="text-hacker-text-dim text-[10px] block mb-1">
                Ollama Server URL
              </label>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  className="input-hacker flex-1 text-xs"
                  placeholder="http://172.17.0.1:11434"
                />
                <button
                  onClick={handleOllamaConnect}
                  disabled={ollamaLoading}
                  className="btn-hacker text-xs whitespace-nowrap flex items-center gap-1"
                >
                  {ollamaLoading ? (
                    "..."
                  ) : (
                    <>
                      <Wifi size={12} /> CONNECT
                    </>
                  )}
                </button>
              </div>
              <p className="text-hacker-text-dim text-[9px] mt-1">
                Docker host: 172.17.0.1 · LAN IP: 192.168.x.x · Local: localhost
              </p>
            </div>

            {/* Model list */}
            {ollamaModels.length > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-hacker-text-dim text-[10px]">
                    Available models ({ollamaModels.length})
                  </span>
                  <button
                    onClick={handleOllamaRefresh}
                    disabled={ollamaLoading}
                    className="btn-hacker text-[10px] flex items-center gap-1 px-2 py-0.5"
                  >
                    <RefreshCw size={10} /> REFRESH
                  </button>
                </div>

                <div className="max-h-[200px] overflow-y-auto border border-hacker-border">
                  {ollamaModels.map((m) => (
                    <button
                      key={m.name}
                      onClick={() => setOllamaSelected(m.name)}
                      className={`w-full text-left px-2 py-1.5 text-[10px] flex justify-between items-center border-b border-hacker-border last:border-0 ${
                        ollamaSelected === m.name
                          ? "bg-hacker-accent/10 text-hacker-accent"
                          : "text-hacker-text-dim hover:bg-hacker-border/30"
                      }`}
                    >
                      <span className="truncate max-w-[280px]">{m.name}</span>
                      <span className="text-hacker-text-dim ml-2 shrink-0">
                        {formatSize(m.size)}
                      </span>
                    </button>
                  ))}
                </div>

                {ollamaSelected && (
                  <button
                    onClick={handleOllamaSelect}
                    className="btn-hacker w-full text-xs flex items-center justify-center gap-1"
                  >
                    <Check size={12} /> USE {ollamaSelected}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex gap-2 justify-end mt-4 pt-3 border-t border-hacker-border">
          <button onClick={onClose} className="btn-hacker text-xs">
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
}
