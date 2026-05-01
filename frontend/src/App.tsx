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

      rerender();
    },
    [send, getProjectSession]
  );

  // ── Add/delete project ──
  const handleAddProject = () => {
    setShowAddProject(true);
  };

  const handleDeleteProject = async (project: Project) => {
    if (!confirm(`Delete project "${project.name}"?\nThis only removes it from Pi-Web. Files on disk are NOT deleted.`)) return;
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
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
    <div className="h-screen flex flex-col scanlines">
      <div className="matrix-bg" />

      {/* ── HEADER (compact, no project selector) ── */}
      <header className="h-8 header-glow bg-hacker-surface flex items-center px-3 gap-2 z-10 shrink-0">
        {/* Logo */}
        <span className="text-hacker-accent text-sm glitch select-none">⚡</span>
        <span className="text-hacker-accent text-xs font-bold tracking-widest select-none">PI</span>

        <div className="w-px h-4 bg-hacker-border-bright" />

        {/* Background streaming count */}
        {backgroundStreamingProjects.length > 0 && (
          <>
            <span className="text-[10px] text-hacker-warn">⚡{backgroundStreamingProjects.length} bg</span>
            <div className="w-px h-4 bg-hacker-border-bright" />
          </>
        )}

        <div className="flex-1" />

        {/* Mode chips — CODE / PLAN / REVIEW */}
        <ModelQuickSwitch onModelApplied={() => {
          if (activeProject) {
            fetch(`/api/settings/session?projectId=${activeProject.id}`).then(r => r.json()).then((s) => {
              updateProjectSession(activeProject.id, { session: s });
            }).catch(() => {});
          }
        }} />

        <div className="w-px h-4 bg-hacker-border-bright" />

        {/* Tab toggles [PI] [TERM] */}
        <button
          onClick={() => setActiveTab("pi")}
          className={`text-[10px] px-2 py-0.5 border font-bold tracking-wide ${
            activeTab === "pi"
              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
              : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
          }`}
        >
          [PI]
        </button>
        <button
          onClick={() => setActiveTab("terminal")}
          className={`text-[10px] px-2 py-0.5 border font-bold tracking-wide ${
            activeTab === "terminal"
              ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
              : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
          }`}
        >
          [TERM]
        </button>

        <div className="w-px h-4 bg-hacker-border-bright" />

        {/* WS status */}
        <span className={`text-[10px] ${connected ? "text-hacker-accent" : "text-hacker-error"}`} title={connected ? "Connected" : "Offline"}>
          {connected ? "◉" : "◌"}
        </span>

        <button onClick={toggleTheme} className="btn-hacker text-xs px-1.5 py-0.5">
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <button onClick={() => setShowModelLibrary(true)} className="btn-hacker text-xs px-1.5 py-0.5" title="Model library (Ctrl+L)">
          ⚙
        </button>
      </header>

      {/* ── MAIN BODY ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar with tabs + project list */}
        <Sidebar
          projects={projects}
          activeProject={activeProject}
          isStreaming={isStreaming}
          onSelectProject={handleSelectProject}
          onAddProject={handleAddProject}
          onDeleteProject={handleDeleteProject}
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

          {/* StatusBar */}
          <StatusBar
            activeProject={activeProject}
            isStreaming={isStreaming}
            stats={stats}
            session={session}
            connected={connected}
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