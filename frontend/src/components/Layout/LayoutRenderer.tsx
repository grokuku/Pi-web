import { useState, useRef, useEffect, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { LayoutType, PanelId } from "../../types";
import { PANEL_LABELS } from "../../types";

// ── Persistence ─────────────────────────────────────

const LAYOUT_KEY = "pi-web-layout";

export interface PersistedLayout {
  layout2: "horizontal-2" | "vertical-2";
  layout3: LayoutType;
  slotOrder: PanelId[];
  sizes: Record<string, number[]>;
}

export function loadPersistedLayout(): PersistedLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Migration: old format { type, slots, sizes } → new format
    if (parsed && !parsed.slotOrder && parsed.slots) {
      return {
        layout2: "horizontal-2",
        layout3: "horizontal-3",
        slotOrder: Array.isArray(parsed.slots) ? parsed.slots : ["pi", "terminal", "files"],
        sizes: typeof parsed.sizes === "object" && !Array.isArray(parsed.sizes) ? parsed.sizes : {},
      };
    }
    if (parsed && Array.isArray(parsed.slotOrder)) return parsed;
    return null;
  } catch { return null; }
}

export function savePersistedLayout(cfg: PersistedLayout) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(cfg)); } catch {}
}

// ── Props ────────────────────────────────────────────

interface Props {
  orderedPanels: PanelId[];
  layoutType: LayoutType;
  sizes: Record<string, number[]>;
  panelContent: Record<PanelId, ReactNode>;
  onSwap: (fromIndex: number, toIndex: number) => void;
  onDetach: (id: PanelId) => void;
  onNewWindow: (id: PanelId) => void;
  onSizesChange: (layoutType: string, newSizes: number[]) => void;
}

// ── Layout Renderer ──────────────────────────────────

