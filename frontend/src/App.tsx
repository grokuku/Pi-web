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

export default function App() {
  const { connected, send, on } = useWebSocket();

  // ── State ──
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [activeTab, setActiveTab] = useState<Tab>("pi");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [session, setSession] = useState<any>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [stats, setStats] = useState<{ tokens: number; cost: number; contextPercent: number } | null>(null);

  // Modals
  const [showProjectSwitch, setShowProjectSwitch] = useState(false);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showModelLibrary, setShowModelLibrary] = useState(false);

  // Keyboard shortcut state
  const abortRef = useRef<() => void>(() => {});

  // ── Theme ──
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // ── Global keyboard shortcuts (Pi CLI compatible) ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

      // Escape → app.interrupt (abort streaming)
      if (e.key === "Escape" && !mod && !shift && !alt) {
        if (isStreaming) {
          e.preventDefault();
          send({ type: "pi_abort" });
        }
        // Close any open modal
        if (showModelLibrary) { e.preventDefault(); setShowModelLibrary(false); }
        else if (showAddProject) { e.preventDefault(); setShowAddProject(false); }
        else if (showProjectSwitch) { e.preventDefault(); setShowProjectSwitch(false); }
        return;
      }

      // Ctrl+L → app.model.select (open settings)
      if (mod && e.key === "l") {
        e.preventDefault();
        setShowModelLibrary(true);
        return;
      }

      // Ctrl+O → app.tools.expand (toggle tool call expansion — delegate to ChatView)
      // Handled within ChatView via a custom event / state lift
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isStreaming, send, showModelLibrary, showAddProject, showProjectSwitch]);

  // ── Load projects ──
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setProjects(data);
      // Restore last active project from localStorage
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

      switch (evt.type) {
        case "agent_start":
          setIsStreaming(true);
          break;
        case "agent_end":
          setIsStreaming(false);
          break;
        case "turn_end": {
          if (evt.message?.usage) {
            const u = evt.message.usage;
            setStats((prev) => ({
              tokens: (prev?.tokens || 0) + (u.input || 0) + (u.output || 0),
              cost: (prev?.cost || 0) + (u.cost?.total || 0),
              contextPercent: Math.round(
                ((u.input || 0) / (200000)) * 100
              ),
            }));
          }
          break;
        }
        case "session_update": {
          if (evt.session) setSession(evt.session);
          break;
        }
        case "queue_update": {
          // Could show pending messages
          break;
        }
      }
    });

    const unsubTerm = on("terminal_data", (msg: any) => {
      // Handled in TerminalView
    });

    const unsubError = on("error", (msg: any) => {
      console.error("[WS Error]", msg.error);
      // Show error in UI if significant
      if (msg.error && !msg.error.includes("No active Pi session")) {
        // Don't spam for expected errors like no session
      }
    });

    return () => {
      unsubPiEvent();
      unsubTerm();
      unsubError();
    };
  }, [on]);

  // ── Handle project selection ──
  const handleSelectProject = (project: Project) => {
    if (activeProject && activeProject.id !== project.id) {
      // Show confirmation modal
      setPendingProject(project);
      setShowProjectSwitch(true);
    } else if (!activeProject) {
      activateProject(project);
    }
  };

  const activateProject = (project: Project) => {
    setActiveProject(project);
    localStorage.setItem("pi-web-active-project", project.id);
    send({ type: "pi_start", projectId: project.id });
    setStats(null);
  };

  const confirmSwitchProject = () => {
    if (pendingProject) {
      activateProject(pendingProject);
    }
    setShowProjectSwitch(false);
    setPendingProject(null);
  };

  const cancelSwitchProject = () => {
    setShowProjectSwitch(false);
    setPendingProject(null);
  };

  // ── Add project ──
  const handleAddProject = () => {
    setShowAddProject(true);
  };

  const handleProjectCreated = async (project: Project) => {
    await loadProjects();
    setShowAddProject(false);
    activateProject(project);
  };

  // ── Session info (via WebSocket) ──
  // Handled inside the pi_event listener below (session_update events)

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

        {/* Project selector */}
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
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.storage === "ssh" ? "🔗" : p.storage === "smb" ? "💾" : "📁"} {p.name}
              </option>
            ))}
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
          fetch("/api/settings/session").then(r => r.json()).then(setSession).catch(() => {});
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
        {/* Sidebar */}
        <Sidebar
          projects={projects}
          activeProject={activeProject}
          stats={stats}
          isStreaming={isStreaming}
          onSelectProject={handleSelectProject}
          onAddProject={handleAddProject}
          send={send}
          session={session}
        />

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-hidden relative">
            <div className={activeTab === "pi" ? "absolute inset-0" : "hidden"}>
              <ChatView send={send} on={on} activeProject={activeProject} isStreaming={isStreaming} session={session} />
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
          onConfirm={confirmSwitchProject}
          onCancel={cancelSwitchProject}
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
            fetch("/api/settings/session").then(r => r.json()).then(setSession).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
