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
    return JSON.parse(raw);
  } catch { return null; }
}

export function savePersistedLayout(cfg: PersistedLayout) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(cfg)); } catch {}
}

// ── Props ────────────────────────────────────────────

interface Props {
  /** Ordered list of active panel IDs (from slotOrder filtered by active panels) */
  orderedPanels: PanelId[];
  /** Active layout type */
  layoutType: LayoutType;
  /** Per-layout-type sizes */
  sizes: Record<string, number[]>;
  /** Panel content renderers (keyed by PanelId) */
  panelContent: Record<PanelId, ReactNode>;
  /** Called when user swaps two panels via dropdown */
  onSwap: (fromIndex: number, toIndex: number) => void;
  /** Called when user clicks detach */
  onDetach: (id: PanelId) => void;
  /** Called when user clicks open-in-new-window */
  onNewWindow: (id: PanelId) => void;
  /** Called when sizes change (after drag) */
  onSizesChange: (layoutType: LayoutType, newSizes: number[]) => void;
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
  const currentSizes = sizes[layoutKey] || defaultSizes(layoutKey, count);

  const [localSizes, setLocalSizes] = useState<number[]>(currentSizes);
  const [innerSizes, setInnerSizes] = useState<number[]>([0.5, 0.5]);
  const innerSizesRef = useRef(innerSizes);
  innerSizesRef.current = innerSizes;
  const [isDragging, setIsDragging] = useState(false);
  const sizesRef = useRef(localSizes);
  sizesRef.current = localSizes;
  const dragRef = useRef<{
    type: "outer" | "inner";
    dividerIndex: number;
    axis: "x" | "y";
    startPos: number;
    startSizes: number[];
    containerSize: number;
  } | null>(null);

  // Sync sizes from parent when layout type changes (not during drag)
  useEffect(() => {
    if (!isDragging) setLocalSizes(currentSizes);
  }, [layoutKey, isDragging]);

  // Detect compound layouts
  const isCompound =
    layoutType === "top-2-bottom-1" ||
    layoutType === "top-1-bottom-2" ||
    layoutType === "left-2-right-1" ||
    layoutType === "left-1-right-2";

