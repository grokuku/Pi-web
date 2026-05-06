import { AlertTriangle, Trash2, FolderX } from "lucide-react";
import { ModalDialog } from "../common/ModalDialog";
import type { Project } from "../../types";

interface Props {
  project: Project | null;
  onClose: () => void;
  onConfirm: (deleteFiles: boolean) => void;
}

export function DeleteProjectModal({ project, onClose, onConfirm }: Props) {
  if (!project) return null;

  const isLocal = project.storage === "local";
  const isRemote = project.storage === "ssh" || project.storage === "smb";

  return (
    <ModalDialog id="delete-project" onClose={onClose}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-hacker-warn/10 border border-hacker-warn/30">
            <AlertTriangle size={20} className="text-hacker-warn" />
          </div>
          <div>
            <span className="text-hacker-warn font-bold text-sm tracking-wider">
              DELETE PROJECT
            </span>
            <div className="text-hacker-text-dim text-xs">
              {isLocal ? "📁 Local project" : isRemote ? "🌐 Remote project" : "📁 Project"}
            </div>
          </div>
        </div>

        {/* Project info */}
        <div className="bg-hacker-surface/50 border border-hacker-border p-3 mb-4">
          <div className="text-hacker-text font-bold text-sm mb-1">
            {project.name}
          </div>
          <div className="text-hacker-text-dim text-xs truncate font-mono">
            {project.cwd}
          </div>
          {project.git?.remote && (
            <div className="text-hacker-info text-[10px] mt-1 truncate">
              git: {project.git.remote}
            </div>
          )}
        </div>

        {/* Warning text */}
        <div className="text-hacker-text text-xs mb-4 leading-relaxed">
          This action will remove the project from Pi-Web.
          {isLocal && (
            <>
              {" "}
              <span className="text-hacker-warn">Choose carefully:</span> you can
              keep the files or delete them permanently.
            </>
          )}
          {isRemote && (
            <>
              {" "}
              <span className="text-hacker-accent">Remote content will NOT be affected</span>
              {" "}(GitHub repos, SSH servers, SMB shares remain untouched).
            </>
          )}
        </div>

        {/* Buttons */}
        <div className="flex flex-col gap-2">
          {/* Cancel */}
          <button
            onClick={onClose}
            className="btn-hacker w-full py-2 text-xs flex items-center justify-center gap-2"
          >
            CANCEL
          </button>

          <div className="h-px bg-hacker-border my-1" />

          {/* Soft delete - keep files */}
          <button
            onClick={() => onConfirm(false)}
            className="w-full py-2 text-xs flex items-center justify-center gap-2 border border-hacker-border-bright hover:bg-hacker-surface/50 transition-colors"
          >
            <Trash2 size={14} />
            <span className="text-hacker-text">
              Delete project
            </span>
            <span className="text-hacker-text-dim">
              — keep files
            </span>
          </button>

          {/* Hard delete - remove files (only for local) */}
          {isLocal && (
            <button
              onClick={() => onConfirm(true)}
              className="w-full py-2 text-xs flex items-center justify-center gap-2 border border-hacker-warn/50 text-hacker-warn hover:bg-hacker-warn/10 transition-colors"
            >
              <FolderX size={14} />
              <span>
                Delete project + files
              </span>
              <span className="opacity-70">
                — permanent
              </span>
            </button>
          )}
        </div>

        {/* Safety note for remote */}
        {isRemote && (
          <div className="mt-3 text-[10px] text-hacker-text-dim text-center">
            💡 Remote content is always preserved. Only the local project configuration is removed.
          </div>
        )}
    </ModalDialog>
  );
}
