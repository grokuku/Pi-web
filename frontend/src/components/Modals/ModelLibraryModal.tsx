import { useState, useEffect, useCallback } from "react";
import {
  X, Wifi, Plus, Trash2, Star, Check, RefreshCw,
  Edit2, Key, Power, Settings, TestTube2, Eye, EyeOff,
} from "lucide-react";
import type { ModelLibrary, RegisteredModel, ProviderConfig, DiscoveredModel, ProviderType } from "../../types";
import { PROVIDER_PRESETS } from "../../types";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

// ── Props ─────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  session: any;
  onModelApplied?: () => void;
}

// ── Main Component ────────────────────────────────────────

export function ModelLibraryModal({ onClose, session, onModelApplied }: Props) {
  const [activeTab, setActiveTab] = useState<"providers" | "models">("providers");
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  // ── Load data ──
  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      setLibrary(await res.json());
    } catch (e: any) { setError(e.message); }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      setProviders(await res.json());
    } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => { loadLibrary(); loadProviders(); }, [loadLibrary, loadProviders]);

  // ── Handlers ──
  const handleAddModels = async (models: Omit<RegisteredModel, "id">[]) => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/model-library/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Failed"); }
      setLibrary(await res.json());
      setStatus("✓ Models added");
      onModelApplied?.();
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleUpdateModel = async (id: string, updates: Partial<RegisteredModel>) => {
    try {
      const res = await fetch(`/api/model-library/models/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Failed"); }
      setLibrary(await res.json());
      onModelApplied?.();
    } catch (e: any) { setError(e.message); }
  };

  const handleRemoveModel = async (id: string) => {
    try {
      const res = await fetch(`/api/model-library/models/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Failed"); }
      setLibrary(await res.json());
    } catch (e: any) { setError(e.message); }
  };

  const handleSetDefault = async (id: string) => {
    try {
      const res = await fetch(`/api/model-library/models/${encodeURIComponent(id)}/default`, { method: "PUT" });
      if (!res.ok) throw new Error("Failed");
      setLibrary(await res.json());
      onModelApplied?.();
    } catch (e: any) { setError(e.message); }
  };

  if (!library) {
    return (
      <div className="modal-overlay">
        <div className="modal-box"><span className="text-hacker-accent animate-pulse">Loading...</span></div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box max-w-[52rem] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-hacker-accent font-bold text-sm tracking-wider">⚡ MODEL LIBRARY</span>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text"><X size={16} /></button>
        </div>

        {/* Status/Error */}
        {status && <div className="text-hacker-accent text-xs border border-hacker-accent/30 p-2 bg-hacker-accent/5 mb-2">{status}</div>}
        {error && <div className="text-hacker-error text-xs border border-hacker-error/30 p-2 mb-2">ERROR: {error}</div>}

        {/* Tabs */}
        <div className="flex gap-1 mb-3 border-b border-hacker-border pb-1">
          <button onClick={() => setActiveTab("providers")}
            className={`px-3 py-1.5 text-xs border-b-2 transition-colors ${activeTab === "providers" ? "border-hacker-accent text-hacker-accent" : "border-transparent text-hacker-text-dim hover:text-hacker-text"}`}>
            🏢 PROVIDERS
          </button>
          <button onClick={() => setActiveTab("models")}
            className={`px-3 py-1.5 text-xs border-b-2 transition-colors ${activeTab === "models" ? "border-hacker-accent text-hacker-accent" : "border-transparent text-hacker-text-dim hover:text-hacker-text"}`}>
            🤖 MODELS
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "providers" && (
            <ProvidersTab providers={providers} setProviders={setProviders} setError={setError} />
          )}
          {activeTab === "models" && (
            <ModelsTab
              library={library}
              providers={providers}
              onAdd={handleAddModels}
              onUpdate={handleUpdateModel}
              onRemove={handleRemoveModel}
              onSetDefault={handleSetDefault}
              loading={loading}
              setLoading={setLoading}
              setError={setError}
              setStatus={setStatus}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Providers Tab ─────────────────────────────────────────

function ProvidersTab({ providers, setProviders, setError }: {
  providers: ProviderConfig[];
  setProviders: (p: ProviderConfig[]) => void;
  setError: (e: string) => void;
}) {
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/providers/${id}`, { method: "DELETE" });
      setProviders(providers.filter(p => p.id !== id));
    } catch (e: any) { setError(e.message); }
  };

  const handleTest = async (id: string) => {
    try {
      const res = await fetch(`/api/providers/${id}/test`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        // Refresh providers to get updated discoveredModels
        const refreshRes = await fetch("/api/providers");
        setProviders(await refreshRes.json());
      } else {
        setError(data.error || "Connection failed");
      }
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="space-y-2">
      {providers.map(p => {
        const preset = PROVIDER_PRESETS[p.type] || PROVIDER_PRESETS["openai-compatible"];
        return (
          <div key={p.id} className="border border-hacker-border bg-hacker-surface/50">
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="text-sm">{p.type === "ollama" ? "🦙" : p.type === "anthropic" ? "☁" : p.type === "google" ? "✨" : "🔗"}</span>
              <div className="flex-1 min-w-0">
                <span className="text-hacker-accent text-xs font-bold">{p.name || p.type}</span>
                <span className="text-hacker-text-dim text-[10px] ml-2">{p.type}</span>
              </div>
              <span className={`text-[9px] px-1.5 py-0.5 border ${
                p.connectionStatus === "ok" ? "border-hacker-accent/50 text-hacker-accent" :
                p.connectionStatus === "error" ? "border-hacker-error/50 text-hacker-error" :
                "border-hacker-border text-hacker-text-dim"
              }`}>
                {p.connectionStatus === "ok" ? "✓ CONNECTED" : p.connectionStatus === "error" ? "✗ ERROR" : "? UNTESTED"}
              </span>
              <button onClick={() => handleTest(p.id)}
                className="btn-hacker text-[10px] px-2 py-0.5 flex items-center gap-1">
                <TestTube2 size={9} /> TEST
              </button>
              <button onClick={() => setEditing(p)}
                className="text-hacker-text-dim hover:text-hacker-accent"><Edit2 size={11} /></button>
              <button onClick={() => handleDelete(p.id)}
                className="text-hacker-text-dim hover:text-hacker-error"><Trash2 size={11} /></button>
            </div>
            {p.baseUrl && <div className="px-3 pb-1.5 text-[9px] text-hacker-text-dim truncate">{p.baseUrl}</div>}
          </div>
        );
      })}

      {providers.length === 0 && (
        <div className="text-center text-hacker-text-dim text-xs border border-hacker-border p-6">
          No providers configured. Add one to get started.
        </div>
      )}

      {showAdd ? (
        <ProviderEditPanel
          provider={null}
          onSave={async (config) => {
            try {
              const res = await fetch("/api/providers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config),
              });
              const newP = await res.json();
              setProviders([...providers, newP]);
              setShowAdd(false);
            } catch (e: any) { setError(e.message); }
          }}
          onCancel={() => setShowAdd(false)}
        />
      ) : editing ? (
        <ProviderEditPanel
          provider={editing}
          onSave={async (config) => {
            try {
              const res = await fetch(`/api/providers/${editing.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config),
              });
              const updated = await res.json();
              setProviders(providers.map(p => p.id === editing.id ? updated : p));
              setEditing(null);
            } catch (e: any) { setError(e.message); }
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button onClick={() => setShowAdd(true)}
          className="mt-2 btn-hacker w-full text-xs py-2 flex items-center justify-center gap-1.5">
          <Plus size={12} /> ADD PROVIDER
        </button>
      )}
    </div>
  );
}

