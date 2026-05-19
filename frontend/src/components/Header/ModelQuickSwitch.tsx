import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, Power, Star } from "lucide-react";
import { PiLogo } from "../common/PiLogo";
import { useTranslation } from "../../i18n";
import { YoloConfigModal } from "../Modals/YoloConfigModal";
import type { ModelLibrary, RegisteredModel, AgentMode, ProjectModeConfig, ProviderConfig, YoloConfig } from "../../types";

const MODE_CONFIG: Record<AgentMode, { icon: React.ReactNode; label: string; color: string; activeBg: string; activeBorder: string }> = {
  code:   { icon: <PiLogo className="w-3.5 h-3.5 inline" />, label: "CODE",   color: "text-hacker-accent",      activeBg: "bg-hacker-accent/20", activeBorder: "border-hacker-accent" },
  yolo:   { icon: "🤝", label: "YOLO",   color: "text-hacker-accent",      activeBg: "bg-hacker-accent/20", activeBorder: "border-hacker-accent" },
  plan:   { icon: "🗺", label: "PLAN",   color: "text-hacker-info",       activeBg: "bg-hacker-info/20",    activeBorder: "border-hacker-info" },
  review: { icon: "📋", label: "REVIEW", color: "text-hacker-warn",       activeBg: "bg-hacker-warn/20",    activeBorder: "border-hacker-warn" },
};

interface Props {
  activeMode?: string;
  activeProjectId?: string;
  modelChangeVersion?: number;
  onModeSwitch?: (mode: AgentMode) => void;
  onModelApplied?: () => void;
}

