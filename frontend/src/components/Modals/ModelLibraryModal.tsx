import { useState, useEffect, useCallback } from "react";
import {
  X, Wifi, Plus, Trash2, Star, Check, RefreshCw,
  Edit2, Key, Power, Settings, TestTube2, Eye, EyeOff,
} from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
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
      <ModalDialog id="model-library-loading" onClose={onClose}>
        <span className="text-hacker-accent animate-pulse">Loading...</span>
      </ModalDialog>
    );
  }

  return (
    <ModalDialog id="model-library" onClose={onClose}>
      <div className="max-h-[90vh] flex flex-col">
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
    </ModalDialog>
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
                <span className="text-hacker-text-dim text-[11px] ml-2">{p.type}</span>
              </div>
              <span className={`text-[11px] px-1.5 py-0.5 border ${
                p.connectionStatus === "ok" ? "border-hacker-accent/50 text-hacker-accent" :
                p.connectionStatus === "error" ? "border-hacker-error/50 text-hacker-error" :
                "border-hacker-border text-hacker-text-dim"
              }`}>
                {p.connectionStatus === "ok" ? "✓ CONNECTED" : p.connectionStatus === "error" ? "✗ ERROR" : "? UNTESTED"}
              </span>
              <button onClick={() => handleTest(p.id)}
                className="btn-hacker text-[11px] px-2 py-0.5 flex items-center gap-1">
                <TestTube2 size={10} /> TEST
              </button>
              <button onClick={() => setEditing(p)}
                className="text-hacker-text-dim hover:text-hacker-accent"><Edit2 size={11} /></button>
              <button onClick={() => handleDelete(p.id)}
                className="text-hacker-text-dim hover:text-hacker-error"><Trash2 size={11} /></button>
            </div>
            {p.baseUrl && <div className="px-3 pb-1.5 text-[11px] text-hacker-text-dim truncate">{p.baseUrl}</div>}
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
      <div className="text-hacker-accent text-[11px] tracking-widest mb-2">
        {isEdit ? "EDIT" : "ADD"} PROVIDER
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="text-hacker-accent text-[11px] block mb-1">TYPE</label>
          <select value={type} onChange={e => handleTypeChange(e.target.value as ProviderType)}
            className="select-hacker w-full text-xs" disabled={isEdit}>
            {Object.entries(PROVIDER_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>{v.description}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-hacker-accent text-[11px] block mb-1">NAME</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="input-hacker w-full text-xs" placeholder="My Provider" />
        </div>
      </div>

      <div className="mb-2">
        <label className="text-hacker-accent text-[11px] flex items-center gap-1 mb-1">
          <Wifi size={10} /> BASE URL
        </label>
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
          className="input-hacker w-full text-xs" placeholder={PROVIDER_PRESETS[type].defaultBaseUrl} />
      </div>

      {PROVIDER_PRESETS[type].requiresApiKey && (
        <div className="mb-2">
          <label className="text-hacker-accent text-[11px] flex items-center gap-1 mb-1">
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

// ── Models Tab (two-column selector) ───────────────────────

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
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [selectedAvailable, setSelectedAvailable] = useState<Set<string>>(new Set());
  const [selectedConfigured, setSelectedConfigured] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  // Provider filters: separate for Available and Selected columns
  const [providerFilterAvailable, setProviderFilterAvailable] = useState<Set<string>>(() => new Set(providers.map(p => p.id)));
  const [providerFilterSelected, setProviderFilterSelected] = useState<Set<string>>(() => new Set(providers.map(p => p.id)));

  // Sync filters when providers change
  useEffect(() => {
    setProviderFilterAvailable(prev => {
      const next = new Set<string>();
      for (const p of providers) {
        if (prev.has(p.id)) next.add(p.id);
      }
      return next;
    });
    setProviderFilterSelected(prev => {
      const next = new Set<string>();
      for (const p of providers) {
        if (prev.has(p.id)) next.add(p.id);
      }
      return next;
    });
  }, [providers]);

  // All discovered models across all providers (cached)
  const [allDiscovered, setAllDiscovered] = useState<DiscoveredModel[]>(() => {
    // Initialize from providers' cached discoveredModels
    const cache: DiscoveredModel[] = [];
    for (const p of providers) {
      if (p.discoveredModels) {
        for (const dm of p.discoveredModels) {
          cache.push({ ...dm, _providerId: p.id } as any);
        }
      }
    }
    return cache;
  });

  // Available = discovered models that are NOT in the library AND match provider filter (Available)
  const configuredIds = new Set(library.models.map(m => m.modelId));
  const filteredAvailable = allDiscovered
    .filter(dm => !configuredIds.has(dm.id))
    .filter(dm => {
      const provId = (dm as any)._providerId as string | undefined;
      if (!provId) return true;
      return providerFilterAvailable.has(provId);
    })
    .filter(dm => !modelFilter || (dm.name || dm.id).toLowerCase().includes(modelFilter.toLowerCase()))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  const filteredConfigured = library.models
    .filter(m => providerFilterSelected.has(m.providerId) || !providers.find(p => p.id === m.providerId))
    .filter(m => !modelFilter || (m.name || m.modelId).toLowerCase().includes(modelFilter.toLowerCase()))
    .sort((a, b) => (a.name || a.modelId).localeCompare(b.name || b.modelId));

  const getProviderName = (providerId: string) => {
    const p = providers.find(p => p.id === providerId);
    return p?.name || p?.type || providerId;
  };

  const getProviderNameForDiscovered = (dm: DiscoveredModel) => {
    const provId = (dm as any)._providerId;
    return provId ? getProviderName(provId) : "";
  };

  // Scan all providers
  const handleScanAll = async () => {
    setScanning(true);
    setError("");
    try {
      const newDiscovered: DiscoveredModel[] = [];
      for (const p of providers) {
        try {
          const res = await fetch(`/api/providers/${p.id}/test`, { method: "POST" });
          const data = await res.json();
          if (data.ok && data.models) {
            for (const m of data.models) {
              newDiscovered.push({ ...m, _providerId: p.id } as any);
            }
          }
        } catch (e: any) {
          console.warn(`[scan] Provider ${p.name} failed:`, e.message);
        }
      }
      setAllDiscovered(newDiscovered);
      // Refresh providers (to cache discovered models)
      const refreshRes = await fetch("/api/providers");
      if (refreshRes.ok) {
        // Optionally update parent state but not critical
      }
      setStatus(`✓ Scanned ${providers.length} provider(s), found ${newDiscovered.length} model(s)`);
    } catch (e: any) { setError(e.message); }
    finally { setScanning(false); }
  };

  // Move selected available → configured
  const handleAddSelected = async () => {
    if (selectedAvailable.size === 0) return;
    const models: Omit<RegisteredModel, "id">[] = [];
    for (const modelId of selectedAvailable) {
      const dm = allDiscovered.find(m => m.id === modelId);
      const provId = (dm as any)?._providerId || "unknown";
      models.push({
        providerId: provId,
        modelId,
        name: dm?.name || modelId,
        isDefault: false,
        reasoning: inferReasoning(modelId),
        vision: inferVision(modelId),
        contextWindow: 128000,
        maxTokens: 16384,
        thinkingLevel: "medium",
      });
    }
    await onAdd(models);
    setSelectedAvailable(new Set());
  };

  // Move selected configured → remove
  const handleRemoveSelected = async () => {
    if (selectedConfigured.size === 0) return;
    for (const id of selectedConfigured) {
      await onRemove(id);
    }
    setSelectedConfigured(new Set());
  };

  const toggleAvailable = (id: string) => {
    const next = new Set(selectedAvailable);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedAvailable(next);
  };

  const toggleConfigured = (id: string) => {
    const next = new Set(selectedConfigured);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedConfigured(next);
  };

  const isOllamaProvider = (provId: string) => {
    return providers.find(p => p.id === provId)?.type === "ollama";
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Model filter */}
      <div className="flex items-center gap-2 mb-1">
        <input
          type="text"
          value={modelFilter}
          onChange={e => setModelFilter(e.target.value)}
          placeholder="Filter models by name..."
          className="flex-1 bg-hacker-bg border border-hacker-border px-2 py-1 text-[11px] text-hacker-text-bright focus:outline-none focus:border-hacker-accent"
        />
        {modelFilter && (
          <button onClick={() => setModelFilter("")} className="text-hacker-text-dim hover:text-hacker-accent">
            <X size={12} />
          </button>
        )}
      </div>

      {/* Provider filter checkboxes */}
      {providers.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-1 px-1">
          {providers.map(p => {
            const checked = providerFilterAvailable.has(p.id);
            const count = allDiscovered.filter(dm => (dm as any)._providerId === p.id).length;
            return (
              <label key={p.id} className="flex items-center gap-1 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setProviderFilterAvailable(prev => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                      return next;
                    });
                  }}
                  className="accent-[var(--accent)] w-3 h-3"
                />
                <span className={`text-[11px] ${checked ? "text-hacker-text-bright" : "text-hacker-text-dim"} group-hover:text-hacker-accent`}>
                  {p.name || p.type}
                </span>
                {count > 0 && <span className="text-[10px] text-hacker-text-dim">({count})</span>}
              </label>
            );
          })}
        </div>
      )}

      {/* Three-column layout: available | actions | selected */}
      <div className="flex gap-1 min-h-[300px]">
        {/* Left column: Available models */}
        <div className="flex-1 border border-hacker-border bg-hacker-surface/50 flex flex-col min-w-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hacker-border bg-hacker-bg/50">
            <span className="text-hacker-accent text-[11px] font-bold tracking-wider flex-1">AVAILABLE</span>
            <span className="text-hacker-text-dim text-[11px]">{filteredAvailable.length}</span>
            <button onClick={handleScanAll} disabled={scanning}
              className="btn-hacker text-[11px] px-1.5 py-0.5 flex items-center gap-0.5" title="Rescan all providers">
              <RefreshCw size={9} className={scanning ? "animate-spin" : ""} /> UPDATE
            </button>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[400px]">
            {filteredAvailable.length === 0 ? (
              <div className="text-hacker-text-dim text-[11px] italic p-3 text-center">
                {allDiscovered.length === 0 ? "Click UPDATE to scan providers" : modelFilter ? "No matches" : "All models already added"}
              </div>
            ) : (
              filteredAvailable.map(dm => {
                const isSelected = selectedAvailable.has(dm.id);
                const provName = getProviderNameForDiscovered(dm);
                return (
                  <button key={dm.id} onClick={() => toggleAvailable(dm.id)}
                    className={`w-full text-left px-3 py-1 text-[11px] flex items-center gap-1.5 border-b border-hacker-border/50 last:border-0 ${
                      isSelected ? "bg-hacker-accent/10 text-hacker-accent" : "text-hacker-text-dim hover:bg-hacker-border/30"
                    }`}>
                    <span className="text-[11px]">{isSelected ? "☑" : "☐"}</span>
                    <span className="truncate flex-1">{dm.name || dm.id}</span>
                    {provName && <span className="text-[11px] text-hacker-text-dim">({provName})</span>}
                    {dm.size ? <span className="text-[11px] text-hacker-text-dim shrink-0">{formatSize(dm.size)}</span> : null}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Middle: Action buttons */}
        <div className="flex flex-col justify-center gap-1 px-0.5">
          <button onClick={handleAddSelected} disabled={selectedAvailable.size === 0}
            className="btn-hacker text-[11px] px-1.5 py-1.5 flex items-center justify-center gap-0.5 disabled:opacity-30"
            title="Add selected models">
            ▶
          </button>
          <button onClick={handleRemoveSelected} disabled={selectedConfigured.size === 0}
            className="btn-hacker text-[11px] px-1.5 py-1.5 flex items-center justify-center gap-0.5 disabled:opacity-30"
            title="Remove selected models">
            ◀
          </button>
        </div>

        {/* Right column: Configured models */}
        <div className="flex-1 border border-hacker-border bg-hacker-surface/50 flex flex-col min-w-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hacker-border bg-hacker-bg/50">
            <span className="text-hacker-accent text-[11px] font-bold tracking-wider flex-1">SELECTED</span>
            <span className="text-hacker-text-dim text-[11px]">{filteredConfigured.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[400px]">
            {filteredConfigured.length === 0 ? (
              <div className="text-hacker-text-dim text-[11px] italic p-3 text-center">
                {library.models.length === 0 ? "No models selected yet" : "No matches"}
              </div>
            ) : (
              filteredConfigured.map(m => {
                const isSelected = selectedConfigured.has(m.id);
                const isDef = m.id === library.defaultModelId;
                
                return (
                  <div key={m.id}>
                    <button onClick={() => toggleConfigured(m.id)}
                      className={`w-full text-left px-3 py-1 text-[11px] flex items-center gap-1.5 border-b border-hacker-border/50 last:border-0 ${
                        isSelected ? "bg-hacker-error/10 text-hacker-error" : isDef ? "bg-hacker-accent/5" : "hover:bg-hacker-border/30"
                      }`}>
                      <span className="text-[11px]">{isSelected ? "☑" : "☐"}</span>
                      <Star size={10} className={isDef ? "text-hacker-accent fill-hacker-accent shrink-0" : "text-hacker-text-dim/30 shrink-0"}
                        onClick={(e) => { e.stopPropagation(); onSetDefault(m.id); }} />
                      <span className={`truncate flex-1 ${isDef ? "text-hacker-accent font-bold" : ""}`}>{m.name}</span>
                      <span className="text-[11px] text-hacker-text-dim">({getProviderName(m.providerId)})</span>
                      <button onClick={(e) => { e.stopPropagation(); setEditingModelId(m.id); }}
                        className="text-hacker-text-dim hover:text-hacker-accent shrink-0"><Settings size={10} /></button>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Set default hint */}
      {library.models.length > 0 && (
        <div className="text-hacker-text-dim text-[11px] text-center">
          ★ = default model · Click ⚙ to edit parameters
        </div>
      )}

      {/* Model Edit Modal */}
      {editingModelId && (() => {
        const editModel = library.models.find(m => m.id === editingModelId);
        if (!editModel) return null;
        return (
          <ModelEditModal
            model={editModel}
            onUpdate={onUpdate}
            isOllama={isOllamaProvider(editModel.providerId)}
            onClose={() => setEditingModelId(null)}
          />
        );
      })()}
    </div>
  );
}
// ── Model Edit Modal (inference params) ────────────────────

function ModelEditModal({ model, onUpdate, isOllama, onClose }: {
  model: RegisteredModel;
  onUpdate: (id: string, updates: Partial<RegisteredModel>) => void;
  isOllama: boolean;
  onClose: () => void;
}) {
  // Local state for context window input (in K) — synced with model prop
  const [contextK, setContextK] = useState<string>(String(Math.round(model.contextWindow / 1024)));
  const [contextCustom, setContextCustom] = useState(false);

  // Sync contextK when model prop changes (after API update)
  useEffect(() => {
    setContextK(String(Math.round(model.contextWindow / 1024)));
  }, [model.contextWindow]);

  const CONTEXT_PRESETS = [4, 8, 16, 32, 64, 128, 200, 256, 500, 1000];

  const applyContext = (k: string) => {
    const num = parseInt(k, 10);
    if (!isNaN(num) && num > 0) {
      onUpdate(model.id, { contextWindow: num * 1024 });
    }
  };

  return (
    <ModalDialog id="model-edit" onClose={onClose}>
      <div className="max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <span className="text-hacker-accent font-bold text-sm tracking-wider">⚡ EDIT MODEL</span>
            <div className="text-hacker-text text-sm font-bold mt-0.5">{model.name}</div>
          </div>
          <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-text"><X size={16} /></button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {/* Temperature + Top P */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">Temperature</label>
              <input type="number" value={model.temperature ?? ""} min={0} max={2} step={0.1}
                onChange={e => onUpdate(model.id, { temperature: e.target.value ? Number(e.target.value) : undefined })}
                className="input-hacker w-full text-sm py-1.5 px-2" placeholder="auto" />
              <div className="text-hacker-text-dim text-[10px] mt-0.5">0.0 – 2.0 (lower = more deterministic)</div>
            </div>
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">Top P</label>
              <input type="number" value={model.topP ?? ""} min={0} max={1} step={0.05}
                onChange={e => onUpdate(model.id, { topP: e.target.value ? Number(e.target.value) : undefined })}
                className="input-hacker w-full text-sm py-1.5 px-2" placeholder="auto" />
              <div className="text-hacker-text-dim text-[10px] mt-0.5">0.0 – 1.0 (nucleus sampling)</div>
            </div>
          </div>

          {/* Ollama-specific params */}
          {isOllama && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-hacker-text-dim text-xs block mb-1">Min P</label>
                <input type="number" value={model.minP ?? ""} min={0} max={1} step={0.05}
                  onChange={e => onUpdate(model.id, { minP: e.target.value ? Number(e.target.value) : undefined })}
                  className="input-hacker w-full text-sm py-1.5 px-2" placeholder="auto" />
              </div>
              <div>
                <label className="text-hacker-text-dim text-xs block mb-1">Top K</label>
                <input type="number" value={model.topK ?? ""} min={1} max={100} step={1}
                  onChange={e => onUpdate(model.id, { topK: e.target.value ? Number(e.target.value) : undefined })}
                  className="input-hacker w-full text-sm py-1.5 px-2" placeholder="auto" />
              </div>
              <div>
                <label className="text-hacker-text-dim text-xs block mb-1">Repeat Penalty</label>
                <input type="number" value={model.repeatPenalty ?? ""} min={1} max={2} step={0.1}
                  onChange={e => onUpdate(model.id, { repeatPenalty: e.target.value ? Number(e.target.value) : undefined })}
                  className="input-hacker w-full text-sm py-1.5 px-2" placeholder="1.1" />
              </div>
            </div>
          )}

          {/* Max Tokens full width */}
          <div>
            <label className="text-hacker-text-dim text-xs block mb-1">Max Tokens</label>
            <input type="number" value={model.maxTokens ?? 16384} min={1} step={1024}
              onChange={e => onUpdate(model.id, { maxTokens: Number(e.target.value) })}
              className="input-hacker w-full text-sm py-1.5 px-2" />
            <div className="text-hacker-text-dim text-[10px] mt-0.5">Maximum output tokens per response</div>
          </div>

          {/* Context Window + Reasoning + Thinking Level */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-3">
              <label className="text-hacker-text-dim text-xs block mb-1">Context Window (tokens)</label>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={contextCustom ? contextK : Math.round(model.contextWindow / 1024)}
                  onChange={e => {
                    setContextK(e.target.value);
                    setContextCustom(true);
                    applyContext(e.target.value);
                  }}
                  onBlur={() => {
                    // Finalize on blur
                    applyContext(contextK);
                    setContextCustom(false);
                  }}
                  min={1}
                  step={1}
                  className="input-hacker w-24 text-sm py-1.5 px-2 text-center"
                />
                <span className="text-hacker-text-dim text-xs shrink-0">K tokens</span>
                <div className="flex gap-1 flex-wrap">
                  {CONTEXT_PRESETS.map(preset => (
                    <button key={preset}
                      onClick={() => {
                        setContextK(String(preset));
                        setContextCustom(false);
                        applyContext(String(preset));
                      }}
                      className={`px-1.5 py-0.5 text-[11px] border transition-colors ${
                        Math.round(model.contextWindow / 1024) === preset
                          ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                          : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50 hover:text-hacker-text"
                      }`}>
                      {preset >= 1000 ? `${preset / 1000}M` : `${preset}K`}
                    </button>
                  ))}
                </div>
              </div>
              <div className="text-hacker-text-dim text-[10px] mt-1">Type a custom value or click a preset. Current: {model.contextWindow.toLocaleString()} tokens</div>
            </div>
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">Reasoning Model</label>
              <select value={model.reasoning ? "yes" : "no"} onChange={e => onUpdate(model.id, { reasoning: e.target.value === "yes" })}
                className="select-hacker w-full text-sm py-1.5 px-2">
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
              <div className="text-hacker-text-dim text-[10px] mt-0.5">Has native chain-of-thought</div>
            </div>
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">Vision Model</label>
              <select value={model.vision ? "yes" : "no"} onChange={e => onUpdate(model.id, { vision: e.target.value === "yes" })}
                className="select-hacker w-full text-sm py-1.5 px-2">
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
              <div className="text-hacker-text-dim text-[10px] mt-0.5">Supports image/vision input</div>
            </div>
            <div>
              <label className="text-hacker-text-dim text-xs block mb-1">Thinking Level</label>
              <select value={model.thinkingLevel} onChange={e => onUpdate(model.id, { thinkingLevel: e.target.value })}
                className="select-hacker w-full text-sm py-1.5 px-2">
                {THINKING_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <div className="text-hacker-text-dim text-[10px] mt-0.5">Reasoning depth (if supported)</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 mt-4 pt-3 border-t border-hacker-border">
          <button onClick={() => {
            onUpdate(model.id, {
              reasoning: inferReasoning(model.modelId || model.name),
              vision: inferVision(model.modelId || model.name),
              contextWindow: 128000,
              maxTokens: 16384,
              thinkingLevel: "medium",
            });
          }}
            className="btn-hacker text-sm px-3 py-2 flex items-center justify-center gap-1.5 text-hacker-text-dim"
            title="Reset to auto-detected defaults">
            ↺ RESET
          </button>
          <div className="flex-1" />
          <button onClick={onClose}
            className="btn-hacker flex-1 text-sm py-2 flex items-center justify-center gap-1.5">
            <Check size={14} /> DONE
          </button>
        </div>
      </div>
    </ModalDialog>
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
  return /deepseek.*r1|qwq|qwen.*think|qwen3[._-]?[5]|qwen3-|openthinker|deepscaler|marco-o1|glm[-_]?[45]|glm.*think|o1(?=[-_]|$)|o3(?=[-_]|$)|o4(?=[-_]|mini|$)|claude.*3[._-]?5.*sonnet|claude.*4|gemini.*2[._-]?5|gemini.*think|kimi|reason/i.test(name);
}

function inferVision(modelId: string): boolean {
  const name = modelId.toLowerCase();
  return /llava|gemma[-_.]?3|minicpm-v|qwen.*vl|qwen.*vision|pixtral|llama.*vision|llama3[._-]?2[._-]?9|phi[-_.]?3[._-]?5|internvl|idefics|cogvlm|molmo|glm.*4v|gpt[-_.]?4[-_.]?o|gpt[-_.]?4[-_.]?vision|gpt[-_.]?4o|vision|kimi|multimodal/i.test(name);
}

function inferContextWindow(modelId: string): number {
  const key = modelId.toLowerCase().replace(/[:_]/g, "-");
  const overrides: Record<string, number> = {
    "kimi-k2.6": 256000,
    "kimi-k2.5": 256000,
    "kimi-k2.0": 200000,
    "kimi-k1.5": 256000,
    "deepseek-r1": 128000,
    "deepseek-v3": 128000,
    "qwq": 128000,
    "qwq-32b": 128000,
    "qwen3.5": 128000,
    "qwen3": 128000,
    "qwen2.5": 128000,
    "qwen2": 128000,
    "llama3.3": 128000,
    "llama3.2": 128000,
    "llama3.1": 128000,
    "llama3": 128000,
    "mistral": 128000,
    "mixtral": 64000,
    "gemma3": 128000,
    "gemma2": 128000,
    "command-r": 128000,
    "aya": 256000,
    "phi3": 128000,
    "phi4": 128000,
    "granite3": 128000,
    "codestral": 32000,
    "nemotron": 128000,
    "llava": 4096,
    "bakllava": 4096,
    "moondream": 8192,
  };
  if (overrides[key] !== undefined) return overrides[key];
  for (const [prefix, ctx] of Object.entries(overrides)) {
    if (key.startsWith(prefix + "-")) return ctx;
  }
  if (key.includes("kimi")) return 256000;
  if (key.includes("deepseek-r1")) return 128000;
  if (key.includes("deepseek-v3")) return 128000;
  if (key.includes("qwq")) return 128000;
  if (key.includes("qwen3")) return 128000;
  if (key.includes("qwen2.5")) return 128000;
  if (key.includes("qwen2")) return 128000;
  if (key.includes("llama3")) return 128000;
  if (key.includes("mistral")) return 128000;
  if (key.includes("mixtral")) return 64000;
  if (key.includes("gemma3")) return 128000;
  if (key.includes("gemma2")) return 128000;
  if (key.includes("gemma")) return 8192;
  if (key.includes("command-r")) return 128000;
  if (key.includes("aya")) return 256000;
  if (key.includes("phi3") || key.includes("phi-3")) return 128000;
  if (key.includes("phi4") || key.includes("phi-4")) return 128000;
  if (key.includes("granite3")) return 128000;
  if (key.includes("codestral")) return 32000;
  if (key.includes("codellama")) return 16384;
  if (key.includes("llava")) return 4096;
  if (key.includes("bakllava")) return 4096;
  if (key.includes("moondream")) return 8192;
  if (key.includes("minicpm")) return 128000;
  if (key.includes("embed")) return 8192;
  return 128000;
}