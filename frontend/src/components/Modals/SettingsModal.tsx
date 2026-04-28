import { useState, useEffect } from "react";
import { X, Wifi, RefreshCw, Check, Key } from "lucide-react";

interface Props {
  onClose: () => void;
  send: (msg: any) => void;
  session: any;
}

interface OllamaModel { name: string; modified_at: string; size: number; }
interface ProviderDef { id: string; name: string; type: "cloud" | "selfhosted"; }

const PROVIDERS: ProviderDef[] = [
  { id: "anthropic", name: "Anthropic", type: "cloud" },
  { id: "openai", name: "OpenAI", type: "cloud" },
  { id: "google", name: "Google Gemini", type: "cloud" },
  { id: "deepseek", name: "DeepSeek", type: "cloud" },
  { id: "mistral", name: "Mistral", type: "cloud" },
  { id: "groq", name: "Groq", type: "cloud" },
  { id: "xai", name: "xAI", type: "cloud" },
  { id: "openrouter", name: "OpenRouter", type: "cloud" },
  { id: "ollama", name: "Ollama", type: "selfhosted" },
];

export function SettingsModal({ onClose, send, session }: Props) {
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://172.17.0.1:11434");
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("medium");

  const isSelfHosted = provider === "ollama";
  const isCloud = PROVIDERS.find((p) => p.id === provider)?.type === "cloud";

  // Load config on mount
  useEffect(() => {
    fetch("/api/ollama/config")
      .then((r) => r.json())
      .then((cfg) => { if (cfg.url) setOllamaUrl(cfg.url); })
      .catch(() => {});
  }, []);

  // Reset when provider changes
  useEffect(() => {
    setModels([]);
    setSelectedModel("");
    setStatus("");
    setError("");
    if (provider === "ollama") setApiKey("");
  }, [provider]);

  // ── Fetch models ──
  const handleFetchModels = async () => {
    setLoading(true);
    setError("");
    setStatus("");

    try {
      if (isSelfHosted) {
        // Ollama
        const res = await fetch("/api/ollama/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: ollamaUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setModels(data.models);
        setStatus(`✓ ${data.models.length} models found`);
      } else {
        // Cloud providers - we can't enumerate models from Pi SDK easily
        // Show common models for the provider
        const commonModels = getCommonModels(provider);
        setModels(commonModels.map((m) => ({ name: m, modified_at: "", size: 0 })));
        setStatus(`✓ Enter API key and select model`);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Apply model ──
  const handleApply = async () => {
    if (!selectedModel) {
      setError("Please select a model");
      return;
    }
    if (isCloud && !apiKey.trim()) {
      setError("API key is required");
      return;
    }

    setLoading(true);
    setError("");

    try {
      // Set API key if cloud
      if (isCloud && apiKey.trim()) {
        const envVar = getEnvVar(provider);
        // We can't set env vars at runtime easily, so we skip this for now
        // The API key should be set via docker environment
      }

      // Set model
      const res = await fetch("/api/settings/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId: selectedModel }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error);
      }
      const modelResult = await res.json();

      // Set thinking level
      await fetch("/api/settings/thinking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: thinkingLevel }),
      });

      if (modelResult.queued) {
        setStatus(`✓ ${selectedModel} queued — will apply when session starts`);
      } else {
        setStatus(`✓ Using ${selectedModel}`);
      }
      setTimeout(onClose, 2000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    if (!bytes) return "";
    return `${(bytes / 1e3).toFixed(0)} KB`;
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box max-h-[85vh] overflow-y-auto max-w-[520px]">
        <div className="flex items-center justify-between mb-4">
          <span className="text-hacker-accent font-bold text-sm tracking-wider">⚙ MODEL SELECTION</span>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text"><X size={16} /></button>
        </div>

        {/* Status / Error */}
        {status && <div className="text-hacker-accent text-xs border border-hacker-accent/30 p-2 bg-hacker-accent/5 mb-2">{status}</div>}
        {error && <div className="text-hacker-error text-xs border border-hacker-error/30 p-2 mb-2">ERROR: {error}</div>}

        <div className="space-y-3 text-sm">
          {/* ── 1. Provider selection ── */}
          <div>
            <label className="text-hacker-accent text-[10px] block mb-1">1. PROVIDER</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className="select-hacker w-full text-xs">
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.type === "selfhosted" ? "🦙" : "☁"} {p.name}</option>
              ))}
            </select>
          </div>

          {/* ── 2a. API Key (cloud) ── */}
          {isCloud && (
            <div>
              <label className="text-hacker-accent text-[10px] block mb-1 flex items-center gap-1">
                <Key size={10} /> 2. API KEY
              </label>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                className="input-hacker w-full text-xs" placeholder={`Enter ${PROVIDERS.find((p) => p.id === provider)?.name} API key...`} />
              <p className="text-hacker-text-dim text-[9px] mt-1">
                Or set <code className="text-hacker-accent">{getEnvVar(provider)}</code> in docker-compose environment
              </p>
            </div>
          )}

          {/* ── 2b. URL (self-hosted) ── */}
          {isSelfHosted && (
            <div>
              <label className="text-hacker-accent text-[10px] block mb-1 flex items-center gap-1">
                <Wifi size={10} /> 2. SERVER URL
              </label>
              <div className="flex gap-1">
                <input type="text" value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)}
                  className="input-hacker flex-1 text-xs" placeholder="http://172.17.0.1:11434" />
                <button onClick={handleFetchModels} disabled={loading}
                  className="btn-hacker text-xs whitespace-nowrap flex items-center gap-1">
                  {loading ? "..." : <><Wifi size={12} /> FETCH</>}
                </button>
              </div>
            </div>
          )}

          {/* ── 3. Model selection ── */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-hacker-accent text-[10px]">3. MODEL</span>
              {isCloud && !models.length && (
                <button onClick={handleFetchModels} className="btn-hacker text-[10px] px-2 py-0.5">LOAD LIST</button>
              )}
            </div>

            {models.length > 0 ? (
              <div className="max-h-[200px] overflow-y-auto border border-hacker-border">
                {models.map((m) => (
                  <button key={m.name} onClick={() => setSelectedModel(m.name)}
                    className={`w-full text-left px-2 py-1.5 text-[10px] flex justify-between items-center border-b border-hacker-border last:border-0 ${
                      selectedModel === m.name ? "bg-hacker-accent/10 text-hacker-accent" : "text-hacker-text-dim hover:bg-hacker-border/30"
                    }`}>
                    <span className="truncate max-w-[320px]">{m.name}</span>
                    {m.size > 0 && <span className="text-hacker-text-dim ml-2 shrink-0">{formatSize(m.size)}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-hacker-text-dim text-[10px] italic border border-hacker-border p-3 text-center">
                {isSelfHosted ? "Click FETCH to load Ollama models" : "Click LOAD LIST to see available models"}
              </div>
            )}
          </div>

          {/* ── 4. Thinking level ── */}
          <div>
            <label className="text-hacker-accent text-[10px] block mb-1">4. THINKING LEVEL</label>
            <select value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value)} className="select-hacker w-full text-xs">
              <option value="off">Off</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">XHigh (Codex only)</option>
            </select>
          </div>

          {/* ── Apply ── */}
          <button onClick={handleApply} disabled={loading || !selectedModel}
            className="btn-hacker w-full text-sm py-2 flex items-center justify-center gap-2">
            <Check size={14} /> {loading ? "APPLYING..." : selectedModel ? `USE ${selectedModel}` : "SELECT A MODEL"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──
function getEnvVar(provider: string): string {
  const map: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY",
    mistral: "MISTRAL_API_KEY", groq: "GROQ_API_KEY",
    xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY",
  };
  return map[provider] || `${provider.toUpperCase()}_API_KEY`;
}

function getCommonModels(provider: string): string[] {
  const map: Record<string, string[]> = {
    anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-5-20251101", "claude-haiku-3-5-20241022"],
    openai: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "codex-max"],
    google: ["gemini-2.5-flash", "gemini-2.5-pro"],
    deepseek: ["deepseek-chat", "deepseek-reasoner"],
    mistral: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
    groq: ["llama-4-scout-17b-16e", "mixtral-8x7b-32768", "deepseek-r1-distill-llama-70b"],
    xai: ["grok-3", "grok-3-mini"],
    openrouter: ["anthropic/claude-sonnet-4", "openai/gpt-4o", "google/gemini-2.5-pro"],
  };
  return map[provider] || [];
}