  // ── Resize ──
  const handleDividerDown = (
    e: React.MouseEvent,
    dividerIndex: number,
    axis: "x" | "y",
    type: "outer" | "inner",
    container?: HTMLElement,
  ) => {
    e.preventDefault();
    // Use explicit container for outer dividers (consistent across layouts),
    // fall back to parentElement for inner dividers (sub-container).
    const el = container || (e.currentTarget as HTMLElement).parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sizes = type === "inner" ? [...innerSizesRef.current] : [...localSizes];
    console.log("[resize:down]", { type, container: !!container, elTag: el.tagName, elClass: el.className.slice(0, 40), rectWidth: rect.width, rectHeight: rect.height, sizes });
    dragRef.current = {
      type,
      dividerIndex,
      axis,
      startPos: axis === "x" ? e.clientX : e.clientY,
      startSizes: sizes,
      containerSize: axis === "x" ? rect.width : rect.height,
    };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;
    let rafId = 0;
    const handleMove = (e: MouseEvent) => {
      if (rafId) return; // throttle to one update per animation frame
      const clientPos = dragRef.current!.axis === "x" ? e.clientX : e.clientY;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const d = dragRef.current;
        if (!d) return;
        const delta = clientPos - d.startPos;
        const frac = delta / d.containerSize;
        const newSizes = [...d.startSizes];
        const minSize = 0.05;
        let clamped = frac;
        if (newSizes[d.dividerIndex] + clamped < minSize) {
          clamped = minSize - newSizes[d.dividerIndex];
        }
        if (newSizes[d.dividerIndex + 1] - clamped < minSize) {
          clamped = newSizes[d.dividerIndex + 1] - minSize;
        }
        newSizes[d.dividerIndex] += clamped;
        newSizes[d.dividerIndex + 1] -= clamped;
        console.log("[resize:move]", { type: d.type, delta, containerSize: d.containerSize, frac, clamped, newSizes });
        if (d.type === "inner") {
          setInnerSizes(newSizes);
        } else {
          setLocalSizes(newSizes);
        }
      });
    };
    const handleUp = () => {
      setIsDragging(false);
      if (dragRef.current) {
        if (dragRef.current.type === "outer") {
          onSizesChange(layoutKey, [...sizesRef.current]);
        }
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

  // ── All 3 slots ALWAYS in the DOM (display:none when inactive) ──
  const ALL_PANELS: PanelId[] = ["pi", "terminal", "files"];

  if (count === 0) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-20 select-none pointer-events-none">
        <span className="text-[12rem] leading-none glitch">⚡</span>
      </div>
    );
  }

  const s = localSizes;

  // ── Shared slot renderer ──
  const renderSlot = (slotIndex: number, flexOverride?: number) => {
    const panelId = ALL_PANELS[slotIndex];
    const panelIdx = orderedPanels.indexOf(panelId);
    const visible = panelIdx >= 0;
    const content = panelContent[panelId];
    const flexVal =
      flexOverride !== undefined
        ? flexOverride
        : visible
          ? count === 1
            ? 1
            : s[panelIdx]
          : 0;

    return (
      <div
        key={panelId}
        style={{
          flex: visible ? `${flexVal} 1 0%` : "0 0 0px",
          display: visible ? undefined : "none",
          overflow: "hidden",
        }}
        className="flex flex-col min-w-0 min-h-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-2 h-8 border-b border-hacker-border bg-hacker-bg/50 shrink-0">
          <select
            value={panelId}
            onChange={(e) => {
              const newId = e.target.value as PanelId;
              const targetIdx = orderedPanels.indexOf(newId);
              if (targetIdx >= 0) onSwap(panelIdx, targetIdx);
            }}
            className="bg-transparent text-xs font-bold text-hacker-accent border-none outline-none cursor-pointer hover:bg-hacker-border/30 px-1 py-0.5 rounded"
          >
            {orderedPanels.map((p) => (
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
        {/* Content — always mounted */}
        <div className="flex-1 overflow-hidden">{content}</div>
      </div>
    );
  };

  // Divider component — outer dividers use containerRef for consistent sizing
  const Divider = ({ axis, dIdx, type = "outer", container }: { axis: "x" | "y"; dIdx: number; type?: "outer" | "inner"; container?: HTMLElement | null }) => (
    <div
      onMouseDown={(e) => handleDividerDown(e, dIdx, axis, type, container || undefined)}
      className={`shrink-0 transition-colors ${
        axis === "x"
          ? "w-1.5 cursor-col-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50"
          : "h-1.5 cursor-row-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50"
      }`}
    />
  );

  // ── Compound layouts ──
  if (isCompound) {
    const outerDir =
      layoutType === "left-2-right-1" || layoutType === "left-1-right-2" ? "row" : "col";
    const innerDir = outerDir === "row" ? "col" : "row";
    const innerAxis: "x" | "y" = innerDir === "row" ? "x" : "y";
    const outerAxis: "x" | "y" = outerDir === "row" ? "x" : "y";

    // Which 2 slots are paired, which one is solo
    let pairedSlots: [number, number];
    let soloSlot: number;
    if (layoutType === "top-2-bottom-1" || layoutType === "left-2-right-1") {
      pairedSlots = [0, 1];
      soloSlot = 2;
    } else {
      // top-1-bottom-2, left-1-right-2
      pairedSlots = [1, 2];
      soloSlot = 0;
    }
    const pairFirst = pairedSlots[0] < soloSlot;

    return (
      <div
        ref={containerRef}
        className={`flex-1 overflow-hidden flex ${outerDir === "col" ? "flex-col" : ""}`}
      >
        {pairFirst ? (
          <>
            {/* Paired sub-container */}
            <div
              className={`flex overflow-hidden ${innerDir === "col" ? "flex-col" : ""}`}
              style={{ flex: `${s[0]} 1 0%`, minWidth: 0, minHeight: 0 }}
            >
              {renderSlot(pairedSlots[0], innerSizes[0])}
              <Divider axis={innerAxis} dIdx={0} type="inner" />
              {renderSlot(pairedSlots[1], innerSizes[1])}
            </div>
            <Divider axis={outerAxis} dIdx={0} type="outer" container={containerRef.current} />
            {renderSlot(soloSlot, s[1])}
          </>
        ) : (
          <>
            {renderSlot(soloSlot, s[0])}
            <Divider axis={outerAxis} dIdx={0} type="outer" container={containerRef.current} />
            {/* Paired sub-container */}
            <div
              className={`flex overflow-hidden ${innerDir === "col" ? "flex-col" : ""}`}
              style={{ flex: `${s[1]} 1 0%`, minWidth: 0, minHeight: 0 }}
            >
              {renderSlot(pairedSlots[0], innerSizes[0])}
              <Divider axis={innerAxis} dIdx={0} type="inner" />
              {renderSlot(pairedSlots[1], innerSizes[1])}
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Flat layouts (horizontal-2/3, vertical-2/3) ──
  const isFlatHorizontal =
    layoutType === "horizontal-2" || layoutType === "horizontal-3";
  const isFlatVertical = !isFlatHorizontal || count <= 1;
  const flatAxis: "x" | "y" = isFlatVertical ? "y" : "x";

  return (
    <div ref={containerRef} className={`flex-1 overflow-hidden flex ${isFlatVertical ? "flex-col" : ""}`}>
      {renderSlot(0)}
      <Divider axis={flatAxis} dIdx={0} type="outer" container={containerRef.current} />
      {renderSlot(1)}
      <Divider axis={flatAxis} dIdx={1} type="outer" container={containerRef.current} />
      {renderSlot(2)}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────

function defaultSizes(layoutKey: string, count: number): number[] {
  if (count <= 1) return [1];
  if (count === 2) return [0.6, 0.4];
  if (layoutKey === "horizontal-3" || layoutKey === "vertical-3") return [0.4, 0.3, 0.3];
  // Compound: sizes = [subContainerFlex, soloFlex] (inner split uses separate state)
  return [0.55, 0.45];
}
