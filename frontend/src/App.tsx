import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { ChatView } from "./components/Chat/ChatView";
import { TerminalView } from "./components/Terminal/TerminalView";
import { FileExplorer } from "./components/Files/FileExplorer";
import { ProjectSwitchModal } from "./components/Modals/ProjectSwitchModal";
import { AddProjectModal } from "./components/Modals/AddProjectModal";
import { ModelLibraryModal } from "./components/Modals/ModelLibraryModal";
import { ExtensionsModal } from "./components/Modals/ExtensionsModal";
import { ModelQuickSwitch } from "./components/Header/ModelQuickSwitch";
import { AccentPicker } from "./components/Header/AccentPicker";
import type { Project } from "./types";

type Tab = "pi" | "terminal" | "files";

// ── Error boundary to prevent white/dark screen of death ──
class ErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean; error: string}> {
  state = { hasError: false, error: "" };
  static getDerivedStateFromError(e: Error) { return { hasError: true, error: e.message }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-hacker-bg text-hacker-accent flex flex-col items-center justify-center gap-4 p-8 font-mono text-sm">
          <div className="text-4xl">⚠</div>
          <div className="text-hacker-accent font-bold">RENDER ERROR</div>
          <pre className="text-hacker-error text-xs max-w-[37.5rem] overflow-auto whitespace-pre-wrap">{this.state.error}</pre>
          <button onClick={() => this.setState({hasError: false, error: ""})} className="btn-hacker">
            RETRY
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Per-project session state ──────────────────────
interface ProjectSessionState {
  isStreaming: boolean;
  session: any;
  stats: { tokens: number; contextPercent: number; totalTokens: number } | null;
}

function App() {
  const { connected, send, on } = useWebSocket();

  // ── State ──
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("pi-web-theme");
    return (saved === "light" || saved === "dark") ? saved : "dark";
  });
  const [accent, setAccent] = useState(() => localStorage.getItem("pi-web-accent") || "");
  const [scanlines, setScanlines] = useState(() => localStorage.getItem("pi-web-scanlines") !== "false");
  const [activeTab, setActiveTab] = useState<Tab>("pi");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [zoomLevel, setZoomLevel] = useState(() => {
    const saved = localStorage.getItem("pi-web-zoom");
    return saved ? parseFloat(saved) : 1.2;
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("pi-web-sidebar-width");
    return saved ? parseInt(saved) : 192;
  });
  const isResizingSidebar = useRef(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const projectSessionsRef = useRef<Map<string, ProjectSessionState>>(new Map());
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((n) => n + 1);

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
  const [showExtensions, setShowExtensions] = useState(false);
  const [activeMode, setActiveMode] = useState<string>("code");
  const [autoReviewState, setAutoReviewState] = useState<{inProgress: boolean; cycle: number; maxReviews: number; phase?: string} | null>(null);

  // ── Helpers ──
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
      // Always re-render on streaming state changes (sidebar shows background streams)
      if (!activeProject || projectId !== activeProject.id || update.isStreaming !== undefined) {
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

  // ── Model change version counter (forces ModelQuickSwitch to reload) ──
  const [modelChangeVersion, setModelChangeVersion] = useState(0);
  const handleModelApplied = useCallback(() => {
    setModelChangeVersion(v => v + 1);
    if (activeProject) {
      fetch(`/api/settings/session?projectId=${activeProject.id}`).then(r => r.json()).then((s) => {
        updateProjectSession(activeProject.id, { session: s });
      }).catch(() => {});
    }
  }, [activeProject?.id, updateProjectSession]);

  // ── Accent ──
  useEffect(() => {
    if (accent) {
      document.documentElement.setAttribute("data-accent", accent);
    } else {
      document.documentElement.removeAttribute("data-accent");
    }
    localStorage.setItem("pi-web-accent", accent);
  }, [accent]);

  const toggleTheme = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("pi-web-theme", next);
      return next;
    });
  };

  const toggleScanlines = () => {
    setScanlines((s) => {
      const next = !s;
      localStorage.setItem("pi-web-scanlines", String(next));
      return next;
    });
  };

  // ── Zoom ──
  useEffect(() => {
    document.documentElement.style.fontSize = `${zoomLevel * 100}%`;
    localStorage.setItem("pi-web-zoom", String(zoomLevel));
  }, [zoomLevel]);
  const zoomIn = () => setZoomLevel((z) => Math.min(z + 0.1, 1.5));
  const zoomOut = () => setZoomLevel((z) => Math.max(z - 0.1, 0.6));

  // ── Sidebar resize ──
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingSidebar.current) return;
      const newWidth = Math.max(140, Math.min(400, e.clientX));
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (isResizingSidebar.current) {
        isResizingSidebar.current = false;
        localStorage.setItem("pi-web-sidebar-width", String(sidebarWidthRef.current));
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [sidebarWidth]);

  const startResizeSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingSidebar.current = true;
  };

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

      if (e.key === "Escape" && !mod && !shift && !alt) {
        if (isStreaming && activeProject) {
          e.preventDefault();
          send({ type: "pi_abort", projectId: activeProject.id });
        }
        if (showModelLibrary) { e.preventDefault(); setShowModelLibrary(false); }
        else if (showExtensions) { e.preventDefault(); setShowExtensions(false); }
        else if (showAddProject) { e.preventDefault(); setShowAddProject(false); }
        else if (showProjectSwitch) { e.preventDefault(); setShowProjectSwitch(false); }
        return;
      }

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

  // ── WS event handler ──
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
        case "mode_change": {
          if (projectId === activeProject?.id) {
            setActiveMode(evt.mode);
          }
          // Reload model library when mode changes (enabled state may have changed)
          setModelChangeVersion(v => v + 1);
          break;
        }
        case "auto_review_status": {
          if (projectId === activeProject?.id) {
            setAutoReviewState({
              inProgress: evt.phase !== "done",
              cycle: evt.cycle,
              maxReviews: evt.maxReviews,
              phase: evt.phase,
            });
          }
          break;
        }
        case "turn_end": {
          if (evt.message?.usage) {
            const u = evt.message.usage;
            const state = getProjectSession(projectId);
            const prevStats = state.stats || { tokens: 0, contextPercent: 0, totalTokens: 0 };
            // tokens = current context size (last input), totalTokens = cumulative
            const lastInputTokens = u.input || 0;
            const lastOutputTokens = u.output || 0;
            const contextWindow = state.session?.model?.contextWindow || 200000;
            const contextPercent = Math.round((lastInputTokens / contextWindow) * 100);
            const newStats = {
              tokens: lastInputTokens, // Current context size (what fills the window)
              contextPercent: Math.max(prevStats.contextPercent, contextPercent), // Only increase
              totalTokens: prevStats.totalTokens + lastInputTokens + lastOutputTokens, // Cumulative for cost info
            };
            updateProjectSession(projectId, { stats: newStats });
          }
          break;
        }
        case "session_update": {
          if (evt.session) {
            // Initialize stats to zero when session is first created
            const state = getProjectSession(projectId);
            if (!state.stats) {
              state.stats = { tokens: 0, contextPercent: 0, totalTokens: 0 };
            }
            updateProjectSession(projectId, { session: evt.session });
            // Sync active mode from backend
            if (evt.session.activeMode && projectId === activeProject?.id) {
              setActiveMode(evt.session.activeMode);
            }
          }
          break;
        }
      }
    });

    const unsubTerm = on("terminal_data", (_msg: any) => {});

    const unsubError = on("error", (msg: any) => {
      console.error("[WS Error]", msg.error);
    });

    const unsubHistory = on("pi_history", (msg: any) => {
      if (msg.messages && msg.messages.length > 0) {
        console.log(`[Pi] Restored ${msg.messages.length} messages for project ${msg.projectId}`);
      }
    });

    const unsubStarted = on("pi_started", (msg: any) => {
      const { projectId, resumed } = msg.data || {};
      if (projectId) {
        console.log(`[Pi] Session ${resumed ? "resumed" : "started"} for project ${projectId}`);
        if (resumed) {
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

  // ── Project selection ──
  const handleSelectProject = (project: Project) => {
    if (activeProject?.id === project.id) return;
    activateProject(project);
  };

  const activateProject = useCallback(
    (project: Project) => {
      setActiveProject(project);
      localStorage.setItem("pi-web-active-project", project.id);

      const state = getProjectSession(project.id);

      if (!state.session) {
        send({
          type: "pi_start",
          projectId: project.id,
          resume: true,
          sessionId: project.lastSessionId,
        });
      } else {
        send({
          type: "pi_history_request",
          projectId: project.id,
        });
      }

      // Load active mode for this project
      fetch(`/api/model-library/projects/${project.id}/mode`)
        .then(r => r.json())
        .then(data => {
          if (data.activeMode) setActiveMode(data.activeMode);
        })
        .catch(() => {});

      rerender();
    },
    [send, getProjectSession]
  );

  // ── Add/delete project ──
  const handleAddProject = () => {
    setShowAddProject(true);
  };

  const handleDeleteProject = async (project: Project, deleteFiles: boolean) => {
    try {
      const queryParam = deleteFiles ? "?deleteFiles=true" : "";
      const res = await fetch(`/api/projects/${project.id}${queryParam}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete project");
      }
      if (activeProject?.id === project.id) {
        setActiveProject(null);
        localStorage.removeItem("pi-web-active-project");
      }
      await loadProjects();
    } catch (e: any) {
      console.error("Failed to delete project:", e.message);
      alert("Failed to delete project: " + e.message);
    }
  };

  const handleProjectCreated = async (project: Project) => {
    await loadProjects();
    setShowAddProject(false);
    activateProject(project);
  };

  // ── Background streaming ──
  const backgroundStreamingProjects = projects.filter(
    (p) => p.id !== activeProject?.id && projectSessionsRef.current.get(p.id)?.isStreaming
  );

  return (
    <div className={`h-screen flex flex-col ${scanlines ? "scanlines" : ""}`}>
      <div className="matrix-bg" />

      {/* ── HEADER ── */}
      <header className="h-10 header-glow bg-hacker-surface flex items-center px-3 gap-2 z-10 shrink-0">
        {/* Logo + connection */}
        <span className="text-hacker-accent text-sm glitch select-none">⚡</span>
        <span className="text-hacker-accent text-xs font-bold tracking-widest select-none">PI</span>
        <span
          className={`text-sm ${connected ? "text-hacker-accent" : "text-hacker-error"} ${connected ? "animate-pulse-subtle" : ""}`}
          title={connected ? "Connected to backend" : "Offline — backend unreachable"}
        >
          {connected ? "●" : "○"}
        </span>

        <div className="w-px h-4 bg-hacker-border-bright" />

        {/* Background streaming count */}
        {backgroundStreamingProjects.length > 0 && (
          <>
            <span className="text-xs text-hacker-warn">⚡{backgroundStreamingProjects.length} bg</span>
            <div className="w-px h-4 bg-hacker-border-bright" />
          </>
        )}

        <div className="flex-1" />

        {/* Mode chips — CODE / PLAN / REVIEW */}
        <ModelQuickSwitch
          activeMode={activeMode}
          activeProjectId={activeProject?.id}
          modelChangeVersion={modelChangeVersion}
          onModeSwitch={(mode) => {
            if (activeProject) {
              send({ type: "mode_switch", projectId: activeProject.id, mode });
            }
          }}
          onModelApplied={handleModelApplied}
        />

        <div className="w-px h-4 bg-hacker-border-bright" />

        {/* Tab toggles [PI] [TERM] */}
        <button
          onClick={() => setActiveTab("pi")}
          className={`text-xs px-2 py-1 border font-bold tracking-wide ${
            activeTab === "pi"
              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
              : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
          }`}
        >
          [PI]
        </button>
        <button
          onClick={() => setActiveTab("terminal")}
          className={`text-xs px-2 py-1 border font-bold tracking-wide ${
            activeTab === "terminal"
              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
              : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
          }`}
        >
          [TERM]
        </button>
        <button
          onClick={() => setActiveTab("files")}
          className={`text-xs px-2 py-1 border font-bold tracking-wide ${
            activeTab === "files"
              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
              : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
          }`}
        >
          [FILES]
        </button>

        <div className="w-px h-4 bg-hacker-border-bright" />

        {/* Zoom buttons */}
        <button onClick={zoomOut} className="btn-hacker text-xs px-1.5 py-1" title="Zoom out">−</button>
        <span className="text-xs text-hacker-text-dim min-w-[28px] text-center">{Math.round(zoomLevel * 100)}%</span>
        <button onClick={zoomIn} className="btn-hacker text-xs px-1.5 py-1" title="Zoom in">+</button>

        <button onClick={toggleTheme} className="btn-hacker text-xs px-2 py-1">
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <AccentPicker theme={theme} accent={accent} onAccentChange={setAccent} scanlines={scanlines} onScanlinesToggle={toggleScanlines} />
        <button onClick={() => setShowExtensions(true)} className="btn-hacker text-xs px-2 py-1" title="Extensions & Skills">
          📦
        </button>
        <button onClick={() => setShowModelLibrary(true)} className="btn-hacker text-xs px-2 py-1" title="Model library (Ctrl+L)">
          ⚙
        </button>
      </header>

      {/* ── MAIN BODY ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar with tabs + project list */}
        <div style={{ width: sidebarWidth }} className="shrink-0 relative">
          <Sidebar
            projects={projects}
            activeProject={activeProject}
            onSelectProject={handleSelectProject}
            onAddProject={handleAddProject}
            onDeleteProject={handleDeleteProject}
            session={session}
            projectSessions={projectSessionsRef.current}
            onSendCommand={(cmd: string) => {
              if (activeProject) {
                send({ type: "pi_prompt", projectId: activeProject.id, message: cmd });
              }
            }}
            onRefreshGit={() => {
              if (activeProject) {
                fetch(`/api/projects/${activeProject.id}/git/sync`, { method: "POST" })
                  .then(() => loadProjects())
                  .catch(() => {});
              }
            }}
          />
          {/* Resize handle */}
          <div
            onMouseDown={startResizeSidebar}
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50 transition-colors"
            title="Resize sidebar"
          />
        </div>

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
            <div className={activeTab === "files" ? "absolute inset-0" : "hidden"}>
              <FileExplorer project={activeProject} />
            </div>
          </div>

          {/* StatusBar */}
          <StatusBar
            activeProject={activeProject}
            isStreaming={isStreaming}
            stats={stats}
            session={session}
            connected={connected}
            activeMode={activeMode}
            autoReviewState={autoReviewState}
          />
        </div>
      </div>

      {/* ── MODALS ── */}
      {showProjectSwitch && pendingProject && (
        <ProjectSwitchModal
          fromProject={activeProject!}
          toProject={pendingProject}
          onConfirm={() => {
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
          onModelApplied={handleModelApplied}
        />
      )}

      {showExtensions && (
        <ExtensionsModal
          onClose={() => setShowExtensions(false)}
        />
      )}
    </div>
  );
}

// Wrap with ErrorBoundary to prevent dark screen of death
export default function AppWithBoundary() {
  return <ErrorBoundary><App /></ErrorBoundary>;
}