export function LayoutRenderer({
  orderedPanels,
  layoutType,
  sizes,
  panelContent,
  onSwap,
  onDetach,
  onNewWindow,
  onSizesChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const count = orderedPanels.length;
  const layoutKey = count <= 1 ? "single" : layoutType;
  const persistedSizes = sizes[layoutKey] || defaultSizes(layoutKey, count);
  const [localSizes, setLocalSizes] = useState<number[]>(persistedSizes);
  const [isDragging, setIsDragging] = useState(false);
  const sizesRef = useRef(localSizes);
  sizesRef.current = localSizes;
  const dragRef = useRef<{
    dividerIndex: number;
    axis: "x" | "y";
    startPos: number;
    startSizes: number[];
    containerSize: number;
  } | null>(null);

  // Sync sizes from parent when layout type changes (not during drag)
  useEffect(() => {
    if (!isDragging) setLocalSizes(persistedSizes);
  }, [layoutKey, isDragging]);

  // ── Resize ──
  const handleDividerDown = (e: React.MouseEvent, dividerIndex: number, axis: "x" | "y") => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current = {
      dividerIndex,
      axis,
      startPos: axis === "x" ? e.clientX : e.clientY,
      startSizes: [...localSizes],
      containerSize: axis === "x" ? rect.width : rect.height,
    };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const d = dragRef.current!;
      const currentPos = d.axis === "x" ? e.clientX : e.clientY;
      const delta = currentPos - d.startPos;
      const frac = delta / d.containerSize;
      const newSizes = [...d.startSizes];
      const idx = d.dividerIndex;
      const minSize = 0.1;
      // Clamp: don't let panels get smaller than 10%
      let clamped = frac;
      if (newSizes[idx] + clamped < minSize) clamped = minSize - newSizes[idx];
      if (newSizes[idx + 1] - clamped < minSize) clamped = newSizes[idx + 1] - minSize;
      newSizes[idx] += clamped;
      newSizes[idx + 1] -= clamped;
      // Normalize to sum = 1
      const sum = newSizes.reduce((a, b) => a + b, 0);
      for (let i = 0; i < newSizes.length; i++) newSizes[i] /= sum;
      setLocalSizes(newSizes);
    };
    const handleUp = () => {
      setIsDragging(false);
      if (dragRef.current) {
        const s = sizesRef.current;
        // Normalize before saving
        const sum = s.reduce((a, b) => a + b, 0);
        const normalized = s.map(v => v / sum);
        onSizesChange(layoutKey, normalized);
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging, layoutKey, onSizesChange]);

  // ── Render helpers ──

  const Divider = ({ axis }: { axis: "x" | "y" }) => (
    <div
      className={`shrink-0 bg-hacker-border/30 transition-colors ${
        axis === "x"
          ? "w-1.5 cursor-col-resize hover:bg-hacker-accent/40 active:bg-hacker-accent/60"
          : "h-1.5 cursor-row-resize hover:bg-hacker-accent/40 active:bg-hacker-accent/60"
      }`}
    />
  );

  const ThinDivider = ({ axis }: { axis: "x" | "y" }) => (
    <div className={`shrink-0 bg-hacker-border/20 ${axis === "x" ? "w-px" : "h-px"}`} />
  );

  // ── Empty state ──
  if (count === 0) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-20 select-none pointer-events-none">
        <span className="text-[12rem] leading-none glitch">⚡</span>
      </div>
    );
  }

  // ── Build slot array: each slot has { panelId, flexStyle }
  const s = localSizes;
  const slots: { id: PanelId; style: React.CSSProperties }[] = [];

  if (count === 1) {
    slots.push({ id: orderedPanels[0], style: { width: "100%", height: "100%" } });
  } else if (count === 2) {
    if (layoutType === "vertical-2") {
      slots.push({ id: orderedPanels[0], style: { height: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[1], style: { height: `${s[1] * 100}%` } });
    } else {
      slots.push({ id: orderedPanels[0], style: { width: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[1], style: { width: `${s[1] * 100}%` } });
    }
  } else if (count === 3) {
    if (layoutType === "horizontal-3") {
      slots.push({ id: orderedPanels[0], style: { width: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[1], style: { width: `${s[1] * 100}%` } });
      slots.push({ id: orderedPanels[2], style: { width: `${s[2] * 100}%` } });
    } else if (layoutType === "vertical-3") {
      slots.push({ id: orderedPanels[0], style: { height: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[1], style: { height: `${s[1] * 100}%` } });
      slots.push({ id: orderedPanels[2], style: { height: `${s[2] * 100}%` } });
    } else if (layoutType === "top-2-bottom-1") {
      slots.push({ id: orderedPanels[0], style: { width: "50%", height: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[1], style: { width: "50%", height: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[2], style: { height: `${s[1] * 100}%` } });
    } else if (layoutType === "top-1-bottom-2") {
      slots.push({ id: orderedPanels[0], style: { height: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[1], style: { width: "50%", height: `${s[1] * 100}%` } });
      slots.push({ id: orderedPanels[2], style: { width: "50%", height: `${s[1] * 100}%` } });
    } else if (layoutType === "left-2-right-1") {
      slots.push({ id: orderedPanels[0], style: { height: "50%", width: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[1], style: { height: "50%", width: `${s[0] * 100}%` } });
      slots.push({ id: orderedPanels[2], style: { width: `${s[1] * 100}%`, height: "100%" } });
    } else { // left-1-right-2
      slots.push({ id: orderedPanels[0], style: { width: `${s[0] * 100}%`, height: "100%" } });
      slots.push({ id: orderedPanels[1], style: { height: "50%", width: `${s[1] * 100}%` } });
      slots.push({ id: orderedPanels[2], style: { height: "50%", width: `${s[1] * 100}%` } });
    }
  }

  // ── Render a single slot ──
  const renderSlot = (slot: { id: PanelId; style: React.CSSProperties }, idx: number) => (
    <div key={slot.id} style={slot.style} className="overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-2 h-8 border-b border-hacker-border bg-hacker-bg/50 shrink-0">
        <select
          value={slot.id}
          onChange={e => {
            const newId = e.target.value as PanelId;
            const targetIdx = orderedPanels.indexOf(newId);
            if (targetIdx >= 0) onSwap(idx, targetIdx);
          }}
          className="bg-transparent text-xs font-bold text-hacker-accent border-none outline-none cursor-pointer hover:bg-hacker-border/30 px-1 py-0.5 rounded"
        >
          {orderedPanels.map(p => (
            <option key={p} value={p} className="bg-hacker-surface text-hacker-text">
              {PANEL_LABELS[p]}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <button onClick={() => onNewWindow(slot.id)} className="p-1 text-hacker-text-dim hover:text-hacker-accent" title="Open in new window">
            <ExternalLink size={12} />
          </button>
          <button onClick={() => onDetach(slot.id)} className="p-1 text-hacker-text-dim hover:text-hacker-accent" title="Detach">
            <ExternalLink size={12} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">{panelContent[slot.id]}</div>
    </div>
  );

  // ── 1 panel ──
  if (count === 1) {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden">
        {renderSlot(slots[0], 0)}
      </div>
    );
  }

  // ── 2 panels ──
  if (count === 2) {
    const isVertical = layoutType === "vertical-2";
    return (
      <div ref={containerRef} className={`flex-1 flex ${isVertical ? "flex-col" : ""} overflow-hidden`}>
        {renderSlot(slots[0], 0)}
        <div onMouseDown={e => handleDividerDown(e, 0, isVertical ? "y" : "x")}>
          <Divider axis={isVertical ? "y" : "x"} />
        </div>
        {renderSlot(slots[1], 1)}
      </div>
    );
  }

  // ── 3 panels: horizontal-3 ──
  if (layoutType === "horizontal-3") {
    return (
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        {renderSlot(slots[0], 0)}
        <div onMouseDown={e => handleDividerDown(e, 0, "x")}><Divider axis="x" /></div>
        {renderSlot(slots[1], 1)}
        <div onMouseDown={e => handleDividerDown(e, 1, "x")}><Divider axis="x" /></div>
        {renderSlot(slots[2], 2)}
      </div>
    );
  }

  // ── 3 panels: vertical-3 ──
  if (layoutType === "vertical-3") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        {renderSlot(slots[0], 0)}
        <div onMouseDown={e => handleDividerDown(e, 0, "y")}><Divider axis="y" /></div>
        {renderSlot(slots[1], 1)}
        <div onMouseDown={e => handleDividerDown(e, 1, "y")}><Divider axis="y" /></div>
        {renderSlot(slots[2], 2)}
      </div>
    );
  }

  // ── 3 panels: top-2-bottom-1 ──
  if (layoutType === "top-2-bottom-1") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        <div className="flex overflow-hidden" style={{ height: `${s[0] * 100}%` }}>
          {renderSlot(slots[0], 0)}
          <ThinDivider axis="x" />
          {renderSlot(slots[1], 1)}
        </div>
        <div onMouseDown={e => handleDividerDown(e, 0, "y")}><Divider axis="y" /></div>
        <div className="flex-1 overflow-hidden">{renderSlot(slots[2], 2)}</div>
      </div>
    );
  }

  // ── 3 panels: top-1-bottom-2 ──
  if (layoutType === "top-1-bottom-2") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        <div style={{ height: `${s[0] * 100}%`, overflow: "hidden" }}>
          {renderSlot(slots[0], 0)}
        </div>
        <div onMouseDown={e => handleDividerDown(e, 0, "y")}><Divider axis="y" /></div>
        <div className="flex flex-1 overflow-hidden">
          {renderSlot(slots[1], 1)}
          <ThinDivider axis="x" />
          {renderSlot(slots[2], 2)}
        </div>
      </div>
    );
  }

  // ── 3 panels: left-2-right-1 ──
  if (layoutType === "left-2-right-1") {
    return (
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        <div className="flex flex-col overflow-hidden" style={{ width: `${s[0] * 100}%`, height: "100%" }}>
          <div style={{ height: "50%", overflow: "hidden" }}>{renderSlot(slots[0], 0)}</div>
          <ThinDivider axis="y" />
          <div style={{ height: "50%", overflow: "hidden" }}>{renderSlot(slots[1], 1)}</div>
        </div>
        <div onMouseDown={e => handleDividerDown(e, 0, "x")}><Divider axis="x" /></div>
        <div style={{ width: `${s[1] * 100}%`, height: "100%", overflow: "hidden" }}>{renderSlot(slots[2], 2)}</div>
      </div>
    );
  }

  // ── 3 panels: left-1-right-2 ──
  return (
    <div ref={containerRef} className="flex-1 flex overflow-hidden">
      <div style={{ width: `${s[0] * 100}%`, height: "100%", overflow: "hidden" }}>{renderSlot(slots[0], 0)}</div>
      <div onMouseDown={e => handleDividerDown(e, 0, "x")}><Divider axis="x" /></div>
      <div className="flex flex-col overflow-hidden" style={{ width: `${s[1] * 100}%`, height: "100%" }}>
        <div style={{ height: "50%", overflow: "hidden" }}>{renderSlot(slots[1], 1)}</div>
        <ThinDivider axis="y" />
        <div style={{ height: "50%", overflow: "hidden" }}>{renderSlot(slots[2], 2)}</div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────

function defaultSizes(layoutKey: string, count: number): number[] {
  if (count <= 1) return [1];
  if (count === 2) return [0.6, 0.4];
  if (layoutKey === "horizontal-3" || layoutKey === "vertical-3") return [0.4, 0.3, 0.3];
  return [0.5, 0.5]; // compound layouts
}
