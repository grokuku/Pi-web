import { memo, useState, useEffect, useRef, useCallback } from "react";
import {
  FileSearch,
  Terminal,
  FileEdit,
  Search,
  Globe,
  Database,
  ScanEye,
  List,
  Wrench,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { ToolCallInfo } from "../../types";

// ── Tool icon mapping ──────────────────────────────────
interface ToolIcon { component: React.ComponentType<any>; color: string }

const TOOL_ICONS: Record<string, ToolIcon> = {
  read:               { component: FileSearch, color: "var(--info)" },
  bash:               { component: Terminal,   color: "var(--accent)" },
  shell:              { component: Terminal,   color: "var(--accent)" },
  edit:               { component: FileEdit,   color: "var(--warm)" },
  write:              { component: FileEdit,   color: "var(--warm)" },
  "write-file":       { component: FileEdit,   color: "var(--warm)" },
  grep:               { component: Search,     color: "var(--info)" },
  find:               { component: Search,     color: "var(--info)" },
  ls:                 { component: List,       color: "var(--text-dim)" },
  list:               { component: List,       color: "var(--text-dim)" },
  firecrawl_scrape:   { component: Globe,      color: "var(--accent)" },
  firecrawl_map:      { component: Globe,      color: "var(--accent)" },
  firecrawl_search:   { component: Globe,      color: "var(--accent)" },
  memory_store:       { component: Database,   color: "var(--accent)" },
  memory_search:      { component: Database,   color: "var(--accent)" },
  memory_delete:      { component: Database,   color: "var(--accent)" },
  memory_list:        { component: Database,   color: "var(--accent)" },
  global_memory_search: { component: Database, color: "var(--accent)" },
  global_memory_list: { component: Database,   color: "var(--accent)" },
  analyze_file:       { component: ScanEye,    color: "var(--warn)" },
};

const DEFAULT_TOOL_ICON: ToolIcon = { component: Wrench, color: "var(--text-dim)" };

function getToolIcon(name: string): ToolIcon {
  return TOOL_ICONS[name] || DEFAULT_TOOL_ICON;
}

// ── Duration formatting ────────────────────────────────
function formatDuration(ms: number): string {
  if (ms < 100) return `${ms}ms`;
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Argument formatting ────────────────────────────────
type FlatArg = { key: string; value: string };

/** Extract key display arguments from a tool call, avoiding raw JSON. */
function formatToolArgs(args: any): FlatArg[] {
  if (!args || typeof args !== "object" || Object.keys(args).length === 0) return [];
  const flat: FlatArg[] = [];

  // Resolve nested wrapper
  const real = args.arguments ?? args.input ?? args;

  // Priority display keys
  const displayKeys = ["command", "pattern", "path", "file_path", "filePath", "path", "filename",
    "message", "query", "url", "directory", "glob", "projectId", "title", "name"];
  const shown = new Set<string>();

  // Show priority keys first
  for (const key of displayKeys) {
    if (key in real && !shown.has(key)) {
      const val = real[key];
      if (val !== undefined && val !== null) {
        flat.push({ key, value: truncateStr(String(val), 80) });
        shown.add(key);
      }
    }
  }

  // Show remaining keys (but cap at 6 total)
  for (const [key, val] of Object.entries(real)) {
    if (shown.has(key)) continue;
    if (flat.length >= 6) break;
    if (val !== undefined && val !== null) {
      flat.push({ key, value: truncateStr(String(val), 60) });
      shown.add(key);
    }
  }

  return flat;
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── Props ──────────────────────────────────────────────
interface Props {
  tools: ToolCallInfo[];
  compact?: boolean;
  onExpand?: () => void;
}

// ── Tool badge (compact mode) ──────────────────────────
const ToolBadge = memo(function ToolBadge({ tool, onClick }: {
  tool: ToolCallInfo;
  onClick: () => void;
}) {
  const Icon = getToolIcon(tool.name).component;
  const color = getToolIcon(tool.name).color;
  const [timedOut, setTimedOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Safety timeout: stop pulse after 90s if tool never finishes
  useEffect(() => {
    if (tool.isStreaming) {
      const timer = setTimeout(() => setTimedOut(true), 90000);
      timerRef.current = timer;
      return () => clearTimeout(timer);
    } else {
      setTimedOut(false);
    }
  }, [tool.isStreaming]);

  const status = timedOut ? "stale"
    : tool.isStreaming ? "running"
    : tool.isError ? "error"
    : "success";

  return (
    <button
      className={`tool-badge ${status}`}
      onClick={onClick}
      title={tool.output ? tool.output.slice(0, 200) : undefined}
      style={{ borderColor: tool.isStreaming ? color : undefined, color: tool.isStreaming ? color : undefined }}
    >
      <span className="tool-badge-icon"><Icon size={10} style={{ color }} /></span>
      <span>{tool.name}</span>
      {status === "success" && <span style={{ color }}>✓</span>}
      {status === "error" && <span>✕</span>}
      {status === "running" && <span style={{ color }}>⟳</span>}
      {status === "stale" && <span style={{ opacity: 0.4 }}>?</span>}
    </button>
  );
});

// ── Tool timeline item ─────────────────────────────────
const TimelineItem = memo(function TimelineItem({ tool, onClose }: { tool: ToolCallInfo; onClose?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const Icon = getToolIcon(tool.name).component;
  const color = getToolIcon(tool.name).color;
  const outputRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState<string | null>(null);

  // Compute duration once tool finishes streaming
  useEffect(() => {
    if (!tool.isStreaming && tool.startTime) {
      const elapsed = Date.now() - tool.startTime;
      setDuration(formatDuration(elapsed));
    }
  }, [tool.isStreaming, tool.startTime]);

  // Auto-expand when tool starts, auto-collapse when done
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (tool.isStreaming && !wasStreaming.current) {
      setExpanded(true);
      // Safety timeout: if tool stays streaming > 90s with no output, mark as timed out
      const timer = setTimeout(() => {
        // Don't actually modify the tool — just stop the local visual pulse.
        // The isStreaming stays true on the tool object, but we use a local override.
        setTimedOut(true);
      }, 90000);
      timerRef.current = timer;
    } else if (!tool.isStreaming && wasStreaming.current) {
      setExpanded(false);
      setTimedOut(false);
      if (timerRef.current) clearTimeout(timerRef.current);
    }
    wasStreaming.current = tool.isStreaming;
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [tool.isStreaming]);

  // Scroll output to bottom on streaming
  useEffect(() => {
    if (expanded && tool.isStreaming && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [tool.output, expanded, tool.isStreaming]);

  const status = timedOut ? "stale"
    : tool.isStreaming ? "running"
    : tool.isError ? "error"
    : "success";
  const args = formatToolArgs(tool.args);
  const hasArgs = args.length > 0;
  const hasOutput = !!tool.output;

  return (
    <div className="tool-timeline-item">
      {/* Dot */}
      <div className={`tool-timeline-dot ${status}`} />

      {/* Header */}
      <div className="tool-timeline-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-timeline-icon">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <span className="tool-timeline-icon" style={{ color }}>
          <Icon size={12} />
        </span>
        <span className="tool-timeline-name">{tool.name}</span>
        {duration && <span className="tool-timeline-duration">{duration}</span>}
        <span className="tool-timeline-status">
          {status === "running" && <span style={{ color: "var(--accent)" }}>⟳</span>}
          {status === "success" && <span style={{ color }}>✓</span>}
          {status === "error" && <span style={{ color: "var(--error)" }}>✕</span>}
          {status === "stale" && <span style={{ color: "var(--text-dim)", opacity: 0.4 }}>?</span>}
        </span>
        {onClose && (
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="ml-1 text-hacker-text-dim hover:text-hacker-warn transition-colors"
            title="Collapse tool"
          >
            ✕
          </button>
        )}
      </div>

      {/* Expanded: args + output */}
      {expanded && (
        <>
          {hasArgs && (
            <div className="tool-timeline-args">
              {args.map((arg, i) => (
                <span key={i} className="tool-timeline-arg">
                  <span className="tool-timeline-arg-key">{arg.key}=</span>
                  <span className="tool-timeline-arg-val" title={arg.value}>{arg.value}</span>
                </span>
              ))}
            </div>
          )}
          {hasOutput && (
            <div ref={outputRef} className={`tool-output ${tool.isError ? "text-hacker-error" : ""}`}>
              {tool.output}
            </div>
          )}
        </>
      )}
    </div>
  );
});

// ── Main component ─────────────────────────────────────
export const ToolTimeline = memo(function ToolTimeline({ tools, compact, onExpand }: Props) {
  if (!tools || tools.length === 0) return null;

  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());

  // Compact mode: render badges, click to expand one tool individually
  if (compact) {
    const hasExpandedSome = expandedToolIds.size > 0;
    const regular = tools.filter(tc => !expandedToolIds.has(tc.id));
    const expanded = tools.filter(tc => expandedToolIds.has(tc.id));

    return (
      <>
        {regular.length > 0 && (
          <div className="tool-badges">
            {regular.map((tc) => (
              <ToolBadge key={tc.id} tool={tc} onClick={() => {
                setExpandedToolIds(prev => new Set(prev).add(tc.id));
              }} />
            ))}
          </div>
        )}
        {hasExpandedSome && (
          <div className="tool-timeline">
            <div className="tool-timeline-line" />
            {expanded.map((tc) => (
              <div key={tc.id}>
                <TimelineItem key={tc.id} tool={tc} onClose={() => {
                  setExpandedToolIds(prev => {
                    const next = new Set(prev);
                    next.delete(tc.id);
                    return next;
                  });
                }} />
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // Timeline mode
  return (
    <div className="tool-timeline">
      <div className="tool-timeline-line" />
      {tools.map((tc) => (
        <TimelineItem key={tc.id} tool={tc} />
      ))}
    </div>
  );
});
