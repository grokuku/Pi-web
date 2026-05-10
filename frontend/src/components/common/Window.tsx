import { useState, useRef, useEffect, type ReactNode } from "react";
import { X, ExternalLink, Minimize2 } from "lucide-react";

// ── Persisted window geometry ──
interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STORAGE_KEY = "pi-web-window-geometry";

function loadGeometry(id: string): WindowGeometry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    const g = all[id];
    if (!g || typeof g.x !== "number" || typeof g.y !== "number" || typeof g.w !== "number" || typeof g.h !== "number") return null;
    if (g.w < 100 || g.h < 100) return null;
    return g;
  } catch { return null; }
}

function saveGeometry(id: string, g: WindowGeometry) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let all: Record<string, WindowGeometry> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) all = parsed;
      } catch { /* ignore */ }
    }
    all[id] = g;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn("[Window] Failed to save geometry:", e);
  }
}

const EDGE = 8;
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGE_CURSORS: Record<Edge, string> = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", sw: "nesw-resize",
};

function getEdge(mx: number, my: number, w: number, h: number): Edge | null {
  const top = my < EDGE, bottom = my > h - EDGE, left = mx < EDGE, right = mx > w - EDGE;
  if (top && left) return "nw"; if (top && right) return "ne";
  if (bottom && left) return "sw"; if (bottom && right) return "se";
  if (top) return "n"; if (bottom) return "s"; if (left) return "w"; if (right) return "e";
  return null;
}

interface Props {
  id: string;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  onDock: () => void; // Bouton pour réintégrer
  defaultW?: number;
  defaultH?: number;
  className?: string;
}

export function Window({ id, title, icon, children, onClose, onDock, defaultW = 800, defaultH = 600, className = "" }: Props) {
  const savedRaw = loadGeometry(id);
  const saved = savedRaw ? {
    x: savedRaw.x,
    y: savedRaw.y,
    w: Math.max(savedRaw.w, defaultW),
    h: Math.max(savedRaw.h, defaultH),
  } : null;

  const [pos, setPos] = useState({
    x: saved?.x ?? Math.max(40, (window.innerWidth - defaultW) / 2),
    y: saved?.y ?? Math.max(40, (window.innerHeight - defaultH) / 2),
  });
  const [size, setSize] = useState({ w: saved?.w ?? defaultW, h: saved?.h ?? defaultH });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hoverEdge, setHoverEdge] = useState<Edge | null>(null);

  const dragState = useRef<any>(null);
  const resizeState = useRef<any>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const posRef = useRef(pos);
  const sizeRef = useRef(size);
  posRef.current = pos;
  sizeRef.current = size;

  const forceSave = () => saveGeometry(id, { x: posRef.current.x, y: posRef.current.y, w: sizeRef.current.w, h: sizeRef.current.h });

  // Fermeture propre
  const handleClose = () => { forceSave(); onClose(); };

  // Drag
  const handleMouseDownDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    const rect = boxRef.current?.getBoundingClientRect();
    if (rect && getEdge(e.clientX - rect.left, e.clientY - rect.top, size.w, size.h)) return;
    e.preventDefault();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      const dx = e.clientX - dragState.current.startX;
      const dy = e.clientY - dragState.current.startY;
      setPos({ x: Math.max(0, dragState.current.origX + dx), y: Math.max(0, dragState.current.origY + dy) });
    };
    const handleUp = () => { setIsDragging(false); dragState.current = null; forceSave(); };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [isDragging]);

  // Resize
  const handleMouseDownResize = (e: React.MouseEvent, edge: Edge) => {
    e.preventDefault(); e.stopPropagation();
    resizeState.current = { edge, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, origW: size.w, origH: size.h };
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: MouseEvent) => {
      if (!resizeState.current) return;
      const s = resizeState.current;
      const dx = e.clientX - s.startX, dy = e.clientY - s.startY;
      let nX = s.origX, nY = s.origY, nW = s.origW, nH = s.origH;
      if (s.edge.includes("e")) nW = Math.max(300, s.origW + dx);
      if (s.edge.includes("w")) { nW = Math.max(300, s.origW - dx); nX = s.origX + (s.origW - nW); }
      if (s.edge.includes("s")) nH = Math.max(200, s.origH + dy);
      if (s.edge.includes("n")) { nH = Math.max(200, s.origH - dy); nY = s.origY + (s.origH - nH); }
      setPos({ x: Math.max(0, nX), y: Math.max(0, nY) });
      setSize({ w: nW, h: nH });
    };
    const handleUp = () => { setIsResizing(false); resizeState.current = null; forceSave(); };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [isResizing]);

  const resizeHandles = (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as Edge[]).map(edge => {
    const isCorner = edge.length === 2;
    const style: React.CSSProperties = {
      position: "absolute", zIndex: 10,
      ...(edge.includes("n") ? { top: 0 } : {}), ...(edge.includes("s") ? { bottom: 0 } : {}),
      ...(edge.includes("e") ? { right: 0 } : {}), ...(edge.includes("w") ? { left: 0 } : {}),
      ...(edge === "n" || edge === "s" ? { left: EDGE, right: EDGE, height: EDGE } : {}),
      ...(edge === "e" || edge === "w" ? { top: EDGE, bottom: EDGE, width: EDGE } : {}),
      ...(isCorner ? { width: EDGE * 2, height: EDGE * 2 } : {}),
      cursor: EDGE_CURSORS[edge],
    };
    return <div key={edge} style={style} onMouseDown={e => handleMouseDownResize(e, edge)} />;
  });

  return (
    <div
      ref={boxRef}
      className={`window-box ${isDragging ? "dragging" : ""} ${isResizing ? "resizing" : ""} ${className}`}
      style={{
        position: "fixed", // Fixed pour être au-dessus de tout sans overlay
        left: pos.x, top: pos.y, width: size.w, height: size.h,
        zIndex: 1000, // Assez haut pour être au-dessus du contenu principal
        background: "var(--surface-raised)",
        border: "1px solid var(--accent-dim)",
        boxShadow: "0 0 30px rgba(var(--accent-rgb), 0.1)",
        display: "flex", flexDirection: "column",
        userSelect: "none",
      }}
      onMouseDown={handleMouseDownDrag}
      onMouseMove={e => {
        if (isDragging || isResizing) return;
        const rect = boxRef.current?.getBoundingClientRect();
        if (rect) setHoverEdge(getEdge(e.clientX - rect.left, e.clientY - rect.top, size.w, size.h));
      }}
      onMouseLeave={() => setHoverEdge(null)}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 h-8 border-b border-hacker-accent/20 bg-hacker-accent-dim/10 shrink-0 cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-1.5 text-xs text-hacker-text-dim">
          {icon}
          <span className="font-bold tracking-wide">{title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onDock} className="p-1 text-hacker-text-dim hover:text-hacker-accent" title="Réintégrer">
            <Minimize2 size={12} />
          </button>
          <button onClick={handleClose} className="p-1 text-hacker-text-dim hover:text-hacker-error" title="Fermer">
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Resize handles */}
      {resizeHandles}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
