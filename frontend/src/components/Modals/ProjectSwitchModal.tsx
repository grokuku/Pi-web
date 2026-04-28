import { AlertTriangle } from "lucide-react";
import type { Project } from "../../types";

interface Props {
  fromProject: Project;
  toProject: Project;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ProjectSwitchModal({
  fromProject,
  toProject,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle size={18} className="text-hacker-warn" />
          <span className="text-hacker-warn font-bold text-sm tracking-wider">
            SWITCH PROJECT
          </span>
        </div>

        <div className="text-sm space-y-2 mb-6">
          <p className="text-hacker-text">
            You are about to switch projects. The current Pi session will be
            terminated.
          </p>
          <div className="bg-hacker-bg/50 border border-hacker-border p-3 text-xs space-y-1">
            <div className="text-hacker-text-dim">
              From:{" "}
              <span className="text-hacker-error">{fromProject.name}</span>
            </div>
            <div className="text-hacker-text-dim">
              To:{" "}
              <span className="text-hacker-accent">{toProject.name}</span>
            </div>
          </div>
          <p className="text-hacker-text-dim text-xs">
            ⚠ Unsaved changes in the terminal may be lost.
          </p>
        </div>

        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="btn-hacker text-xs">
            CANCEL
          </button>
          <button onClick={onConfirm} className="btn-hacker danger text-xs">
            SWITCH NOW
          </button>
        </div>
      </div>
    </div>
  );
}
