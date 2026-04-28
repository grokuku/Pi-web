import type { Project } from "../../types";

interface Props {
  activeProject: Project | null;
  isStreaming: boolean;
  stats: { tokens: number; cost: number; contextPercent: number } | null;
  session: any;
}

export function StatusBar({
  activeProject,
  isStreaming,
  stats,
  session,
}: Props) {
  return (
    <div className="h-6 status-glow bg-hacker-surface flex items-center px-3 gap-4 text-[10px] shrink-0">
      {/* Project info */}
      {activeProject ? (
        <>
          <span className="text-hacker-accent">
            {activeProject.type === "ssh" ? "🔗" : activeProject.type === "smb" ? "💾" : "📁"}{" "}
            {activeProject.name}
          </span>
          <span className="text-hacker-text-dim">|</span>
          <span className="text-hacker-text-dim">{activeProject.cwd}</span>
        </>
      ) : (
        <span className="text-hacker-text-dim">No project selected</span>
      )}

      <div className="flex-1" />

      {/* Session info */}
      {session && (
        <>
          <span className="text-hacker-text-dim">
            {session.model?.name || "No model"}
          </span>
          <span className="text-hacker-text-dim">|</span>
        </>
      )}

      {/* Streaming indicator */}
      {isStreaming && (
        <>
          <span className="text-hacker-accent flex items-center gap-1">
            <span className="pulse-dot w-1.5 h-1.5" /> streaming
          </span>
          <span className="text-hacker-text-dim">|</span>
        </>
      )}

      {/* Stats */}
      {stats && (
        <>
          <span className="text-hacker-text-dim">
            {(stats.tokens / 1000).toFixed(1)}K tokens
          </span>
          <span className="text-hacker-text-dim">|</span>
          <span className="text-hacker-text-dim">
            ${stats.cost.toFixed(4)}
          </span>
          <span className="text-hacker-text-dim">|</span>
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-hacker-border">
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
            <span className="text-hacker-text-dim">
              {stats.contextPercent}%
            </span>
          </div>
        </>
      )}
    </div>
  );
}
