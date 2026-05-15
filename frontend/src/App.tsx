import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { ChatView } from "./components/Chat/ChatView";
import { TerminalView } from "./components/Terminal/TerminalView";
import { FileExplorer } from "./components/Files/FileExplorer";
import { WelcomeView } from "./components/Sidebar/WelcomeView";
import { ProjectSwitchModal } from "./components/Modals/ProjectSwitchModal";
import { AddProjectModal } from "./components/Modals/AddProjectModal";
import { SettingsModal } from "./components/Modals/SettingsModal";
import { PiLogo } from "./components/common/PiLogo";
import { ModelQuickSwitch } from "./components/Header/ModelQuickSwitch";
import { AccentPicker } from "./components/Header/AccentPicker";
import { Window } from "./components/common/Window";
import { LayoutRenderer, loadPersistedLayout, savePersistedLayout } from "./components/Layout/LayoutRenderer";
import { X } from "lucide-react";
import type { Project, PanelId } from "./types";

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

  // ── Panel State ──
  interface PanelState { visible: boolean; floating: boolean; }
  const [panels, setPanels] = useState<Record<PanelId, PanelState>>(() => {
    const saved = localStorage.getItem("pi-web-panels");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (typeof parsed === "object" && parsed !== null) return parsed;
      } catch {}
    }
    return { pi: { visible: true, floating: false }, terminal: { visible: false, floating: false }, files: { visible: false, floating: false } };
  });

  const savePanels = (p: Record<PanelId, PanelState>) => {
    try { localStorage.setItem("pi-web-panels", JSON.stringify(p)); } catch {}
    setPanels(p);
  };

  const togglePanel = (id: PanelId) => savePanels({ ...panels, [id]: { ...panels[id], visible: !panels[id].visible, floating: false } });
  const undockPanel = (id: PanelId) => savePanels({ ...panels, [id]: { ...panels[id], visible: true, floating: true } });
  const dockPanel = (id: PanelId) => savePanels({ ...panels, [id]: { ...panels[id], visible: true, floating: false } });
  const hidePanel = (id: PanelId) => savePanels({ ...panels, [id]: { ...panels[id], visible: false, floating: false } });

  // Open panel in new browser window (tab)
  const openInNewWindow = (id: PanelId) => {
    const width = 1200, height = 800;
    const left = window.screenX + 100;
    const top = window.screenY + 100;
    const features = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
    // Build URL with standalone mode and panel parameter
    const url = new URL(window.location.href);
    url.searchParams.set('standalone', 'true');
    url.searchParams.set('panel', id);
    const win = window.open(url.toString(), `pi-web-${id}`, features);
      // Hide the panel in the main interface to avoid duplicates
      hidePanel(id);
    if (win) {
      win.document.title = `Pi-Web - ${id.toUpperCase()}`;
    }
  };

  // Helper to render panel buttons in header
  const renderPanelSwitch = (id: PanelId, label: string) => {
    const isOn = panels[id].visible && !panels[id].floating;
    return (
      <button
        onClick={() => togglePanel(id)}
        className={`text-xs px-2 py-1 border font-bold tracking-wide transition-all ${
          isOn ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10" : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
        }`}
        title={`${isOn ? 'Hide' : 'Show'} ${label}`}
      >
        {isOn ? `[${label}]` : label}
      </button>
    );
  };

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
  const [showSettings, setShowSettings] = useState(false);
  const [activeMode, setActiveMode] = useState<string>("code");
  const [autoReviewState, setAutoReviewState] = useState<{inProgress: boolean; cycle: number; maxReviews: number; phase?: string} | null>(null);

  // ── Layout config (persisted) ──
  const [layoutCfg, setLayoutCfg] = useState(() => {
    const saved = loadPersistedLayout();
    if (saved) return saved;
    return {
      layout2: "horizontal-2" as const,
      layout3: "horizontal-3" as const,
      slotOrder: ["pi" as PanelId, "terminal" as PanelId, "files" as PanelId],
      sizes: {} as Record<string, number[]>,
    };
  });

  const activeDocked = (["pi", "terminal", "files"] as PanelId[])
    .filter(id => panels[id]?.visible && !panels[id]?.floating);

  // Ordered panels for LayoutRenderer
  const orderedPanels = layoutCfg.slotOrder.filter(id => activeDocked.includes(id));

  // Active layout type based on count
  const activeLayoutType = orderedPanels.length <= 1 ? "single" :
    orderedPanels.length === 2 ? layoutCfg.layout2 : layoutCfg.layout3;

  const handleSwap = (fromIdx: number, toIdx: number) => {
    setLayoutCfg(prev => {
      const newOrder = [...prev.slotOrder];
      // Swap: put the panel at fromIdx to toIdx, and move what was at toIdx to fromIdx
      // But orderedPanels is a subset of slotOrder — we need to swap in the full slotOrder
      const fromPanel = orderedPanels[fromIdx];
      const toPanel = orderedPanels[toIdx];
      const realFromIdx = prev.slotOrder.indexOf(fromPanel);
      const realToIdx = prev.slotOrder.indexOf(toPanel);
      [newOrder[realFromIdx], newOrder[realToIdx]] = [newOrder[realToIdx], newOrder[realFromIdx]];
      const next = { ...prev, slotOrder: newOrder };
      savePersistedLayout(next);
      return next;
    });
  };

  const handleLayoutSizesChange = (layoutKey: string, newSizes: number[]) => {
    setLayoutCfg(prev => {
      const next = { ...prev, sizes: { ...prev.sizes, [layoutKey]: newSizes } };
      savePersistedLayout(next);
      return next;
    });
  };

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
  }, []);

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
        if (showSettings) { e.preventDefault(); setShowSettings(false); }
        else if (showAddProject) { e.preventDefault(); setShowAddProject(false); }
        else if (showProjectSwitch) { e.preventDefault(); setShowProjectSwitch(false); }
        return;
      }

      if (mod && e.key === "l") {
        e.preventDefault();
        setShowSettings(true);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isStreaming, send, showSettings, showAddProject, showProjectSwitch, activeProject]);

  // ── Load projects ──
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setProjects(data);
      // No auto-activation — welcome page is shown on load/refresh
      // User picks a project from the welcome page or sidebar
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

  // ── Standalone mode (opened from main window as new tab) ──
  const urlParams = new URLSearchParams(window.location.search);
  const isStandalone = urlParams.get('standalone') === 'true';
  const standalonePanel = urlParams.get('panel') as PanelId | null;

  // ── Handle file reference injection ──
  const handleReferenceFile = useCallback((filePath: string) => {
    if (!activeProject) return;
    // Send a special prompt prefix that the backend can interpret as a file reference
    const referencePrompt = `@file ${filePath}`;
    send({ type: "pi_prompt", projectId: activeProject.id, message: referencePrompt, isReference: true });
    console.log(`[FileExplorer] Referenced file: ${filePath}`);
  }, [activeProject, send]);

  // ── BroadcastChannel for cross-tab/window communication ──
  useEffect(() => {
    const channel = new BroadcastChannel('pi-web-file-ref');
    channel.onmessage = (event) => {
      if (event.data.type === 'file-reference') {
        const { filePath, projectId } = event.data;
        if (projectId === activeProject?.id) {
          handleReferenceFile(filePath);
        }
      }
      if (event.data.type === 'restore-panel') {
        const panelId = event.data.panelId as PanelId;
        // Restore the panel in the main interface
        if (panelId && (panelId === "pi" || panelId === "terminal" || panelId === "files")) {
          setPanels(prev => {
            const p = { ...prev };
            if (p[panelId]) {
              p[panelId] = { ...p[panelId], visible: true, floating: false };
            }
            return p;
          });
        }
      }
    };
    return () => channel.close();
  }, [activeProject, handleReferenceFile, panels, savePanels]);

  // ── RENDER ──
  // If standalone mode, only show the requested panel (no header, no sidebar)
  if (isStandalone && standalonePanel) {
    return (
      <div className={`h-screen flex flex-col ${scanlines ? "scanlines" : ""}`}>
        {/* Close button for standalone mode */}
        <div className="flex items-center justify-between px-3 h-10 bg-hacker-surface border-b border-hacker-border">
          <span className="text-hacker-accent text-xs font-bold tracking-widest">PI-WEB STANDALONE - {standalonePanel.toUpperCase()}</span>
          <button
            onClick={() => {
              // Notify main window to restore the panel
              const channel = new BroadcastChannel('pi-web-file-ref');
              channel.postMessage({ type: 'restore-panel', panelId: standalonePanel });
              channel.close();
              // Close this window
              window.close();
            }}
            className="btn-hacker text-xs px-2 py-1"
            title="Close and restore to main window"
          >
            Close ✕
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {standalonePanel === "pi" && (
            <div className="h-full flex flex-col">
              <div className="flex-1 overflow-hidden">
                <ChatView
                  send={send}
                  on={on}
                  activeProject={activeProject}
                  isStreaming={isStreaming}
                  session={session}
                  projectId={activeProject?.id || ""}
                />
              </div>
            </div>
          )}
          {standalonePanel === "terminal" && (
            <div className="h-full flex flex-col">
              <div className="flex-1 overflow-hidden">
                <TerminalView send={send} on={on} activeProject={activeProject} isActive={false} />
              </div>
            </div>
          )}
          {standalonePanel === "files" && (
            <div className="h-full flex flex-col">
              <div className="flex-1 overflow-hidden">
                <FileExplorer project={activeProject} onReferenceFile={handleReferenceFile} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Normal mode: full interface
  return (
    <div className={`h-screen flex flex-col ${scanlines ? "scanlines" : ""}`}>
      <div className="matrix-bg" />

      {/* ── HEADER ── */}
      <header className="h-10 header-glow bg-hacker-surface flex items-center px-3 gap-2 z-10 shrink-0">
        {/* Logo + connection */}
        <PiLogo className="text-hacker-accent w-6 h-6" />
        <span
          className={`text-sm ${connected ? "text-hacker-accent" : "text-hacker-error"} ${connected ? "animate-pulse-subtle" : ""}`}
          title={connected ? "Connected to backend" : "Offline — backend unreachable"}
        >
          {connected ? "●" : "○"}
        </span>

        <div className="w-px h-4 bg-hacker-border-right" />

        {/* Background streaming count */}
        {backgroundStreamingProjects.length > 0 && (
          <>
            <span className="text-xs text-hacker-warn"><PiLogo className="w-3.5 h-3.5 inline" />{backgroundStreamingProjects.length} bg</span>
            <div className="w-px h-4 bg-hacker-border-right" />
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

        <div className="w-px h-4 bg-hacker-border-right" />

        {/* Panel Switches (ON/OFF) */}
        {renderPanelSwitch("pi", "PI")}
        {renderPanelSwitch("terminal", "TERM")}
        {renderPanelSwitch("files", "FILES")}

        <div className="w-px h-4 bg-hacker-border-right" />

        {/* Zoom buttons */}
        <button onClick={zoomOut} className="btn-hacker text-xs px-1.5 py-1" title="Zoom out">−</button>
        <span className="text-xs text-hacker-text-dim min-w-[28px] text-center">{Math.round(zoomLevel * 100)}%</span>
        <button onClick={zoomIn} className="btn-hacker text-xs px-1.5 py-1" title="Zoom in">+</button>

        <button onClick={toggleTheme} className="btn-hacker text-xs px-2 py-1">
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <AccentPicker theme={theme} accent={accent} onAccentChange={setAccent} scanlines={scanlines} onScanlinesToggle={toggleScanlines} />
        <button onClick={() => setShowSettings(true)} className="btn-hacker text-xs px-2 py-1" title="Settings (Ctrl+L)">
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

        {/* MAIN CONTENT AREA */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!activeProject ? (
            /* Welcome page when no project is active */
            <>
              <div className="flex-1 overflow-auto">
                <WelcomeView
                  projects={projects}
                  onSelectProject={handleSelectProject}
                  onAddProject={handleAddProject}
                />
              </div>
              <StatusBar
                activeProject={null}
                isStreaming={false}
                stats={null}
                session={null}
                connected={connected}
                activeMode={activeMode}
              />
            </>
          ) : (
            <>
              {/* Docked Panels Area — layout-driven */}
              <LayoutRenderer
                orderedPanels={orderedPanels}
                layoutType={activeLayoutType}
                sizes={layoutCfg.sizes}
                panelContent={{
                  pi: (
                    <ChatView send={send} on={on} activeProject={activeProject} isStreaming={isStreaming} session={session} projectId={activeProject?.id || ""} />
                  ),
                  terminal: (
                    <TerminalView send={send} on={on} activeProject={activeProject} isActive={panels.terminal?.visible && !panels.terminal?.floating} />
                  ),
                  files: (
                    <FileExplorer project={activeProject} onReferenceFile={handleReferenceFile} />
                  ),
                }}
                onSwap={handleSwap}
                onDetach={undockPanel}
                onNewWindow={openInNewWindow}
                onSizesChange={handleLayoutSizesChange}
              />

              {/* StatusBar (always at bottom of main area) */}
              <StatusBar
                activeProject={activeProject}
                isStreaming={isStreaming}
                stats={stats}
                session={session}
                connected={connected}
                activeMode={activeMode}
                autoReviewState={autoReviewState}
              />
            </>
          )}
        </div>
      </div>

      {/* FLOATING PANELS (Windows) */}
      {panels.pi.visible && panels.pi.floating && (
        <Window id="pi-float" title="PI" icon={<PiLogo className="w-4 h-4 text-hacker-accent" />} onClose={() => hidePanel("pi")} onDock={() => dockPanel("pi")}>
          <ChatView send={send} on={on} activeProject={activeProject} isStreaming={isStreaming} session={session} projectId={activeProject?.id || ""} />
        </Window>
      )}
      {panels.terminal.visible && panels.terminal.floating && (
        <Window id="term-float" title="TERMINAL" icon="🖥" onClose={() => hidePanel("terminal")} onDock={() => dockPanel("terminal")}>
          <TerminalView send={send} on={on} activeProject={activeProject} isActive={false} />
        </Window>
      )}
      {panels.files.visible && panels.files.floating && (
        <Window id="files-float" title="FILES" icon="📁" onClose={() => hidePanel("files")} onDock={() => dockPanel("files")}>
          <FileExplorer project={activeProject} onReferenceFile={handleReferenceFile} />
        </Window>
      )}

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

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          session={session}
          onModelApplied={handleModelApplied}
          activeProjectId={activeProject?.id}
          onLayoutChange={() => {
            const saved = loadPersistedLayout();
            if (saved) setLayoutCfg(saved);
          }}
        />
      )}
    </div>
  );
}

// Wrap with ErrorBoundary to prevent dark screen of death
export default function AppWithBoundary() {
  return <ErrorBoundary><App /></ErrorBoundary>;
}
