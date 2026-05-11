import type { Project } from "../../types";
import { PiLogo } from "../common/PiLogo";

interface Props {
  activeProject: Project | null;
  isStreaming: boolean;
  stats: { tokens: number; contextPercent: number; totalTokens: number } | null;
  session: any;
  connected: boolean;
  activeMode?: string;
  autoReviewState?: { inProgress: boolean; cycle: number; maxReviews: number; phase?: string } | null;
}

export function StatusBar({
  activeProject,
  isStreaming,
  stats,
  session,
  connected,
  activeMode = "code",
  autoReviewState,
}: Props) {
  // Show zero stats when a session exists but stats haven't been populated yet
  const displayStats = stats || (session ? { tokens: 0, contextPercent: 0, totalTokens: 0 } : null);

  return (
    <div className="h-8 status-glow bg-hacker-surface flex items-center px-3 gap-3 text-[11px] shrink-0">
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

      {/* Active mode */}
      {activeMode && activeMode !== "code" && (
        <>
          <span className={activeMode === "review" ? "text-hacker-warn" : activeMode === "plan" ? "text-hacker-info" : "text-hacker-accent"}>
            {activeMode === "review" ? "📋" : activeMode === "plan" ? "🗺" : <PiLogo className="w-3 h-3 inline" />} {activeMode.toUpperCase()}
          </span>
          <span className="text-hacker-border-bright">│</span>
        </>
      )}

      {/* Auto-review indicator */}
      {autoReviewState?.inProgress && (
        <>
          <span className="text-hacker-warn animate-pulse">
            🔄 {autoReviewState.phase === "reviewing" ? "Reviewing" : "Fixing"} ({autoReviewState.cycle}/{autoReviewState.maxReviews})
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
      {displayStats && (
        <>
          {/* Current context: last prompt size */}
          <span className="text-hacker-text-dim" title={`Context: ${displayStats.tokens.toLocaleString()} tokens\nTotal: ${displayStats.totalTokens.toLocaleString()} tokens`}>
            ctx {(displayStats.tokens / 1000).toFixed(1)}K
          </span>
          <span className="text-hacker-border-bright">│</span>
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-hacker-border rounded-sm overflow-hidden">
              <div
                className={`h-full transition-all ${
                  displayStats.contextPercent > 80
                    ? "bg-hacker-warn"
                    : displayStats.contextPercent > 60
                    ? "bg-hacker-info"
                    : "bg-hacker-accent"
                }`}
                style={{ width: `${Math.min(displayStats.contextPercent, 100)}%` }}
              />
            </div>
            <span className="text-hacker-text-dim min-w-[27px]">
              {displayStats.contextPercent}%
            </span>
            {session?.model?.contextWindow && (
              <span className="text-hacker-text-dim" title="Model context window">
                /{session.model.contextWindow >= 1000000 ? `${(session.model.contextWindow / 1000000).toFixed(0)}M` : `${(session.model.contextWindow / 1000).toFixed(0)}K`}
              </span>
            )}
          </div>
          <span className="text-hacker-border-bright">│</span>
        </>
      )}
    </div>
  );
}