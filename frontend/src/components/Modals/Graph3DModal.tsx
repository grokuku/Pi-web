import { X, ExternalLink, RefreshCw } from "lucide-react";
import { useState, useEffect } from "react";
import { useOverlayStack, isTopOverlay } from "../../hooks/useOverlayStack";
import { useTranslation } from "../../i18n";

interface Props {
  onClose: () => void;
}

export function Graph3DModal({ onClose }: Props) {
  const { t } = useTranslation();
  // Lot B : harmonisation Échap — cet overlay plein écran (non basé sur
  // ModalDialog) ne gérait pas la touche Échap. Il s'enregistre désormais dans
  // la pile centralisée et se ferme comme les autres modaux, uniquement s'il
  // est au sommet de la pile.
  const overlayToken = useOverlayStack();
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
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState<boolean | null>(null);

  // Check if CBM server is running
  useEffect(() => {
    fetch("/api/cbm/status")
      .then(r => r.json())
      .then(data => {
        setAvailable(data.running ?? false);
      })
      .catch(() => setAvailable(false));
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 bg-hacker-bg/95 flex flex-col"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-hacker-border-bright bg-hacker-surface shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-hacker-accent text-xs font-bold tracking-widest">
            📊 {t('graph3d.title')}
          </span>
          {available === false && (
            <span className="text-hacker-warn text-[10px]">
              {t('graph3d.serverNotRunning')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/cbm-ui/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-hacker-text-dim hover:text-hacker-accent p-1"
            title={t('graph3d.openNewTab')}
          >
            <ExternalLink size={14} />
          </a>
          <button
            onClick={() => {
              setLoading(true);
              // Force iframe reload by changing key
              const iframe = document.getElementById("cbm-graph-frame") as HTMLIFrameElement;
              if (iframe) iframe.src = "/cbm-ui/";
            }}
            className="text-hacker-text-dim hover:text-hacker-accent p-1"
            title={t('graph3d.reload')}
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={onClose}
            className="text-hacker-text-dim hover:text-hacker-error p-1"
            title={t('graph3d.close')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* iframe container */}
      <div className="flex-1 relative bg-hacker-bg">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-hacker-text-dim text-xs">
              <div className="animate-pulse">{t('graph3d.loading')}</div>
            </div>
          </div>
        )}
        {available === false ? (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="text-center space-y-3 max-w-md">
              <div className="text-hacker-warn text-sm font-bold">{t('graph3d.notAvailable')}</div>
              <div className="text-hacker-text-dim text-xs whitespace-pre-line">
                {t('graph3d.notAvailableDesc')}
              </div>
              <button
                onClick={() => {
                  fetch("/api/cbm/status")
                    .then(r => r.json())
                    .then(data => setAvailable(data.running ?? false))
                    .catch(() => setAvailable(false));
                }}
                className="btn-hacker text-xs px-3 py-1.5"
              >
                {t('graph3d.retry')}
              </button>
            </div>
          </div>
        ) : (
          <iframe
            id="cbm-graph-frame"
            src="/cbm-ui/"
            className="w-full h-full border-0"
            onLoad={() => setLoading(false)}
            title={t('graph3d.iframeTitle')}
          />
        )}
      </div>
    </div>
  );
}