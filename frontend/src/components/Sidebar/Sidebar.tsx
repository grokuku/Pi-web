import {
  FolderGit,
  Plus,
  Power,
  Terminal,
  FolderOpen,
  RefreshCw,
  FileText,
} from "lucide-react";
import type { Project } from "../../types";

interface Props {
  projects: Project[];
  activeProject: Project | null;
  stats: { tokens: number; cost: number; contextPercent: number } | null;
  isStreaming: boolean;
  onSelectProject: (p: Project) => void;
  onAddProject: () => void;
  send: (msg: any) => void;
  session: any;
}

export function Sidebar({
  projects,
  activeProject,
  stats,
  isStreaming,
  onSelectProject,
  onAddProject,
  send,
  session,
}: Props) {
  return (
    <aside className="w-52 border-r border-hacker-border-bright bg-hacker-surface sidebar-stripe flex flex-col shrink-0 text-xs">
      {/* Projects section */}
      <div className="p-2 border-b border-hacker-border">
        <div className="text-hacker-accent text-[10px] tracking-widest mb-2">
          ⚡ PROJECTS
        </div>

        <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelectProject(p)}
              className={`w-full text-left px-2 py-1 flex items-center gap-1.5 ${
                activeProject?.id === p.id
                  ? "bg-hacker-accent/10 border border-hacker-accent/30 text-hacker-accent"
                  : "hover:bg-hacker-border/50 text-hacker-text-dim"
              }`}
            >
              <span className="text-[10px]">
                {p.type === "ssh" ? "🔗" : p.type === "smb" ? "💾" : "📁"}
              </span>
              <span className="truncate">{p.name}</span>
              {p.git?.branch && (
                <span className="text-[8px] text-hacker-info ml-auto">git</span>
              )}
            </button>
          ))}
        </div>

        <button
          onClick={onAddProject}
          className="w-full mt-2 btn-hacker text-[10px] py-1 flex items-center justify-center gap-1"
        >
          <Plus size={12} /> NEW PROJECT
        </button>
      </div>

      {/* Session stats */}
      <div className="p-2 border-b border-hacker-border">
        <div className="text-hacker-accent text-[10px] tracking-widest mb-2">
          📊 STATS
        </div>

        {session ? (
          <div className="space-y-1">
            <StatRow label="Model" value={session.model?.name || "?"} />
            <StatRow label="Thinking" value={session.thinkingLevel || "off"} />
            <StatRow
              label="Messages"
              value={String(session.messageCount || 0)}
            />
            {stats && (
              <>
                <StatRow
                  label="Tokens"
                  value={formatTokens(stats.tokens)}
                />
                <StatRow label="Cost" value={`$${stats.cost.toFixed(4)}`} />
                <StatRow
                  label="Context"
                  value={`${stats.contextPercent}%`}
                  warn={stats.contextPercent > 80}
                />
              </>
            )}
            {isStreaming && (
              <div className="flex items-center gap-1.5 text-hacker-accent">
                <span className="pulse-dot w-2 h-2" />
                <span>streaming...</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-hacker-text-dim italic text-[10px]">
            No active session
          </div>
        )}
      </div>

      {/* Git info */}
      {activeProject?.git?.remote && (
        <div className="p-2 border-b border-hacker-border">
          <div className="text-hacker-accent text-[10px] tracking-widest mb-2">
            🗃 GIT
          </div>
          <div className="space-y-1">
            <StatRow label="Remote" value={truncate(activeProject.git.remote, 20)} />
            <StatRow label="Branch" value={activeProject.git.branch} />
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="p-2 mt-auto border-t border-hacker-border-bright">
        <div className="text-hacker-accent text-[10px] tracking-widest mb-2">
          ⚡ ACTIONS
        </div>
        <div className="space-y-1">
          <ActionBtn
            icon={<RefreshCw size={12} />}
            label="Restart Pi"
            onClick={() => {
              send({ type: "pi_start", projectId: activeProject?.id });
            }}
          />
          <ActionBtn
            icon={<FileText size={12} />}
            label="New Session"
            onClick={async () => {
              await fetch("/api/settings/session/new", { method: "POST" });
            }}
          />
          <ActionBtn
            icon={<FolderOpen size={12} />}
            label="Explorer"
            onClick={() => {
              send({
                type: "pi_prompt",
                message: "List the files in the current directory",
              });
            }}
          />
          <ActionBtn
            icon={<Power size={12} />}
            label="Shutdown Pi"
            onClick={() => {
              send({ type: "pi_abort" });
            }}
            danger
          />
        </div>
      </div>
    </aside>
  );
}

function StatRow({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-hacker-text-dim">{label}</span>
      <span className={warn ? "text-hacker-warn" : "text-hacker-text-bright"}>
        {value}
      </span>
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 px-2 py-1 text-left ${
        danger
          ? "text-hacker-error hover:bg-hacker-error/10 border border-transparent hover:border-hacker-error/30"
          : "text-hacker-text-dim hover:text-hacker-text hover:bg-hacker-border/50"
      }`}
    >
      {icon}
      <span className="text-[10px]">{label}</span>
    </button>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return "..." + s.slice(-max);
}
