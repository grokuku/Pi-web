import { memo, useState, useCallback, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import { useTranslation } from "../../i18n";
import { copyToClipboard } from "../../utils/clipboard";

interface Props {
  thinking: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  // Lot C : vrai dès que la réponse (text_delta) a commencé à arriver → le
  // bloc se replie automatiquement (info consommée), sauf override manuel.
  textStarted?: boolean;
  // Lot C : durée de réflexion figée (ms) — affichée dans l'en-tête replié.
  thinkingDurationMs?: number;
}

// Formate une durée en ms → "12s" / "1m 05s" (affichage en-tête replié).
function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export const ThinkingBlock = memo(function ThinkingBlock({ thinking, isStreaming, defaultExpanded = true, textStarted = false, thinkingDurationMs }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Override manuel : une fois que l'utilisateur a toggle pendant ce stream,
  // l'auto-repli ne s'applique plus (même pattern que ToolCallRow).
  const [userToggled, setUserToggled] = useState(false);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasContent = thinking.length > 0;

  // Auto-repli quand la réponse commence à arriver (info consommée) — sauf si
  // l'utilisateur a manuellement toggle pendant ce stream (override prime).
  useEffect(() => {
    if (textStarted && isStreaming && !userToggled) setExpanded(false);
  }, [textStarted, isStreaming, userToggled]);

  // Nettoyage du timer de feedback si le bloc est démonté
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  const toggle = useCallback(() => {
    setUserToggled(true);
    setExpanded(v => !v);
  }, []);

  const handleCopy = useCallback(async () => {
    // Helper robuste (navigator.clipboard + fallback execCommand) : nécessaire
    // en http LAN non sécurisé où navigator.clipboard n'existe pas.
    const ok = await copyToClipboard(thinking);
    if (!ok) return;
    setCopied(true);
    // Feedback « Copié ✓ » pendant 2s puis retour à l'icône copier
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [thinking]);

  if (!hasContent) return null;

  return (
    <div className="thinking-block mb-2">
      <div className="thinking-block-header">
        <button
          onClick={toggle}
          className="thinking-toggle-btn"
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span className="thinking-block-label">{t('thinkingBlock.thinking')}</span>
          {!expanded && thinkingDurationMs !== undefined && (
            <span className="thinking-block-duration">{t('chat.thoughtFor', formatDuration(thinkingDurationMs))}</span>
          )}
        </button>
        <button onClick={handleCopy} className="thinking-copy-btn" title={t('thinkingBlock.copy')}>
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? t('thinkingBlock.copied') : t('thinkingBlock.copy')}
        </button>
      </div>
      {expanded && (
        <>
          <div className="thinking-content">{thinking}</div>
          {isStreaming && (
            <div className="thinking-progress-bar">
              <div className="thinking-progress-fill" />
            </div>
          )}
        </>
      )}
    </div>
  );
});
