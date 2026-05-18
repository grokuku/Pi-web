import { memo, useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import { useTranslation } from "../../i18n";

interface Props {
  thinking: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ thinking, isStreaming, defaultExpanded = true }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const hasContent = thinking.length > 0;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(thinking).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
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
