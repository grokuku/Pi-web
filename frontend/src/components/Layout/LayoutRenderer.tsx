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
  const [flexSizes, setFlexSizes] = useState<number[]>(persistedSizes);
  const [isDragging, setIsDragging] = useState(false);
  const sizesRef = useRef(flexSizes);
  sizesRef.current = flexSizes;
  const dragRef = useRef<{
    dividerIndex: number;
    axis: "x" | "y";
    startPos: number;
    startSizes: number[];
    containerSize: number;
  } | null>(null);

  useEffect(() => {
    if (!isDragging) setFlexSizes(persistedSizes);
  }, [layoutKey, isDragging]);

  // ── Resize ──
  const handleDividerDown = (e: React.MouseEvent, dividerIndex: number, axis: "x" | "y") => {
    e.preventDefault();
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current = {
      dividerIndex,
      axis,
      startPos: axis === "x" ? e.clientX : e.clientY,
      startSizes: [...flexSizes],
      containerSize: axis === "x" ? rect.width : rect.height,
    };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const d = dragRef.current!;
      const currentPos = d.axis === "x" ? e.clientX : e.clientY;
      const deltaPx = currentPos - d.startPos;
      // Convert px delta to flex-grow delta
      const totalGrow = d.startSizes.reduce((a, b) => a + b, 0);
      const deltaGrow = (deltaPx / d.containerSize) * totalGrow;
      const newSizes = [...d.startSizes];
      const idx = d.dividerIndex;
      const minGrow = totalGrow * 0.05; // min 5% of total
      let clamped = deltaGrow;
      if (newSizes[idx] + clamped < minGrow) clamped = minGrow - newSizes[idx];
      if (newSizes[idx + 1] - clamped < minGrow) clamped = newSizes[idx + 1] - minGrow;
      newSizes[idx] += clamped;
      newSizes[idx + 1] -= clamped;
      setFlexSizes(newSizes);
    };
    const handleUp = () => {
      setIsDragging(false);
      if (dragRef.current) {
        onSizesChange(layoutKey, [...sizesRef.current]);
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

  // ── Panel slot ──
  const renderSlot = (panelId: PanelId, idx: number, flexGrow: number, extraStyle?: React.CSSProperties) => (
    <div key={panelId} style={{ flex: `${flexGrow} 1 0%`, ...extraStyle }} className="overflow-hidden flex flex-col min-w-0 min-h-0">
      <div className="flex items-center justify-between px-2 h-8 border-b border-hacker-border bg-hacker-bg/50 shrink-0">
        <select
          value={panelId}
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
          <button onClick={() => onNewWindow(panelId)} className="p-1 text-hacker-text-dim hover:text-hacker-accent" title="Open in new window">
            <ExternalLink size={12} />
          </button>
          <button onClick={() => onDetach(panelId)} className="p-1 text-hacker-text-dim hover:text-hacker-accent" title="Detach">
            <ExternalLink size={12} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden min-h-0">{panelContent[panelId]}</div>
    </div>
  );

  // ── Divider (draggable, visible) ──
  const Divider = ({ axis, idx }: { axis: "x" | "y"; idx: number }) => (
    <div
      onMouseDown={e => handleDividerDown(e, idx, axis)}
      className={`shrink-0 cursor-${axis === "x" ? "col" : "row"}-resize group ${
        axis === "x" ? "w-2" : "h-2"
      }`}
    >
      <div className={`h-full w-full flex items-center justify-center ${
        axis === "x" ? "flex-col" : "flex-row"
      }`}>
        <div className={`bg-hacker-border/60 group-hover:bg-hacker-accent/70 transition-colors rounded-full ${
          axis === "x" ? "w-0.5 h-8" : "h-0.5 w-8"
        }`} />
      </div>
    </div>
  );

  const ThinDivider = ({ axis }: { axis: "x" | "y" }) => (
    <div className={`shrink-0 bg-hacker-border/20 ${axis === "x" ? "w-px" : "h-px"}`} />
  );

  const f = flexSizes;

  // ── Empty ──
  if (count === 0) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-20 select-none pointer-events-none">
        <span className="text-[12rem] leading-none glitch">⚡</span>
      </div>
    );
  }

  // ── 1 panel ──
  if (count === 1) {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex">
        {renderSlot(orderedPanels[0], 0, 1)}
      </div>
    );
  }

  // ── 2 panels ──
  if (count === 2) {
    const isVertical = layoutType === "vertical-2";
    return (
      <div ref={containerRef} className={`flex-1 overflow-hidden flex ${isVertical ? "flex-col" : ""}`}>
        {renderSlot(orderedPanels[0], 0, f[0])}
        <Divider axis={isVertical ? "y" : "x"} idx={0} />
        {renderSlot(orderedPanels[1], 1, f[1])}
      </div>
    );
  }

  // ── 3 panels: horizontal-3 ──
  if (layoutType === "horizontal-3") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex">
        {renderSlot(orderedPanels[0], 0, f[0])}
        <Divider axis="x" idx={0} />
        {renderSlot(orderedPanels[1], 1, f[1])}
        <Divider axis="x" idx={1} />
        {renderSlot(orderedPanels[2], 2, f[2])}
      </div>
    );
  }

  // ── 3 panels: vertical-3 ──
  if (layoutType === "vertical-3") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex flex-col">
        {renderSlot(orderedPanels[0], 0, f[0])}
        <Divider axis="y" idx={0} />
        {renderSlot(orderedPanels[1], 1, f[1])}
        <Divider axis="y" idx={1} />
        {renderSlot(orderedPanels[2], 2, f[2])}
      </div>
    );
  }

  // ── 3 panels: top-2-bottom-1 ──
  if (layoutType === "top-2-bottom-1") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex flex-col">
        <div style={{ flex: `${f[0]} 1 0%` }} className="flex overflow-hidden min-h-0">
          {renderSlot(orderedPanels[0], 0, 1, { minWidth: 0 })}
          <ThinDivider axis="x" />
          {renderSlot(orderedPanels[1], 1, 1, { minWidth: 0 })}
        </div>
        <Divider axis="y" idx={0} />
        <div style={{ flex: `${f[1]} 1 0%` }} className="overflow-hidden min-h-0">
          {renderSlot(orderedPanels[2], 2, 1)}
        </div>
      </div>
    );
  }

  // ── 3 panels: top-1-bottom-2 ──
  if (layoutType === "top-1-bottom-2") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex flex-col">
        <div style={{ flex: `${f[0]} 1 0%` }} className="overflow-hidden min-h-0">
          {renderSlot(orderedPanels[0], 0, 1)}
        </div>
        <Divider axis="y" idx={0} />
        <div style={{ flex: `${f[1]} 1 0%` }} className="flex overflow-hidden min-h-0">
          {renderSlot(orderedPanels[1], 1, 1, { minWidth: 0 })}
          <ThinDivider axis="x" />
          {renderSlot(orderedPanels[2], 2, 1, { minWidth: 0 })}
        </div>
      </div>
    );
  }

  // ── 3 panels: left-2-right-1 ──
  if (layoutType === "left-2-right-1") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex">
        <div style={{ flex: `${f[0]} 1 0%` }} className="flex flex-col overflow-hidden min-w-0">
          <div style={{ flex: "1 1 0%" }} className="overflow-hidden min-h-0">
            {renderSlot(orderedPanels[0], 0, 1)}
          </div>
          <ThinDivider axis="y" />
          <div style={{ flex: "1 1 0%" }} className="overflow-hidden min-h-0">
            {renderSlot(orderedPanels[1], 1, 1)}
          </div>
        </div>
        <Divider axis="x" idx={0} />
        <div style={{ flex: `${f[1]} 1 0%` }} className="overflow-hidden min-w-0">
          {renderSlot(orderedPanels[2], 2, 1)}
        </div>
      </div>
    );
  }

  // ── 3 panels: left-1-right-2 ──
  return (
    <div ref={containerRef} className="flex-1 overflow-hidden flex">
      <div style={{ flex: `${f[0]} 1 0%` }} className="overflow-hidden min-w-0">
        {renderSlot(orderedPanels[0], 0, 1)}
      </div>
      <Divider axis="x" idx={0} />
      <div style={{ flex: `${f[1]} 1 0%` }} className="flex flex-col overflow-hidden min-w-0">
        <div style={{ flex: "1 1 0%" }} className="overflow-hidden min-h-0">
          {renderSlot(orderedPanels[1], 1, 1)}
        </div>
        <ThinDivider axis="y" />
        <div style={{ flex: "1 1 0%" }} className="overflow-hidden min-h-0">
          {renderSlot(orderedPanels[2], 2, 1)}
        </div>
      </div>
    </div>
  );
}

function defaultSizes(_layoutKey: string, count: number): number[] {
  if (count <= 1) return [1];
  if (count === 2) return [6, 4];
  return [4, 3, 3]; // flex-grow proportions
}
