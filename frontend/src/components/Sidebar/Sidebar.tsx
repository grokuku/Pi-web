import {
  Plus,
  Power,
  FolderOpen,
  RefreshCw,
  FileText,
  Trash2,
  Terminal,
  MessageSquare,
} from "lucide-react";
import { GitPanel } from "./GitPanel";
import type { Project } from "../../types";

interface Props {
  projects: Project[];
  activeProject: Project | null;
  isStreaming: boolean;
  activeTab: "pi" | "terminal";
  onSelectTab: (tab: "pi" | "terminal") => void;
  onSelectProject: (p: Project) => void;
  onAddProject: () => void;
  onDeleteProject: (p: Project) => void;
  send: (msg: any) => void;
  session: any;
  projectSessions?: Map<string, { isStreaming: boolean; session: any; stats: any }>;
}

export function Sidebar({
  projects,
  activeProject,
  isStreaming,
  activeTab,
  onSelectTab,
  onSelectProject,
  onAddProject,
  onDeleteProject,
  send,
  session,
  projectSessions,
}: Props) {
  return (
    <aside className="w-48 border-r-2 border-hacker-accent/20 sidebar-zone sidebar-stripe flex flex-col shrink-0 text-xs">
      {/* ── Tab switcher [PI] [TERM] ── */}
      <div className="flex border-b border-hacker-border-bright">
        <button
          onClick={() => onSelectTab("pi")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold tracking-wide transition-colors ${
            activeTab === "pi"
              ? "bg-hacker-accent/10 text-hacker-accent border-b-2 border-hacker-accent"
              : "text-hacker-text-dim hover:text-hacker-text hover:bg-hacker-border/30"
          }`}
        >
          <MessageSquare size={12} />
          PI
        </button>
        <button
          onClick={() => onSelectTab("terminal")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold tracking-wide transition-colors ${
            activeTab === "terminal"
              ? "bg-hacker-accent/10 text-hacker-accent border-b-2 border-hacker-accent"
              : "text-hacker-text-dim hover:text-hacker-text hover:bg-hacker-border/30"
          }`}
        >
          <Terminal size={12} />
          TERM
        </button>
      </div>

      {/* ── Projects ── */}
      <div className="p-2 border-b border-hacker-border">
        <div className="text-hacker-accent text-[10px] tracking-widest mb-1.5">
          PROJECTS
        </div>

        <div className="space-y-0.5 max-h-[180px] overflow-y-auto">
          {projects.map((p) => {
            const pState = projectSessions?.get(p.id);
            const isThisStreaming = pState?.isStreaming ?? false;
            const hasSession = !!pState?.session;
            return (
              <div key={p.id} className={`flex items-center group ${
                activeProject?.id === p.id
                  ? "bg-hacker-accent/10 border border-hacker-accent/30"
                  : "hover:bg-hacker-border/50"
              }`}>
                <button
                  onClick={() => onSelectProject(p)}
                  className={`flex-1 text-left px-2 py-1 flex items-center gap-1.5 ${
                    activeProject?.id === p.id
                      ? "text-hacker-accent"
                      : "text-hacker-text-dim"
                  }`}>
                  <span className="text-[10px]">
                    {p.storage === "ssh" ? "🔗" : p.storage === "smb" ? "💾" : "📁"}
                  </span>
                  <span className="truncate flex-1">{p.name}</span>
                  {isThisStreaming && (
                    <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-hacker-accent shrink-0" title="Streaming" />
                  )}
                  {hasSession && !isThisStreaming && (
                    <span className="w-1.5 h-1.5 rounded-full bg-hacker-info/50 shrink-0" title="Session active" />
                  )}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteProject(p); }}
                  className="px-1 py-1 text-hacker-text-dim/0 group-hover:text-hacker-error/70 hover:!text-hacker-error transition-colors"
                  title="Delete project"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            );
          })}
        </div>

        <button
          onClick={onAddProject}
          className="w-full mt-1.5 btn-hacker text-[10px] py-0.5 flex items-center justify-center gap-1"
        >
          <Plus size={10} /> NEW
        </button>
      </div>

      {/* ── Streaming indicator (active project) ── */}
      {isStreaming && (
        <div className="px-2 py-1.5 border-b border-hacker-border bg-hacker-accent/5 flex items-center gap-1.5">
          <span className="pulse-dot w-2 h-2 bg-hacker-accent" />
          <span className="text-hacker-accent text-[10px]">streaming...</span>
        </div>
      )}

      {/* ── Git panel ── */}
      {activeProject && activeProject.git?.remote && (
        <GitPanel project={activeProject} />
      )}

      {/* ── Quick actions ── */}
      <div className="p-2 mt-auto border-t border-hacker-border-bright">
        <div className="text-hacker-accent text-[10px] tracking-widest mb-1.5">ACTIONS</div>
        <div className="space-y-0.5">
          <ActionBtn
            icon={<RefreshCw size={10} />}
            label="Restart Pi"
            onClick={() => {
              send({ type: "pi_start", projectId: activeProject?.id });
            }}
          />
          <ActionBtn
            icon={<FileText size={10} />}
            label="New Session"
            onClick={async () => {
              await fetch("/api/settings/session/new", { method: "POST" });
            }}
          />
          <ActionBtn
            icon={<FolderOpen size={10} />}
            label="Explorer"
            onClick={() => {
              send({
                type: "pi_prompt",
                message: "List the files in the current directory",
              });
            }}
          />
          <ActionBtn
            icon={<Power size={10} />}
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
      className={`w-full flex items-center gap-1.5 px-2 py-0.5 text-left ${
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