// ── Provider Edit/Add Panel ──────────────────────────────

function ProviderEditPanel({ provider, onSave, onCancel }: {
  provider: ProviderConfig | null;
  onSave: (config: any) => void;
  onCancel: () => void;
}) {
  const isEdit = !!provider;
  const preset = provider ? PROVIDER_PRESETS[provider.type] : null;

  const [name, setName] = useState(provider?.name || "");
  const [type, setType] = useState<ProviderType>(provider?.type || "ollama");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || PROVIDER_PRESETS.ollama.defaultBaseUrl);
  const [apiKey, setApiKey] = useState(provider?.apiKey || "");
  const [showKey, setShowKey] = useState(false);

  const handleTypeChange = (newType: ProviderType) => {
    setType(newType);
    const p = PROVIDER_PRESETS[newType];
    if (!isEdit) setBaseUrl(p.defaultBaseUrl);
    if (!isEdit) setName(p.description.split(" ")[0]);
  };

  const handleSave = () => {
    onSave({
      name: name || type,
      type,
      baseUrl,
      apiKey: apiKey || undefined,
    });
  };

  return (
    <div className="border border-hacker-accent/30 bg-hacker-surface/80 p-3 mt-2">
      <div className="text-hacker-accent text-[10px] tracking-widest mb-2">
        {isEdit ? "EDIT" : "ADD"} PROVIDER
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="text-hacker-accent text-[10px] block mb-1">TYPE</label>
          <select value={type} onChange={e => handleTypeChange(e.target.value as ProviderType)}
            className="select-hacker w-full text-xs" disabled={isEdit}>
            {Object.entries(PROVIDER_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>{v.description}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-hacker-accent text-[10px] block mb-1">NAME</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="input-hacker w-full text-xs" placeholder="My Provider" />
        </div>
      </div>

      <div className="mb-2">
        <label className="text-hacker-accent text-[10px] flex items-center gap-1 mb-1">
          <Wifi size={10} /> BASE URL
        </label>
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
          className="input-hacker w-full text-xs" placeholder={PROVIDER_PRESETS[type].defaultBaseUrl} />
      </div>

      {PROVIDER_PRESETS[type].requiresApiKey && (
        <div className="mb-2">
          <label className="text-hacker-accent text-[10px] flex items-center gap-1 mb-1">
            <Key size={10} /> API KEY
          </label>
          <div className="flex gap-1">
            <input value={apiKey} onChange={e => setApiKey(e.target.value)}
              type={showKey ? "text" : "password"}
              className="input-hacker flex-1 text-xs" />
            <button onClick={() => setShowKey(!showKey)}
              className="btn-hacker text-xs px-2">
              {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={handleSave} className="btn-hacker flex-1 text-xs flex items-center justify-center gap-1">
          <Check size={12} /> {isEdit ? "SAVE" : "ADD"}
        </button>
        <button onClick={onCancel} className="btn-hacker text-xs px-4">CANCEL</button>
      </div>
    </div>
  );
}

// ── Models Tab ───────────────────────────────────────────

function ModelsTab({ library, providers, onAdd, onUpdate, onRemove, onSetDefault, loading, setLoading, setError, setStatus }: {
  library: ModelLibrary;
  providers: ProviderConfig[];
  onAdd: (models: Omit<RegisteredModel, "id">[]) => Promise<void>;
  onUpdate: (id: string, updates: Partial<RegisteredModel>) => void;
  onRemove: (id: string) => void;
  onSetDefault: (id: string) => void;
  loading: boolean;
  setLoading: (b: boolean) => void;
  setError: (e: string) => void;
  setStatus: (s: string) => void;
}) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const getProviderName = (providerId: string) => {
    const p = providers.find(p => p.id === providerId);
    return p?.name || p?.type || providerId;
  };

  return (
    <div className="space-y-2">
      {/* Model list */}
      {library.models.length === 0 ? (
        <div className="text-center text-hacker-text-dim text-xs border border-hacker-border p-6">
          <span className="text-2xl block mb-2">🤖</span>
          No models configured yet. Add one to get started.
        </div>
      ) : (
        library.models.map(m => (
          <ModelRow
            key={m.id}
            model={m}
            providerName={getProviderName(m.providerId)}
            isDefault={m.id === library.defaultModelId}
            isEditing={editingId === m.id}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onSetDefault={onSetDefault}
            onStartEdit={() => setEditingId(editingId === m.id ? null : m.id)}
          />
        ))
      )}

      {/* Add button */}
      {!showAddModal && (
        <button onClick={() => setShowAddModal(true)}
          className="mt-2 btn-hacker w-full text-xs py-2 flex items-center justify-center gap-1.5">
          <Plus size={12} /> ADD MODELS
        </button>
      )}

      {showAddModal && (
        <AddModelsModal
          providers={providers}
          onAdd={onAdd}
          onClose={() => setShowAddModal(false)}
          loading={loading}
          setLoading={setLoading}
          setError={setError}
          setStatus={setStatus}
        />
      )}
    </div>
  );
}

// ── Model Row ─────────────────────────────────────────────

function ModelRow({ model, providerName, isDefault, isEditing, onUpdate, onRemove, onSetDefault, onStartEdit }: {
  model: RegisteredModel;
  providerName: string;
  isDefault: boolean;
  isEditing: boolean;
  onUpdate: (id: string, updates: Partial<RegisteredModel>) => void;
  onRemove: (id: string) => void;
  onSetDefault: (id: string) => void;
  onStartEdit: () => void;
}) {
  return (
    <div className={`border ${isDefault ? "border-hacker-accent/50 bg-hacker-accent/5" : "border-hacker-border bg-hacker-surface/50"}`}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        {/* Default star */}
        <button onClick={() => onSetDefault(model.id)}
          className={`text-sm ${isDefault ? "text-hacker-accent" : "text-hacker-text-dim hover:text-hacker-accent/60"}`}
          title={isDefault ? "Default model" : "Set as default"}>
          <Star size={12} fill={isDefault ? "currentColor" : "none"} />
        </button>

        {/* Model name */}
        <span className="text-xs font-bold text-hacker-text flex-1 truncate">
          {model.name}
        </span>
        <span className="text-[9px] text-hacker-text-dim">({providerName})</span>

        {/* Quick toggles */}
        <button onClick={() => onUpdate(model.id, { reasoning: !model.reasoning })}
          className={`text-[9px] border px-1.5 py-0.5 cursor-pointer select-none ${
            model.reasoning ? "border-hacker-warn/50 text-hacker-warn bg-hacker-warn/10" : "border-hacker-border text-hacker-text-dim hover:text-hacker-text"
          }`} title={model.reasoning ? "Reasoning ON" : "Reasoning OFF"}>
          🧠 {model.reasoning ? "ON" : "OFF"}
        </button>

        {/* Context window */}
        <select value={model.contextWindow} onChange={e => onUpdate(model.id, { contextWindow: Number(e.target.value) })}
          className="select-hacker text-[9px] py-0 px-1 max-w-[52px]" onClick={e => e.stopPropagation()}>
          <option value={8192}>8K</option>
          <option value={32768}>32K</option>
          <option value={65536}>64K</option>
          <option value={128000}>128K</option>
          <option value={200000}>200K</option>
          <option value={256000}>256K</option>
          <option value={1000000}>1M</option>
        </select>

        {/* Thinking level */}
        <select value={model.thinkingLevel} onChange={e => onUpdate(model.id, { thinkingLevel: e.target.value })}
          className="select-hacker text-[9px] py-0 px-1 max-w-[70px]" onClick={e => e.stopPropagation()}>
          {THINKING_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>

        {/* Edit + Delete */}
        <button onClick={onStartEdit}
          className="text-hacker-text-dim hover:text-hacker-accent"><Settings size={11} /></button>
        <button onClick={() => onRemove(model.id)}
          className="text-hacker-text-dim hover:text-hacker-error"><Trash2 size={11} /></button>
      </div>

      {/* Expanded edit panel */}
      {isEditing && (
        <div className="px-3 pb-2 pt-1 border-t border-hacker-border/50">
          <ModelEditPanel model={model} onUpdate={onUpdate} />
        </div>
      )}
    </div>
  );
}

// ── Model Edit Panel (inference params) ───────────────────

function ModelEditPanel({ model, onUpdate }: {
  model: RegisteredModel;
  onUpdate: (id: string, updates: Partial<RegisteredModel>) => void;
}) {
  const providerType = "openai-compatible"; // default, we don't have direct type here
  // For ollama, all params are supported. For others, only temp + topP
  const isOllama = model.providerId.toLowerCase().includes("ollama");

  return (
    <div className="grid grid-cols-4 gap-x-3 gap-y-1.5">
      <div>
        <label className="text-hacker-text-dim text-[9px] block">Temperature</label>
        <input type="number" value={model.temperature ?? ""} min={0} max={2} step={0.1}
          onChange={e => onUpdate(model.id, { temperature: e.target.value ? Number(e.target.value) : undefined })}
          className="input-hacker w-full text-[10px] py-0 px-1" placeholder="auto" />
      </div>
      <div>
        <label className="text-hacker-text-dim text-[9px] block">Top P</label>
        <input type="number" value={model.topP ?? ""} min={0} max={1} step={0.05}
          onChange={e => onUpdate(model.id, { topP: e.target.value ? Number(e.target.value) : undefined })}
          className="input-hacker w-full text-[10px] py-0 px-1" placeholder="auto" />
      </div>
      <div className={isOllama ? "" : "opacity-40 pointer-events-none"}>
        <label className="text-hacker-text-dim text-[9px] block">Min P</label>
        <input type="number" value={model.minP ?? ""} min={0} max={1} step={0.05}
          onChange={e => onUpdate(model.id, { minP: e.target.value ? Number(e.target.value) : undefined })}
          className="input-hacker w-full text-[10px] py-0 px-1" placeholder="auto" />
      </div>
      <div className={isOllama ? "" : "opacity-40 pointer-events-none"}>
        <label className="text-hacker-text-dim text-[9px] block">Repeat Penalty</label>
        <input type="number" value={model.repeatPenalty ?? ""} min={1} max={2} step={0.1}
          onChange={e => onUpdate(model.id, { repeatPenalty: e.target.value ? Number(e.target.value) : undefined })}
          className="input-hacker w-full text-[10px] py-0 px-1" placeholder="1.1" />
      </div>
      <div>
        <label className="text-hacker-text-dim text-[9px] block">Max Tokens</label>
        <input type="number" value={model.maxTokens ?? 16384} min={1} step={1024}
          onChange={e => onUpdate(model.id, { maxTokens: Number(e.target.value) })}
          className="input-hacker w-full text-[10px] py-0 px-1" />
      </div>
      <div className={isOllama ? "" : "opacity-40 pointer-events-none"}>
        <label className="text-hacker-text-dim text-[9px] block">Top K</label>
        <input type="number" value={model.topK ?? ""} min={1} max={100} step={1}
          onChange={e => onUpdate(model.id, { topK: e.target.value ? Number(e.target.value) : undefined })}
          className="input-hacker w-full text-[10px] py-0 px-1" placeholder="auto" />
      </div>
      <div>
        <label className="text-hacker-text-dim text-[9px] block">Context Window</label>
        <select value={model.contextWindow} onChange={e => onUpdate(model.id, { contextWindow: Number(e.target.value) })}
          className="select-hacker w-full text-[10px] py-0 px-1">
          <option value={8192}>8K</option>
          <option value={32768}>32K</option>
          <option value={65536}>64K</option>
          <option value={128000}>128K</option>
          <option value={200000}>200K</option>
          <option value={256000}>256K</option>
          <option value={1000000}>1M</option>
        </select>
      </div>
      <div>
        <label className="text-hacker-text-dim text-[9px] block">Thinking Level</label>
        <select value={model.thinkingLevel} onChange={e => onUpdate(model.id, { thinkingLevel: e.target.value })}
          className="select-hacker w-full text-[10px] py-0 px-1">
          {THINKING_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
    </div>
  );
}

// ── Add Models Modal ──────────────────────────────────────

function AddModelsModal({ providers, onAdd, onClose, loading, setLoading, setError, setStatus }: {
  providers: ProviderConfig[];
  onAdd: (models: Omit<RegisteredModel, "id">[]) => Promise<void>;
  onClose: () => void;
  loading: boolean;
  setLoading: (b: boolean) => void;
  setError: (e: string) => void;
  setStatus: (s: string) => void;
}) {
  const [selectedProvider, setSelectedProvider] = useState<string>(providers[0]?.id || "");
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState(false);

  const provider = providers.find(p => p.id === selectedProvider);

  const handleScan = async () => {
    if (!provider) return;
    setTesting(true);
    setError("");
    try {
      const res = await fetch(`/api/providers/${provider.id}/test`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setDiscoveredModels(data.models || []);
        // Refresh providers to get updated models
        setStatus(`✓ Found ${data.models?.length || 0} models`);
      } else {
        setError(data.error || "Connection failed");
      }
    } catch (e: any) { setError(e.message); }
    finally { setTesting(false); }
  };

  const handleAddSelected = async () => {
    if (selectedIds.size === 0) return;
    const models: Omit<RegisteredModel, "id">[] = [];
    for (const modelId of selectedIds) {
      const dm = discoveredModels.find(m => m.id === modelId);
      models.push({
        providerId: selectedProvider,
        modelId,
        name: dm?.name || modelId,
        isDefault: false,
        reasoning: inferReasoning(modelId),
        contextWindow: 128000,
        maxTokens: 16384,
        thinkingLevel: "medium",
      });
    }
    await onAdd(models);
    onClose();
  };

  const toggleModel = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const selectAll = () => {
    if (selectedIds.size === discoveredModels.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(discoveredModels.map(m => m.id)));
    }
  };

  return (
    <div className="border border-hacker-accent/30 bg-hacker-surface/80 p-3 mt-2">
      <div className="text-hacker-accent text-[10px] tracking-widest mb-2">+ ADD MODELS</div>

      {/* Provider selector */}
      <div className="mb-2">
        <label className="text-hacker-accent text-[10px] block mb-1">PROVIDER</label>
        <select value={selectedProvider} onChange={e => { setSelectedProvider(e.target.value); setDiscoveredModels([]); setSelectedIds(new Set()); }}
          className="select-hacker w-full text-xs">
          {providers.map(p => (
            <option key={p.id} value={p.id}>{p.name || p.type} ({p.type})</option>
          ))}
        </select>
      </div>

      {/* Scan button */}
      <div className="mb-2">
        <button onClick={handleScan} disabled={testing || !provider}
          className="btn-hacker w-full text-xs flex items-center justify-center gap-1.5">
          {testing ? <RefreshCw size={12} className="animate-spin" /> : <Wifi size={12} />}
          {testing ? "SCANNING..." : "SCAN MODELS"}
        </button>
        {provider?.connectionStatus === "ok" && discoveredModels.length === 0 && (
          <div className="text-hacker-text-dim text-[9px] mt-1">Connected — click SCAN to list models</div>
        )}
      </div>

      {/* Discovered models list */}
      {discoveredModels.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1">
            <label className="text-hacker-accent text-[10px]">{discoveredModels.length} MODEL{discoveredModels.length !== 1 ? "S" : ""} FOUND</label>
            <button onClick={selectAll} className="text-hacker-text-dim text-[9px] hover:text-hacker-accent">
              {selectedIds.size === discoveredModels.length ? "DESELECT ALL" : "SELECT ALL"}
            </button>
          </div>
          <div className="max-h-[250px] overflow-y-auto border border-hacker-border">
            {discoveredModels.map(m => (
              <button key={m.id} onClick={() => toggleModel(m.id)}
                className={`w-full text-left px-2 py-1.5 text-[10px] flex justify-between items-center border-b border-hacker-border last:border-0 ${
                  selectedIds.has(m.id) ? "bg-hacker-accent/10 text-hacker-accent" : "text-hacker-text-dim hover:bg-hacker-border/30"
                }`}>
                <span className="flex items-center gap-1.5">
                  <span className="text-[8px]">{selectedIds.has(m.id) ? "☑" : "☐"}</span>
                  <span className="truncate max-w-[320px]">{m.name || m.id}</span>
                </span>
                {m.size ? <span className="text-hacker-text-dim ml-2 shrink-0">{formatSize(m.size)}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button onClick={handleAddSelected} disabled={selectedIds.size === 0 || loading}
          className="btn-hacker flex-1 text-xs flex items-center justify-center gap-1">
          <Check size={12} /> ADD {selectedIds.size > 0 ? `${selectedIds.size} MODEL${selectedIds.size > 1 ? "S" : ""}` : ""}
        </button>
        <button onClick={onClose} className="btn-hacker text-xs px-4">CANCEL</button>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (!bytes) return "";
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function inferReasoning(modelId: string): boolean {
  const name = modelId.toLowerCase();
  return /deepseek.*r1|qwq|qwen.*think|qwen3[._-]?[5]|qwen3-|openthinker|deepscaler|marco-o1|glm[-_]?[45]|glm.*think|o1(?=[-_]|$)|o3(?=[-_]|$)|o4(?=[-_]|mini|$)|claude.*3[._-]?5.*sonnet|claude.*4|gemini.*2[._-]?5|gemini.*think|reason/i.test(name);
}