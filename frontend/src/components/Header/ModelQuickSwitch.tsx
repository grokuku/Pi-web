import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, Power, Star } from "lucide-react";
import type { ModelLibrary, RegisteredModel, AgentMode, ProjectModeConfig } from "../../types";

const MODE_CONFIG: Record<AgentMode, { icon: string; label: string; color: string }> = {
  code:   { icon: "⚡", label: "CODE",   color: "text-hacker-accent" },
  plan:   { icon: "🗺", label: "PLAN",   color: "text-hacker-info" },
  review: { icon: "📋", label: "REVIEW", color: "text-hacker-warn" },
};

interface Props {
  activeMode?: string;
  activeProjectId?: string;
  onModeSwitch?: (mode: AgentMode) => void;
  onModelApplied?: () => void;
}

export function ModelQuickSwitch({ activeMode, activeProjectId, onModeSwitch, onModelApplied }: Props) {
  const [openMode, setOpenMode] = useState<AgentMode | null>(null);
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Load library
  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      setLibrary(await res.json());
    } catch {}
  }, []);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);
  useEffect(() => { if (onModelApplied) loadLibrary(); }, [onModelApplied, loadLibrary]);

  // Close on click outside
  useEffect(() => {
    if (!openMode) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenMode(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openMode]);

  // Get project mode config
  const pm: ProjectModeConfig = activeProjectId
    ? (library?.projectModes?.[activeProjectId] || {
        code: { modelId: null },
        plan: { modelId: null, enabled: false },
        review: { modelId: null, enabled: false, maxReviews: 1 },
      })
    : {
        code: { modelId: null },
        plan: { modelId: null, enabled: false },
        review: { modelId: null, enabled: false, maxReviews: 1 },
      };

  const getModelForMode = (mode: AgentMode): RegisteredModel | null => {
    const modelId = pm[mode as keyof ProjectModeConfig]?.modelId;
    if (modelId && library) {
      const m = library.models.find(m => m.id === modelId);
      if (m) return m;
    }
    // Fall back to default model
    if (library?.defaultModelId) {
      return library.models.find(m => m.id === library.defaultModelId) || null;
    }
    return library?.models[0] || null;
  };

  const defaultModel = library ? (library.models.find(m => m.id === library.defaultModelId) || library.models[0]) : null;

  const handleSelectModel = async (mode: AgentMode, modelId: string | null) => {
    if (!activeProjectId) return;
    try {
      await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, modelId }),
      });
      await loadLibrary();
      onModelApplied?.();
    } catch (e) { console.error("handleSelectModel error:", e); }
    setOpenMode(null);
  };

  const handleToggleMode = async (e: React.MouseEvent, mode: "plan" | "review", enabled: boolean) => {
    e.stopPropagation();
    if (!activeProjectId) return;
    try {
      await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, enabled }),
      });
      await loadLibrary();
      onModelApplied?.();
    } catch (e) { console.error("handleToggleMode error:", e); }
  };

  const handleMaxReviews = async (maxReviews: number) => {
    if (!activeProjectId) return;
    try {
      await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "review", maxReviews }),
      });
      await loadLibrary();
    } catch (e) { console.error("handleMaxReviews error:", e); }
  };

  const handleChipClick = (mode: AgentMode) => {
    if (openMode === mode) { setOpenMode(null); return; }
    setOpenMode(mode);
  };

  const getShortModelName = (model: RegisteredModel | null): string => {
    if (!model) return "—";
    const name = model.name;
    if (name.length <= 12) return name;
    return name.slice(0, 10) + "…";
  };

  const getProviderLabel = (model: RegisteredModel | null): string => {
    if (!model || !library) return "";
    // Find the provider to get its custom name
    // We don't have providers list here, so show model's providerId
    return model.providerId;
  };

  const modes: AgentMode[] = ["code", "plan", "review"];

  return (
    <div ref={ref} className="flex items-center gap-1">
      {modes.map((mode) => {
        const cfg = MODE_CONFIG[mode];
        const model = getModelForMode(mode);
        const isCode = mode === "code";
        const modeCfg = mode !== "code" ? pm[mode] : null;
        const isEnabled = isCode ? true : (modeCfg as any)?.enabled ?? false;
        const isActive = activeMode === mode && isEnabled;
        const isDropdownOpen = openMode === mode;

        return (
          <div key={mode} className="relative">
            <button
              onClick={() => handleChipClick(mode)}
              className={`mode-chip flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-sm ${
                isActive ? "active" : isEnabled ? "" : "disabled"
              }`}
            >
              <span className={`font-bold tracking-wide ${isActive ? cfg.color : "text-hacker-text-dim"}`}>
                {cfg.icon}
              </span>
              <span className={isActive ? "" : "text-hacker-text-dim"}>
                {isActive ? getShortModelName(model) : cfg.label}
              </span>
              <ChevronDown size={8} className={`text-hacker-text-dim transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} />
            </button>

            {isDropdownOpen && (
              <div className="absolute top-full right-0 mt-1 w-[220px] bg-hacker-surface border border-hacker-border-bright shadow-lg z-50">
                {/* Mode header */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-hacker-bg/50 border-b border-hacker-border/50">
                  <span className={`text-[10px] font-bold tracking-wider ${isEnabled && (isCode || model) ? cfg.color : "text-hacker-text-dim"}`}>
                    {cfg.icon} {cfg.label}
                  </span>
                  {/* ON/OFF toggle (not for CODE) */}
                  {!isCode && (
                    <button
                      onClick={(e) => handleToggleMode(e, mode as "plan" | "review", !isEnabled)}
                      className={`text-[9px] px-1.5 py-0.5 border flex items-center gap-0.5 ${
                        isEnabled
                          ? "border-hacker-accent/50 text-hacker-accent bg-hacker-accent/10"
                          : "border-hacker-border text-hacker-text-dim"
                      }`}>
                      <Power size={7} />
                      {isEnabled ? "ON" : "OFF"}
                    </button>
                  )}
                </div>

                {/* Switch to this mode button */}
                {isEnabled && !isActive && model && (
                  <button
                    onClick={() => { onModeSwitch?.(mode); setOpenMode(null); }}
                    className="w-full text-left px-3 py-1.5 text-[10px] text-hacker-accent font-bold border-b border-hacker-border/50 hover:bg-hacker-accent/5">
                    → Switch to {cfg.label} mode
                  </button>
                )}

                {/* Models list */}
                {isEnabled && library && library.models.length > 0 ? (
                  <>
                    <div className="max-h-[150px] overflow-y-auto">
                      {library.models.map((m) => {
                        const isModelActive = m.id === (pm[mode as keyof ProjectModeConfig] as any)?.modelId;
                        const isDefault = m.id === library.defaultModelId;
                        return (
                          <button
                            key={m.id}
                            onClick={() => handleSelectModel(mode, m.id)}
                            className={`w-full text-left px-3 py-1 text-[10px] flex items-center gap-1.5 ${
                              isModelActive
                                ? "bg-hacker-accent/10 text-hacker-accent"
                                : "text-hacker-text-dim hover:bg-hacker-border/30 hover:text-hacker-text"
                            }`}>
                            <Star size={8} className={isDefault ? "text-hacker-accent fill-hacker-accent" : "text-transparent"} />
                            <span className="truncate flex-1">{m.name}</span>
                            <span className="text-[8px] text-hacker-text-dim">({m.providerId})</span>
                            {isModelActive && <span className="text-hacker-accent text-[8px]">●</span>}
                          </button>
                        );
                      })}
                    </div>
                    {/* Default option */}
                    <button
                      onClick={() => handleSelectModel(mode, null)}
                      className="w-full text-left px-3 py-1 text-[10px] text-hacker-text-dim hover:text-hacker-text border-t border-hacker-border/30">
                      ★ Use default model
                    </button>
                  </>
                ) : isEnabled ? (
                  <div className="px-3 py-1.5 text-[9px] text-hacker-text-dim italic">
                    No models configured
                  </div>
                ) : null}

                {/* Max reviews (REVIEW mode only) */}
                {mode === "review" && isEnabled && (
                  <div className="flex items-center gap-2 px-3 py-1.5 border-t border-hacker-border/30">
                    <span className="text-[9px] text-hacker-text-dim">🔄 MAX REVIEWS</span>
                    <select
                      value={(pm.review as any).maxReviews ?? 1}
                      onChange={(e) => handleMaxReviews(Number(e.target.value))}
                      className="select-hacker text-[9px] py-0 px-1 max-w-[48px]"
                    >
                      <option value={0}>OFF</option>
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}