import { useState, useEffect, useCallback } from "react";
import {
  X, Package, Puzzle, Lightbulb, Palette, Plus, Trash2,
  ToggleLeft, ToggleRight, RefreshCw, Key, Eye, EyeOff, Shield,
} from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import { ProvidersTab, ModelsTab } from "./ModelLibraryModal";
import { loadLayoutConfig, saveLayoutConfig } from "../Layout/LayoutRenderer";
import type { ModelLibrary, RegisteredModel, ProviderConfig, DiscoveredModel, LayoutType, PanelId, LayoutConfig } from "../../types";

// ── Types ──────────────────────────────────────────────

interface PackageInfo {
  source: string;
  scope: "user" | "project";
  installed: boolean;
  installedPath?: string;
  type?: "npm" | "git" | "local";
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

interface AvailableResources {
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

type ResourceType = "extensions" | "skills" | "prompts" | "themes";

const RESOURCE_ICONS: Record<ResourceType, typeof Package> = {
  extensions: Puzzle,
  skills: Lightbulb,
  prompts: Package,
  themes: Palette,
};

const RESOURCE_LABELS: Record<ResourceType, string> = {
  extensions: "Extensions",
  skills: "Skills",
  prompts: "Prompts",
  themes: "Themes",
};

type TabId = "models" | "extensions" | "general" | "layout";

// ── Props ──────────────────────────────────────────────

interface Props {
  onClose: () => void;
  session: any;
  onModelApplied?: () => void;
}

// ── Main Component ─────────────────────────────────────

export function SettingsModal({ onClose, session, onModelApplied }: Props) {
  const [tab, setTab] = useState<TabId>("models");

  // ── Model Library state ──
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

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

  // ── Extensions state ──
  const [pkgList, setPkgList] = useState<PackageInfo[]>([]);
  const [available, setAvailable] = useState<AvailableResources>({ extensions: [], skills: [], prompts: [], themes: [] });
  const [piSettings, setPiSettings] = useState<Record<string, any>>({});
  const [newSource, setNewSource] = useState("");
  const [extError, setExtError] = useState<string | null>(null);

  const loadExtData = useCallback(async () => {
    setLoading(true);
    setExtError(null);
    try {
      const [pkgRes, availRes, settingsRes] = await Promise.all([
        fetch("/api/pi/packages"),
        fetch("/api/pi/available"),
        fetch("/api/pi"),
      ]);
      if (pkgRes.ok) setPkgList(await pkgRes.json());
      if (availRes.ok) setAvailable(await availRes.json());
      if (settingsRes.ok) setPiSettings(await settingsRes.json());
    } catch (e: any) {
      setExtError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "extensions") loadExtData();
  }, [tab, loadExtData]);

  const addPackage = async () => {
    if (!newSource.trim()) return;
    setLoading(true);
    setExtError(null);
    try {
      const res = await fetch("/api/pi/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: newSource.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add package");
      }
      const data = await res.json();
      setPkgList(data.packages || []);
      setNewSource("");
    } catch (e: any) {
      setExtError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const removePackage = async (source: string) => {
    setLoading(true);
    setExtError(null);
    try {
      const res = await fetch(`/api/pi/packages/${encodeURIComponent(source)}`, { method: "DELETE" });
      if (res.ok) {
        const data = await res.json();
        setPkgList(data.packages || []);
      }
    } catch (e: any) {
      setExtError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleResource = async (type: ResourceType, source: string, enabled: boolean) => {
    setLoading(true);
    setExtError(null);
    try {
      const res = await fetch("/api/pi/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, source, enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setPiSettings((prev: any) => ({ ...prev, [type]: data[type] }));
      }
    } catch (e: any) {
      setExtError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const currentExtensions: string[] = piSettings.extensions || [];
  const currentSkills: string[] = piSettings.skills || [];
  const currentPrompts: string[] = piSettings.prompts || [];
  const currentThemes: string[] = piSettings.themes || [];

  // ── General parameters state ──
  const [authUser, setAuthUser] = useState(() => localStorage.getItem("pi-web-auth-user") || "");
  const [authPass, setAuthPass] = useState(() => localStorage.getItem("pi-web-auth-pass") || "");
  const [showPass, setShowPass] = useState(false);
  const [authSaved, setAuthSaved] = useState(false);

  const saveAuth = () => {
    if (authUser) {
      localStorage.setItem("pi-web-auth-user", authUser);
      localStorage.setItem("pi-web-auth-pass", authPass);
    } else {
      localStorage.removeItem("pi-web-auth-user");
      localStorage.removeItem("pi-web-auth-pass");
    }
    setAuthSaved(true);
    setTimeout(() => setAuthSaved(false), 2000);
  };

  // ── Tabs ──
  const TABS: { id: TabId; icon: string; label: string }[] = [
    { id: "models", icon: "⚡", label: "Model Library" },
    { id: "extensions", icon: "📦", label: "Extensions & Skills" },
    { id: "general", icon: "⚙", label: "General Parameters" },
    { id: "layout", icon: "⊞", label: "Layout" },
  ];

  // Sub-tab state for Model Library (persists across main tab switches)
  const [modelSubTab, setModelSubTab] = useState<"providers" | "models">("providers");
  const [extSubTab, setExtSubTab] = useState<"packages" | "resources">("packages");

  return (
    <ModalDialog id="settings" onClose={onClose}>
      <div className="w-full h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-hacker-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-hacker-accent text-sm font-bold tracking-wider">⚡ SETTINGS</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-error">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-hacker-border shrink-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-xs font-bold tracking-wider transition-colors ${
                tab === t.id
                  ? "text-hacker-accent border-b-2 border-hacker-accent bg-hacker-accent/5"
                  : "text-hacker-text-dim hover:text-hacker-text-bright"
              }`}
            >
              <span className="mr-1.5">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {/* Status/Error */}
        {status && (
          <div className="mx-3 mt-2 px-3 py-1.5 text-hacker-accent text-xs border border-hacker-accent/30 bg-hacker-accent/5">
            {status}
          </div>
        )}
        {(error || extError) && (
          <div className="mx-3 mt-2 px-3 py-2 bg-hacker-error/10 text-hacker-error text-xs">
            {error || extError}
            <button onClick={() => { setError(""); setExtError(null); }} className="ml-2 text-hacker-text-dim hover:text-hacker-error">✕</button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {/* Model Library Tab */}
          {tab === "models" && library && (
            <div className="p-3">
              <div className="flex gap-1 mb-3 border-b border-hacker-border pb-1">
                {(["providers", "models"] as const).map(st => (
                  <button key={st} onClick={() => setModelSubTab(st)}
                    className={`px-3 py-1.5 text-xs border-b-2 transition-colors ${
                      modelSubTab === st
                        ? "border-hacker-accent text-hacker-accent"
                        : "border-transparent text-hacker-text-dim hover:text-hacker-text"
                    }`}>
                    {st === "providers" ? "🏢 PROVIDERS" : "🤖 MODELS"}
                  </button>
                ))}
              </div>
              {modelSubTab === "providers" ? (
                <ProvidersTab providers={providers} setProviders={setProviders} setError={setError} />
              ) : (
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
          )}

          {/* Extensions & Skills Tab */}
          {tab === "extensions" && (
            <div className="p-3">
              <div className="flex gap-1 mb-3 border-b border-hacker-border pb-1">
                {(["packages", "resources"] as const).map(st => (
                  <button key={st} onClick={() => setExtSubTab(st)}
                    className={`px-3 py-1.5 text-xs border-b-2 transition-colors ${
                      extSubTab === st
                        ? "border-hacker-accent text-hacker-accent"
                        : "border-transparent text-hacker-text-dim hover:text-hacker-text"
                    }`}>
                    {st === "packages" ? "PACKAGES" : "RESOURCES"}
                  </button>
                ))}
              </div>

              {extSubTab === "packages" ? (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newSource}
                      onChange={e => setNewSource(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && addPackage()}
                      placeholder="npm package or git URL (e.g. @pi/extension-memory)"
                      className="flex-1 bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                    />
                    <button
                      onClick={addPackage}
                      disabled={loading || !newSource.trim()}
                      className="btn-hacker text-xs px-3 py-1.5 flex items-center gap-1 shrink-0"
                    >
                      <Plus size={12} /> ADD
                    </button>
                  </div>

                  {pkgList.length === 0 ? (
                    <div className="text-hacker-text-dim text-xs text-center py-8">
                      No packages installed yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {pkgList.map(pkg => (
                        <div key={pkg.source} className="flex items-center gap-2 bg-hacker-bg/50 border border-hacker-border rounded px-3 py-2">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${pkg.installed ? "bg-hacker-accent" : "bg-hacker-error"}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-hacker-text-bright truncate font-mono">{pkg.source}</div>
                            <div className="text-[10px] text-hacker-text-dim flex items-center gap-2">
                              <span className="uppercase">{pkg.type || "unknown"}</span>
                              {pkg.scope === "project" && <span className="text-hacker-warn">project</span>}
                            </div>
                          </div>
                          <button onClick={() => removePackage(pkg.source)}
                            className="text-hacker-text-dim hover:text-hacker-error shrink-0" title="Remove">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <ResourceSection type="extensions" items={currentExtensions} available={available.extensions} onToggle={toggleResource} onAdd={s => toggleResource("extensions", s, true)} disabled={loading} />
                  <ResourceSection type="skills" items={currentSkills} available={available.skills} onToggle={toggleResource} onAdd={s => toggleResource("skills", s, true)} disabled={loading} />
                  <ResourceSection type="prompts" items={currentPrompts} available={available.prompts || []} onToggle={toggleResource} onAdd={s => toggleResource("prompts", s, true)} disabled={loading} />
                  <ResourceSection type="themes" items={currentThemes} available={available.themes} onToggle={toggleResource} onAdd={s => toggleResource("themes", s, true)} disabled={loading} />

                  <div className="pt-2 border-t border-hacker-border">
                    <div className="text-xs text-hacker-text-dim mb-2">Add a resource path manually:</div>
                    <div className="flex gap-2">
                      <select id="resource-type-select" className="bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-2 py-1 rounded">
                        <option value="extensions">Extension</option>
                        <option value="skills">Skill</option>
                        <option value="prompts">Prompt</option>
                        <option value="themes">Theme</option>
                      </select>
                      <input type="text" id="resource-path-input" placeholder="./path/to/resource"
                        className="flex-1 bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1 rounded focus:border-hacker-accent outline-none" />
                      <button onClick={() => {
                        const type = (document.getElementById("resource-type-select") as HTMLSelectElement).value as ResourceType;
                        const path = (document.getElementById("resource-path-input") as HTMLInputElement).value.trim();
                        if (path) toggleResource(type, path, true);
                      }} disabled={loading} className="btn-hacker text-xs px-3 py-1 flex items-center gap-1">
                        <Plus size={12} /> ADD
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-3 pt-2 border-t border-hacker-border text-[10px] text-hacker-text-dim flex items-center gap-3">
                <span>Config: <code className="text-hacker-accent">~/.pi/agent/settings.json</code></span>
              </div>
            </div>
          )}

          {/* General Parameters Tab */}
          {tab === "general" && (
            <div className="p-3 space-y-4">
              {/* Auth Section */}
              <div className="border border-hacker-border bg-hacker-surface/50">
                <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50 flex items-center gap-2">
                  <Shield size={14} className="text-hacker-accent" />
                  <span className="text-xs font-bold text-hacker-accent tracking-wider">WEB INTERFACE AUTHENTICATION</span>
                </div>
                <div className="p-3 space-y-3">
                  <p className="text-[11px] text-hacker-text-dim">
                    Set credentials to protect the web interface with HTTP Basic Authentication.
                    Leave empty to disable authentication.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-hacker-text-dim text-xs block mb-1">Username</label>
                      <input
                        type="text"
                        value={authUser}
                        onChange={e => setAuthUser(e.target.value)}
                        placeholder="admin"
                        className="input-hacker w-full text-xs py-1.5 px-2"
                      />
                    </div>
                    <div>
                      <label className="text-hacker-text-dim text-xs block mb-1">Password</label>
                      <div className="flex gap-1">
                        <input
                          type={showPass ? "text" : "password"}
                          value={authPass}
                          onChange={e => setAuthPass(e.target.value)}
                          placeholder="••••••••"
                          className="input-hacker flex-1 text-xs py-1.5 px-2"
                        />
                        <button onClick={() => setShowPass(!showPass)}
                          className="btn-hacker text-xs px-2">
                          {showPass ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      </div>
                    </div>
                  </div>
                  <button onClick={saveAuth}
                    className={`btn-hacker text-xs px-4 py-1.5 ${authSaved ? "text-hacker-accent border-hacker-accent" : ""}`}>
                    {authSaved ? "✓ SAVED" : "SAVE CREDENTIALS"}
                  </button>
                </div>
              </div>

              {/* Placeholder for future options */}
              <div className="text-[11px] text-hacker-text-dim text-center py-4 border border-hacker-border/30 border-dashed">
                Additional parameters will be added here as needed.
              </div>
            </div>
          )}

          {/* Layout Tab */}
          {tab === "layout" && (
            <LayoutTab onLayoutChange={() => {}} />
          )}
        </div>
      </div>
    </ModalDialog>
  );
}

// ── Resource section ────────────────────────────────────

interface ResourceSectionProps {
  type: ResourceType;
  items: string[];
  available: string[];
  onToggle: (type: ResourceType, source: string, enabled: boolean) => void;
  onAdd: (source: string) => void;
  disabled: boolean;
}

function ResourceSection({ type, items, available, onToggle, onAdd, disabled }: ResourceSectionProps) {
  const Icon = RESOURCE_ICONS[type];
  const label = RESOURCE_LABELS[type];

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} className="text-hacker-accent" />
        <span className="text-xs text-hacker-text-bright font-bold tracking-wider">{label}</span>
        <span className="text-[10px] text-hacker-text-dim">({items.length})</span>
      </div>

      {items.length === 0 && available.length === 0 ? (
        <div className="text-[10px] text-hacker-text-dim pl-4 py-1">No {label.toLowerCase()} configured</div>
      ) : (
        <div className="space-y-1 pl-1">
          {items.map(source => (
            <div key={source} className="flex items-center gap-2 py-1">
              <button onClick={() => onToggle(type, source, false)} disabled={disabled}
                className="text-hacker-accent hover:text-hacker-error shrink-0" title="Disable">
                <ToggleRight size={14} />
              </button>
              <span className="text-xs text-hacker-text-bright font-mono truncate flex-1">{source}</span>
            </div>
          ))}
          {available.filter(a => !items.includes(a)).map(source => (
            <div key={source} className="flex items-center gap-2 py-1 opacity-60">
              <button onClick={() => onAdd(source)} disabled={disabled}
                className="text-hacker-text-dim hover:text-hacker-accent shrink-0" title="Enable">
                <ToggleLeft size={14} />
              </button>
              <span className="text-xs text-hacker-text-dim font-mono truncate flex-1">{source}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Layout Tab ─────────────────────────────────────────

const LAYOUT_LABELS: Record<LayoutType, string> = {
  "single": "Single panel",
  "horizontal-2": "Side by side",
  "vertical-2": "Stacked",
  "horizontal-3": "3 columns",
  "vertical-3": "3 rows",
  "top-2-bottom-1": "2 top / 1 bottom",
  "top-1-bottom-2": "1 top / 2 bottom",
  "left-2-right-1": "2 left / 1 right",
  "left-1-right-2": "1 left / 2 right",
};

const LAYOUT_PREVIEW: Record<LayoutType, string> = {
  "single": "■",
  "horizontal-2": "◫",
  "vertical-2": "⬜\n⬜",
  "horizontal-3": "◫◫◫",
  "vertical-3": "⬜\n⬜\n⬜",
  "top-2-bottom-1": "◫◫\n ⬜",
  "top-1-bottom-2": " ⬜\n◫◫",
  "left-2-right-1": "⬜◫\n⬜◫",
  "left-1-right-2": "◫⬜\n◫⬜",
};

const PANEL_LABELS: Record<PanelId, string> = {
  pi: "PI (Chat)",
  terminal: "Terminal",
  files: "Files",
};

function LayoutTab({ onLayoutChange }: { onLayoutChange: () => void }) {
  const [config, setConfig] = useState<LayoutConfig>(() => {
    const saved = loadLayoutConfig();
    return saved || { type: "horizontal-2", slots: ["pi", "terminal"], sizes: [0.6, 0.4] };
  });

  // Read active panels from localStorage
  const activePanels = (() => {
    try {
      const raw = localStorage.getItem("pi-web-panels");
      if (raw) {
        const p = JSON.parse(raw);
        return (["pi", "terminal", "files"] as PanelId[]).filter(id => p[id]?.visible && !p[id]?.floating);
      }
    } catch {}
    return ["pi"] as PanelId[];
  })();

  const activeCount = activePanels.length;

  // Available layouts for the current panel count
  const availableLayouts = (() => {
    if (activeCount <= 1) return ["single"] as LayoutType[];
    if (activeCount === 2) return ["horizontal-2", "vertical-2"] as LayoutType[];
    return ["horizontal-3", "vertical-3", "top-2-bottom-1", "top-1-bottom-2", "left-2-right-1", "left-1-right-2"] as LayoutType[];
  })();

  const handleTypeChange = (type: LayoutType) => {
    const newConfig: LayoutConfig = {
      type,
      slots: type === "single" ? ["pi"] : config.slots.slice(0, type.startsWith("single") ? 1 : 2).length < (type.endsWith("3") || type.includes("3") ? 3 : 2)
        ? [...activePanels.slice(0, type.endsWith("3") || type.includes("3") ? 3 : 2)]
        : config.slots.slice(0, type.endsWith("3") || type.includes("3") ? 3 : 2),
      sizes: new Array(type.endsWith("3") || type.includes("3") ? 3 : type === "single" ? 1 : 2).fill(0).map((_, i, arr) => 1 / arr.length),
    };
    // Ensure 'pi' is always in the slots
    if (!newConfig.slots.includes("pi")) {
      newConfig.slots[0] = "pi";
    }
    // Ensure unique slots
    const seen = new Set<PanelId>();
    newConfig.slots = newConfig.slots.filter(s => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
    // Fill remaining with active panels not yet assigned
    for (const p of activePanels) {
      if (!newConfig.slots.includes(p) && newConfig.slots.length < (newConfig.type === "single" ? 1 : newConfig.type.endsWith("3") || newConfig.type.includes("3") ? 3 : 2)) {
        newConfig.slots.push(p);
      }
    }
    setConfig(newConfig);
    saveLayoutConfig(newConfig);
    onLayoutChange();
  };

  const handleSlotChange = (idx: number, panelId: PanelId) => {
    const newSlots = [...config.slots];
    // Swap: put the replaced panel in the slot that had this panel
    const oldPanel = newSlots[idx];
    const swapIdx = newSlots.indexOf(panelId);
    if (swapIdx >= 0) {
      newSlots[swapIdx] = oldPanel;
    }
    newSlots[idx] = panelId;
    const newConfig = { ...config, slots: newSlots };
    setConfig(newConfig);
    saveLayoutConfig(newConfig);
    onLayoutChange();
  };

  const slotCount = config.type === "single" ? 1 : (config.type.endsWith("3") || config.type.includes("3")) ? 3 : 2;

  return (
    <div className="p-3 space-y-4">
      {/* Info */}
      <div className="text-[11px] text-hacker-text-dim">
        Active panels: <span className="text-hacker-accent">{activeCount}</span>
        {activeCount === 1 && " — Only PI (Chat) is shown."}
      </div>

      {/* Layout type selector */}
      <div className="border border-hacker-border bg-hacker-surface/50">
        <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50">
          <span className="text-xs font-bold text-hacker-accent tracking-wider">LAYOUT TYPE</span>
        </div>
        <div className="p-2 grid grid-cols-2 gap-2">
          {availableLayouts.map(type => {
            const isActive = config.type === type;
            return (
              <button
                key={type}
                onClick={() => handleTypeChange(type)}
                className={`text-left px-3 py-2 text-xs border transition-colors whitespace-pre ${
                  isActive
                    ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                    : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50 hover:text-hacker-text"
                }`}
              >
                <div className="font-mono text-sm mb-0.5">{LAYOUT_PREVIEW[type]}</div>
                <div>{LAYOUT_LABELS[type]}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Slot assignment (for 2-3 panels) */}
      {slotCount > 1 && (
        <div className="border border-hacker-border bg-hacker-surface/50">
          <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50">
            <span className="text-xs font-bold text-hacker-accent tracking-wider">PANEL ASSIGNMENT</span>
          </div>
          <div className="p-2 space-y-2">
            {config.slots.slice(0, slotCount).map((slot, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="text-[11px] text-hacker-text-dim w-16 shrink-0">
                  Slot {idx + 1}:
                </span>
                <select
                  value={slot}
                  onChange={e => handleSlotChange(idx, e.target.value as PanelId)}
                  className="select-hacker flex-1 text-xs py-1"
                >
                  {activePanels.map(p => (
                    <option key={p} value={p}>
                      {PANEL_LABELS[p]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-[10px] text-hacker-text-dim italic">
        Switch panels ON/OFF via the header buttons to change the number of active panels.
        Drag dividers between panels to resize.
      </div>
    </div>
  );
}
