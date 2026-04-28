import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, Zap, Power } from "lucide-react";
import type { ModelLibrary, AgentMode, ModelEntry } from "../../types";

const MODE_LABELS: Record<AgentMode, { icon: string; label: string }> = {
  code: { icon: "⚡", label: "CODE" },
  review: { icon: "📋", label: "REVIEW" },
  plan: { icon: "🗺", label: "PLAN" },
};

interface Props {
  onModelApplied?: () => void;
}

export function ModelQuickSwitch({ onModelApplied }: Props) {
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Load library when dropdown opens
  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      const data = await res.json();
      setLibrary(data);
    } catch {}
  }, []);

  useEffect(() => {
    if (open) loadLibrary();
  }, [open, loadLibrary]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // ── Get current mode + model for display ──
  const getCurrentDisplay = (): string => {
    if (!library) return "No model";
    for (const mode of Object.keys(library.modes) as AgentMode[]) {
      const cfg = library.modes[mode];
      if (!cfg.enabled || !cfg.activeModelId) continue;
      const entry = cfg.models.find((m) => m.id === cfg.activeModelId);
      if (entry) {
        return `${MODE_LABELS[mode].icon} ${entry.name}`;
      }
    }
    return "No model";
  };

  // ── Switch active model ──
  const handleSelectModel = async (mode: AgentMode, entryId: string) => {
    try {
      const res = await fetch(`/api/model-library/modes/${mode}/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      const data = await res.json();
      setLibrary(data);
      onModelApplied?.();
    } catch {}
    setOpen(false);
  };

  // ── Toggle mode ──
  const handleToggleMode = async (e: React.MouseEvent, mode: AgentMode, enabled: boolean) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/model-library/modes/${mode}/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      setLibrary(data);
    } catch {}
  };

  // ── Find the first enabled mode with an active model ──
  const activeMode = library
    ? (Object.keys(library.modes) as AgentMode[]).find(
        (m) => library.modes[m].enabled && library.modes[m].activeModelId
      ) || "code"
    : "code";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-hacker-text-dim hover:text-hacker-text px-2 py-1 border border-hacker-border-bright hover:border-hacker-accent/50 transition-colors"
      >
        <span className="text-hacker-accent truncate max-w-[160px]">{getCurrentDisplay()}</span>
        <ChevronDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-[240px] bg-hacker-surface border border-hacker-border-bright shadow-lg z-50 animate-in fade-in slide-in-from-top-1">
          {(Object.keys(MODE_LABELS) as AgentMode[]).map((mode) => {
            const cfg = library?.modes[mode];
            const isActive = cfg?.enabled && !!cfg?.activeModelId;
            const label = MODE_LABELS[mode];

            return (
              <div key={mode} className="border-b border-hacker-border/50 last:border-0">
                {/* Mode header */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-hacker-bg/50">
                  <span className={`text-[10px] font-bold tracking-wider ${
                    isActive ? "text-hacker-accent" : "text-hacker-text-dim"
                  }`}>
                    {label.icon} {label.label}
                  </span>
                  <button
                    onClick={(e) => handleToggleMode(e, mode, !cfg?.enabled)}
                    className={`text-[9px] px-1.5 py-0.5 border ${
                      cfg?.enabled
                        ? "border-hacker-accent/50 text-hacker-accent"
                        : "border-hacker-border text-hacker-text-dim"
                    }`}
                  >
                    <Power size={8} />
                  </button>
                </div>

                {/* Models for this mode */}
                {cfg?.enabled && cfg.models.length > 0 ? (
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
                    {cfg?.models.length === 0 ? "No models" : "Disabled"}
                  </div>
                )}
              </div>
            );
          })}

          {/* Open settings link */}
          <div className="px-3 py-2 border-t border-hacker-border-bright">
            <button
              onClick={() => { setOpen(false); }}
              className="text-[9px] text-hacker-text-dim hover:text-hacker-accent w-full text-center"
              title="Open Settings (Ctrl+L)"
            >
              ⚙ Manage models...
            </button>
          </div>
        </div>
      )}
    </div>
  );
}