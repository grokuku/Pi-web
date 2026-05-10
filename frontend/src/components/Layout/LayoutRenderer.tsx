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

  // ── Single render path: always all 3 slots in the DOM ──
  // This keeps ChatView/TerminalView/FileExplorer mounted across layout changes,
  // preventing message loss when toggling panels or changing layouts.
  const ALL_PANELS: PanelId[] = ["pi", "terminal", "files"];

  // Derived: is the layout horizontal or vertical?
  const isHorizontal =
    layoutType === "horizontal-2" ||
    layoutType === "horizontal-3" ||
    layoutType === "left-2-right-1" ||
    layoutType === "left-1-right-2";
  const isVertical = !isHorizontal || count <= 1;
  const axis = isVertical ? "y" : "x";

  if (count === 0) {
    return (
      <div className="flex-1 flex items-center justify-center opacity-20 select-none pointer-events-none">
        <span className="text-[12rem] leading-none glitch">⚡</span>
      </div>
    );
  }

  const s = localSizes;

  return (
    <div ref={containerRef} className={`flex-1 overflow-hidden flex ${isVertical ? "flex-col" : ""}`}>
      {[0, 1, 2].map((slotIndex) => {
        const panelId = ALL_PANELS[slotIndex];
        const panelIdx = orderedPanels.indexOf(panelId);
        const visible = panelIdx >= 0;
        const content = panelContent[panelId];

        const prevPanelId = slotIndex > 0 ? ALL_PANELS[slotIndex - 1] : null;
        const prevVisible = prevPanelId ? orderedPanels.indexOf(prevPanelId) >= 0 : false;
        const showDivider = slotIndex > 0 && (visible || prevVisible);
        const dividerHidden = slotIndex > 0 && !(visible && prevVisible);

        return (
          <>
            {slotIndex > 0 && (
              <div
                onMouseDown={showDivider ? (e) => handleDividerDown(e, slotIndex - 1, axis) : undefined}
                style={{ display: dividerHidden ? "none" : undefined }}
                className={`shrink-0 ${axis === "x" ? "w-1.5" : "h-1.5"} ${
                  showDivider
                    ? axis === "x"
                      ? "cursor-col-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50"
                      : "cursor-row-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50"
                    : ""
                }`}
              />
            )}
            <div
              style={{
                flex: visible ? (count === 1 ? "1 1 0%" : `${s[panelIdx]} 1 0%`) : "0 0 0%",
                display: visible ? undefined : "none",
                overflow: "hidden",
                minWidth: visible && !isVertical ? 0 : undefined,
                minHeight: visible && isVertical ? 0 : undefined,
              }}
              className="flex flex-col"
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
                  <button
                    onClick={() => onNewWindow(panelId)}
                    className="p-1 text-hacker-text-dim hover:text-hacker-accent"
                    title="Open in new window"
                  >
                    <ExternalLink size={12} />
                  </button>
                  <button
                    onClick={() => onDetach(panelId)}
                    className="p-1 text-hacker-text-dim hover:text-hacker-accent"
                    title="Detach"
                  >
                    <ExternalLink size={12} />
                  </button>
                </div>
              </div>
              {/* Content — always mounted, hidden via display:none when inactive */}
              <div className="flex-1 overflow-hidden">{content}</div>
            </div>
          </>
        );
      })}
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
