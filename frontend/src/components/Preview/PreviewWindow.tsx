import { useState, useRef, useEffect } from "react";
import { useTranslation } from "../../i18n";

// ── Fenêtre flottante de preview ─────────────────────────────────────────
// Fenêtre redimensionnable/déplaçable au-dessus du chat (z-index élevé).
// - Draggable par sa barre de titre, resizable par le coin bas-droit.
// - Position/taille persistées en localStorage (clé pi-web.preview-window).
// - Barre de titre : titre (path ou « Mockup ») + boutons ⟳ / device / ↗ / ✕.
// - L'iframe charge l'URL de preview (contenu = code du projet de l'utilisateur)
//   avec un sandbox permissif (scripts/forms/modals/popups/same-origin).
// - Échap ferme la fenêtre.

interface PreviewWindowProps {
  url: string;
  title: string;
  onClose: () => void;
}

// ── Géométrie persistée ────────────────────────────────
interface Geometry { x: number; y: number; w: number; h: number; }

const STORAGE_KEY = "pi-web.preview-window";

function loadGeometry(): Geometry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (typeof g.x !== "number" || typeof g.y !== "number" || typeof g.w !== "number" || typeof g.h !== "number") return null;
    if (g.w < 320 || g.h < 200) return null;
    return g;
  } catch { return null; }
}

function saveGeometry(g: Geometry) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(g)); } catch { /* ignore */ }
}

const DEFAULT_W = 900;
const DEFAULT_H = 600;

export function PreviewWindow({ url, title, onClose }: PreviewWindowProps) {
  const { t } = useTranslation();

  const saved = loadGeometry();
  const [pos, setPos] = useState({
    x: saved?.x ?? Math.max(40, (window.innerWidth - DEFAULT_W) / 2),
    y: saved?.y ?? Math.max(40, (window.innerHeight - DEFAULT_H) / 2),
  });
  const [size, setSize] = useState({ w: saved?.w ?? DEFAULT_W, h: saved?.h ?? DEFAULT_H });
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeState = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
  const posRef = useRef(pos); posRef.current = pos;
  const sizeRef = useRef(size); sizeRef.current = size;

  const forceSave = () => saveGeometry({ x: posRef.current.x, y: posRef.current.y, w: sizeRef.current.w, h: sizeRef.current.h });

  // ── Échap ferme la fenêtre ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  // ── Drag par la barre de titre ──
  const onTitleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    setIsDragging(true);
  };
  useEffect(() => {
    if (!isDragging) return;
    const move = (e: MouseEvent) => {
      if (!dragState.current) return;
      setPos({
        x: Math.max(0, dragState.current.origX + e.clientX - dragState.current.startX),
        y: Math.max(0, dragState.current.origY + e.clientY - dragState.current.startY),
      });
    };
    const up = () => { setIsDragging(false); dragState.current = null; forceSave(); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [isDragging]);

  // ── Resize par le coin bas-droit ──
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    resizeState.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
    setIsResizing(true);
  };
  useEffect(() => {
    if (!isResizing) return;
    const move = (e: MouseEvent) => {
      if (!resizeState.current) return;
      setSize({
        w: Math.max(320, resizeState.current.origW + e.clientX - resizeState.current.startX),
        h: Math.max(200, resizeState.current.origH + e.clientY - resizeState.current.startY),
      });
    };
    const up = () => { setIsResizing(false); resizeState.current = null; forceSave(); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [isResizing]);

  const openNewTab = () => window.open(url, "_blank", "noopener,noreferrer");

  const iframeWidth = device === "mobile" ? 375 : "100%";

  return (
    <div
      ref={boxRef}
      className={`preview-window ${isDragging ? "dragging" : ""} ${isResizing ? "resizing" : ""}`}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        zIndex: 2000,
        display: "flex",
        flexDirection: "column",
        background: "var(--surface-raised)",
        border: "1px solid var(--accent-dim)",
        boxShadow: "0 0 30px rgba(var(--accent-rgb), 0.15)",
        userSelect: "none",
      }}
    >
      {/* Barre de titre */}
      <div
        className="flex items-center justify-between px-2 h-8 border-b border-hacker-accent/20 bg-hacker-accent-dim/10 shrink-0 cursor-grab active:cursor-grabbing"
        onMouseDown={onTitleMouseDown}
      >
        <span className="text-xs text-hacker-text-dim font-bold tracking-wide truncate flex-1">{title}</span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setReloadKey(k => k + 1)}
            title={t('preview.refresh')}
            aria-label={t('preview.refresh')}
            className="p-1 text-hacker-text-dim hover:text-hacker-accent"
          >⟳</button>
          <button
            onClick={() => setDevice(d => d === "desktop" ? "mobile" : "desktop")}
            title={device === "desktop" ? t('preview.mobile') : t('preview.desktop')}
            aria-label={device === "desktop" ? t('preview.mobile') : t('preview.desktop')}
            className="p-1 text-hacker-text-dim hover:text-hacker-accent"
          >{device === "desktop" ? "📱" : "🖥"}</button>
          <button
            onClick={openNewTab}
            title={t('preview.openNewTab')}
            aria-label={t('preview.openNewTab')}
            className="p-1 text-hacker-text-dim hover:text-hacker-accent"
          >↗</button>
          <button
            onClick={onClose}
            title={t('preview.close')}
            aria-label={t('preview.close')}
            className="p-1 text-hacker-text-dim hover:text-hacker-error"
          >✕</button>
        </div>
      </div>

      {/* Contenu : iframe de preview */}
      <div className="flex-1 overflow-auto relative" style={{ userSelect: "auto" }}>
        <div
          className="h-full w-full"
          style={{ display: "flex", justifyContent: device === "mobile" ? "center" : "flex-start" }}
        >
          <iframe
            key={reloadKey}
            src={url}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
            title={title}
            style={{ width: iframeWidth, height: "100%", border: "none", background: "#fff", flexShrink: 0 }}
          />
        </div>
      </div>

      {/* Poignée de resize (coin bas-droit) */}
      <div
        onMouseDown={onResizeMouseDown}
        className="preview-resize-handle"
        style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", zIndex: 10 }}
      />
    </div>
  );
}
