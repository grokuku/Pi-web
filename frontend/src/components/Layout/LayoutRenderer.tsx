import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import type { LayoutConfig, LayoutType, PanelId } from "../../types";

// ── Layout config persistence ─────────────────────────

const LAYOUT_KEY = "pi-web-layout";

export function loadLayoutConfig(): LayoutConfig | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

export function saveLayoutConfig(config: LayoutConfig) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(config));
  } catch {}
}

// ── Panel content registry ────────────────────────────

export interface PanelSlot {
  id: PanelId;
  label: string;
  content: ReactNode;
}

interface Props {
  /** Active panels (from panel state) */
  activePanels: PanelId[];
  /** Layout configuration */
  config: LayoutConfig;
  /** Panel slots (id → rendered content) */
  panels: Record<PanelId, ReactNode>;
  /** Called when sizes change after drag */
  onSizesChange: (sizes: number[]) => void;
}

// ── Layout Renderer ───────────────────────────────────

export function LayoutRenderer({ activePanels, config, panels, onSizesChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(() => config.sizes || [1]);
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const dragRef = useRef<{
    dividerIndex: number;
    axis: "x" | "y";
    startPos: number;
    startSizes: number[];
    containerSize: number;
  } | null>(null);

  // Which panels are actually rendered (from activePanels, ordered by config.slots)
  const orderedSlots = config.slots.filter(s => activePanels.includes(s));
  const count = orderedSlots.length;

  // Ensure sizes array matches slot count
  useEffect(() => {
    if (sizes.length !== count) {
      const newSizes = new Array(count).fill(1 / count);
      if (count === 2) {
        newSizes[0] = 0.6;
        newSizes[1] = 0.4;
      }
      setSizes(newSizes);
    }
  }, [count, sizes.length]);

  // Sync config.sizes from parent (only when not dragging)
  useEffect(() => {
    if (!isDraggingDivider && config.sizes && config.sizes.length === count) {
      setSizes(config.sizes);
    }
  }, [config.sizes, count, isDraggingDivider]);

  // ── Resize logic ──
  const handleDividerDown = (e: React.MouseEvent, dividerIndex: number, axis: "x" | "y") => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current = {
      dividerIndex,
      axis,
      startPos: axis === "x" ? e.clientX : e.clientY,
      startSizes: [...sizes],
      containerSize: axis === "x" ? rect.width : rect.height,
    };
    setIsDraggingDivider(true);
  };

  useEffect(() => {
    if (!isDraggingDivider) return;
    const handleMove = (e: MouseEvent) => {
      const d = dragRef.current!;
      const delta = (d.axis === "x" ? e.clientX : e.clientY) - d.startPos;
      const frac = delta / d.containerSize;
      const newSizes = [...d.startSizes];
      // Move delta from left/top panel to right/bottom panel
      const minSize = 0.1; // minimum 10% per panel
      const maxDelta = Math.max(minSize - newSizes[d.dividerIndex], frac);
      const clampedDelta = Math.min(newSizes[d.dividerIndex + 1] - minSize, maxDelta);
      newSizes[d.dividerIndex] -= clampedDelta;
      newSizes[d.dividerIndex + 1] += clampedDelta;
      setSizes(newSizes);
    };
    const handleUp = () => {
      setIsDraggingDivider(false);
      if (dragRef.current) {
        onSizesChange([...sizesRef.current]);
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDraggingDivider, onSizesChange]);

  // ── Render helpers ──

  const renderPanel = (slot: PanelId, idx: number, containerStyle: React.CSSProperties) => (
    <div key={`${slot}-${idx}`} style={containerStyle} className="overflow-hidden">
      {panels[slot]}
    </div>
  );

  const renderDivider = (idx: number, axis: "x" | "y") => (
    <div
      key={`div-${idx}`}
      onMouseDown={e => handleDividerDown(e, idx, axis)}
      className={`shrink-0 transition-colors ${
        axis === "x"
          ? "w-1.5 cursor-col-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50"
          : "h-1.5 cursor-row-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50"
      }`}
    />
  );

  // ── 1 panel (always PI) ──
  if (count <= 1) {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden">
        {renderPanel(orderedSlots[0] || "pi", 0, { width: "100%", height: "100%" })}
      </div>
    );
  }

  const type = config.type;

  // ── 2 panels ──
  if (count === 2) {
    if (type === "vertical-2") {
      return (
        <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
          {renderPanel(orderedSlots[0], 0, { height: `${sizes[0] * 100}%`, overflow: "hidden" })}
          {renderDivider(0, "y")}
          {renderPanel(orderedSlots[1], 1, { height: `${sizes[1] * 100}%`, overflow: "hidden" })}
        </div>
      );
    }
    // horizontal-2 (default)
    return (
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        {renderPanel(orderedSlots[0], 0, { width: `${sizes[0] * 100}%`, overflow: "hidden" })}
        {renderDivider(0, "x")}
        {renderPanel(orderedSlots[1], 1, { width: `${sizes[1] * 100}%`, overflow: "hidden" })}
      </div>
    );
  }

  // ── 3 panels ──
  if (type === "horizontal-3") {
    return (
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        {renderPanel(orderedSlots[0], 0, { width: `${sizes[0] * 100}%`, overflow: "hidden" })}
        {renderDivider(0, "x")}
        {renderPanel(orderedSlots[1], 1, { width: `${sizes[1] * 100}%`, overflow: "hidden" })}
        {renderDivider(1, "x")}
        {renderPanel(orderedSlots[2], 2, { width: `${sizes[2] * 100}%`, overflow: "hidden" })}
      </div>
    );
  }

  if (type === "vertical-3") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        {renderPanel(orderedSlots[0], 0, { height: `${sizes[0] * 100}%`, overflow: "hidden" })}
        {renderDivider(0, "y")}
        {renderPanel(orderedSlots[1], 1, { height: `${sizes[1] * 100}%`, overflow: "hidden" })}
        {renderDivider(1, "y")}
        {renderPanel(orderedSlots[2], 2, { height: `${sizes[2] * 100}%`, overflow: "hidden" })}
      </div>
    );
  }

  if (type === "top-2-bottom-1") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        <div className="flex overflow-hidden" style={{ height: `${sizes[0] * 100}%` }}>
          {renderPanel(orderedSlots[0], 0, { width: "50%", overflow: "hidden", height: "100%" })}
          <div className="w-px shrink-0 bg-hacker-border/50" />
          {renderPanel(orderedSlots[1], 1, { width: "50%", overflow: "hidden", height: "100%" })}
        </div>
        {renderDivider(0, "y")}
        {renderPanel(orderedSlots[2], 2, { height: `${(1 - sizes[0]) * 100}%`, overflow: "hidden" })}
      </div>
    );
  }

  if (type === "top-1-bottom-2") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        {renderPanel(orderedSlots[0], 0, { height: `${sizes[0] * 100}%`, overflow: "hidden" })}
        {renderDivider(0, "y")}
        <div className="flex overflow-hidden" style={{ height: `${(1 - sizes[0]) * 100}%` }}>
          {renderPanel(orderedSlots[1], 1, { width: "50%", overflow: "hidden", height: "100%" })}
          <div className="w-px shrink-0 bg-hacker-border/50" />
          {renderPanel(orderedSlots[2], 2, { width: "50%", overflow: "hidden", height: "100%" })}
        </div>
      </div>
    );
  }

  if (type === "left-2-right-1") {
    return (
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        <div className="flex flex-col overflow-hidden" style={{ width: `${sizes[0] * 100}%`, height: "100%" }}>
          {renderPanel(orderedSlots[0], 0, { height: "50%", overflow: "hidden" })}
          <div className="h-px shrink-0 bg-hacker-border/50" />
          {renderPanel(orderedSlots[1], 1, { height: "50%", overflow: "hidden" })}
        </div>
        {renderDivider(0, "x")}
        {renderPanel(orderedSlots[2], 2, { width: `${(1 - sizes[0]) * 100}%`, overflow: "hidden", height: "100%" })}
      </div>
    );
  }

  // left-1-right-2
  return (
    <div ref={containerRef} className="flex-1 flex overflow-hidden">
      {renderPanel(orderedSlots[0], 0, { width: `${sizes[0] * 100}%`, overflow: "hidden", height: "100%" })}
      {renderDivider(0, "x")}
      <div className="flex flex-col overflow-hidden" style={{ width: `${(1 - sizes[0]) * 100}%`, height: "100%" }}>
        {renderPanel(orderedSlots[1], 1, { height: "50%", overflow: "hidden" })}
        <div className="h-px shrink-0 bg-hacker-border/50" />
        {renderPanel(orderedSlots[2], 2, { height: "50%", overflow: "hidden" })}
      </div>
    </div>
  );
}
