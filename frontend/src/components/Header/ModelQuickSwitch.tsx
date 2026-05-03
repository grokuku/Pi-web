import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, Power, Zap } from "lucide-react";
import type { ModelLibrary, AgentMode, ModelEntry } from "../../types";

const MODE_CONFIG: Record<AgentMode, { icon: string; label: string; color: string }> = {
  code: { icon: "⚡", label: "CODE", color: "text-hacker-accent" },
  commit: { icon: "📝", label: "COMMIT", color: "text-hacker-text" },
  plan: { icon: "🗺", label: "PLAN", color: "text-hacker-info" },
  review: { icon: "📋", label: "REVIEW", color: "text-hacker-warn" },
};

interface Props {
  activeMode?: string;  // current mode from the backend session
  onModeSwitch?: (mode: AgentMode) => void;
  onModelApplied?: () => void;
}

export function ModelQuickSwitch({ activeMode, onModeSwitch, onModelApplied }: Props) {
  const [openMode, setOpenMode] = useState<AgentMode | null>(null);
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Load library
  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      const data = await res.json();
      setLibrary(data);
    } catch {}
  }, []);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  // Reload library when mode is applied (model might have changed)
  useEffect(() => {
    if (onModelApplied) loadLibrary();
  }, [onModelApplied, loadLibrary]);

  // Close on click outside
  useEffect(() => {
    if (!openMode) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpenMode(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openMode]);

  const handleSelectModel = async (mode: AgentMode, entryId: string) => {
    try {
      const res = await fetch(`/api/model-library/modes/${mode}/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      if (!res.ok) { console.error("Failed to set active model:", await res.text()); return; }
      const data = await res.json();
      setLibrary(data);
      onModelApplied?.();
    } catch (e) { console.error("handleSelectModel error:", e); }
    setOpenMode(null);
  };

  const handleToggleMode = async (e: React.MouseEvent, mode: AgentMode, enabled: boolean) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/model-library/modes/${mode}/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) { console.error("Failed to toggle mode:", await res.text()); return; }
      const data = await res.json();
      setLibrary(data);
      onModelApplied?.();
    } catch (e) { console.error("handleToggleMode error:", e); }
  };

  const handleChipClick = (mode: AgentMode) => {
    const cfg = library?.modes[mode];
    // If clicking the currently active mode, open dropdown
    if (mode === activeMode) {
      setOpenMode(openMode === mode ? null : mode);
      return;
    }
    // If mode is enabled with a model, switch to it
    if (cfg?.enabled && cfg?.activeModelId) {
      onModeSwitch?.(mode);
      setOpenMode(null);
    } else {
      // Open dropdown to configure
      setOpenMode(openMode === mode ? null : mode);
    }
  };

  const getActiveModelName = (mode: AgentMode): string => {
    const cfg = library?.modes[mode];
    if (!cfg?.activeModelId || !cfg?.models) return "—";
    const entry = cfg.models.find((m) => m.id === cfg.activeModelId);
    if (!entry) return "—";
    const name = entry.name;
    if (name.includes("claude")) return name.replace("Claude ", "C").replace("claude-", "c");
    if (name.includes("GPT")) return name.replace("GPT-", "G");
    if (name.includes("o1")) return name.replace("o1-", "o1");
    return name.length > 10 ? name.slice(0, 10) + "…" : name;
  };

  const modes: AgentMode[] = ["code", "plan", "review"];

  return (
    <div ref={ref} className="flex items-center gap-1.5">
      {modes.map((mode) => {
        const cfg = library?.modes[mode];
        const isEnabled = cfg?.enabled ?? false;
        const hasModel = !!(cfg?.activeModelId);
        const isActive = activeMode === mode && isEnabled && hasModel;
        const cfg2 = MODE_CONFIG[mode];
        const isDropdownOpen = openMode === mode;

        return (
          <div key={mode} className="relative">
            <button
              onClick={() => handleChipClick(mode)}
              className={`mode-chip flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-sm ${
                isActive ? "active" : isEnabled ? "" : "disabled"
              }`}
            >
              <span className="mode-chip-toggle" />
              <span className={`mode-chip-label font-bold tracking-wide ${isActive ? cfg2.color : "text-hacker-text-dim"}`}>
                {cfg2.icon}
              </span>
              <span className={`mode-chip-label ${isActive ? "" : "text-hacker-text-dim"}`}>
                {isActive ? getActiveModelName(mode) : cfg2.label}
              </span>
              <ChevronDown size={8} className={`text-hacker-text-dim transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} />
            </button>

            {isDropdownOpen && (
              <div className="absolute top-full right-0 mt-1 w-[200px] bg-hacker-surface border border-hacker-border-bright shadow-lg z-50">
                {/* Mode header with toggle */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-hacker-bg/50 border-b border-hacker-border/50">
                  <span className={`text-[10px] font-bold tracking-wider ${isEnabled && hasModel ? cfg2.color : "text-hacker-text-dim"}`}>
                    {cfg2.icon} {cfg2.label}
                  </span>
                  <button
                    onClick={(e) => handleToggleMode(e, mode, !isEnabled)}
                    className={`text-[9px] px-1.5 py-0.5 border ${
                      isEnabled
                        ? "border-hacker-accent/50 text-hacker-accent bg-hacker-accent/10"
                        : "border-hacker-border text-hacker-text-dim"
                    }`}
                  >
                    <Power size={8} />
                  </button>
                </div>

                {/* Switch to this mode button (if not active but enabled) */}
                {isEnabled && hasModel && !isActive && (
                  <button
                    onClick={() => { onModeSwitch?.(mode); setOpenMode(null); }}
                    className="w-full text-left px-3 py-1.5 text-[10px] text-hacker-accent font-bold border-b border-hacker-border/50 hover:bg-hacker-accent/5"
                  >
                    → Switch to {cfg2.label} mode
                  </button>
                )}

                {/* Models list */}
                {isEnabled && cfg?.models && cfg.models.length > 0 ? (
                  cfg.models.map((entry) => {
                    const isModelActive = entry.id === cfg.activeModelId;
                    return (
                      <button
                        key={entry.id}
                        onClick={() => handleSelectModel(mode, entry.id)}
                        className={`w-full text-left px-3 py-1 text-[10px] flex items-center gap-1.5 ${
                          isModelActive
                            ? "bg-hacker-accent/10 text-hacker-accent"
                            : "text-hacker-text-dim hover:bg-hacker-border/30 hover:text-hacker-text"
                        }`}
                      >
                        <Zap size={8} className={isModelActive ? "text-hacker-accent" : "text-transparent"} />
                        <span className="truncate flex-1">{entry.name}</span>
                        {isModelActive && <span className="text-hacker-accent text-[8px]">●</span>}
                      </button>
                    );
                  })
                ) : (
                  <div className="px-3 py-1.5 text-[9px] text-hacker-text-dim italic">
                    {!isEnabled ? "Disabled" : "No models"}
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