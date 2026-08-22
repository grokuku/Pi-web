import { useState, useRef, useEffect, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { useOverlayStack, isTopOverlay } from "../../hooks/useOverlayStack";
import { useIsMobile } from "../../hooks/useMediaQuery";

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
    if (!g || typeof g.x !== "number" || typeof g.y !== "number" || typeof g.w !== "number" || typeof g.h !== "number") {
      return null;
    }
    // Validate reasonable values (not negative, width/height at least 100)
    if (g.w < 100 || g.h < 100) return null;
    return g;
  } catch { return null; }
}

function saveGeometry(id: string, g: ModalGeometry) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let all: Record<string, ModalGeometry> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
          all = parsed;
        }
        // If parsed is invalid, all remains empty object (we'll overwrite with current id)
      } catch {
        // Invalid JSON, start fresh
      }
    }
    all[id] = g;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn("[ModalDialog] Failed to save geometry:", e);
  }
}

// ── Default sizes per modal ──
const DEFAULTS: Record<string, { w: number; h: number }> = {
  "model-library": { w: 1200, h: 800 },
  "model-library-loading": { w: 1200, h: 800 },
  "model-edit": { w: 800, h: 700 },
  "add-project": { w: 900, h: 700 },
  "commit-push": { w: 900, h: 700 },
  "git-auth": { w: 800, h: 600 },
  "git-identity": { w: 800, h: 600 },
  "project-switch": { w: 800, h: 700 },
  "delete-project": { w: 800, h: 500 },
  "new-chat-confirm": { w: 480, h: 300 },
  "file-viewer": { w: 900, h: 700 },
  "extensions": { w: 900, h: 700 },
  "settings": { w: 1200, h: 800 },
  "usage-stats": { w: 1200, h: 800 },
  "routing-config": { w: 640, h: 720 },
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
  /** Libellé accessible de la modale (aria-label) — clé i18n fournie par l'appelant */
  ariaLabel?: string;
  /** id de l'élément titre pour aria-labelledby (si la modale affiche un titre) */
  ariaLabelledById?: string;
}

export function ModalDialog({ id, onClose, children, className = "", ariaLabel, ariaLabelledById }: Props) {
  const { t } = useTranslation();
  // Sur mobile (<768px) la modale est recentrée au centre de l'écran (pas de drag persistant).
  const isMobile = useIsMobile();
  const boxRef = useRef<HTMLDivElement>(null);
  // Lot B : enregistrement du modal dans la pile centralisée des overlays.
  // Le handler Échap global de App.tsx consulte cette pile pour ne PAS envoyer
  // pi_abort tant qu'un modal/visionneuse est ouvert (priorité au modal).
  const overlayToken = useOverlayStack();
  const savedRaw = loadGeometry(id);
  const def = DEFAULTS[id] || { w: 1320, h: 800 };

  // Enforce minimum size: if saved geometry is smaller than defaults, use defaults
  const saved = savedRaw ? {
    x: savedRaw.x,
    y: savedRaw.y,
    w: Math.max(savedRaw.w, def.w),
    h: Math.max(savedRaw.h, def.h),
  } : null;

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
  // Save whenever position or size changes (for live feedback)
  useEffect(() => {
    saveGeometry(id, { x: pos.x, y: pos.y, w: size.w, h: size.h });
  }, [id, pos.x, pos.y, size.w, size.h]);

  // Save on unmount (when modal closes via X or Escape key)
  useEffect(() => {
    return () => {
      // Cleanup function runs on unmount
      saveGeometry(id, { x: posRef.current.x, y: posRef.current.y, w: sizeRef.current.w, h: sizeRef.current.h });
    };
  }, [id]);

  // Helper to force save (used in drag/resize end)
  const forceSaveGeometry = () => {
    saveGeometry(id, { x: posRef.current.x, y: posRef.current.y, w: sizeRef.current.w, h: sizeRef.current.h });
  };

  // ── Escape key to close ──
  // Lot B : seul le modal AU SOMMET de la pile d'overlays réagit à Échap — une
  // pression ferme un seul modal (le plus récent) au lieu de toute la cascade
  // de modaux imbriqués d'un coup.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopOverlay(overlayToken.current)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, overlayToken]);

  // ── Drag ──
  const handlePointerDownDrag = (e: React.PointerEvent) => {
    // En mobile la modal est recentrée en dur (left/top 50% + translate(-50%,-50%)) :
    // le drag y est inutile, casse le défilement tactile (preventDefault) et corrompt
    // la géométrie persistée. On désactive donc le drag sur mobile (le resize reste actif).
    if (isMobile) return;
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
    // Capture du pointeur (tactile/souris) pour suivre le drag hors de la zone
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: PointerEvent) => {
      if (!dragState.current) return;
      const dx = e.clientX - dragState.current.startX;
      const dy = e.clientY - dragState.current.startY;
      const newX = Math.max(0, Math.min(window.innerWidth - 100, dragState.current.origX + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - 40, dragState.current.origY + dy));
      // Update ref synchronously so forceSaveGeometry has latest values
      posRef.current = { x: newX, y: newY };
      setPos({ x: newX, y: newY });
    };
    const handleUp = () => {
      setIsDragging(false);
      dragState.current = null;
      forceSaveGeometry();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => { window.removeEventListener("pointermove", handleMove); window.removeEventListener("pointerup", handleUp); window.removeEventListener("pointercancel", handleUp); };
  }, [isDragging]);

  // ── Resize ──
  const handlePointerDownResize = (e: React.PointerEvent, edge: Edge) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeState.current = { edge, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, origW: size.w, origH: size.h };
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: PointerEvent) => {
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
      newX = Math.max(0, newX);
      newY = Math.max(0, newY);
      // Update refs synchronously so forceSaveGeometry has latest values
      posRef.current = { x: newX, y: newY };
      sizeRef.current = { w: newW, h: newH };
      setPos({ x: newX, y: newY });
      setSize({ w: newW, h: newH });
    };
    const handleUp = () => {
      setIsResizing(false);
      resizeState.current = null;
      forceSaveGeometry();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => { window.removeEventListener("pointermove", handleMove); window.removeEventListener("pointerup", handleUp); window.removeEventListener("pointercancel", handleUp); };
  }, [isResizing]);

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
    return <div key={edge} data-resize-handle style={style} onPointerDown={e => handlePointerDownResize(e, edge)} />;
  });

  return (
    <div className="modal-overlay">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? t('common.dialog')}
        aria-labelledby={ariaLabelledById || undefined}
        className={`modal-box ${isDragging ? "dragging" : ""} ${isResizing ? "resizing" : ""} ${className}`}
        style={{
          position: "absolute",
          // Sur mobile (<768px) : recentrage au centre de l'écran, indépendant de la position persistée.
          left: isMobile ? "50%" : pos.x,
          top: isMobile ? "50%" : pos.y,
          transform: isMobile ? "translate(-50%, -50%)" : undefined,
          width: size.w,
          height: size.h,
          cursor: isDragging ? "grabbing" : hoverEdge ? EDGE_CURSORS[hoverEdge] : "default",
          userSelect: "none",
        }}
        onPointerDown={handlePointerDownDrag}
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