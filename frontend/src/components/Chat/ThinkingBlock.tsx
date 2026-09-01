import { memo, useState, useCallback, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import { useTranslation } from "../../i18n";
import { copyToClipboard } from "../../utils/clipboard";

interface Props {
  thinking: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ thinking, isStreaming, defaultExpanded = true }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasContent = thinking.length > 0;

  // Nettoyage du timer de feedback si le bloc est démonté
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

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
          onClick={() => setExpanded(!expanded)}
          className="thinking-toggle-btn"
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span className="thinking-block-label">{t('thinkingBlock.thinking')}</span>
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
