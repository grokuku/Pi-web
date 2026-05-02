import { useState, useEffect, useCallback } from "react";
import {
  X, Wifi, Plus, Trash2, Zap, Check, RefreshCw,
  ChevronRight, ChevronDown, Key, Power, Lock, FileText,
} from "lucide-react";
import type { ModelLibrary, AgentMode, ModelEntry, ModeConfig } from "../../types";

// ── Constants ────────────────────────────────────────────

interface ProviderDef {
  id: string;
  name: string;
  type: "cloud" | "selfhosted";
  icon: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: "anthropic", name: "Anthropic", type: "cloud", icon: "☁" },
  { id: "openai", name: "OpenAI", type: "cloud", icon: "☁" },
  { id: "google", name: "Google Gemini", type: "cloud", icon: "☁" },
  { id: "deepseek", name: "DeepSeek", type: "cloud", icon: "☁" },
  { id: "mistral", name: "Mistral", type: "cloud", icon: "☁" },
  { id: "groq", name: "Groq", type: "cloud", icon: "☁" },
  { id: "xai", name: "xAI", type: "cloud", icon: "☁" },
  { id: "openrouter", name: "OpenRouter", type: "cloud", icon: "☁" },
  { id: "ollama", name: "Ollama", type: "selfhosted", icon: "🦙" },
];

const MODE_LABELS: Record<AgentMode, { icon: string; label: string; desc: string }> = {
  code: { icon: "⚡", label: "CODE", desc: "Coding assistant" },
  commit: { icon: "📝", label: "COMMIT", desc: "Git commit messages" },
  review: { icon: "📋", label: "REVIEW", desc: "Code review" },
  plan: { icon: "🗺", label: "PLAN", desc: "Architecture & planning" },
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

// ── Props ─────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  session: any;
  onModelApplied?: () => void;
}

// ── Main Component ────────────────────────────────────────

