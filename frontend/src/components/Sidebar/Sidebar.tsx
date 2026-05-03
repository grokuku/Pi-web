import {
  Plus,
  Power,
  FolderOpen,
  RefreshCw,
  FileText,
  Trash2,
  GripVertical,
} from "lucide-react";
import { useState, useRef, useCallback } from "react";
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
  onRefreshGit?: () => void;
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
  onRefreshGit,
}: Props) {
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [localProjects, setLocalProjects] = useState<Project[]>(projects);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [projectListHeight, setProjectListHeight] = useState(() => {
    const saved = localStorage.getItem("pi-web-project-list-height");
    return saved ? parseInt(saved) : 180;
  });
  const projectListHeightRef = useRef(projectListHeight);
  projectListHeightRef.current = projectListHeight;
  const isResizingProjects = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // Sync localProjects when the prop changes (but not during drag)
  if (dragIdx === null && localProjects !== projects) {
    setLocalProjects(projects);
  }

  const handleDeleteConfirm = (deleteFiles: boolean) => {
    if (projectToDelete) {
      onDeleteProject(projectToDelete, deleteFiles);
      setProjectToDelete(null);
    }
  };

  // ── Drag and drop ──
  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    // Set a transparent drag image so only the grip icon feedback is visible
    const el = e.currentTarget as HTMLElement;
    e.dataTransfer.setDragImage(el, 16, 8);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragIdx !== null && idx !== dragIdx) {
      setDragOverIdx(idx);
    }
  };

  const handleDragEnd = () => {
    if (dragIdx !== null && dragOverIdx !== null && dragIdx !== dragOverIdx) {
      const reordered = [...localProjects];
      const [moved] = reordered.splice(dragIdx, 1);
      reordered.splice(dragOverIdx, 0, moved);
      setLocalProjects(reordered);
      // Persist the new order
      fetch("/api/projects/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectIds: reordered.map((p) => p.id) }),
      }).catch((err) => console.error("Failed to persist project order:", err));
    }
    setDragIdx(null);
    setDragOverIdx(null);
  };

  // ── Project list vertical resize ──
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingProjects.current = true;
    startY.current = e.clientY;
    startHeight.current = projectListHeight;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isResizingProjects.current) return;
      const delta = ev.clientY - startY.current;
      const newHeight = Math.max(80, Math.min(600, startHeight.current + delta));
      setProjectListHeight(newHeight);
    };

    const handleMouseUp = () => {
      if (isResizingProjects.current) {
        isResizingProjects.current = false;
        localStorage.setItem("pi-web-project-list-height", String(projectListHeightRef.current));
      }
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [projectListHeight]);

  return (
    <aside className="h-full border-r border-hacker-border-bright sidebar-zone flex flex-col shrink-0 text-xs">
      {/* ── Projects ── */}
      <div className="p-2 pb-0">
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

        <div className="space-y-0.5 overflow-y-auto" style={{ maxHeight: projectListHeight }}>
          {localProjects.map((p, idx) => {
            const pState = projectSessions?.get(p.id);
            const isThisStreaming = pState?.isStreaming ?? false;
            const hasSession = !!pState?.session;
            const isDragging = dragIdx === idx;
            const isDragTarget = dragOverIdx === idx;
            return (
              <div
                key={p.id}
                className={`flex items-center group ${
                  activeProject?.id === p.id
                    ? "bg-hacker-accent/10 border border-hacker-accent/30"
                    : isDragTarget
                    ? "bg-hacker-accent/5 border border-hacker-accent/20 border-dashed"
                    : "hover:bg-hacker-border/50 border border-transparent"
                } ${isDragging ? "opacity-40" : ""}`}
              >
                {/* Drag handle */}
                <div
                  draggable
                  onDragStart={(e) => handleDragStart(e, idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                  className="px-1 py-1 cursor-grab active:cursor-grabbing text-hacker-text-dim/0 group-hover:text-hacker-text-dim/60 hover:!text-hacker-text-dim shrink-0"
                  title="Drag to reorder"
                >
                  <GripVertical size={10} />
                </div>

                {/* Project button */}
                <button
                  onClick={() => onSelectProject(p)}
                  className={`flex-1 text-left px-1.5 py-1 flex items-center gap-1.5 ${
                    activeProject?.id === p.id
                      ? "text-hacker-accent"
                      : "text-hacker-text-dim"
                  }`}>
                  <span className="truncate flex-1">{p.name}</span>
                  {isThisStreaming && (
                    <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-hacker-accent shrink-0" title="Streaming" />
                  )}
                  {hasSession && !isThisStreaming && (
                    <span className="w-1.5 h-1.5 rounded-full bg-hacker-info/50 shrink-0" title="Session active" />
                  )}
                </button>

                {/* Delete button */}
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

      {/* Resize handle for project list */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="h-1 cursor-row-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50 transition-colors border-b border-hacker-border-bright"
        title="Resize project list"
      />

      {/* ── Git panel ── */}
      {activeProject && activeProject.git?.remote && (
        <GitPanel project={activeProject} onRefresh={onRefreshGit} />
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
                projectId: activeProject?.id,
                message: "List the files in the current directory",
              });
            }}
          />
          <ActionBtn
            icon={<Power size={10} />}
            label="Shutdown Pi"
            onClick={() => {
              send({ type: "pi_abort", projectId: activeProject?.id });
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