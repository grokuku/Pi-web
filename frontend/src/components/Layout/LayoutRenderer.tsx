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
    if (!isDragging) setLocalSizes(currentSizes);
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
      const delta = (d.axis === "x" ? e.clientX : e.clientY) - d.startPos;
      const frac = delta / d.containerSize;
      const newSizes = [...d.startSizes];
      const minSize = 0.1;
      const maxDelta = Math.max(minSize - newSizes[d.dividerIndex], frac);
      const clampedDelta = Math.min(newSizes[d.dividerIndex + 1] - minSize, maxDelta);
      newSizes[d.dividerIndex] -= clampedDelta;
      newSizes[d.dividerIndex + 1] += clampedDelta;
      setLocalSizes(newSizes);
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

  // ── Panel slot rendering ──
  const PanelSlot = ({ idx, style }: { idx: number; style: React.CSSProperties }) => {
    const panelId = orderedPanels[idx];
    const content = panelContent[panelId];
    const allActive = orderedPanels;

    return (
      <div style={style} className="overflow-hidden flex flex-col">
        {/* Header with dropdown + buttons */}
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
            {allActive.map(p => (
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
        {/* Content */}
        <div className="flex-1 overflow-hidden">{content}</div>
      </div>
    );
  };

  const Divider = ({ idx, axis }: { idx: number; axis: "x" | "y" }) => (
    <div
      onMouseDown={e => handleDividerDown(e, idx, axis)}
      className={`shrink-0 transition-colors ${
        axis === "x"
          ? "w-1.5 cursor-col-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50"
          : "h-1.5 cursor-row-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50"
      }`}
    />
  );

  // ── Empty state (0 panels) ──
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
      <div ref={containerRef} className="flex-1 overflow-hidden">
        <PanelSlot idx={0} style={{ width: "100%", height: "100%" }} />
      </div>
    );
  }

  const s = localSizes;

  // ── 2 panels ──
  if (count === 2) {
    if (layoutType === "vertical-2") {
      return (
        <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
          <PanelSlot idx={0} style={{ height: `${s[0] * 100}%` }} />
          <Divider idx={0} axis="y" />
          <PanelSlot idx={1} style={{ height: `${s[1] * 100}%` }} />
        </div>
      );
    }
    // horizontal-2
    return (
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        <PanelSlot idx={0} style={{ width: `${s[0] * 100}%` }} />
        <Divider idx={0} axis="x" />
        <PanelSlot idx={1} style={{ width: `${s[1] * 100}%` }} />
      </div>
    );
  }

  // ── 3 panels ──
  if (layoutType === "horizontal-3") {
    return (
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        <PanelSlot idx={0} style={{ width: `${s[0] * 100}%` }} />
        <Divider idx={0} axis="x" />
        <PanelSlot idx={1} style={{ width: `${s[1] * 100}%` }} />
        <Divider idx={1} axis="x" />
        <PanelSlot idx={2} style={{ width: `${s[2] * 100}%` }} />
      </div>
    );
  }
  if (layoutType === "vertical-3") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        <PanelSlot idx={0} style={{ height: `${s[0] * 100}%` }} />
        <Divider idx={0} axis="y" />
        <PanelSlot idx={1} style={{ height: `${s[1] * 100}%` }} />
        <Divider idx={1} axis="y" />
        <PanelSlot idx={2} style={{ height: `${s[2] * 100}%` }} />
      </div>
    );
  }
  if (layoutType === "top-2-bottom-1") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        <div className="flex overflow-hidden" style={{ height: `${s[0] * 100}%` }}>
          <PanelSlot idx={0} style={{ width: "50%", height: "100%" }} />
          <div className="w-px shrink-0 bg-hacker-border/50" />
          <PanelSlot idx={1} style={{ width: "50%", height: "100%" }} />
        </div>
        <Divider idx={0} axis="y" />
        <PanelSlot idx={2} style={{ height: `${(1 - s[0]) * 100}%` }} />
      </div>
    );
  }
  if (layoutType === "top-1-bottom-2") {
    return (
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        <PanelSlot idx={0} style={{ height: `${s[0] * 100}%` }} />
        <Divider idx={0} axis="y" />
        <div className="flex overflow-hidden" style={{ height: `${(1 - s[0]) * 100}%` }}>
          <PanelSlot idx={1} style={{ width: "50%", height: "100%" }} />
          <div className="w-px shrink-0 bg-hacker-border/50" />
          <PanelSlot idx={2} style={{ width: "50%", height: "100%" }} />
        </div>
      </div>
    );
  }
  if (layoutType === "left-2-right-1") {
    return (
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        <div className="flex flex-col overflow-hidden" style={{ width: `${s[0] * 100}%`, height: "100%" }}>
          <PanelSlot idx={0} style={{ height: "50%" }} />
          <div className="h-px shrink-0 bg-hacker-border/50" />
          <PanelSlot idx={1} style={{ height: "50%" }} />
        </div>
        <Divider idx={0} axis="x" />
        <PanelSlot idx={2} style={{ width: `${(1 - s[0]) * 100}%`, height: "100%" }} />
      </div>
    );
  }
  // left-1-right-2
  return (
    <div ref={containerRef} className="flex-1 flex overflow-hidden">
      <PanelSlot idx={0} style={{ width: `${s[0] * 100}%`, height: "100%" }} />
      <Divider idx={0} axis="x" />
      <div className="flex flex-col overflow-hidden" style={{ width: `${(1 - s[0]) * 100}%`, height: "100%" }}>
        <PanelSlot idx={1} style={{ height: "50%" }} />
        <div className="h-px shrink-0 bg-hacker-border/50" />
        <PanelSlot idx={2} style={{ height: "50%" }} />
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────

function defaultSizes(layoutKey: string, count: number): number[] {
  if (count <= 1) return [1];
  if (count === 2) return [0.6, 0.4];
  if (layoutKey === "horizontal-3" || layoutKey === "vertical-3") return [0.4, 0.3, 0.3];
  // For compound layouts (top-2-bottom-1 etc), primary split
  return [0.5, 0.5];
}
