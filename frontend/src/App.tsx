import { useState, useEffect, useCallback, useRef } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { ChatView } from "./components/Chat/ChatView";
import { TerminalView } from "./components/Terminal/TerminalView";
import { ProjectSwitchModal } from "./components/Modals/ProjectSwitchModal";
import { AddProjectModal } from "./components/Modals/AddProjectModal";
import { ModelLibraryModal } from "./components/Modals/ModelLibraryModal";
import { ModelQuickSwitch } from "./components/Header/ModelQuickSwitch";
import type { Project } from "./types";

type Tab = "pi" | "terminal";

// ── Per-project session state ──────────────────────
// This allows multiple projects to stream in parallel,
// each maintaining its own chat history, streaming state, etc.
interface ProjectSessionState {
  isStreaming: boolean;
  session: any;
  stats: { tokens: number; cost: number; contextPercent: number } | null;
}

export default function App() {
  const { connected, send, on } = useWebSocket();

  // ── State ──
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [activeTab, setActiveTab] = useState<Tab>("pi");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  // ── Per-project sessions (keyed by project ID) ──
  // This map persists across project switches, so background
  // projects continue to receive events and accumulate messages.
  const projectSessionsRef = useRef<Map<string, ProjectSessionState>>(new Map());
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((n) => n + 1);

  // Get the active project's session state (for backward-compat props)
  const activeSessionState = activeProject
    ? projectSessionsRef.current.get(activeProject.id)
    : undefined;
  const isStreaming = activeSessionState?.isStreaming ?? false;
  const session = activeSessionState?.session ?? null;
  const stats = activeSessionState?.stats ?? null;

  // Modals
  const [showProjectSwitch, setShowProjectSwitch] = useState(false);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showModelLibrary, setShowModelLibrary] = useState(false);

  // ── Helpers for per-project state ──
  const getProjectSession = useCallback((projectId: string): ProjectSessionState => {
    let state = projectSessionsRef.current.get(projectId);
    if (!state) {
      state = { isStreaming: false, session: null, stats: null };
      projectSessionsRef.current.set(projectId, state);
    }
    return state;
  }, []);

  const updateProjectSession = useCallback(
    (projectId: string, update: Partial<ProjectSessionState>) => {
      const state = getProjectSession(projectId);
      Object.assign(state, update);
      // Only re-render if this is the active project
      if (activeProject?.id === projectId) {
        rerender();
      }
    },
    [activeProject?.id]
  );

  // ── Theme ──
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

      // Escape → abort streaming of the ACTIVE project
      if (e.key === "Escape" && !mod && !shift && !alt) {
        if (isStreaming && activeProject) {
          e.preventDefault();
          send({ type: "pi_abort", projectId: activeProject.id });
        }
        if (showModelLibrary) { e.preventDefault(); setShowModelLibrary(false); }
        else if (showAddProject) { e.preventDefault(); setShowAddProject(false); }
        else if (showProjectSwitch) { e.preventDefault(); setShowProjectSwitch(false); }
        return;
      }

      // Ctrl+L → model settings
      if (mod && e.key === "l") {
        e.preventDefault();
        setShowModelLibrary(true);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isStreaming, send, showModelLibrary, showAddProject, showProjectSwitch, activeProject]);

  // ── Load projects ──
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setProjects(data);
      const savedId = localStorage.getItem("pi-web-active-project");
      if (savedId && !activeProject) {
        const saved = data.find((p: Project) => p.id === savedId);
        if (saved) activateProject(saved);
      }
    } catch (e) {
      console.error("Failed to load projects:", e);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // ── WS event handler (routes events to the correct project) ──
  useEffect(() => {
    const unsubPiEvent = on("pi_event", (msg: any) => {
      const evt = msg.event;
      const projectId = msg.projectId;

      switch (evt.type) {
        case "agent_start": {
          updateProjectSession(projectId, { isStreaming: true });
          break;
        }
        case "agent_end": {
          updateProjectSession(projectId, { isStreaming: false });
          break;
        }
        case "turn_end": {
          if (evt.message?.usage) {
            const u = evt.message.usage;
            const state = getProjectSession(projectId);
            const prevStats = state.stats;
            const newStats = {
              tokens: (prevStats?.tokens || 0) + (u.input || 0) + (u.output || 0),
              cost: (prevStats?.cost || 0) + (u.cost?.total || 0),
              contextPercent: Math.round(
                ((u.input || 0) / ((state.session?.model?.contextWindow) || 200000)) * 100
              ),
            };
            updateProjectSession(projectId, { stats: newStats });
          }
          break;
        }
        case "session_update": {
          if (evt.session) {
            updateProjectSession(projectId, { session: evt.session });
          }
          break;
        }
      }
    });

    const unsubTerm = on("terminal_data", (_msg: any) => {
      // Handled in TerminalView
    });

    const unsubError = on("error", (msg: any) => {
      console.error("[WS Error]", msg.error);
    });

    // ── Handle session history on reconnect ──
    const unsubHistory = on("pi_history", (msg: any) => {
      if (msg.messages && msg.messages.length > 0) {
        console.log(`[Pi] Restored ${msg.messages.length} messages for project ${msg.projectId}`);
        // ChatView will handle this via its own subscriber
      }
    });

    // ── Handle pi_started event (confirms session is ready) ──
    const unsubStarted = on("pi_started", (msg: any) => {
      const { projectId, resumed } = msg.data || {};
      if (projectId) {
        console.log(`[Pi] Session ${resumed ? "resumed" : "started"} for project ${projectId}`);
        if (resumed) {
          // Update session state to reflect resumed session
          updateProjectSession(projectId, { isStreaming: false });
        }
      }
    });

    return () => {
      unsubPiEvent();
      unsubTerm();
      unsubError();
      unsubHistory();
      unsubStarted();
    };
  }, [on, getProjectSession, updateProjectSession]);

  // ── Handle project selection ──
  // No confirmation modal needed — just switch! Background projects keep streaming.
  const handleSelectProject = (project: Project) => {
    if (activeProject?.id === project.id) return; // Already active
    activateProject(project);
  };

  const activateProject = useCallback(
    (project: Project) => {
      setActiveProject(project);
      localStorage.setItem("pi-web-active-project", project.id);

      // Check if we already have an in-memory session for this project
      const state = getProjectSession(project.id);

      if (!state.session) {
        // No in-memory session — request one from the backend.
        // Handles: first activation, page refresh, session cleanup
        send({
          type: "pi_start",
          projectId: project.id,
          resume: true,
          sessionId: project.lastSessionId,
        });
      } else {
        // Session already alive (streaming in background).
        // Just switch UI — but request history refresh to catch up on missed events.
        send({
          type: "pi_history_request",
          projectId: project.id,
        });
      }

      rerender();
    },
    [send, getProjectSession]
  );

  // ── Add project ──
  const handleAddProject = () => {
    setShowAddProject(true);
  };

  const handleProjectCreated = async (project: Project) => {
    await loadProjects();
    setShowAddProject(false);
    activateProject(project);
  };

  // ── Compute which projects are streaming in background ──
  const backgroundStreamingProjects = projects.filter(
    (p) => p.id !== activeProject?.id && projectSessionsRef.current.get(p.id)?.isStreaming
  );

  return (
    <div className="h-screen flex flex-col scanlines">
      {/* Matrix background */}
      <div className="matrix-bg" />

      {/* ── HEADER ── */}
      <header className="h-10 header-glow bg-hacker-surface flex items-center px-3 gap-3 z-10 shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <span className="text-hacker-accent text-lg glitch select-none">⚡</span>
          <span className="text-hacker-accent text-sm font-bold tracking-widest select-none">
            PI-WEB
          </span>
        </div>

        <div className="w-px h-5 bg-hacker-border-bright" />

        {/* Project selector with background streaming indicators */}
        <div className="flex items-center gap-2">
          <select
            className="select-hacker text-xs min-w-[160px]"
            value={activeProject?.id || ""}
            onChange={(e) => {
              const p = projects.find((p) => p.id === e.target.value);
              if (p) handleSelectProject(p);
            }}
          >
            <option value="" disabled>
              -- select project --
            </option>
            {projects.map((p) => {
              const pState = projectSessionsRef.current.get(p.id);
              const isThisStreaming = pState?.isStreaming ?? false;
              const suffix = isThisStreaming ? " ⚡" : pState?.session ? " ●" : "";
              return (
                <option key={p.id} value={p.id}>
                  {p.storage === "ssh" ? "🔗" : p.storage === "smb" ? "💾" : "📁"} {p.name}{suffix}
                </option>
              );
            })}
          </select>
          <button onClick={handleAddProject} className="btn-hacker text-xs px-2 py-1">
            +NEW
          </button>
        </div>

        {activeProject && (
          <>
            <div className="w-px h-5 bg-hacker-border-bright" />
            <span className="text-hacker-text-dim text-xs truncate max-w-[300px]">
              {activeProject.cwd}
            </span>
          </>
        )}

        {/* Background streaming indicator */}
        {backgroundStreamingProjects.length > 0 && (
          <>
            <div className="w-px h-5 bg-hacker-border-bright" />
            <div className="flex items-center gap-1 text-xs animate-pulse">
              <span className="text-hacker-accent">⚡</span>
              <span className="text-hacker-warn">
                {backgroundStreamingProjects.length} running{backgroundStreamingProjects.length > 1 ? "" : ""}
              </span>
            </div>
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* WS status */}
        <span
          className={`text-xs ${connected ? "text-hacker-accent" : "text-hacker-error"}`}
        >
          {connected ? "◉ CONNECTED" : "◌ OFFLINE"}
        </span>

        <div className="w-px h-5 bg-hacker-border-bright" />

        {/* Model quick switch */}
        <ModelQuickSwitch onModelApplied={() => {
          if (activeProject) {
            fetch(`/api/settings/session?projectId=${activeProject.id}`).then(r => r.json()).then((s) => {
              updateProjectSession(activeProject.id, { session: s });
            }).catch(() => {});
          }
        }} />

        <div className="w-px h-5 bg-hacker-border-bright" />

        {/* Tab toggles */}
        <button
          onClick={() => setActiveTab("pi")}
          className={`text-xs px-3 py-1 border ${
            activeTab === "pi"
              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/5"
              : "border-transparent text-hacker-text-dim hover:text-hacker-text"
          }`}
        >
          [PI]
        </button>
        <button
          onClick={() => setActiveTab("terminal")}
          className={`text-xs px-3 py-1 border ${
            activeTab === "terminal"
              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/5"
              : "border-transparent text-hacker-text-dim hover:text-hacker-text"
          }`}
        >
          [TERMINAL]
        </button>

        <div className="w-px h-5 bg-hacker-border-bright" />

        {/* Theme + Settings */}
        <button onClick={toggleTheme} className="btn-hacker text-xs px-2 py-1">
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <button
          onClick={() => setShowModelLibrary(true)}
          className="btn-hacker text-xs px-2 py-1"
        >
          ⚙
        </button>
      </header>

      {/* ── MAIN BODY ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar with per-project streaming state */}
        <Sidebar
          projects={projects}
          activeProject={activeProject}
          stats={stats}
          isStreaming={isStreaming}
          onSelectProject={handleSelectProject}
          onAddProject={handleAddProject}
          send={send}
          session={session}
          projectSessions={projectSessionsRef.current}
        />

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-hidden relative">
            <div className={activeTab === "pi" ? "absolute inset-0" : "hidden"}>
              <ChatView
                send={send}
                on={on}
                activeProject={activeProject}
                isStreaming={isStreaming}
                session={session}
                projectId={activeProject?.id || ""}
              />
            </div>
            <div className={activeTab === "terminal" ? "absolute inset-0" : "hidden"}>
              <TerminalView send={send} on={on} activeProject={activeProject} isActive={activeTab === "terminal"} />
            </div>
          </div>

          <StatusBar
            activeProject={activeProject}
            isStreaming={isStreaming}
            stats={stats}
            session={session}
          />
        </div>
      </div>

      {/* ── MODALS ── */}
      {showProjectSwitch && pendingProject && (
        <ProjectSwitchModal
          fromProject={activeProject!}
          toProject={pendingProject}
          onConfirm={() => {
            // No need for confirmation anymore — just switch!
            // Background sessions continue running.
            activateProject(pendingProject);
            setShowProjectSwitch(false);
            setPendingProject(null);
          }}
          onCancel={() => {
            setShowProjectSwitch(false);
            setPendingProject(null);
          }}
        />
      )}

      {showAddProject && (
        <AddProjectModal
          onClose={() => setShowAddProject(false)}
          onCreated={handleProjectCreated}
        />
      )}

      {showModelLibrary && (
        <ModelLibraryModal
          onClose={() => setShowModelLibrary(false)}
          session={session}
          onModelApplied={() => {
            if (activeProject) {
              fetch(`/api/settings/session?projectId=${activeProject.id}`).then(r => r.json()).then((s) => {
                updateProjectSession(activeProject.id, { session: s });
              }).catch(() => {});
            }
          }}
        />
      )}
    </div>
  );
}