export function ModelQuickSwitch({ activeMode, activeProjectId, modelChangeVersion, onModeSwitch, onModelApplied }: Props) {
  const { t } = useTranslation();
  const [openMode, setOpenMode] = useState<AgentMode | null>(null);
  const [showYoloConfig, setShowYoloConfig] = useState(false);
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      setLibrary(await res.json());
    } catch {}
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      setProviders(await res.json());
    } catch {}
  }, []);

  useEffect(() => { loadLibrary(); loadProviders(); }, [loadLibrary, loadProviders]);
  // Reload when models change externally (e.g. from ModelLibraryModal)
  useEffect(() => { loadLibrary(); }, [modelChangeVersion, loadLibrary]);

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
  const yoloConfig: YoloConfig = pm.yolo?.config || { model1: null, model2: null, planCycles: 2, codeCycles: 2, globalCycles: 1 };

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

  const handleToggleMode = async (e: React.MouseEvent, mode: "plan" | "review" | "yolo") => {
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

      // If enabling PLAN or YOLO, also switch to that mode
      if ((mode === "plan" || mode === "yolo") && newEnabled) {
        onModeSwitch?.(mode);
      }
      // If disabling and was active, switch back to code
      if (!newEnabled && activeMode === mode) {
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
    if (mode === "yolo" && pm.yolo?.enabled && activeMode === "yolo") {
      setShowYoloConfig(true);
      return;
    }
    if (openMode === mode) { setOpenMode(null); return; }
    setOpenMode(mode);
  };

  const getShortModelName = (model: RegisteredModel | null): string => {
    if (!model) return "—";
    return model.name || model.id;
  };

  const getProviderName = (providerId: string): string => {
    const p = providers.find(p => p.id === providerId);
    if (!p) return "";
    const name = p.name || p.type || providerId;
    if (name.length <= 15) return name;
    return name.slice(0, 12) + "…";
  };

  const modes: AgentMode[] = ["code", "plan", "review", "yolo"];

  return (
    <>
    <div ref={ref} className="flex items-center gap-1.5">
      {modes.map((mode) => {
        const cfg = MODE_CONFIG[mode];
        const model = getModelForMode(mode);
        const isCode = mode === "code";
        const modeCfg = mode !== "code" ? (pm as any)[mode] : null;
        const isEnabled = isCode || (modeCfg?.enabled ?? false);
        const isActive = activeMode === mode && isEnabled;
        const isDropdownOpen = openMode === mode;

        // Visual states
        const isPlanActive = pm.plan.enabled && activeMode === "plan";
        const isReviewActive = pm.review.enabled && (activeMode === "review");
        const isOverridden = !isCode && (
          (isPlanActive && mode !== "plan") ||
          (isReviewActive && mode !== "review" && !pm.review.enabled)
        );
        const isVisuallyActive = isActive || (mode !== "code" && isEnabled);

        return (
          <div key={mode} className="relative">
            {/* Main button — integrated ON/OFF */}
            <button
              className={`flex items-center border rounded transition-all ${
                isVisuallyActive
                  ? `${cfg.activeBg} ${cfg.activeBorder} ${cfg.color}`
                  : isOverridden
                  ? "bg-hacker-bg border-hacker-border/50 text-hacker-text-dim/50"
                  : isEnabled
                  ? "bg-hacker-bg border-hacker-border text-hacker-text-dim"
                  : "bg-hacker-bg border-hacker-border/40 text-hacker-text-dim/50"
              }`}
              onClick={() => handleChipClick(mode)}
            >
              {/* ON/OFF toggle zone (left part of button) */}
              {!isCode && (
                <div
                  onClick={(e) => handleToggleMode(e, mode as "plan" | "review" | "yolo")}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); handleToggleMode(e as any, mode as "plan" | "review" | "yolo"); } }}
                  className={`px-2 py-1 border-r transition-colors cursor-pointer ${
                    isEnabled
                      ? `border-hacker-border/60 ${cfg.color}`
                      : "border-hacker-border/20 text-hacker-text-dim/30 hover:text-hacker-text-dim"
                  }`}
                  title={isEnabled ? t('modelSwitch.disable', t('modelSwitch.' + mode)) : t('modelSwitch.enable', t('modelSwitch.' + mode))}
                >
                  <Power size={10} />
                </div>
              )}

              <div className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer ${
                isVisuallyActive ? "" : isOverridden ? "opacity-40" : ""
              }`}>
                <span className={`text-xs ${isVisuallyActive ? cfg.color : ""}`}>{cfg.icon}</span>
                <span className={`text-xs font-bold tracking-wide ${
                  isVisuallyActive ? cfg.color : "text-hacker-text-dim"
                }`}>
                  {t('modelSwitch.' + mode)}
                </span>
                {isVisuallyActive && (
                  <span className="text-xs text-hacker-text-dim">{getShortModelName(model)}</span>
                )}
                <ChevronDown size={10} className={`text-hacker-text-dim transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} />
              </div>
            </button>

            {/* Dropdown — always shows model list regardless of enabled state */}
            {isDropdownOpen && (
              <div className="absolute top-full right-0 mt-1 w-[350px] bg-hacker-surface border border-hacker-border-bright shadow-lg z-50">
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-hacker-bg/50 border-b border-hacker-border/50">
                  <span className={`text-xs font-bold tracking-wider ${isEnabled ? cfg.color : "text-hacker-text-dim"}`}>
                    {cfg.icon} {t('modelSwitch.' + mode)} {isCode ? t('modelSwitch.alwaysOn') : isEnabled ? "● ON" : "○ OFF"}
                  </span>
                </div>

                {/* Model list — always shown */}
                {mode === "yolo" ? (
                  <div className="px-3 py-3 space-y-2">
                    <p className="text-[11px] text-hacker-text-dim">
                      YOLO uses two AI agents debating together. Configure both models and debate cycles.
                    </p>
                    {pm.yolo?.config?.model1 ? (
                      <div className="text-[11px] text-hacker-text-dim">
                        Agent 1: <span className="text-hacker-accent">{library?.models.find(m => m.providerId === pm.yolo.config.model1?.providerId && m.modelId === pm.yolo.config.model1?.modelId)?.name || `${pm.yolo.config.model1.providerId}/${pm.yolo.config.model1.modelId}`}</span>
                        <br />
                        Agent 2: <span className="text-hacker-accent">{library?.models.find(m => m.providerId === pm.yolo.config.model2?.providerId && m.modelId === pm.yolo.config.model2?.modelId)?.name || `${pm.yolo.config.model2?.providerId}/${pm.yolo.config.model2?.modelId}`}</span>
                        <br />
                        Plan: <span className="text-hacker-accent">{pm.yolo.config.planCycles}x</span> · Code: <span className="text-hacker-accent">{pm.yolo.config.codeCycles}x</span> · Global: <span className="text-hacker-accent">{pm.yolo.config.globalCycles}x</span>
                      </div>
                    ) : (
                      <p className="text-[11px] text-hacker-text-dim italic">Not configured yet.</p>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setOpenMode(null); setShowYoloConfig(true); }}
                      className="w-full btn-hacker text-xs px-3 py-1.5"
                    >
                      ⚙ CONFIGURE YOLO
                    </button>
                  </div>
                ) : library && library.models.length > 0 ? (
                  <div className="max-h-[300px] overflow-y-auto">
                    {[...library.models].sort((a, b) => a.name.localeCompare(b.name)).map((m) => {
                      const isModelSelected = m.id === (pm as any)[mode]?.modelId;
                      const isDefault = m.id === library.defaultModelId;
                      return (
                        <button
                          key={m.id}
                          onClick={() => handleSelectModel(mode, m.id)}
                          className={`w-full text-left px-3 py-1 text-xs flex items-center gap-1.5 ${
                            isModelSelected
                              ? `bg-hacker-accent/10 ${cfg.color}`
                              : "text-hacker-text-dim hover:bg-hacker-border/30 hover:text-hacker-text"
                          }`}>
                          <Star size={8} className={isDefault ? "text-hacker-accent fill-hacker-accent shrink-0" : "text-transparent shrink-0"} />
                          <span className="truncate flex-1">{m.name}</span>
                          {m.providerId && getProviderName(m.providerId) && <span className="text-[10px] text-hacker-text-dim shrink-0">({getProviderName(m.providerId)})</span>}
                          {isModelSelected && <span className={`${cfg.color} text-[10px] shrink-0`}>●</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-3 py-1.5 text-[11px] text-hacker-text-dim italic">
                    No models configured
                  </div>
                )}

                {/* Switch to mode button (if enabled and not active) */}
                {isEnabled && !isActive && (model || mode === "yolo") && (
                  <button
                    onClick={() => { onModeSwitch?.(mode); setOpenMode(null); }}
                    className={`w-full text-left px-3 py-1.5 text-xs ${cfg.color} font-bold border-t border-hacker-border/30 hover:bg-hacker-accent/5`}>
                    → {t('modelSwitch.switchTo', t('modelSwitch.' + mode))}
                  </button>
                )}

                {/* Max reviews (REVIEW only, always show if enabled) */}
                {mode === "review" && isEnabled && (
                  <div className="flex items-center gap-2 px-3 py-1.5 border-t border-hacker-border/30">
                    <span className="text-[11px] text-hacker-text-dim">🔄 MAX REVIEWS</span>
                    <select
                      value={(pm.review as any).maxReviews ?? 1}
                      onChange={(e) => handleMaxReviews(Number(e.target.value))}
                      className="select-hacker text-[10px] py-0 px-1 max-w-[48px]"
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
      {showYoloConfig && (
        <YoloConfigModal
          onClose={() => setShowYoloConfig(false)}
          onChange={async (cfg) => {
            if (!activeProjectId) return;
            try {
              await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: "yolo", config: cfg }),
              });
              await loadLibrary();
              onModelApplied?.();
            } catch (e) { console.error("Save yolo config:", e); }
          }}
          models={library?.models || []}
          providers={providers}
          config={yoloConfig}
        />
      )}
    </>
  );
}

function defaultProjectMode(): ProjectModeConfig {
  return {
    code: { modelId: null },
    plan: { modelId: null, enabled: false },
    review: { modelId: null, enabled: false, maxReviews: 1 },
    yolo: { modelId: null, enabled: false,
      config: { model1: null, model2: null, planCycles: 2, codeCycles: 2, globalCycles: 1 } },
  };
}