export function ModelLibraryModal({ onClose, session, onModelApplied }: Props) {
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const [activeMode, setActiveMode] = useState<AgentMode>("code");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  // ── Add model panel state ──
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [addProvider, setAddProvider] = useState("ollama");
  const [addOllamaUrl, setAddOllamaUrl] = useState("http://172.17.0.1:11434");
  const [availableModels, setAvailableModels] = useState<{ name: string; size: number }[]>([]);
  const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());
  const [addThinkingLevel, setAddThinkingLevel] = useState("medium");
  const [addContextWindow, setAddContextWindow] = useState(0); // 0 = auto
  const [addReasoning, setAddReasoning] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [editInstructions, setEditInstructions] = useState("");

  // ── Load library ──
  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      const data = await res.json();
      setLibrary(data);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  // Load Ollama config on mount
  useEffect(() => {
    fetch("/api/ollama/config")
      .then((r) => r.json())
      .then((cfg) => { if (cfg.url) setAddOllamaUrl(cfg.url); })
      .catch(() => {});
  }, []);

  // ── Fetch models (Ollama or cloud list) ──
  const handleFetchModels = async () => {
    setLoading(true);
    setError("");
    const isSelfHosted = addProvider === "ollama";

    try {
      if (isSelfHosted) {
        // Also configure Ollama on the backend
        const cfgRes = await fetch("/api/ollama/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: addOllamaUrl }),
        });
        const cfgData = await cfgRes.json();
        if (!cfgRes.ok) throw new Error(cfgData.error);
        setAvailableModels(
          (cfgData.models || []).map((m: any) => ({
            name: m.name,
            size: m.size || 0,
          }))
        );
      } else {
        // Cloud: show common models
        const common = getCommonModels(addProvider);
        setAvailableModels(common.map((name) => ({ name, size: 0 })));
      }
      setStatus(`✓ ${isSelfHosted ? "Ollama" : PROVIDERS.find((p) => p.id === addProvider)?.name} models loaded`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Add selected models to current mode ──
  const handleAddModels = async () => {
    if (selectedToAdd.size === 0) return;
    setLoading(true);
    setError("");

    try {
      for (const modelName of selectedToAdd) {
        await fetch(`/api/model-library/modes/${activeMode}/models`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: addProvider,
            modelId: modelName,
            name: modelName,
            thinkingLevel: addThinkingLevel,
            contextWindow: addContextWindow || undefined,
            reasoning: addReasoning || undefined,
            maxTokens: addReasoning ? 16384 : 4096,
          }),
        });
      }
      // Reload library
      await loadLibrary();
      setSelectedToAdd(new Set());
      setShowAddPanel(false);
      setStatus(`✓ Added ${selectedToAdd.size} model(s) to ${MODE_LABELS[activeMode].label}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Remove model from mode ──
  const handleRemoveModel = async (entryId: string) => {
    try {
      const res = await fetch(
        `/api/model-library/modes/${activeMode}/models/${encodeURIComponent(entryId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) { const data = await res.json().catch(() => ({})); setError(data.error || `Error ${res.status}`); return; }
      const data = await res.json();
      setLibrary(data);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Set active model ──
  const handleSetActive = async (entryId: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/model-library/modes/${activeMode}/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setError(data.error || `Error ${res.status}`); return; }
      const data = await res.json();
      setLibrary(data);
      setStatus("✓ Model activated");
      onModelApplied?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Toggle mode enabled ──
  const handleToggleMode = async (mode: AgentMode, enabled: boolean) => {
    try {
      const res = await fetch(`/api/model-library/modes/${mode}/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setError(data.error || `Error ${res.status}`); return; }
      const data = await res.json();
      setLibrary(data);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Update thinking level on a model ──
  const handleThinkingChange = async (entryId: string, thinkingLevel: string) => {
    try {
      const res = await fetch(
        `/api/model-library/modes/${activeMode}/models/${encodeURIComponent(entryId)}/thinking`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thinkingLevel }),
        }
      );
      if (!res.ok) { const data = await res.json().catch(() => ({})); setError(data.error || `Error ${res.status}`); return; }
      const data = await res.json();
      setLibrary(data);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Update model properties (contextWindow, reasoning, maxTokens) ──
  const handlePropertiesChange = async (entryId: string, props: { contextWindow?: number; reasoning?: boolean; maxTokens?: number }) => {
    try {
      const res = await fetch(
        `/api/model-library/modes/${activeMode}/models/${encodeURIComponent(entryId)}/properties`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(props),
        }
      );
      if (!res.ok) { const data = await res.json().catch(() => ({})); setError(data.error || `Error ${res.status}`); return; }
      const data = await res.json();
      setLibrary(data);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Update mode instructions ──
  const handleSaveInstructions = async () => {
    try {
      const res = await fetch(`/api/model-library/modes/${activeMode}/instructions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: editInstructions }),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setError(data.error || `Error ${res.status}`); return; }
      const data = await res.json();
      setLibrary(data);
      setShowInstructions(false);
      setStatus("✓ Instructions saved");
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Update mode read-only ──
  const handleToggleReadOnly = async (readOnly: boolean) => {
    try {
      const res = await fetch(`/api/model-library/modes/${activeMode}/readonly`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readOnly }),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); setError(data.error || `Error ${res.status}`); return; }
      const data = await res.json();
      setLibrary(data);
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!library) {
    return (
      <div className="modal-overlay">
        <div className="modal-box">
          <span className="text-hacker-accent animate-pulse">Loading library...</span>
        </div>
      </div>
    );
  }

  const modeConfig = library.modes[activeMode] || {
    enabled: false,
    activeModelId: null,
    models: [],
    instructions: "",
    tools: [],
    readOnly: true,
  };
  const activeEntry = modeConfig.models.find(
    (m) => m.id === modeConfig.activeModelId
  );

  // Group models by provider for the card layout
  const modelsByProvider = groupByProvider(modeConfig);

  return (
    <div className="modal-overlay">
      <div className="modal-box max-w-[680px] max-h-[90vh] overflow-y-auto">
        {/* ── Header ── */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-hacker-accent font-bold text-sm tracking-wider">
            ⚡ MODEL LIBRARY
          </span>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text">
            <X size={16} />
          </button>
        </div>

        {/* ── Status / Error ── */}
        {status && (
          <div className="text-hacker-accent text-xs border border-hacker-accent/30 p-2 bg-hacker-accent/5 mb-2">
            {status}
          </div>
        )}
        {error && (
          <div className="text-hacker-error text-xs border border-hacker-error/30 p-2 mb-2">
            ERROR: {error}
          </div>
        )}

        {/* ── Mode tabs ── */}
        <div className="flex gap-1 mb-4 border-b border-hacker-border pb-1">
          {(Object.keys(MODE_LABELS) as AgentMode[]).map((mode) => {
            const cfg = library.modes[mode];
            const isActive = activeMode === mode;
            const label = MODE_LABELS[mode];
            return (
              <button
                key={mode}
                onClick={() => setActiveMode(mode)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-b-2 transition-colors ${
                  isActive
                    ? "border-hacker-accent text-hacker-accent"
                    : "border-transparent text-hacker-text-dim hover:text-hacker-text"
                }`}
              >
                <span>{label.icon}</span>
                <span className="font-bold">{label.label}</span>
                {cfg.enabled && cfg.models.length > 0 && (
                  <span className="text-[9px] text-hacker-text-dim">({cfg.models.length})</span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Mode header: enable/disable + active model ── */}
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => handleToggleMode(activeMode, !modeConfig.enabled)}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs border ${
              modeConfig.enabled
                ? "border-hacker-accent text-hacker-accent bg-hacker-accent/5"
                : "border-hacker-border text-hacker-text-dim hover:text-hacker-text"
            }`}
          >
            <Power size={10} />
            {modeConfig.enabled ? "ON" : "OFF"}
          </button>
          {activeEntry && modeConfig.enabled && (
            <span className="text-xs text-hacker-text-dim">
              Active: <span className="text-hacker-accent">{activeEntry.name}</span>
              <span className="text-hacker-text-dim ml-1">think:{activeEntry.thinkingLevel}</span>
            </span>
          )}
          {!modeConfig.enabled && (
            <span className="text-xs text-hacker-text-dim italic">
              {MODE_LABELS[activeMode].desc} — disabled
            </span>
          )}
        </div>

        {/* ── Mode instructions & tools ── */}
        {modeConfig.enabled && (
          <div className="mb-3 border border-hacker-border">
            {/* Instructions toggle */}
            <button
              onClick={() => {
                if (!showInstructions) {
                  setEditInstructions(modeConfig.instructions || "");
                }
                setShowInstructions(!showInstructions);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs bg-hacker-surface/50">
              {showInstructions ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <FileText size={12} className="text-hacker-info" />
              <span className="text-hacker-accent font-bold">INSTRUCTIONS</span>
              {modeConfig.instructions && (
                <span className="text-hacker-text-dim text-[9px] ml-auto">
                  {modeConfig.instructions.length > 50
                    ? modeConfig.instructions.slice(0, 50) + "..."
                    : modeConfig.instructions}
                </span>
              )}
            </button>

            {showInstructions && (
              <div className="p-3 border-t border-hacker-border">
                <textarea
                  value={editInstructions}
                  onChange={(e) => setEditInstructions(e.target.value)}
                  className="input-hacker w-full text-xs min-h-[120px] resize-y"
                  placeholder="System instructions for this mode...\n\nDefine how the AI should behave in this mode.\nLeave empty for default behavior."
                />
                <div className="flex gap-2 mt-2">
                  <button onClick={handleSaveInstructions} className="btn-hacker text-xs px-3 py-1">
                    SAVE
                  </button>
                  <button onClick={() => setShowInstructions(false)} className="btn-hacker text-xs px-3 py-1">
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {/* Read-only toggle */}
            <div className="flex items-center gap-3 px-3 py-2 border-t border-hacker-border">
              <div className="flex items-center gap-1.5 flex-1">
                <Lock size={10} className={modeConfig.readOnly ? "text-hacker-warn" : "text-hacker-text-dim"} />
                <span className="text-[10px] text-hacker-text-dim">READ-ONLY TOOLS</span>
              </div>
              <button
                onClick={() => handleToggleReadOnly(!modeConfig.readOnly)}
                className={`text-[10px] px-2 py-0.5 border ${
                  modeConfig.readOnly
                    ? "border-hacker-warn text-hacker-warn bg-hacker-warn/5"
                    : "border-hacker-border text-hacker-text-dim hover:text-hacker-text"
                }`}
              >
                {modeConfig.readOnly ? "ON" : "OFF"}
              </button>
              {modeConfig.readOnly && modeConfig.tools.length > 0 && (
                <span className="text-[9px] text-hacker-text-dim">
                  {modeConfig.tools.join(", ")}
                </span>
              )}
            </div>
          </div>
        )}
        {modeConfig.enabled && (
          <div className="space-y-3">
            {Object.entries(modelsByProvider).map(([providerId, models]) => {
              const provDef = PROVIDERS.find((p) => p.id === providerId);
              return (
                <ProviderCard
                  key={providerId}
                  providerId={providerId}
                  providerDef={provDef}
                  models={models}
                  activeModelId={modeConfig.activeModelId}
                  onSetActive={handleSetActive}
                  onRemove={handleRemoveModel}
                  onThinkingChange={handleThinkingChange}
                  onPropertiesChange={handlePropertiesChange}
                />
              );
            })}

            {/* Empty state */}
            {modeConfig.models.length === 0 && (
              <div className="text-center text-hacker-text-dim text-xs border border-hacker-border p-6">
                <span className="text-2xl block mb-2">📦</span>
                No models configured for {MODE_LABELS[activeMode].label} mode.
                <br />
                Click [+ ADD MODEL] to get started.
              </div>
            )}
          </div>
        )}

        {/* ── Add model panel ── */}
        {modeConfig.enabled && !showAddPanel && (
          <button
            onClick={() => setShowAddPanel(true)}
            className="mt-3 btn-hacker w-full text-xs py-2 flex items-center justify-center gap-1.5"
          >
            <Plus size={12} /> ADD MODEL
          </button>
        )}

        {showAddPanel && (
          <AddModelPanel
            provider={addProvider}
            setProvider={setAddProvider}
            ollamaUrl={addOllamaUrl}
            setOllamaUrl={setAddOllamaUrl}
            availableModels={availableModels}
            selectedToAdd={selectedToAdd}
            setSelectedToAdd={setSelectedToAdd}
            thinkingLevel={addThinkingLevel}
            setThinkingLevel={setAddThinkingLevel}
            contextWindow={addContextWindow}
            setContextWindow={setAddContextWindow}
            reasoning={addReasoning}
            setReasoning={setAddReasoning}
            loading={loading}
            onFetch={handleFetchModels}
            onAdd={handleAddModels}
            onCancel={() => {
              setShowAddPanel(false);
              setSelectedToAdd(new Set());
              setAvailableModels([]);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Provider Card ─────────────────────────────────────────

function ProviderCard({
  providerId,
  providerDef,
  models,
  activeModelId,
  onSetActive,
  onRemove,
  onThinkingChange,
  onPropertiesChange,
}: {
  providerId: string;
  providerDef?: ProviderDef;
  models: ModelEntry[];
  activeModelId: string | null;
  onSetActive: (id: string) => void;
  onRemove: (id: string) => void;
  onThinkingChange: (id: string, level: string) => void;
  onPropertiesChange: (id: string, props: { contextWindow?: number; reasoning?: boolean; maxTokens?: number }) => void;
}) {
  const icon = providerDef?.icon || "☁";
  const name = providerDef?.name || providerId;

  return (
    <div className="border border-hacker-border bg-hacker-bg/50">
      {/* Provider header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hacker-border bg-hacker-surface/50">
        <span className="text-sm">{icon}</span>
        <span className="text-hacker-accent text-xs font-bold tracking-wide">{name}</span>
        <span className="text-hacker-text-dim text-[10px] ml-auto">
          {models.length} model{models.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Model rows */}
      {models.map((entry) => {
        const isActive = entry.id === activeModelId;
        return (
          <div
            key={entry.id}
            className={`flex items-center gap-2 px-3 py-2 border-b border-hacker-border/50 last:border-0 ${
              isActive ? "bg-hacker-accent/5" : "hover:bg-hacker-border/30"
            }`}
          >
            {/* Active indicator */}
            <span className={`text-[10px] ${isActive ? "text-hacker-accent" : "text-hacker-text-dim"}`}>
              {isActive ? "⚡" : "○"}
            </span>

            {/* Model name */}
            <span className={`text-xs flex-1 truncate ${isActive ? "text-hacker-accent font-bold" : "text-hacker-text"}`}>
              {entry.name}
            </span>

            {/* Thinking level selector */}
            <select
              value={entry.thinkingLevel}
              onChange={(e) => onThinkingChange(entry.id, e.target.value)}
              className="select-hacker text-[10px] py-0 px-1 max-w-[80px]"
              onClick={(e) => e.stopPropagation()}
            >
              {THINKING_LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>

            {/* Capabilities: editable reasoning + context window */}
            <button
              onClick={(e) => { e.stopPropagation(); onPropertiesChange(entry.id, { reasoning: !entry.reasoning }); }}
              className={`text-[9px] border px-1 cursor-pointer select-none ${
                entry.reasoning
                  ? "border-hacker-warn/50 text-hacker-warn bg-hacker-warn/10"
                  : "border-hacker-border text-hacker-text-dim hover:text-hacker-text"
              }`}
              title={entry.reasoning ? "Reasoning ON — click to disable" : "Reasoning OFF — click to enable"}
            >
              🧠 {entry.reasoning ? "ON" : "OFF"}
            </button>

            <select
              value={entry.contextWindow || 0}
              onChange={(e) => { e.stopPropagation(); onPropertiesChange(entry.id, { contextWindow: Number(e.target.value) }); }}
              className="select-hacker text-[9px] py-0 px-1 max-w-[48px]"
              onClick={(e) => e.stopPropagation()}
              title="Context window size"
            >
              <option value={0}>Auto</option>
              <option value={8192}>8K</option>
              <option value={32768}>32K</option>
              <option value={65536}>64K</option>
              <option value={128000}>128K</option>
              <option value={200000}>200K</option>
              <option value={1000000}>1M</option>
            </select>

            {/* Actions */}
            {!isActive && (
              <button
                onClick={() => onSetActive(entry.id)}
                className="btn-hacker text-[10px] px-2 py-0.5 flex items-center gap-0.5"
              >
                <Zap size={9} /> SELECT
              </button>
            )}
            {isActive && (
              <span className="text-[10px] text-hacker-accent font-bold px-2">ACTIVE</span>
            )}
            <button
              onClick={() => onRemove(entry.id)}
              className="text-hacker-text-dim hover:text-hacker-error"
              title="Remove from library"
            >
              <Trash2 size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Add Model Panel ───────────────────────────────────────

function AddModelPanel({
  provider,
  setProvider,
  ollamaUrl,
  setOllamaUrl,
  availableModels,
  selectedToAdd,
  setSelectedToAdd,
  thinkingLevel,
  setThinkingLevel,
  contextWindow,
  setContextWindow,
  reasoning,
  setReasoning,
  loading,
  onFetch,
  onAdd,
  onCancel,
}: {
  provider: string;
  setProvider: (p: string) => void;
  ollamaUrl: string;
  setOllamaUrl: (u: string) => void;
  availableModels: { name: string; size: number }[];
  selectedToAdd: Set<string>;
  setSelectedToAdd: (s: Set<string>) => void;
  thinkingLevel: string;
  setThinkingLevel: (l: string) => void;
  contextWindow: number;
  setContextWindow: (n: number) => void;
  reasoning: boolean;
  setReasoning: (b: boolean) => void;
  loading: boolean;
  onFetch: () => void;
  onAdd: () => void;
  onCancel: () => void;
}) {
  const isSelfHosted = provider === "ollama";

  const toggleModel = (name: string) => {
    const next = new Set(selectedToAdd);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelectedToAdd(next);
  };

  const selectAll = () => {
    if (selectedToAdd.size === availableModels.length) {
      setSelectedToAdd(new Set());
    } else {
      setSelectedToAdd(new Set(availableModels.map((m) => m.name)));
    }
  };

  return (
    <div className="border border-hacker-border-bright bg-hacker-surface/80 mt-3 p-3">
      <div className="text-hacker-accent text-[10px] tracking-widest mb-2">+ ADD MODEL</div>

      {/* Step 1: Provider */}
      <div className="mb-2">
        <label className="text-hacker-accent text-[10px] block mb-1">1. PROVIDER</label>
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setSelectedToAdd(new Set());
          }}
          className="select-hacker w-full text-xs"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.icon} {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Step 2: Config */}
      <div className="mb-2">
        {isSelfHosted ? (
          <>
            <label className="text-hacker-accent text-[10px] flex items-center gap-1 mb-1">
              <Wifi size={10} /> 2. SERVER URL
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
                onClick={onFetch}
                disabled={loading}
                className="btn-hacker text-xs whitespace-nowrap flex items-center gap-1"
              >
                {loading ? "..." : <><Wifi size={12} /> FETCH</>}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="text-hacker-accent text-[10px] flex items-center gap-1 mb-1">
              <Key size={10} /> 2. LOAD MODELS
            </label>
            <button
              onClick={onFetch}
              disabled={loading}
              className="btn-hacker text-xs w-full flex items-center justify-center gap-1"
            >
              {loading ? "...LOADING" : <><RefreshCw size={12} /> LOAD MODEL LIST</>}
            </button>
          </>
        )}
      </div>

      {/* Step 3: Model selection */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <label className="text-hacker-accent text-[10px]">3. SELECT MODELS</label>
          {availableModels.length > 0 && (
            <button onClick={selectAll} className="text-hacker-text-dim text-[9px] hover:text-hacker-accent">
              {selectedToAdd.size === availableModels.length ? "DESELECT ALL" : "SELECT ALL"}
            </button>
          )}
        </div>
        {availableModels.length > 0 ? (
          <div className="max-h-[200px] overflow-y-auto border border-hacker-border">
            {availableModels.map((m) => (
              <button
                key={m.name}
                onClick={() => toggleModel(m.name)}
                className={`w-full text-left px-2 py-1.5 text-[10px] flex justify-between items-center border-b border-hacker-border last:border-0 ${
                  selectedToAdd.has(m.name)
                    ? "bg-hacker-accent/10 text-hacker-accent"
                    : "text-hacker-text-dim hover:bg-hacker-border/30"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-[8px]">{selectedToAdd.has(m.name) ? "☑" : "☐"}</span>
                  <span className="truncate max-w-[320px]">{m.name}</span>
                </span>
                {m.size > 0 && (
                  <span className="text-hacker-text-dim ml-2 shrink-0">{formatSize(m.size)}</span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-hacker-text-dim text-[10px] italic border border-hacker-border p-3 text-center">
            {isSelfHosted ? "Click FETCH to load Ollama models" : "Click LOAD MODEL LIST"}
          </div>
        )}
      </div>

      {/* Step 4: Default thinking */}
      <div className="mb-2">
        <label className="text-hacker-accent text-[10px] block mb-1">4. DEFAULT THINKING</label>
        <select
          value={thinkingLevel}
          onChange={(e) => setThinkingLevel(e.target.value)}
          className="select-hacker w-full text-xs"
        >
          {THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>

      {/* Step 5: Model capabilities */}
      <div className="mb-3 flex gap-3">
        <div className="flex-1">
          <label className="text-hacker-accent text-[10px] block mb-1">5. CONTEXT WINDOW</label>
          <select
            value={contextWindow}
            onChange={(e) => setContextWindow(Number(e.target.value))}
            className="select-hacker w-full text-xs"
          >
            <option value={0}>Auto</option>
            <option value={8192}>8K</option>
            <option value={32768}>32K</option>
            <option value={65536}>64K</option>
            <option value={128000}>128K</option>
            <option value={200000}>200K</option>
            <option value={1000000}>1M</option>
          </select>
        </div>
        <div>
          <label className="text-hacker-accent text-[10px] block mb-1">REASONING</label>
          <button
            onClick={() => setReasoning(!reasoning)}
            className={`flex items-center gap-1.5 px-3 py-[7px] border text-xs ${
              reasoning
                ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                : "border-hacker-border text-hacker-text-dim hover:text-hacker-text"
            }`}
          >
            {reasoning ? "🧠 ON" : "○ OFF"}
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={onAdd}
          disabled={selectedToAdd.size === 0 || loading}
          className="btn-hacker flex-1 text-xs flex items-center justify-center gap-1"
        >
          <Check size={12} /> ADD {selectedToAdd.size > 0 ? `${selectedToAdd.size} MODEL${selectedToAdd.size > 1 ? "S" : ""}` : ""}
        </button>
        <button onClick={onCancel} className="btn-hacker text-xs px-4">
          CANCEL
        </button>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────

function groupByProvider(modeConfig: ModeConfig): Record<string, ModelEntry[]> {
  const groups: Record<string, ModelEntry[]> = {};
  for (const entry of modeConfig.models) {
    if (!groups[entry.provider]) groups[entry.provider] = [];
    groups[entry.provider].push(entry);
  }
  return groups;
}

function formatSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (!bytes) return "";
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function getCommonModels(provider: string): string[] {
  const map: Record<string, string[]> = {
    anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-5-20251101", "claude-haiku-3-5-20241022"],
    openai: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
    google: ["gemini-2.5-flash", "gemini-2.5-pro"],
    deepseek: ["deepseek-chat", "deepseek-reasoner"],
    mistral: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
    groq: ["llama-4-scout-17b-16e", "mixtral-8x7b-32768", "deepseek-r1-distill-llama-70b"],
    xai: ["grok-3", "grok-3-mini"],
    openrouter: ["anthropic/claude-sonnet-4", "openai/gpt-4o", "google/gemini-2.5-pro"],
  };
  return map[provider] || [];
}