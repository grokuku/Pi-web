import { useState } from "react";
import { loadPersistedLayout, savePersistedLayout } from "../../Layout/LayoutRenderer";
import type { LayoutType, PanelId } from "../../../types";
import { PANEL_LABELS } from "../../../types";

// ── Layout Tab ──────────────────────────────────────────

const LAYOUT_LABELS_2: Record<string, string> = {
  "horizontal-2": "◫ Side by side",
  "vertical-2": "⬜ Stacked",
};

const LAYOUT_LABELS_3: Record<string, string> = {
  "horizontal-3": "◫◫◫ 3 columns",
  "vertical-3": "3 rows",
  "top-2-bottom-1": "2 top / 1 bottom",
  "top-1-bottom-2": "1 top / 2 bottom",
  "left-2-right-1": "2 left / 1 right",
  "left-1-right-2": "1 left / 2 right",
};

function LayoutTab({ onLayoutChange }: { onLayoutChange: () => void }) {
  const [cfg, setCfg] = useState(() => {
    const saved = loadPersistedLayout();
    return saved || {
      layout2: "horizontal-2" as const,
      layout3: "horizontal-3" as LayoutType,
      slotOrder: ["pi" as PanelId, "terminal" as PanelId, "files" as PanelId],
      sizes: {} as Record<string, number[]>,
    };
  });

  const save = (updates: Partial<typeof cfg>) => {
    setCfg(prev => {
      const next = { ...prev, ...updates };
      savePersistedLayout(next);
      return next;
    });
    onLayoutChange();
  };

  return (
    <div className="p-3 space-y-4">
      <div className="text-[11px] text-hacker-text-dim">
        Configure the layout for 2 and 3 active panels. Switch panels ON/OFF via the header buttons.
        Use the dropdown in each panel's header to swap modules.
      </div>

      {/* 2-panel layout */}
      <div className="border border-hacker-border bg-hacker-surface/50">
        <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50">
          <span className="text-xs font-bold text-hacker-accent tracking-wider">2 PANELS</span>
        </div>
        <div className="p-2 flex gap-2">
          {Object.entries(LAYOUT_LABELS_2).map(([type, label]) => (
            <button
              key={type}
              onClick={() => save({ layout2: type as "horizontal-2" | "vertical-2" })}
              className={`flex-1 text-left px-3 py-2 text-xs border transition-colors ${
                cfg.layout2 === type
                  ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                  : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50 hover:text-hacker-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 3-panel layout */}
      <div className="border border-hacker-border bg-hacker-surface/50">
        <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50">
          <span className="text-xs font-bold text-hacker-accent tracking-wider">3 PANELS</span>
        </div>
        <div className="p-2 grid grid-cols-2 gap-2">
          {Object.entries(LAYOUT_LABELS_3).map(([type, label]) => (
            <button
              key={type}
              onClick={() => save({ layout3: type as LayoutType })}
              className={`text-left px-3 py-2 text-xs border transition-colors ${
                cfg.layout3 === type
                  ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                  : "border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50 hover:text-hacker-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Slot order */}
      <div className="border border-hacker-border bg-hacker-surface/50">
        <div className="px-3 py-2 border-b border-hacker-border bg-hacker-bg/50">
          <span className="text-xs font-bold text-hacker-accent tracking-wider">DEFAULT SLOT ORDER</span>
        </div>
        <div className="p-2">
          <div className="text-[10px] text-hacker-text-dim mb-2">
            Order determines which panel goes in which position. Swap at runtime via dropdowns.
          </div>
          <div className="flex items-center gap-1 text-xs">
            {cfg.slotOrder.map((id, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-hacker-text-dim">→</span>}
                <span className="text-hacker-accent px-2 py-0.5 border border-hacker-border bg-hacker-bg/50">
                  {PANEL_LABELS[id]}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="text-[10px] text-hacker-text-dim italic">
        Drag dividers between panels to resize. Sizes are saved per layout type.
      </div>
    </div>
  );
}

export default LayoutTab;
