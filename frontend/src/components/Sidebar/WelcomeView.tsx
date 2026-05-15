import { useState, useEffect } from "react";
import { PiLogo } from "../common/PiLogo";
import { Package, AlertTriangle, CheckCircle, Clock, Cpu, FolderOpen, Plus, RefreshCw, ArrowUpCircle } from "lucide-react";
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

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
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
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    fetch("/api/status")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => setStatus(data))
      .catch(e => setError(e.message));

    // Check for updates on load
    checkForUpdate();
  }, []);

  const checkForUpdate = () => {
    setCheckingUpdate(true);
    fetch("/api/status/update")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => setUpdateInfo(data))
      .catch(() => {}) // Silently fail — not critical
      .finally(() => setCheckingUpdate(false));
  };

  const issues = status?.extensions.filter(e => !e.installed) ?? [];
  // Dynamic columns for projects: 2 if ≤6, 3 if >6
  const projCols = projects.length > 6 ? 3 : 2;

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 overflow-auto">
      <div className="max-w-2xl w-full space-y-4">

        {/* Logo + Title */}
        <div className="text-center space-y-1.5">
          <PiLogo className="w-14 h-14 mx-auto text-hacker-accent" />
          <h1 className="text-hacker-accent text-lg font-bold tracking-widest">PI-WEB</h1>
          <p className="text-hacker-text-dim text-[11px]">
            Web interface for the Pi Coding Agent
          </p>
        </div>

        {/* Version info — compact grid */}
        {status && (
          <div className="border border-hacker-border bg-hacker-surface/30 rounded p-2.5">
            <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="text-hacker-text-dim">Pi-Web</span>
                <span className="text-hacker-accent font-mono">v{status.piWebVersion}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-hacker-text-dim">Pi SDK</span>
                <span className="text-hacker-accent font-mono">v{status.piSdkVersion}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-hacker-text-dim">Node</span>
                <span className="text-hacker-text-bright font-mono">{status.nodeVersion}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock size={9} className="text-hacker-text-dim" />
                <span className="text-hacker-text-bright font-mono">{formatUptime(status.uptimeSeconds)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Cpu size={9} className="text-hacker-text-dim" />
                <span className="text-hacker-text-bright font-mono">{status.activeSessions} session{status.activeSessions !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <FolderOpen size={9} className="text-hacker-text-dim" />
                <span className="text-hacker-text-bright font-mono">{status.projectsCount} project{status.projectsCount !== 1 ? "s" : ""}</span>
              </div>
            </div>

            {/* Update check row */}
            <div className="mt-1.5 pt-1.5 border-t border-hacker-border/50 flex items-center justify-center gap-2 text-[10px]">
              {checkingUpdate ? (
                <span className="text-hacker-text-dim flex items-center gap-1">
                  <RefreshCw size={9} className="animate-spin" /> Checking for updates...
                </span>
              ) : updateInfo ? (
                updateInfo.updateAvailable ? (
                  <span className="text-hacker-warn flex items-center gap-1">
                    <ArrowUpCircle size={10} />
                    Update available: v{updateInfo.latestVersion}
                  </span>
                ) : (
                  <span className="text-green-400 flex items-center gap-1">
                    <CheckCircle size={10} />
                    Up to date
                  </span>
                )
              ) : (
                <button
                  onClick={checkForUpdate}
                  className="text-hacker-text-dim hover:text-hacker-accent transition-colors"
                >
                  Check for updates
                </button>
              )}
            </div>
          </div>
        )}

        {/* Error loading status */}
        {error && (
          <div className="border border-hacker-error/30 bg-hacker-error/5 rounded p-2 text-xs text-hacker-error flex items-center gap-2">
            <AlertTriangle size={12} /> Failed to load status: {error}
          </div>
        )}

        {/* Extensions — compact inline */}
        {status && status.extensions.length > 0 && (
          <div className="border border-hacker-border bg-hacker-surface/30 rounded px-3 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <Package size={11} className="text-hacker-accent" />
              <span className="text-[11px] text-hacker-text-bright font-bold tracking-wider">EXTENSIONS</span>
              <span className="text-[9px] text-hacker-text-dim">({status.extensions.length})</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              {status.extensions.map(ext => (
                <div key={ext.source} className="flex items-center gap-1">
                  {ext.installed ? (
                    <CheckCircle size={10} className="text-green-400 shrink-0" />
                  ) : (
                    <AlertTriangle size={10} className="text-hacker-error shrink-0" />
                  )}
                  <span className={`text-[10px] font-mono ${ext.installed ? "text-hacker-text-dim" : "text-hacker-error"}`}>
                    {ext.source}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Issues warning */}
        {issues.length > 0 && (
          <div className="border border-hacker-warn/30 bg-hacker-warn/5 rounded p-2 text-[11px] text-hacker-warn flex items-center gap-2">
            <AlertTriangle size={13} className="shrink-0" />
            <span>
              {issues.length} extension{issues.length > 1 ? "s" : ""} not installed —
              Settings → Extensions & Skills → Reload session
            </span>
          </div>
        )}

        {/* Project grid */}
        <div className="border border-hacker-border bg-hacker-surface/30 rounded p-2.5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-hacker-text-bright font-bold tracking-wider">PROJECTS</span>
            <button
              onClick={onAddProject}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 border border-hacker-accent/50 text-hacker-accent hover:bg-hacker-accent/10 rounded transition-colors"
            >
              <Plus size={9} /> ADD
            </button>
          </div>
          {projects.length === 0 ? (
            <div className="space-y-2 py-4 text-center">
              <p className="text-xs text-hacker-text-dim">No projects yet.</p>
              <button
                onClick={onAddProject}
                className="btn-hacker text-xs px-4 py-2"
              >
                + Add your first project
              </button>
            </div>
          ) : (
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${projCols}, minmax(0, 1fr))` }}
            >
              {projects.map(project => (
                <button
                  key={project.id}
                  onClick={() => onSelectProject(project)}
                  className="text-left px-2.5 py-1.5 border border-hacker-border hover:border-hacker-accent hover:bg-hacker-accent/5 rounded transition-colors group"
                >
                  <div className="text-[11px] text-hacker-text-bright font-mono truncate group-hover:text-hacker-accent">
                    {project.name}
                  </div>
                  <div className="text-[9px] text-hacker-text-dim truncate">{project.cwd}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Shortcuts */}
        <div className="text-center text-[10px] text-hacker-text-dim flex items-center justify-center gap-2">
          <span>Select a project to start</span>
          <span className="text-hacker-border">|</span>
          <kbd className="px-1 border border-hacker-border text-hacker-accent">Ctrl+L</kbd>
          <span>Settings</span>
          <span className="text-hacker-border">·</span>
          <kbd className="px-1 border border-hacker-border text-hacker-accent">Esc</kbd>
          <span>Abort</span>
        </div>
      </div>
    </div>
  );
}