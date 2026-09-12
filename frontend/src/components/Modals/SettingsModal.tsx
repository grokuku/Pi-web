import { useState, useEffect, useCallback } from "react";
import { PiLogo } from "../common/PiLogo";
import {
  X, Plus, Trash2, Eye, EyeOff, Shield, Keyboard, Brain,
} from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import { ProvidersTab, ModelsTab } from "./ModelLibraryModal";
import { MemorySettingsTab } from "./MemorySettingsTab";
import type { ModelLibrary, RegisteredModel, ProviderConfig } from "../../types";
import { useTranslation } from "../../i18n";
import { addModels, updateModel, removeModel, setDefaultModel, apiErrorLabels } from "../../utils/model-library-api";
import { toast } from "../../utils/holaf-toast";
import { getPreviewMode, setPreviewMode, onPreviewModeChange, type PreviewMode } from "../../utils/preview-mode";
import type { ResourceType } from "./settings/types";
import ShortcutsTab from "./settings/ShortcutsTab";
import SecurityTab from "./settings/SecurityTab";
import LayoutTab from "./settings/LayoutTab";
import ApiKeysTab from "./settings/ApiKeysTab";
import ResourceSection from "./settings/ResourceSection";

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

type TabId = "models" | "extensions" | "analysis" | "general" | "memory" | "security" | "layout" | "api-keys" | "shortcuts";

// ── Props ──────────────────────────────────────────────

interface Props {
  onClose: () => void;
  session: any;
  onModelApplied?: () => void;
  onLayoutChange?: () => void;
  activeProjectId?: string;
}

// ── Main Component ─────────────────────────────────────

