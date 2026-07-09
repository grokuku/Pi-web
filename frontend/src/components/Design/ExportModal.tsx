import { useState, useCallback } from "react";
import { Copy, Download, X } from "lucide-react";

interface ExportModalProps {
  html: string;
  css: string;
  onClose: () => void;
}

export function ExportModal({ html, css, onClose }: ExportModalProps) {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const handleCopyHtml = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopyFeedback("HTML copied!");
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setCopyFeedback("Failed to copy");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [html]);

  const handleCopyCss = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(css);
      setCopyFeedback("CSS copied!");
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setCopyFeedback("Failed to copy");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [css]);

  const handleDownload = useCallback(() => {
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Exported Design</title>
  <style>
${css}
  </style>
</head>
<body>
${html}
</body>
</html>`;
    const blob = new Blob([fullHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "design-export.html";
    a.click();
    URL.revokeObjectURL(url);
  }, [html, css]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-hacker-surface border border-hacker-border rounded-lg shadow-2xl w-[48rem] max-w-[90vw] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-hacker-border shrink-0">
          <h2 className="text-sm font-bold text-hacker-accent tracking-wider">
            EXPORT DESIGN
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-hacker-text-dim hover:text-hacker-accent transition-colors"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Copy feedback */}
          {copyFeedback && (
            <div className="text-xs text-hacker-accent font-bold text-center">
              {copyFeedback}
            </div>
          )}

          {/* HTML */}
          <div>
            <label className="text-xs font-bold text-hacker-text-dim mb-1 block">
              HTML
            </label>
            <textarea
              readOnly
              value={html}
              className="w-full h-40 bg-hacker-bg text-hacker-text text-xs font-mono border border-hacker-border rounded p-2 resize-y focus:outline-none focus:border-hacker-accent"
              spellCheck={false}
            />
          </div>

          {/* CSS */}
          <div>
            <label className="text-xs font-bold text-hacker-text-dim mb-1 block">
              CSS
            </label>
            <textarea
              readOnly
              value={css}
              className="w-full h-32 bg-hacker-bg text-hacker-text text-xs font-mono border border-hacker-border rounded p-2 resize-y focus:outline-none focus:border-hacker-accent"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hacker-border shrink-0">
          <button
            onClick={handleCopyHtml}
            className="btn-hacker text-xs px-3 py-1.5 flex items-center gap-1"
          >
            <Copy size={14} />
            Copy HTML
          </button>
          <button
            onClick={handleCopyCss}
            className="btn-hacker text-xs px-3 py-1.5 flex items-center gap-1"
          >
            <Copy size={14} />
            Copy CSS
          </button>
          <button
            onClick={handleDownload}
            className="btn-hacker text-xs px-3 py-1.5 flex items-center gap-1"
          >
            <Download size={14} />
            Download .html
          </button>
          <button
            onClick={onClose}
            className="btn-hacker text-xs px-3 py-1.5"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
