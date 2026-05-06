import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";

// ── Persisted modal geometry (localStorage) ──
interface ModalGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STORAGE_KEY = "pi-web-modal-geometry";

function loadGeometry(id: string): ModalGeometry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    const g = all[id];
    if (!g || typeof g.x !== "number") return null;
    return g;
  } catch { return null; }
}

function saveGeometry(id: string, g: ModalGeometry) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[id] = g;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {}
}

// ── Default sizes per modal ──
const DEFAULTS: Record<string, { w: number; h: number }> = {
  "model-library": { w: 780, h: 560 },
  "model-edit": { w: 520, h: 520 },
  "add-project": { w: 440, h: 400 },
  "commit-push": { w: 480, h: 480 },
  "git-auth": { w: 400, h: 340 },
  "git-identity": { w: 380, h: 300 },
  "project-switch": { w: 380, h: 420 },
  "delete-project": { w: 380, h: 260 },
};

// ── Resize handle positions ──
const EDGE = 8; // px grab area from edge (larger for easier grabbing)
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const EDGE_CURSORS: Record<Edge, string> = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", sw: "nesw-resize",
};

function getEdge(mx: number, my: number, w: number, h: number): Edge | null {
  const top = my < EDGE;
  const bottom = my > h - EDGE;
  const left = mx < EDGE;
  const right = mx > w - EDGE;
  if (top && left) return "nw";
  if (top && right) return "ne";
  if (bottom && left) return "sw";
  if (bottom && right) return "se";
  if (top) return "n";
  if (bottom) return "s";
  if (left) return "w";
  if (right) return "e";
  return null;
}

interface Props {
  id: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional className for the inner box */
  className?: string;
}

export function ModalDialog({ id, onClose, children, className = "" }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const saved = loadGeometry(id);
  const def = DEFAULTS[id] || { w: 440, h: 400 };

  // Calculate centered position if no saved position
  const defaultX = saved?.x ?? Math.max(40, (window.innerWidth - (saved?.w ?? def.w)) / 2);
  const defaultY = saved?.y ?? Math.max(40, (window.innerHeight - (saved?.h ?? def.h)) / 2);

  const [pos, setPos] = useState({ x: defaultX, y: defaultY });
  const [size, setSize] = useState({ w: saved?.w ?? def.w, h: saved?.h ?? def.h });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hoverEdge, setHoverEdge] = useState<Edge | null>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeState = useRef<{ edge: Edge; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number } | null>(null);

  // Use refs for current pos/size so drag/resize callbacks always have latest values
  const posRef = useRef(pos);
  const sizeRef = useRef(size);
  posRef.current = pos;
  sizeRef.current = size;

  // ── Persist to localStorage ──
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveGeometry(id, { x: posRef.current.x, y: posRef.current.y, w: sizeRef.current.w, h: sizeRef.current.h });
    }, 200);
  }, [id]);

  // Save on unmount (final position)
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveGeometry(id, { x: posRef.current.x, y: posRef.current.y, w: sizeRef.current.w, h: sizeRef.current.h });
    };
  }, [id]);

  // ── Escape key to close ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // ── Drag ──
  const handleMouseDownDrag = (e: React.MouseEvent) => {
    // Only start drag on non-interactive elements
    if ((e.target as HTMLElement).closest("button, input, select, textarea, a, [role='button']")) return;
    // Don't drag if near edge (resize zone)
    const rect = boxRef.current?.getBoundingClientRect();
    if (rect) {
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (getEdge(mx, my, size.w, size.h)) return;
    }
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
      const newX = Math.max(0, Math.min(window.innerWidth - 100, dragState.current.origX + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - 40, dragState.current.origY + dy));
      setPos({ x: newX, y: newY });
    };
    const handleUp = () => {
      setIsDragging(false);
      dragState.current = null;
      persist();
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [isDragging, persist]);

  // ── Resize ──
  const handleMouseDownResize = (e: React.MouseEvent, edge: Edge) => {
    e.preventDefault();
    e.stopPropagation();
    resizeState.current = { edge, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, origW: size.w, origH: size.h };
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: MouseEvent) => {
      if (!resizeState.current) return;
      const s = resizeState.current;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      const MIN_W = 300;
      const MIN_H = 200;
      let newX = s.origX, newY = s.origY, newW = s.origW, newH = s.origH;
      if (s.edge.includes("e")) newW = Math.max(MIN_W, s.origW + dx);
      if (s.edge.includes("w")) { newW = Math.max(MIN_W, s.origW - dx); newX = s.origX + (s.origW - newW); }
      if (s.edge.includes("s")) newH = Math.max(MIN_H, s.origH + dy);
      if (s.edge.includes("n")) { newH = Math.max(MIN_H, s.origH - dy); newY = s.origY + (s.origH - newH); }
      // Clamp position
      newX = Math.max(0, newX);
      newY = Math.max(0, newY);
      setPos({ x: newX, y: newY });
      setSize({ w: newW, h: newH });
    };
    const handleUp = () => {
      setIsResizing(false);
      resizeState.current = null;
      persist();
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [isResizing, persist]);

  // ── Render resize handles ──
  const resizeHandles = (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as Edge[]).map(edge => {
    const isCorner = edge.length === 2;
    const style: React.CSSProperties = {
      position: "absolute",
      zIndex: 10,
      ...(edge.includes("n") ? { top: 0 } : {}),
      ...(edge.includes("s") ? { bottom: 0 } : {}),
      ...(edge.includes("e") ? { right: 0 } : {}),
      ...(edge.includes("w") ? { left: 0 } : {}),
      ...(edge === "n" || edge === "s" ? { left: EDGE, right: EDGE, height: EDGE } : {}),
      ...(edge === "e" || edge === "w" ? { top: EDGE, bottom: EDGE, width: EDGE } : {}),
      ...(isCorner ? { width: EDGE * 2, height: EDGE * 2 } : {}),
      cursor: EDGE_CURSORS[edge],
    };
    return <div key={edge} style={style} onMouseDown={e => handleMouseDownResize(e, edge)} />;
  });

  return (
    <div className="modal-overlay">
      <div
        ref={boxRef}
        className={`modal-box ${isDragging ? "dragging" : ""} ${isResizing ? "resizing" : ""} ${className}`}
        style={{
          position: "absolute",
          left: pos.x,
          top: pos.y,
          width: size.w,
          height: size.h,
          maxWidth: "none",
          maxHeight: "none",
          cursor: isDragging ? "grabbing" : hoverEdge ? EDGE_CURSORS[hoverEdge] : "default",
          userSelect: "none",
        }}
        onMouseDown={handleMouseDownDrag}
        onMouseMove={e => {
          if (isDragging || isResizing) return;
          const rect = boxRef.current?.getBoundingClientRect();
          if (rect) {
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            setHoverEdge(getEdge(mx, my, size.w, size.h));
          }
        }}
        onMouseLeave={() => setHoverEdge(null)}
      >
        {/* Resize handles — on top so they grab before scrollbar */}
        {resizeHandles}
        {/* Inner scrollable content — separate from resize zone */}
        <div className="modal-inner">
          {children}
        </div>
      </div>
    </div>
  );
}