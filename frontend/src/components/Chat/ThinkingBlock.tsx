import { memo, useState, useEffect, useCallback } from "react";
import { Copy, Check } from "lucide-react";

interface Props {
  thinking: string;
  isStreaming?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ thinking, isStreaming }: Props) {
  const [copied, setCopied] = useState(false);
  const hasContent = thinking.length > 0;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(thinking).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [thinking]);

  // Don't show thinking block at all if no content (prevents rendering empty block when streaming hasn't produced thinking yet)
  if (!hasContent) return null;

  return (
    <div className="thinking-block mb-2">
      <div className="thinking-block-header">
        <span className="thinking-block-label">THINKING</span>
        <button onClick={handleCopy} className="thinking-copy-btn" title="Copy thinking">
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? " Copied" : " Copy"}
        </button>
      </div>
      <div className="thinking-content">{thinking}</div>
      {isStreaming && (
        <div className="thinking-progress-bar">
          <div className="thinking-progress-fill" />
        </div>
      )}
    </div>
  );
});
