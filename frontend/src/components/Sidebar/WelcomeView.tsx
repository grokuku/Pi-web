import { useState, useEffect } from "react";
import { PiLogo } from "../common/PiLogo";
import { Package, AlertTriangle, CheckCircle, Clock, Cpu, FolderOpen } from "lucide-react";
import type { Project } from "../../types";

// ── Types ──────────────────────────────────────────────

interface ExtensionInfo {
  source: string;
  installed: boolean;
  error?: string;
}

interface StatusInfo {
  piWebVersion: string;
  piSdkVersion: string;
  extensions: ExtensionInfo[];
  activeSessions: number;
  uptimeSeconds: number;
  projectsCount: number;
  nodeVersion: string;
}

// ── Helpers ──────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── Component ───────────────────────────────────────────

interface Props {
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onAddProject: () => void;
}

export function WelcomeView({ projects, onSelectProject, onAddProject }: Props) {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then(r => r.json())
      .then(data => setStatus(data))
      .catch(e => setError(e.message));
  }, []);

  const issues = status?.extensions.filter(e => !e.installed) ?? [];

  return (
    <div className="h-full flex flex-col items-center justify-center p-8 overflow-auto">
      <div className="max-w-lg w-full space-y-5">

        {/* Logo + Title */}
        <div className="text-center space-y-2">
          <PiLogo className="w-16 h-16 mx-auto text-hacker-accent" />
          <h1 className="text-hacker-accent text-xl font-bold tracking-widest">PI-WEB</h1>
          <p className="text-hacker-text-dim text-xs">
            Web interface for the Pi Coding Agent
          </p>
        </div>

        {/* Version info */}
        {status && (
          <div className="border border-hacker-border bg-hacker-surface/30 rounded p-3 space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-hacker-text-dim w-24">Pi-Web</span>
              <span className="text-hacker-accent font-mono">v{status.piWebVersion}</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-hacker-text-dim w-24">Pi SDK</span>
              <span className="text-hacker-accent font-mono">v{status.piSdkVersion}</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-hacker-text-dim w-24">Node.js</span>
              <span className="text-hacker-text-bright font-mono">{status.nodeVersion}</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-hacker-text-dim w-24">Uptime</span>
              <span className="text-hacker-text-bright font-mono flex items-center gap-1">
                <Clock size={10} /> {formatUptime(status.uptimeSeconds)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-hacker-text-dim w-24">Sessions</span>
              <span className="text-hacker-text-bright font-mono flex items-center gap-1">
                <Cpu size={10} /> {status.activeSessions} active
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-hacker-text-dim w-24">Projects</span>
              <span className="text-hacker-text-bright font-mono flex items-center gap-1">
                <FolderOpen size={10} /> {status.projectsCount}
              </span>
            </div>
          </div>
        )}

        {/* Error loading status */}
        {error && (
          <div className="border border-hacker-error/30 bg-hacker-error/5 rounded p-2 text-xs text-hacker-error flex items-center gap-2">
            <AlertTriangle size={12} /> Failed to load status: {error}
          </div>
        )}

        {/* Extensions */}
        {status && status.extensions.length > 0 && (
          <div className="border border-hacker-border bg-hacker-surface/30 rounded p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Package size={12} className="text-hacker-accent" />
              <span className="text-xs text-hacker-text-bright font-bold tracking-wider">EXTENSIONS</span>
              <span className="text-[10px] text-hacker-text-dim">({status.extensions.length})</span>
            </div>
            <div className="space-y-1">
              {status.extensions.map(ext => (
                <div key={ext.source} className="flex items-center gap-2">
                  {ext.installed ? (
                    <CheckCircle size={11} className="text-green-400 shrink-0" />
                  ) : (
                    <AlertTriangle size={11} className="text-hacker-error shrink-0" />
                  )}
                  <span className={`text-[11px] font-mono truncate ${ext.installed ? "text-hacker-text-bright" : "text-hacker-error"}`}>
                    {ext.source}
                  </span>
                  {!ext.installed && (
                    <span className="text-[9px] text-hacker-error ml-auto shrink-0">not found</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Issues warning */}
        {issues.length > 0 && (
          <div className="border border-hacker-warn/30 bg-hacker-warn/5 rounded p-2.5 text-xs text-hacker-warn flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" />
            <span>
              {issues.length} extension{issues.length > 1 ? "s" : ""} not installed properly.
              Check Settings → Extensions & Skills, then click "Reload session".
            </span>
          </div>
        )}

        {/* Project selection */}
        <div className="border border-hacker-border bg-hacker-surface/30 rounded p-3">
          <div className="text-xs text-hacker-text-bright font-bold tracking-wider mb-2">PROJECTS</div>
          {projects.length === 0 ? (
            <div className="space-y-3">
              <p className="text-xs text-hacker-text-dim">No projects yet. Add one to get started.</p>
              <button
                onClick={onAddProject}
                className="btn-hacker text-xs px-4 py-2 w-full"
              >
                + Add a project
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              {projects.map(project => (
                <button
                  key={project.id}
                  onClick={() => onSelectProject(project)}
                  className="w-full text-left px-3 py-2 text-xs border border-hacker-border hover:border-hacker-accent hover:bg-hacker-accent/5 rounded transition-colors flex items-center gap-2 group"
                >
                  <FolderOpen size={12} className="text-hacker-accent" />
                  <div className="flex-1 min-w-0">
                    <div className="text-hacker-text-bright font-mono truncate group-hover:text-hacker-accent">
                      {project.name}
                    </div>
                    <div className="text-[10px] text-hacker-text-dim truncate">{project.cwd}</div>
                  </div>
                </button>
              ))}
              <button
                onClick={onAddProject}
                className="btn-hacker text-xs px-3 py-1.5 w-full mt-1"
              >
                + Add another project
              </button>
            </div>
          )}
        </div>

        {/* Welcome message */}
        <div className="text-center text-[10px] text-hacker-text-dim space-y-1">
          <p>Select a project from the list above or the sidebar to start.</p>
          <p className="flex items-center justify-center gap-1">
            <span>Keyboard shortcuts:</span>
            <kbd className="px-1 border border-hacker-border text-hacker-accent">Ctrl+L</kbd>
            <span>Settings</span>
            <span className="mx-1">·</span>
            <kbd className="px-1 border border-hacker-border text-hacker-accent">Esc</kbd>
            <span>Abort</span>
          </p>
        </div>
      </div>
    </div>
  );
}