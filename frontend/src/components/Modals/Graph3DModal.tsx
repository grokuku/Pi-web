import { X, ExternalLink, RefreshCw } from "lucide-react";
import { useState, useEffect } from "react";

interface Props {
  onClose: () => void;
}

export function Graph3DModal({ onClose }: Props) {
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
            📊 CODEBASE GRAPH 3D
          </span>
          {available === false && (
            <span className="text-hacker-warn text-[10px]">
              — Server not running. Start a Pi session to index the project.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href="http://localhost:9749"
            target="_blank"
            rel="noopener noreferrer"
            className="text-hacker-text-dim hover:text-hacker-accent p-1"
            title="Open in new tab (direct)"
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
            title="Reload"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={onClose}
            className="text-hacker-text-dim hover:text-hacker-error p-1"
            title="Close"
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
              <div className="animate-pulse">Loading 3D graph...</div>
            </div>
          </div>
        )}
        {available === false ? (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="text-center space-y-3 max-w-md">
              <div className="text-hacker-warn text-sm font-bold">⚠ Graph server not available</div>
              <div className="text-hacker-text-dim text-xs">
                The codebase-memory-mcp binary needs to be running to display the 3D graph.
                <br /><br />
                It starts automatically when you open a Pi chat session.
                <br /><br />
                If the binary is not installed yet, it will be downloaded on first session start (~15 MB).
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
                Retry
              </button>
            </div>
          </div>
        ) : (
          <iframe
            id="cbm-graph-frame"
            src="/cbm-ui/"
            className="w-full h-full border-0"
            onLoad={() => setLoading(false)}
            title="Codebase 3D Graph"
          />
        )}
      </div>
    </div>
  );
}