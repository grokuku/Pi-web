import { useState, useRef, useEffect, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { LayoutType, PanelId } from "../../types";
import { PANEL_LABELS } from "../../types";

const LAYOUT_KEY = "pi-web-layout";
const ALL_PANELS: PanelId[] = ["pi", "terminal", "files"];

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
        layout2: "horizontal-2", layout3: "horizontal-3",
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

export function LayoutRenderer({
  orderedPanels, layoutType, sizes, panelContent,
  onSwap, onDetach, onNewWindow, onSizesChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const count = orderedPanels.length;
  const layoutKey = count <= 1 ? "single" : layoutType;
  const persistedSizes = sizes[layoutKey] || defaultSizes(layoutKey, count);
  const [flexSizes, setFlexSizes] = useState<number[]>(persistedSizes);
  const [isDragging, setIsDragging] = useState(false);
  const sizesRef = useRef(flexSizes);
  sizesRef.current = flexSizes;
  const dragRef = useRef<{ dIdx: number; axis: "x"|"y"; startPos: number; startSizes: number[]; containerSize: number } | null>(null);

  useEffect(() => { if (!isDragging) setFlexSizes(persistedSizes); }, [layoutKey, isDragging]);

  const handleDividerDown = (e: React.MouseEvent, dIdx: number, axis: "x"|"y") => {
    e.preventDefault(); e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current = { dIdx, axis, startPos: axis==="x"?e.clientX:e.clientY, startSizes:[...flexSizes],
      containerSize: axis==="x"?rect.width:rect.height };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const d = dragRef.current!;
      const deltaPx = (d.axis==="x"?e.clientX:e.clientY) - d.startPos;
      const a = d.dIdx * 2, b = a + 1;
      const totalGrow = d.startSizes[a] + d.startSizes[b];
      const deltaGrow = (deltaPx / d.containerSize) * totalGrow;
      const newSizes = [...d.startSizes];
      const minGrow = totalGrow * 0.05;
      let clamped = deltaGrow;
      if (newSizes[a] + clamped < minGrow) clamped = minGrow - newSizes[a];
      if (newSizes[b] - clamped < minGrow) clamped = newSizes[b] - minGrow;
      newSizes[a] += clamped; newSizes[b] -= clamped;
      setFlexSizes(newSizes);
    };
    const handleUp = () => { setIsDragging(false); if (dragRef.current) onSizesChange(layoutKey, [...sizesRef.current]); dragRef.current = null; };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [isDragging, layoutKey, onSizesChange]);

  const Slot = ({ pid, idx }: { pid: PanelId; idx: number }) => (
    <div key={pid} className="overflow-hidden flex flex-col min-w-0 min-h-0">
      <div className="flex items-center justify-between px-2 h-8 border-b border-hacker-border bg-hacker-bg/50 shrink-0">
        <select value={pid} onChange={e => { const nid = e.target.value as PanelId; const ti = orderedPanels.indexOf(nid); if (ti>=0) onSwap(idx, ti); }}
          className="bg-transparent text-xs font-bold text-hacker-accent border-none outline-none cursor-pointer hover:bg-hacker-border/30 px-1 py-0.5 rounded">
          {orderedPanels.map(p => <option key={p} value={p} className="bg-hacker-surface text-hacker-text">{PANEL_LABELS[p]}</option>)}
        </select>
        <div className="flex items-center gap-1">
          <button onClick={() => onNewWindow(pid)} className="p-1 text-hacker-text-dim hover:text-hacker-accent" title="Open in new window"><ExternalLink size={12}/></button>
          <button onClick={() => onDetach(pid)} className="p-1 text-hacker-text-dim hover:text-hacker-accent" title="Detach"><ExternalLink size={12}/></button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden min-h-0">{panelContent[pid]}</div>
    </div>
  );

  const Divider = ({ axis, dIdx }: { axis: "x"|"y"; dIdx: number }) => (
    <div onMouseDown={e => handleDividerDown(e, dIdx, axis)}
      className={`shrink-0 cursor-${axis==="x"?"col":"row"}-resize group ${axis==="x"?"w-2":"h-2"}`}>
      <div className={`h-full w-full flex items-center justify-center ${axis==="x"?"flex-col":"flex-row"}`}>
        <div className={`bg-hacker-border/60 group-hover:bg-hacker-accent/70 transition-colors rounded-full ${axis==="x"?"w-0.5 h-10":"h-0.5 w-10"}`} />
      </div>
    </div>
  );

  const f = flexSizes;

  // ── Empty ──
  if (count === 0) {
    return <div className="flex-1 flex items-center justify-center opacity-20 select-none pointer-events-none"><span className="text-[12rem] leading-none glitch">⚡</span></div>;
  }

  // ── 1 panel ──
  if (count === 1) {
    return (<div ref={containerRef} className="flex-1 overflow-hidden flex"><div style={{ flex: "1 1 0%" }}>{Slot({pid: orderedPanels[0], idx: 0})}</div></div>);
  }

  // ── 2 panels ──
  if (count === 2) {
    const isV = layoutType === "vertical-2";
    return (
      <div ref={containerRef} className={`flex-1 overflow-hidden flex ${isV?"flex-col":""}`}>
        <div style={{ flex: `${f[0]} 1 0%` }}>{Slot({pid: orderedPanels[0], idx: 0})}</div>
        <Divider axis={isV?"y":"x"} dIdx={0} />
        <div style={{ flex: `${f[1]} 1 0%` }}>{Slot({pid: orderedPanels[1], idx: 1})}</div>
      </div>
    );
  }

  // ── 3 panels: flat ──
  if (layoutType === "horizontal-3") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex">
        <div style={{ flex: `${f[0]} 1 0%` }}>{Slot({pid: orderedPanels[0], idx: 0})}</div>
        <Divider axis="x" dIdx={0} />
        <div style={{ flex: `${f[1]} 1 0%` }}>{Slot({pid: orderedPanels[1], idx: 1})}</div>
        <Divider axis="x" dIdx={1} />
        <div style={{ flex: `${f[2]} 1 0%` }}>{Slot({pid: orderedPanels[2], idx: 2})}</div>
      </div>
    );
  }
  if (layoutType === "vertical-3") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex flex-col">
        <div style={{ flex: `${f[0]} 1 0%` }}>{Slot({pid: orderedPanels[0], idx: 0})}</div>
        <Divider axis="y" dIdx={0} />
        <div style={{ flex: `${f[1]} 1 0%` }}>{Slot({pid: orderedPanels[1], idx: 1})}</div>
        <Divider axis="y" dIdx={1} />
        <div style={{ flex: `${f[2]} 1 0%` }}>{Slot({pid: orderedPanels[2], idx: 2})}</div>
      </div>
    );
  }

  // ── Compound layouts: 4 sizes [mainA, mainB, subA, subB] ──
  // dIdx=0: main divider (between multi-panel region and solo panel)
  // dIdx=1: sub divider (within multi-panel region)

  // top-2-bottom-1: [slot0|slot1] / slot2
  if (layoutType === "top-2-bottom-1") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex flex-col">
        <div style={{ flex: `${f[0]} 1 0%` }} className="flex overflow-hidden min-h-0">
          <div style={{ flex: `${f[2]} 1 0%`, minWidth: 0 }}>{Slot({pid: orderedPanels[0], idx: 0})}</div>
          <Divider axis="x" dIdx={1} />
          <div style={{ flex: `${f[3]} 1 0%`, minWidth: 0 }}>{Slot({pid: orderedPanels[1], idx: 1})}</div>
        </div>
        <Divider axis="y" dIdx={0} />
        <div style={{ flex: `${f[1]} 1 0%`, minHeight: 0 }}>{Slot({pid: orderedPanels[2], idx: 2})}</div>
      </div>
    );
  }

  // top-1-bottom-2: slot0 / [slot1|slot2]
  if (layoutType === "top-1-bottom-2") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex flex-col">
        <div style={{ flex: `${f[0]} 1 0%`, minHeight: 0 }}>{Slot({pid: orderedPanels[0], idx: 0})}</div>
        <Divider axis="y" dIdx={0} />
        <div style={{ flex: `${f[1]} 1 0%` }} className="flex overflow-hidden min-h-0">
          <div style={{ flex: `${f[2]} 1 0%`, minWidth: 0 }}>{Slot({pid: orderedPanels[1], idx: 1})}</div>
          <Divider axis="x" dIdx={1} />
          <div style={{ flex: `${f[3]} 1 0%`, minWidth: 0 }}>{Slot({pid: orderedPanels[2], idx: 2})}</div>
        </div>
      </div>
    );
  }

  // left-2-right-1: [slot0/slot1] | slot2
  if (layoutType === "left-2-right-1") {
    return (
      <div ref={containerRef} className="flex-1 overflow-hidden flex">
        <div style={{ flex: `${f[0]} 1 0%` }} className="flex flex-col overflow-hidden min-w-0">
          <div style={{ flex: `${f[2]} 1 0%`, minHeight: 0 }}>{Slot({pid: orderedPanels[0], idx: 0})}</div>
          <Divider axis="y" dIdx={1} />
          <div style={{ flex: `${f[3]} 1 0%`, minHeight: 0 }}>{Slot({pid: orderedPanels[1], idx: 1})}</div>
        </div>
        <Divider axis="x" dIdx={0} />
        <div style={{ flex: `${f[1]} 1 0%`, minWidth: 0 }}>{Slot({pid: orderedPanels[2], idx: 2})}</div>
      </div>
    );
  }

  // left-1-right-2: slot0 | [slot1/slot2]
  return (
    <div ref={containerRef} className="flex-1 overflow-hidden flex">
      <div style={{ flex: `${f[0]} 1 0%`, minWidth: 0 }}>{Slot({pid: orderedPanels[0], idx: 0})}</div>
      <Divider axis="x" dIdx={0} />
      <div style={{ flex: `${f[1]} 1 0%` }} className="flex flex-col overflow-hidden min-w-0">
        <div style={{ flex: `${f[2]} 1 0%`, minHeight: 0 }}>{Slot({pid: orderedPanels[1], idx: 1})}</div>
        <Divider axis="y" dIdx={1} />
        <div style={{ flex: `${f[3]} 1 0%`, minHeight: 0 }}>{Slot({pid: orderedPanels[2], idx: 2})}</div>
      </div>
    </div>
  );
}

function defaultSizes(layoutKey: string, count: number): number[] {
  if (count <= 1) return [1];
  if (count === 2) return [6, 4];
  if (layoutKey === "horizontal-3" || layoutKey === "vertical-3") return [4, 3, 3];
  return [5, 5, 1, 1]; // compound: main 50/50, sub 50/50
}
