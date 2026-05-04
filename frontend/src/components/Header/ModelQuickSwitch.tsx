import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, Power, Star } from "lucide-react";
import type { ModelLibrary, RegisteredModel, AgentMode, ProjectModeConfig } from "../../types";

const MODE_CONFIG: Record<AgentMode, { icon: string; label: string; color: string; activeBg: string }> = {
  code:   { icon: "⚡", label: "CODE",   color: "text-hacker-accent",      activeBg: "bg-hacker-accent/15 border-hacker-accent/50" },
  plan:   { icon: "🗺", label: "PLAN",   color: "text-hacker-info",       activeBg: "bg-hacker-info/15 border-hacker-info/50" },
  review: { icon: "📋", label: "REVIEW", color: "text-hacker-warn",       activeBg: "bg-hacker-warn/15 border-hacker-warn/50" },
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
    ? (library?.projectModes?.[activeProjectId] || defaultProjectMode())
    : defaultProjectMode();

  const getModelForMode = (mode: AgentMode): RegisteredModel | null => {
    const modelId = (pm as any)[mode]?.modelId;
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

  const handleSelectModel = async (mode: AgentMode, modelId: string) => {
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

  const handleToggleMode = async (e: React.MouseEvent, mode: "plan" | "review") => {
    e.stopPropagation();
    if (!activeProjectId) return;
    const modeCfg = (pm as any)[mode] as { enabled: boolean };
    const newEnabled = !modeCfg.enabled;
    try {
      await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, enabled: newEnabled }),
      });
      await loadLibrary();
      onModelApplied?.();

      // If enabling PLAN, also switch to plan mode
      if (mode === "plan" && newEnabled) {
        onModeSwitch?.("plan");
      }
      // If disabling PLAN and was active, switch back to code
      if (mode === "plan" && !newEnabled && activeMode === "plan") {
        onModeSwitch?.("code");
      }
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

  const modes: AgentMode[] = ["code", "plan", "review"];

  return (
    <div ref={ref} className="flex items-center gap-1.5">
      {modes.map((mode) => {
        const cfg = MODE_CONFIG[mode];
        const model = getModelForMode(mode);
        const isCode = mode === "code";
        const modeCfg = mode !== "code" ? (pm as any)[mode] : null;
        const isEnabled = isCode || (modeCfg?.enabled ?? false);
        const isActive = activeMode === mode && isEnabled;
        const isDropdownOpen = openMode === mode;

        // Determine visual state:
        // - CODE is always on but visually dimmed when PLAN is active (PLAN overrides)
        // - REVIEW is lit when enabled AND not overridden by PLAN
        // - PLAN is lit when enabled
        const isVisuallyActive = isActive;
        const isPlanActive = pm.plan.enabled && activeMode === "plan";
        const isOverriddenByPlan = !isCode && isPlanActive && mode !== "plan";

        return (
          <div key={mode} className="relative">
            {/* Main button — integrated ON/OFF */}
            <button
              className={`flex items-center border rounded-sm transition-all ${
                isVisuallyActive
                  ? `${cfg.activeBg} border ${cfg.color}`
                  : isOverriddenByPlan
                  ? "bg-hacker-bg border-hacker-border/50 text-hacker-text-dim/50"
                  : isEnabled
                  ? "bg-hacker-bg border-hacker-border text-hacker-text-dim"
                  : "bg-hacker-bg border-hacker-border/40 text-hacker-text-dim/50"
              }`}
              onClick={() => handleChipClick(mode)}
            >
              {/* ON/OFF toggle zone (left part of button) */}
              {!isCode && (
                <button
                  onClick={(e) => handleToggleMode(e, mode as "plan" | "review")}
                  className={`px-1.5 py-0.5 border-r transition-colors ${
                    isEnabled
                      ? `border-hacker-border ${cfg.color}`
                      : "border-hacker-border/30 text-hacker-text-dim/40 hover:text-hacker-text-dim"
                  }`}
                  title={isEnabled ? `Disable ${cfg.label}` : `Enable ${cfg.label}`}
                >
                  <Power size={8} />
                </button>
              )}

              {/* Main clickable zone */}
              <div className={`flex items-center gap-1 px-1.5 py-0.5 cursor-pointer ${
                isVisuallyActive ? "" : isOverriddenByPlan ? "opacity-40" : ""
              }`}>
                <span className={`text-xs ${isVisuallyActive ? cfg.color : ""}`}>{cfg.icon}</span>
                <span className={`text-[10px] font-bold tracking-wide ${
                  isVisuallyActive ? cfg.color : "text-hacker-text-dim"
                }`}>
                  {isVisuallyActive ? getShortModelName(model) : cfg.label}
                </span>
                <ChevronDown size={8} className={`text-hacker-text-dim transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} />
              </div>
            </button>

            {/* Dropdown */}
            {isDropdownOpen && (
              <div className="absolute top-full right-0 mt-1 w-[220px] bg-hacker-surface border border-hacker-border-bright shadow-lg z-50">
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-hacker-bg/50 border-b border-hacker-border/50">
                  <span className={`text-[10px] font-bold tracking-wider ${isEnabled ? cfg.color : "text-hacker-text-dim"}`}>
                    {cfg.icon} {cfg.label} {isCode ? "(always on)" : isEnabled ? "● ON" : "○ OFF"}
                  </span>
                </div>

                {/* Model list (only if enabled) */}
                {isEnabled && library && library.models.length > 0 ? (
                  <div className="max-h-[150px] overflow-y-auto">
                    {library.models.map((m) => {
                      const isModelSelected = m.id === (pm as any)[mode]?.modelId;
                      const isDefault = m.id === library.defaultModelId;
                      return (
                        <button
                          key={m.id}
                          onClick={() => handleSelectModel(mode, m.id)}
                          className={`w-full text-left px-3 py-1 text-[10px] flex items-center gap-1.5 ${
                            isModelSelected
                              ? `bg-hacker-accent/10 ${cfg.color}`
                              : "text-hacker-text-dim hover:bg-hacker-border/30 hover:text-hacker-text"
                          }`}>
                          <Star size={8} className={isDefault ? "text-hacker-accent fill-hacker-accent shrink-0" : "text-transparent shrink-0"} />
                          <span className="truncate flex-1">{m.name}</span>
                          {m.providerId && <span className="text-[8px] text-hacker-text-dim shrink-0">({m.providerId})</span>}
                          {isModelSelected && <span className={`${cfg.color} text-[8px] shrink-0`}>●</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : isEnabled ? (
                  <div className="px-3 py-1.5 text-[9px] text-hacker-text-dim italic">
                    No models configured
                  </div>
                ) : null}

                {/* Switch to mode button (if enabled and not active) */}
                {isEnabled && !isActive && model && (
                  <button
                    onClick={() => { onModeSwitch?.(mode); setOpenMode(null); }}
                    className={`w-full text-left px-3 py-1.5 text-[10px] ${cfg.color} font-bold border-t border-hacker-border/30 hover:bg-hacker-accent/5`}>
                    → Switch to {cfg.label}
                  </button>
                )}

                {/* Max reviews (REVIEW only) */}
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

function defaultProjectMode(): ProjectModeConfig {
  return {
    code: { modelId: null },
    plan: { modelId: null, enabled: false },
    review: { modelId: null, enabled: false, maxReviews: 1 },
  };
}