export function SettingsModal({ onClose, session, onModelApplied, onLayoutChange, activeProjectId }: Props) {
  const [tab, setTab] = useState<TabId>("models");

  // ── i18n (déclaré en tête : utilisé par les handlers de modèles ci-dessous) ──
  const { t, lang, setLang, supportedLanguages } = useTranslation();

  // ── Model Library state ──
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLibrary(data && typeof data === "object" && !Array.isArray(data) ? data : null);
    } catch (e: any) { setError(e.message); }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProviders(Array.isArray(data) ? data : []);
    } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => { loadLibrary(); loadProviders(); }, [loadLibrary, loadProviders]);

  const handleAddModels = async (models: Omit<RegisteredModel, "id">[]) => {
    setLoading(true); setError("");
    try {
      setLibrary(await addModels(models, apiErrorLabels(t)));
      // Message unifié avec ModelLibraryModal (i18n) — cf. rapport dédoublonnage.
      setStatus(t('modelLibrary.modelsAdded'));
      onModelApplied?.();
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleUpdateModel = async (id: string, updates: Partial<RegisteredModel>) => {
    try {
      setLibrary(await updateModel(id, updates, apiErrorLabels(t)));
      onModelApplied?.();
    } catch (e: any) { setError(e.message); }
  };

  const handleRemoveModel = async (id: string) => {
    try {
      setLibrary(await removeModel(id, apiErrorLabels(t)));
    } catch (e: any) { setError(e.message); }
  };

  const handleSetDefault = async (id: string) => {
    try {
      setLibrary(await setDefaultModel(id, apiErrorLabels(t)));
      onModelApplied?.();
    } catch (e: any) { setError(e.message); }
  };

  // ── Extensions state ──
  const [pkgList, setPkgList] = useState<PackageInfo[]>([]);
  const [available, setAvailable] = useState<AvailableResources>({ extensions: [], skills: [], prompts: [], themes: [] });
  const [piSettings, setPiSettings] = useState<Record<string, any>>({});
  const [newSource, setNewSource] = useState("");
  const [extError, setExtError] = useState<string | null>(null);
  const [reloadStatus, setReloadStatus] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
    if (!newSource.trim() || adding) return;
    setAdding(true);
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
      if (data.warning) setExtError(data.warning);
    } catch (e: any) {
      setExtError(e.message);
    } finally {
      setAdding(false);
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

  // Reload Pi session after extension/skill changes
  const reloadSession = useCallback(async () => {
    if (!activeProjectId) return;
    setReloadStatus("reloading");
    try {
      const res = await fetch("/api/pi/reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProjectId }),
      });
      if (res.ok) {
        setReloadStatus("done");
        setTimeout(() => setReloadStatus(null), 3000);
      } else {
        const data = await res.json();
        setReloadStatus(null);
        setExtError(data.error || "Failed to reload session");
      }
    } catch (e: any) {
      setReloadStatus(null);
      setExtError(e.message);
    }
  }, [activeProjectId]);

  // ── General parameters state ──
  // ── Mode d'ouverture des images & previews (reflète utils/preview-mode) ──
  // S'abonne au CustomEvent pour rester synchrone avec la toolbar 🪟 ; le clic
  // appelle setPreviewMode (persiste + émet) → effet LIVE sans reload.
  const [previewMode, setPreviewModeState] = useState<PreviewMode>(() => getPreviewMode());
  useEffect(() => onPreviewModeChange(setPreviewModeState), []);

  const [authUser, setAuthUser] = useState(() => localStorage.getItem("pi-web-auth-user") || "");
  const [authPass, setAuthPass] = useState(() => localStorage.getItem("pi-web-auth-pass") || "");
  const [showPass, setShowPass] = useState(false);
  const [thinkExpand, setThinkExpand] = useState(() => {
    return localStorage.getItem("pi-web-thinking-expand") !== "false";
  });

  // ── Concurrency state ──
  const [maxLLMSlots, setMaxLLMSlots] = useState(3);
  const [maxAgentSlots, setMaxAgentSlots] = useState(5);
  const [concurrencyStats, setConcurrencyStats] = useState<any>(null);

  // ── Webclaw config state ──
  // Durcissement (lot XSS) : la clé n'est plus renvoyée par l'API. Le champ
  // reste vide = la clé existante est conservée au save (keep-if-absent).
  const [webclawUrl, setWebclawUrl] = useState("");
  const [webclawApiKey, setWebclawApiKey] = useState("");
  const [webclawHasApiKey, setWebclawHasApiKey] = useState(false);
  const [webclawKeyPreview, setWebclawKeyPreview] = useState("");

  // ── Tavily config state ──
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [tavilyHasApiKey, setTavilyHasApiKey] = useState(false);
  const [tavilyKeyPreview, setTavilyKeyPreview] = useState("");

  const loadWebclawConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/webclaw");
      if (res.ok) {
        const data = await res.json();
        setWebclawUrl(data.url || "");
        setWebclawApiKey("");  // clé jamais renvoyée : champ vide = inchangée
        setWebclawHasApiKey(!!data.hasApiKey);
        setWebclawKeyPreview(data.apiKeyPreview || "");
      }
    } catch {}
  }, []);

  const saveWebclawConfig = async () => {
    try {
      const res = await fetch("/api/settings/webclaw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // apiKey omis si le champ est vide → le backend garde la clé existante
        body: JSON.stringify({ url: webclawUrl, ...(webclawApiKey ? { apiKey: webclawApiKey } : {}) }),
      });
      if (res.ok) {
        setWebclawApiKey("");
        const data = await res.json().catch(() => null);
        if (data) {
          setWebclawHasApiKey(!!data.hasApiKey);
          setWebclawKeyPreview(data.apiKeyPreview || "");
        }
        toast(t('common.saved'), "success");
      }
    } catch (e: any) {
      console.error("[webclaw] Failed to save:", e);
    }
  };

  const loadTavilyConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/tavily");
      if (res.ok) {
        const data = await res.json();
        setTavilyApiKey("");  // clé jamais renvoyée : champ vide = inchangée
        setTavilyHasApiKey(!!data.hasApiKey);
        setTavilyKeyPreview(data.apiKeyPreview || "");
      }
    } catch {}
  }, []);

  const saveTavilyConfig = async () => {
    try {
      const res = await fetch("/api/settings/tavily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // apiKey omis si le champ est vide → la clé existante est conservée
        ...(tavilyApiKey ? { body: JSON.stringify({ apiKey: tavilyApiKey }) } : { body: JSON.stringify({}) }),
      });
      if (res.ok) {
        setTavilyApiKey("");
        setTavilyHasApiKey((prev) => prev || !!tavilyApiKey);
        if (tavilyApiKey) setTavilyKeyPreview(`••••${tavilyApiKey.slice(-4)}`);
        toast(t('common.saved'), "success");
      }
    } catch (e: any) {
      console.error("[tavily] Failed to save:", e);
    }
  };

  const loadConcurrencyConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/concurrency");
      const data = await res.json();
      setMaxLLMSlots(data.config.maxLLMSlots ?? 3);
      setMaxAgentSlots(data.config.maxAgentSlots ?? 5);
      setConcurrencyStats(data.stats);
    } catch {}
  }, []);

  const saveConcurrency = async () => {
    try {
      const res = await fetch("/api/settings/concurrency", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxLLMSlots, maxAgentSlots }),
      });
      const data = await res.json();
      setConcurrencyStats(data.stats);
      toast(t('common.saved'), "success");
    } catch (e: any) {
      console.error("[concurrency] Failed to save:", e);
    }
  };

  // Load concurrency config on mount
  useEffect(() => { loadConcurrencyConfig(); }, [loadConcurrencyConfig]);
  useEffect(() => { loadWebclawConfig(); }, [loadWebclawConfig]);
  useEffect(() => { loadTavilyConfig(); }, [loadTavilyConfig]);

  const saveAuth = () => {
    if (authUser) {
      localStorage.setItem("pi-web-auth-user", authUser);
      localStorage.setItem("pi-web-auth-pass", authPass);
    } else {
      localStorage.removeItem("pi-web-auth-user");
      localStorage.removeItem("pi-web-auth-pass");
    }
    toast(t('common.saved'), "success");
  };

  // ── i18n ──
  // (useTranslation déclaré en tête de composant — voir plus haut)

  // ── Tabs ──
  const TABS: { id: TabId; icon: React.ReactNode; label: string }[] = [
    { id: "models", icon: <PiLogo className="w-4 h-4 inline" />, label: t('settings.tabs.models') },
    { id: "analysis", icon: "🔬", label: t('settings.tabs.analysis') },
    { id: "extensions", icon: "📦", label: t('settings.tabs.extensions') },
    { id: "general", icon: "⚙", label: t('settings.tabs.general') },
    { id: "memory", icon: <Brain size={14} />, label: t('settings.tabs.memory') },
    { id: "security", icon: <Shield size={14} />, label: t('settings.tabs.security') },
    { id: "shortcuts", icon: <Keyboard size={14} />, label: "Raccourcis" },
    { id: "layout", icon: "⊞", label: t('settings.tabs.layout') },
    { id: "api-keys", icon: "🔑", label: "API Keys" },
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
            <span className="text-hacker-accent text-sm font-bold tracking-wider"><PiLogo className="w-4 h-4 inline" /> SETTINGS</span>
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
                  refreshLibrary={async () => { await loadLibrary(); }}
                />
              )}
            </div>
          )}


          {/* Analysis Models Tab */}
          {tab === "analysis" && library && (
            <div className="p-3 space-y-4">
              <div className="text-hacker-accent text-sm font-bold mb-2">🔬 Analysis Models</div>
              <div className="text-xs text-hacker-text-dim mb-4">
                Configure models used for file analysis (PDFs, images, audio, etc.). 
                If a model is not set, the main conversation model will be used (or raw extraction for text-based files).
              </div>

              {/* Vision Model */}
              <div className="border border-hacker-border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
                      <span>🖼️</span> Vision Model
                    </div>
                    <div className="text-[10px] text-hacker-text-dim mt-0.5">
                      Used for image analysis when the main model doesn{"'"}t support vision
                    </div>
                  </div>
                  {library.visionModelId && (
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/model-library/vision-model", { method: "DELETE" });
                          if (res.ok) setLibrary(await res.json());
                        } catch (e: any) { setError(e.message); }
                      }}
                      className="text-[10px] text-hacker-text-dim hover:text-hacker-error"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <select
                  value={library.visionModelId || ""}
                  onChange={async (e) => {
                    const id = e.target.value;
                    if (!id) return;
                    try {
                      const res = await fetch(`/api/model-library/vision-model/${encodeURIComponent(id)}`, { method: "PUT" });
                      if (res.ok) setLibrary(await res.json());
                      else { const d = await res.json().catch(() => ({})); setError(d.error || "Failed"); }
                    } catch (e: any) { setError(e.message); }
                  }}
                  className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                >
                  <option value="">— None (use main model) —</option>
                  {(library.models || [])
                    .filter(m => m.vision)
                    .map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
                <div className="text-[10px] text-hacker-text-dim mt-1">
                  {(library.models || []).filter(m => m.vision).length === 0 
                    ? "No vision-capable models found. Add a model with vision support in Model Library." 
                    : `${(library.models || []).filter(m => m.vision).length} vision model(s) available`}
                </div>
              </div>

              {/* Audio Model */}
              <div className="border border-hacker-border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
                      <span>🎵</span> Audio / Transcription Model
                    </div>
                    <div className="text-[10px] text-hacker-text-dim mt-0.5">
                      Used for audio transcription (requires compatible service)
                    </div>
                  </div>
                  {library.audioModelId && (
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/model-library/audio-model", { method: "DELETE" });
                          if (res.ok) setLibrary(await res.json());
                        } catch (e: any) { setError(e.message); }
                      }}
                      className="text-[10px] text-hacker-text-dim hover:text-hacker-error"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <select
                  value={library.audioModelId || ""}
                  onChange={async (e) => {
                    const id = e.target.value;
                    if (!id) return;
                    try {
                      const res = await fetch(`/api/model-library/audio-model/${encodeURIComponent(id)}`, { method: "PUT" });
                      if (res.ok) setLibrary(await res.json());
                      else { const d = await res.json().catch(() => ({})); setError(d.error || "Failed"); }
                    } catch (e: any) { setError(e.message); }
                  }}
                  className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                >
                  <option value="">— Not configured —</option>
                  {(library.models || [])
                    .map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
                <div className="text-[10px] text-hacker-text-dim mt-1">
                  Audio transcription requires a Whisper-compatible service. Coming soon.
                </div>
              </div>

              {/* Commit Model (existing) */}
              <div className="border border-hacker-border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
                      <span>📝</span> Commit Message Model
                    </div>
                    <div className="text-[10px] text-hacker-text-dim mt-0.5">
                      Used for generating AI commit messages
                    </div>
                  </div>
                  {library.commitModelId && (
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/model-library/commit-model", { method: "DELETE" });
                          if (res.ok) setLibrary(await res.json());
                        } catch (e: any) { setError(e.message); }
                      }}
                      className="text-[10px] text-hacker-text-dim hover:text-hacker-error"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <select
                  value={library.commitModelId || ""}
                  onChange={async (e) => {
                    const id = e.target.value;
                    if (!id) return;
                    try {
                      const res = await fetch(`/api/model-library/commit-model/${encodeURIComponent(id)}`, { method: "PUT" });
                      if (res.ok) setLibrary(await res.json());
                      else { const d = await res.json().catch(() => ({})); setError(d.error || "Failed"); }
                    } catch (e: any) { setError(e.message); }
                  }}
                  className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                >
                  <option value="">— Use default model —</option>
                  {(library.models || [])
                    .map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>

              {/* Librarian Model */}
              <div className="border border-hacker-border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
                      <span>📚</span> Librarian Model
                    </div>
                    <div className="text-[10px] text-hacker-text-dim mt-0.5">
                      Used for documentation synthesis in the librarian service
                    </div>
                  </div>
                  {library.librarianModelId && (
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/model-library/librarian-model", { method: "DELETE" });
                          if (res.ok) setLibrary(await res.json());
                        } catch (e: any) { setError(e.message); }
                      }}
                      className="text-[10px] text-hacker-text-dim hover:text-hacker-error"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <select
                  value={library.librarianModelId || ""}
                  onChange={async (e) => {
                    const id = e.target.value;
                    if (!id) return;
                    try {
                      const res = await fetch(`/api/model-library/librarian-model/${encodeURIComponent(id)}`, { method: "PUT" });
                      if (res.ok) setLibrary(await res.json());
                      else { const d = await res.json().catch(() => ({})); setError(d.error || "Failed"); }
                    } catch (e: any) { setError(e.message); }
                  }}
                  className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                >
                  <option value="">— Use default model —</option>
                  {(library.models || [])
                    .map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>

              {/* How it works */}
              <div className="border border-hacker-accent/20 bg-hacker-accent/5 rounded p-3">
                <div className="text-xs text-hacker-text-bright font-bold mb-2">How file analysis works</div>
                <div className="text-[11px] text-hacker-text-dim space-y-1.5">
                  <div><span className="text-green-400">PDFs & Text</span> — Extracted directly, no model needed</div>
                  <div><span className="text-green-400">Images</span> — Sent to the main model if it supports vision, otherwise sent to the Vision Model above</div>
                  <div><span className="text-yellow-400">Audio</span> — Requires a transcription service (not yet available)</div>
                  <div><span className="text-yellow-400">Video</span> — Requires ffmpeg + transcription (not yet available)</div>
                </div>
              </div>

              {/* Webclaw Configuration */}
              <div className="border border-hacker-border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
                      <span>🕸️</span> Webclaw Configuration
                    </div>
                    <div className="text-[10px] text-hacker-text-dim mt-0.5">
                      Web scraping & search service for the librarian
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="text-hacker-text-dim text-xs block mb-1">URL</label>
                    <input
                      type="text"
                      value={webclawUrl}
                      onChange={e => setWebclawUrl(e.target.value)}
                      placeholder="http://localhost:3001"
                      className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-hacker-text-dim text-xs block mb-1">API Key</label>
                    <input
                      type="password"
                      value={webclawApiKey}
                      onChange={e => setWebclawApiKey(e.target.value)}
                      placeholder={webclawHasApiKey ? webclawKeyPreview : "••••••••"}
                      className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                    />
                  </div>
                  <button
                    onClick={saveWebclawConfig}
                    className="btn-hacker text-xs px-4 py-1.5"
                  >
                    SAVE
                  </button>
                </div>
              </div>

              {/* Tavily Configuration */}
              <div className="border border-hacker-border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-xs font-bold text-hacker-text-bright flex items-center gap-1.5">
                      <span>🔍</span> Tavily API Key
                    </div>
                    <div className="text-[10px] text-hacker-text-dim mt-0.5">
                      Web search API for the librarian (used when Webclaw search is unavailable)
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="text-hacker-text-dim text-xs block mb-1">API Key</label>
                    <input
                      type="password"
                      value={tavilyApiKey}
                      onChange={e => setTavilyApiKey(e.target.value)}
                      placeholder={tavilyHasApiKey ? tavilyKeyPreview : "tvly-••••••••"}
                      className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] text-hacker-text-dim">
                      Get a free key at <a href="https://tavily.com" target="_blank" rel="noopener noreferrer" className="text-hacker-accent hover:underline">tavily.com</a> (1000 searches/month free)
                    </div>
                    <button
                      onClick={saveTavilyConfig}
                      className="btn-hacker text-xs px-4 py-1.5"
                    >
                      SAVE
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Extensions & Skills Tab */}
          {tab === "extensions" && (
            <div className="p-3">
              <div className="mb-3 border border-hacker-warn/20 bg-hacker-warn/5 p-2 rounded">
                <div className="text-[11px] text-hacker-text-dim mb-1.5">
                  Extensions and skills are loaded when a Pi session starts. Changes require a session reload.
                </div>
                <button
                  onClick={reloadSession}
                  disabled={reloadStatus === "reloading" || !activeProjectId}
                  className={`btn-hacker text-[10px] px-2 py-0.5 ${
                    reloadStatus === "done" ? "!bg-green-600/20 !border-green-600/50 !text-green-400" : ""
                  }`}
                >
                  {reloadStatus === "reloading" ? "Reloading…" : reloadStatus === "done" ? "✓ Reloaded" : "Reload session"}
                </button>
              </div>
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
                      disabled={adding || !newSource.trim()}
                      className="btn-hacker text-xs px-3 py-1.5 flex items-center gap-1 shrink-0"
                    >
                      {adding ? "Installing..." : "ADD"}
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
                    className="btn-hacker text-xs px-4 py-1.5">
                    SAVE CREDENTIALS
                  </button>
                </div>
              </div>

              {/* Language Section */}
              <div className="border border-hacker-border bg-hacker-surface/50">
                <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50 flex items-center gap-2">
                  <span className="text-xs font-bold text-hacker-accent tracking-wider">🌐 {t('settings.general.title')}</span>
                </div>
                <div className="p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-hacker-text-dim text-xs">{t('settings.general.language')}</label>
                    <select
                      value={lang}
                      onChange={e => setLang(e.target.value as "fr" | "en")}
                      className="bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1.5 rounded focus:border-hacker-accent outline-none"
                    >
                      <option value="">— {t('settings.general.systemDefault')} —</option>
                      <option value="fr">Français</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Interface — ouverture des images & previews (modale interne ↔ popup) */}
              <div className="border border-hacker-border bg-hacker-surface/50">
                <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50 flex items-center gap-2">
                  <span className="text-xs font-bold text-hacker-accent tracking-wider">🪟 {t('ui.previewMode.title')}</span>
                </div>
                <div className="p-3 space-y-2">
                  <div className="text-[11px] text-hacker-text-dim">{t('ui.previewMode.desc')}</div>
                  <div className="flex items-center gap-1">
                    {(["internal", "popup"] as const).map(m => (
                      <button
                        key={m}
                        onClick={() => setPreviewMode(m)}
                        className={`text-xs px-3 py-1 border transition-colors ${
                          previewMode === m
                            ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                            : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50"
                        }`}
                      >
                        {m === "internal" ? t('ui.previewMode.internal') : t('ui.previewMode.popup')}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] text-hacker-text-dim">
                    {previewMode === "popup" ? t('ui.previewMode.popupHint') : t('ui.previewMode.internalHint')}
                  </div>
                </div>
              </div>

              {/* Think Expand Default */}
              <div className="border border-hacker-border bg-hacker-surface/50">
                <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50 flex items-center gap-2">
                  <span className="text-xs font-bold text-hacker-accent tracking-wider">🧠 {t('settings.general.thinkExpand')}</span>
                </div>
                <div className="p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-hacker-text-dim">{t('settings.general.thinkExpandDesc')}</span>
                    <button
                      onClick={() => {
                        const next = !thinkExpand;
                        setThinkExpand(next);
                        localStorage.setItem("pi-web-thinking-expand", String(next));
                      }}
                      className={`text-xs px-3 py-1 border transition-colors ${
                        thinkExpand
                          ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                          : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50"
                      }`}
                    >
                      {thinkExpand ? t('common.on') : t('common.off')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Concurrency Section */}
              <div className="border border-hacker-border bg-hacker-surface/50">
                <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50 flex items-center gap-2">
                  <span className="text-xs font-bold text-hacker-accent tracking-wider">☎️ CONCURRENCE</span>
                </div>
                <div className="p-3 space-y-3">
                  <p className="text-[11px] text-hacker-text-dim">
                    Limite le nombre d'appels LLM et de sessions agent simultanés.
                    Les appels en attente sont mis en file d'attente.
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-hacker-text-dim text-xs block mb-1">
                        ☎️ LLM slots max
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={maxLLMSlots}
                        onChange={e => setMaxLLMSlots(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                        className="input-hacker w-full text-xs py-1.5 px-2"
                      />
                    </div>
                    <div>
                      <label className="text-hacker-text-dim text-xs block mb-1">
                        🔧 Agent slots max
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={maxAgentSlots}
                        onChange={e => setMaxAgentSlots(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                        className="input-hacker w-full text-xs py-1.5 px-2"
                      />
                    </div>
                  </div>
                  <button onClick={saveConcurrency}
                    className="btn-hacker text-xs px-4 py-1.5">
                    SAVE
                  </button>
                  {concurrencyStats && (
                    <div className="text-[10px] text-hacker-text-dim space-y-1 mt-2 pt-2 border-t border-hacker-border/30">
                      <div>☎️ LLM : {concurrencyStats.llmSlots.used}/{concurrencyStats.llmSlots.max} utilisé{concurrencyStats.llmSlots.queue > 0 ? ` · ${concurrencyStats.llmSlots.queue} en attente` : ""}</div>
                      <div>🔧 Agents : {concurrencyStats.agentSlots.used}/{concurrencyStats.agentSlots.max} utilisé{concurrencyStats.agentSlots.queue > 0 ? ` · ${concurrencyStats.agentSlots.queue} en attente` : ""}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Placeholder for future options */}
              <div className="text-[11px] text-hacker-text-dim text-center py-4 border border-hacker-border/30 border-dashed">
                {t('settings.general.additional')}
              </div>
            </div>
          )}

          {/* Layout Tab */}
          {tab === "layout" && (
            <LayoutTab onLayoutChange={() => onLayoutChange?.()} />
          )}

          {/* Memory Tab (Lot M3) — mémoires globale + projet actif */}
          {tab === "memory" && <MemorySettingsTab activeProjectId={activeProjectId} />}

          {/* Security Tab */}
          {tab === "security" && <SecurityTab />}

          {/* Shortcuts Tab */}
          {tab === "shortcuts" && <ShortcutsTab />}

          {/* API Keys Tab */}
          {tab === "api-keys" && (
            <ApiKeysTab />
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
