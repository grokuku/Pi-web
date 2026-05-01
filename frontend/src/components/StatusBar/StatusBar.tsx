import type { Project } from "../../types";

interface Props {
  activeProject: Project | null;
  isStreaming: boolean;
  stats: { tokens: number; cost: number; contextPercent: number } | null;
  session: any;
  connected: boolean;
}

export function StatusBar({
  activeProject,
  isStreaming,
  stats,
  session,
  connected,
}: Props) {
  return (
    <div className="h-7 status-glow bg-hacker-surface flex items-center px-3 gap-3 text-[10px] shrink-0">
      {/* Project info */}
      {activeProject ? (
        <>
          <span className="text-hacker-accent">
            {activeProject.storage === "ssh" ? "🔗" : activeProject.storage === "smb" ? "💾" : "📁"}{" "}
            {activeProject.name}
          </span>
          <span className="text-hacker-border-bright">│</span>
          <span className="text-hacker-text-dim truncate max-w-[250px]" title={activeProject.cwd}>
            {activeProject.cwd}
          </span>
          {activeProject.git?.branch && (
            <>
              <span className="text-hacker-border-bright">│</span>
              <span className="text-hacker-info">
                {activeProject.git.branch}
              </span>
            </>
          )}
        </>
      ) : (
        <span className="text-hacker-text-dim">No project</span>
      )}

      <div className="flex-1" />

      {/* Model */}
      {session?.model?.name && (
        <>
          <span className="text-hacker-text-dim">
            {session.model.name}
          </span>
          <span className="text-hacker-border-bright">│</span>
        </>
      )}

      {/* Thinking level */}
      {session?.thinkingLevel && session.thinkingLevel !== "off" && (
        <>
          <span className="text-hacker-warn/70">
            🧠 {session.thinkingLevel}
          </span>
          <span className="text-hacker-border-bright">│</span>
        </>
      )}

      {/* Streaming */}
      {isStreaming && (
        <>
          <span className="text-hacker-accent flex items-center gap-1">
            <span className="pulse-dot w-1.5 h-1.5" /> streaming
          </span>
          <span className="text-hacker-border-bright">│</span>
        </>
      )}

      {/* Stats */}
      {stats && (
        <>
          {/* Token count with context bar */}
          <span className="text-hacker-text-dim">
            {(stats.tokens / 1000).toFixed(1)}K tok
          </span>
          <span className="text-hacker-border-bright">│</span>
          <span className="text-hacker-text-dim">
            ${stats.cost.toFixed(4)}
          </span>
          <span className="text-hacker-border-bright">│</span>
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-hacker-border rounded-sm overflow-hidden">
              <div
                className={`h-full transition-all ${
                  stats.contextPercent > 80
                    ? "bg-hacker-warn"
                    : stats.contextPercent > 60
                    ? "bg-hacker-info"
                    : "bg-hacker-accent"
                }`}
                style={{ width: `${Math.min(stats.contextPercent, 100)}%` }}
              />
            </div>
            <span className="text-hacker-text-dim min-w-[27px]">
              {stats.contextPercent}%
            </span>
          </div>
          <span className="text-hacker-border-bright">│</span>
        </>
      )}
    </div>
  );
}