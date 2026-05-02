import {
  Plus,
  Power,
  FolderOpen,
  RefreshCw,
  FileText,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { GitPanel } from "./GitPanel";
import { DeleteProjectModal } from "../Modals/DeleteProjectModal";
import type { Project } from "../../types";

interface Props {
  projects: Project[];
  activeProject: Project | null;
  onSelectProject: (p: Project) => void;
  onAddProject: () => void;
  onDeleteProject: (p: Project, deleteFiles: boolean) => void;
  send: (msg: any) => void;
  session: any;
  projectSessions?: Map<string, { isStreaming: boolean; session: any; stats: any }>;
  onSendCommand: (cmd: string) => void;
}

export function Sidebar({
  projects,
  activeProject,
  onSelectProject,
  onAddProject,
  onDeleteProject,
  send,
  session,
  projectSessions,
  onSendCommand,
}: Props) {
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const handleDeleteConfirm = (deleteFiles: boolean) => {
    if (projectToDelete) {
      onDeleteProject(projectToDelete, deleteFiles);
      setProjectToDelete(null);
    }
  };
  return (
    <aside className="h-full border-r border-hacker-border-bright sidebar-zone flex flex-col shrink-0 text-xs">
      {/* ── Projects ── */}
      <div className="p-2 border-b border-hacker-border">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-hacker-accent text-[10px] tracking-widest">PROJECTS</span>
          <button
            onClick={onAddProject}
            className="text-hacker-text-dim hover:text-hacker-accent text-[10px] leading-none"
            title="Add project"
          >
            <Plus size={10} />
          </button>
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
                  onClick={(e) => { e.stopPropagation(); setProjectToDelete(p); }}
                  className="px-1 py-1 text-hacker-text-dim/0 group-hover:text-hacker-error/70 hover:!text-hacker-error transition-colors"
                  title="Delete project"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Git panel ── */}
      {activeProject && activeProject.git?.remote && (
        <GitPanel project={activeProject} />
      )}

      {/* ── Slash commands ── */}
      <div className="p-2 border-t border-hacker-border-bright">
        <div className="text-hacker-accent text-[10px] tracking-widest mb-1.5">COMMANDS</div>
        <div className="flex flex-wrap gap-1">
          {[
            { cmd: "/new", tip: "New session" },
            { cmd: "/compact", tip: "Compact context" },
            { cmd: "/model", tip: "List/switch model" },
            { cmd: "/clear", tip: "Clear screen" },
            { cmd: "/help", tip: "Show commands" },
          ].map(({ cmd, tip }) => (
            <button
              key={cmd}
              onClick={() => onSendCommand(cmd)}
              className="text-[9px] text-hacker-text-dim border border-hacker-border px-1.5 py-0.5 hover:border-hacker-accent/50 hover:text-hacker-accent hover:bg-hacker-accent/5"
              title={tip}
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>

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

      {/* ── Delete project modal ── */}
      <DeleteProjectModal
        project={projectToDelete}
        onClose={() => setProjectToDelete(null)}
        onConfirm={handleDeleteConfirm}
      />
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