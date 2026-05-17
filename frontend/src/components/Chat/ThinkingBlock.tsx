import { memo, useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";

interface Props {
  thinking: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ thinking, isStreaming, defaultExpanded = true }: Props) {
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
          <span className="thinking-block-label">THINKING</span>
        </button>
        <button onClick={handleCopy} className="thinking-copy-btn" title="Copy thinking">
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? " Copied" : " Copy"}
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
