import { useState, useEffect, useCallback } from "react";
import { X, Package, Puzzle, Lightbulb, Palette, Plus, Trash2, ToggleLeft, ToggleRight, RefreshCw } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";

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

// ── Component ──────────────────────────────────────────

interface Props {
  onClose: () => void;
}

export function ExtensionsModal({ onClose }: Props) {
  const [tab, setTab] = useState<"packages" | "resources">("packages");
  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [available, setAvailable] = useState<AvailableResources>({ extensions: [], skills: [], prompts: [], themes: [] });
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [newSource, setNewSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pkgRes, availRes, settingsRes] = await Promise.all([
        fetch("/api/pi/packages"),
        fetch("/api/pi/available"),
        fetch("/api/pi"),
      ]);
      if (pkgRes.ok) setPackages(await pkgRes.json());
      if (availRes.ok) setAvailable(await availRes.json());
      if (settingsRes.ok) setSettings(await settingsRes.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const addPackage = async () => {
    if (!newSource.trim()) return;
    setLoading(true);
    setError(null);
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
      setPackages(data.packages || []);
      setNewSource("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const removePackage = async (source: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pi/packages/${encodeURIComponent(source)}`, { method: "DELETE" });
      if (res.ok) {
        const data = await res.json();
        setPackages(data.packages || []);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleResource = async (type: ResourceType, source: string, enabled: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pi/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, source, enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings((prev: any) => ({ ...prev, [type]: data[type] }));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const updateSettings = async (updates: Record<string, any>) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pi", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        setSettings(await res.json());
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const currentExtensions: string[] = settings.extensions || [];
  const currentSkills: string[] = settings.skills || [];
  const currentPrompts: string[] = settings.prompts || [];
  const currentThemes: string[] = settings.themes || [];

  return (
    <ModalDialog id="extensions" onClose={onClose}>
      <div className="w-full h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-hacker-border shrink-0">
          <h2 className="text-sm text-hacker-accent font-bold tracking-wider">EXTENSIONS & SKILLS</h2>
          <div className="flex items-center gap-2">
            <button onClick={loadData} className="text-hacker-text-dim hover:text-hacker-accent" title="Refresh">
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
            <button onClick={onClose} className="text-hacker-text-dim hover:text-hacker-error">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tab selector */}
        <div className="flex border-b border-hacker-border shrink-0">
          {(["packages", "resources"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-xs font-bold tracking-wider transition-colors ${
                tab === t
                  ? "text-hacker-accent border-b-2 border-hacker-accent bg-hacker-accent/5"
                  : "text-hacker-text-dim hover:text-hacker-text-bright"
              }`}
            >
              {t === "packages" ? "PACKAGES" : "RESOURCES"}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-3 mt-2 px-3 py-2 bg-hacker-error/10 text-hacker-error text-xs rounded">
            {error}
            <button onClick={() => setError(null)} className="ml-2 text-hacker-text-dim hover:text-hacker-error">✕</button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-3">
          {tab === "packages" && (
            <div className="space-y-3">
              {/* Add package */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newSource}
                  onChange={e => setNewSource(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addPackage()}
                  placeholder="npm package or git URL (e.g. @pi/extension-memory or git+https://...)"
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

              {/* Package list */}
              {packages.length === 0 ? (
                <div className="text-hacker-text-dim text-xs text-center py-8">
                  No packages installed yet.<br />
                  <span className="text-[10px]">Add a package source above, or visit <a href="https://pi.dev/packages" target="_blank" className="text-hacker-accent hover:underline">pi.dev/packages</a></span>
                </div>
              ) : (
                <div className="space-y-2">
                  {packages.map(pkg => (
                    <div key={pkg.source} className="flex items-center gap-2 bg-hacker-bg/50 border border-hacker-border rounded px-3 py-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${pkg.installed ? "bg-hacker-accent" : "bg-hacker-error"}`} title={pkg.installed ? "Installed" : "Not found"} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-hacker-text-bright truncate font-mono">{pkg.source}</div>
                        <div className="text-[10px] text-hacker-text-dim flex items-center gap-2">
                          <span className="uppercase">{pkg.type || "unknown"}</span>
                          {pkg.scope === "project" && <span className="text-hacker-warn">project</span>}
                          {pkg.installed && pkg.installedPath && <span className="truncate">{pkg.installedPath.split("/").slice(-3).join("/")}</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => removePackage(pkg.source)}
                        className="text-hacker-text-dim hover:text-hacker-error shrink-0"
                        title="Remove"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "resources" && (
            <div className="space-y-4">
              {/* Extensions */}
              <ResourceSection
                type="extensions"
                items={currentExtensions}
                available={available.extensions}
                onToggle={toggleResource}
                onAdd={source => toggleResource("extensions", source, true)}
                disabled={loading}
              />

              {/* Skills */}
              <ResourceSection
                type="skills"
                items={currentSkills}
                available={available.skills}
                onToggle={toggleResource}
                onAdd={source => toggleResource("skills", source, true)}
                disabled={loading}
              />

              {/* Prompts */}
              <ResourceSection
                type="prompts"
                items={currentPrompts}
                available={available.prompts || []}
                onToggle={toggleResource}
                onAdd={source => toggleResource("prompts", source, true)}
                disabled={loading}
              />

              {/* Themes */}
              <ResourceSection
                type="themes"
                items={currentThemes}
                available={available.themes}
                onToggle={toggleResource}
                onAdd={source => toggleResource("themes", source, true)}
                disabled={loading}
              />

              {/* Add manual resource */}
              <div className="pt-2 border-t border-hacker-border">
                <div className="text-xs text-hacker-text-dim mb-2">Add a resource path manually:</div>
                <div className="flex gap-2">
                  <select
                    id="resource-type-select"
                    className="bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-2 py-1 rounded"
                  >
                    <option value="extensions">Extension</option>
                    <option value="skills">Skill</option>
                    <option value="prompts">Prompt</option>
                    <option value="themes">Theme</option>
                  </select>
                  <input
                    type="text"
                    id="resource-path-input"
                    placeholder="./path/to/resource"
                    className="flex-1 bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-3 py-1 rounded focus:border-hacker-accent outline-none"
                  />
                  <button
                    onClick={() => {
                      const type = (document.getElementById("resource-type-select") as HTMLSelectElement).value as ResourceType;
                      const path = (document.getElementById("resource-path-input") as HTMLInputElement).value.trim();
                      if (path) toggleResource(type, path, true);
                    }}
                    disabled={loading}
                    className="btn-hacker text-xs px-3 py-1 flex items-center gap-1"
                  >
                    <Plus size={12} /> ADD
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer with settings links */}
        <div className="border-t border-hacker-border px-3 py-2 shrink-0">
          <div className="text-[10px] text-hacker-text-dim flex items-center gap-3">
            <span>Config: <code className="text-hacker-accent">~/.pi/agent/settings.json</code></span>
            <a href="https://pi.dev/packages" target="_blank" className="text-hacker-accent hover:underline">pi.dev/packages</a>
          </div>
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
              <button
                onClick={() => onToggle(type, source, false)}
                disabled={disabled}
                className="text-hacker-accent hover:text-hacker-error shrink-0"
                title="Disable"
              >
                <ToggleRight size={14} />
              </button>
              <span className="text-xs text-hacker-text-bright font-mono truncate flex-1">{source}</span>
            </div>
          ))}
          {/* Available but not enabled */}
          {available.filter(a => !items.includes(a)).map(source => (
            <div key={source} className="flex items-center gap-2 py-1 opacity-60">
              <button
                onClick={() => onAdd(source)}
                disabled={disabled}
                className="text-hacker-text-dim hover:text-hacker-accent shrink-0"
                title="Enable"
              >
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