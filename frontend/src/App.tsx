import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { useIsMobile } from "./hooks/useMediaQuery";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { ChatView } from "./components/Chat/ChatView";
import { TerminalView } from "./components/Terminal/TerminalView";
import { FileExplorer } from "./components/Files/FileExplorer";
import { DesignPanel } from "./components/Design/DesignPanel";
import { WelcomeView } from "./components/Sidebar/WelcomeView";
import { AddProjectModal } from "./components/Modals/AddProjectModal";
import { SettingsModal } from "./components/Modals/SettingsModal";
import { UsageStatsModal } from "./components/Modals/UsageStatsModal";
import { Graph3DModal } from "./components/Modals/Graph3DModal";
import { CbmStatsModal } from "./components/Modals/CbmStatsModal";
import { PiLogo } from "./components/common/PiLogo";
import { ModelQuickSwitch } from "./components/Header/ModelQuickSwitch";
import { MobileHeaderMenu } from "./components/Header/MobileHeaderMenu";
import { AccentPicker } from "./components/Header/AccentPicker";
import { Window } from "./components/common/Window";
import { LayoutRenderer, loadPersistedLayout, savePersistedLayout } from "./components/Layout/LayoutRenderer";
import { X } from "lucide-react";
import type { Project, PanelId, Activity } from "./types";
import { I18nProvider, useTranslation, getT } from "./i18n";
import { hasOpenOverlay } from "./hooks/useOverlayStack";

// ── Error boundary to prevent white/dark screen of death ──
class ErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean; error: string}> {
  state = { hasError: false, error: "" };
  static getDerivedStateFromError(e: Error) { return { hasError: true, error: e.message }; }
  render() {
    if (this.state.hasError) {
      const t = getT();
      return (
        <div className="h-screen w-screen bg-hacker-bg text-hacker-accent flex flex-col items-center justify-center gap-4 p-8 font-mono text-sm">
          <div className="text-4xl">⚠</div>
          <div className="text-hacker-accent font-bold">{t('error.renderError')}</div>
          <pre className="text-hacker-error text-xs max-w-[37.5rem] overflow-auto whitespace-pre-wrap">{this.state.error}</pre>
          <button onClick={() => this.setState({hasError: false, error: ""})} className="btn-hacker">
            {t('error.retry')}
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
  activity: Activity | null;  // activité en cours (StatusBar), dérivée des pi_event
  lastEventAt: number;  // timestamp of last pi_event received (0 = never)
}

function App() {
  const { t } = useTranslation();
  // queueSize : messages en attente dans la file WS (Lot B) — exposé à ChatView
  const { connected, send, on, queueSize } = useWebSocket();
  const isGecko = typeof navigator !== 'undefined' && /Gecko\//.test(navigator.userAgent);

  // ── State ──
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("pi-web-theme");
    return (saved === "light" || saved === "dark") ? saved : "dark";
  });
  const [accent, setAccent] = useState(() => localStorage.getItem("pi-web-accent") || "");
  const [scanlines, setScanlines] = useState(() => {
    // Auto-disable scanlines + matrix-bg on Gecko (Firefox/Floorp) — the Cycle Collector
    // runs at ~50% CPU with full-screen fixed overlays, making the UI unresponsive.
    if (typeof navigator !== 'undefined' && /Gecko\//.test(navigator.userAgent)) {
      return false;
    }
    return localStorage.getItem("pi-web-scanlines") !== "false";
  });

  // ── Panel State ──
  interface PanelState { visible: boolean; floating: boolean; }
  const DEFAULT_PANELS: Record<PanelId, PanelState> = { pi: { visible: true, floating: false }, terminal: { visible: false, floating: false }, files: { visible: false, floating: false } };
  const [panels, setPanels] = useState<Record<PanelId, PanelState>>(() => {
    const saved = localStorage.getItem("pi-web-panels");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (typeof parsed === "object" && parsed !== null) {
          // Merge with defaults so any newly-added panel keys are always present
          // Also validate each key has the correct shape
          const merged: Record<PanelId, PanelState> = { ...DEFAULT_PANELS };
          for (const key of Object.keys(parsed) as PanelId[]) {
            if (key in DEFAULT_PANELS) {
              const val = parsed[key];
              merged[key] = {
                visible: typeof val?.visible === 'boolean' ? val.visible : false,
                floating: typeof val?.floating === 'boolean' ? val.floating : false,
              };
            }
          }
          return merged;
        }
      } catch {}
    }
    return { ...DEFAULT_PANELS };
  });

  const savePanels = (p: Record<PanelId, PanelState>) => {
    try { localStorage.setItem("pi-web-panels", JSON.stringify(p)); } catch {}
    setPanels(p);
  };

  const togglePanel = (id: PanelId) => savePanels({ ...panels, [id]: { ...(panels[id] ?? { visible: false, floating: false }), visible: !(panels[id]?.visible ?? false), floating: false } });
  const undockPanel = (id: PanelId) => savePanels({ ...panels, [id]: { ...(panels[id] ?? { visible: false, floating: false }), visible: true, floating: true } });
  const dockPanel = (id: PanelId) => savePanels({ ...panels, [id]: { ...(panels[id] ?? { visible: false, floating: false }), visible: true, floating: false } });
  const hidePanel = (id: PanelId) => savePanels({ ...panels, [id]: { ...(panels[id] ?? { visible: false, floating: false }), visible: false, floating: false } });

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
    const panel = panels[id] ?? { visible: false, floating: false };
    const isOn = panel.visible && !panel.floating;
    return (
      <button
        onClick={() => togglePanel(id)}
        className={`hidden md:inline-flex text-xs px-2 py-1 border font-bold tracking-wide transition-all ${
          isOn ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10" : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
        }`}
        title={`${isOn ? t('header.hidePanel', label) : t('header.showPanel', label)}`}
      >
        {isOn ? `[${label}]` : label}
      </button>
    );
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
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
  // BUG-68 : streamingStalled est désormais calculé (plus codé en dur à false).
  // Il devient true quand le projet actif est en streaming mais qu'aucun event
  // (message_update, tool_execution_*, etc.) n'a été reçu depuis 30s.
  // L'interval de watchdog ci-dessous met à jour `stallMap` toutes les 15s.
  const [stallMap, setStallMap] = useState<Record<string, boolean>>({});
  const streamingStalled = activeProject ? (stallMap[activeProject.id] ?? false) : false;
  const session = activeSessionState?.session ?? null;
  const stats = activeSessionState?.stats ?? null;
  const activeActivity = activeSessionState?.activity ?? null;

  // Modals
  const [showAddProject, setShowAddProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsageStats, setShowUsageStats] = useState(false);
  const [showGraph3D, setShowGraph3D] = useState(false);
  const [showCbmStats, setShowCbmStats] = useState(false);
  const [activeMode, setActiveMode] = useState<string>("code");
  // BUG mode-sync : l'activeMode réel du backend est exposé dans le payload WS
  // `connected` (data.activeSessions) qui arrive AVANT que le projet actif soit
  // connu (activeProject est null au reload). Sans ce ref, ce mode était jeté et
  // l'UI restait bloquée sur CODE alors que le backend était resté en ROUTING.
  // On mémorise ici l'activeMode par projet pour le réutiliser dès que le projet
  // actif devient connu (activateProject / effet de resynchronisation).
  const activeModeByProjectRef = useRef<Map<string, string>>(new Map());

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
      state = { isStreaming: false, session: null, stats: null, activity: null, lastEventAt: 0 };
      projectSessionsRef.current.set(projectId, state);
    }
    return state;
  }, []);

  const updateProjectSession = useCallback(
    (projectId: string, update: Partial<ProjectSessionState>) => {
      const state = getProjectSession(projectId);
      const isActive = projectId === activeProject?.id;
      const prevIsStreaming = state.isStreaming;
      const prevSession = state.session;
      const prevStats = state.stats;
      const prevActivity = state.activity;
      Object.assign(state, update);

      // Projets en arrière-plan : le sidebar doit refléter leur état.
      if (!isActive) {
        rerender();
        return;
      }

      // Projet actif : ne re-render que si une valeur affichée change
      // (isStreaming, session pour le modèle/contexte, stats pour la barre).
      const streamingChanged = update.isStreaming !== undefined && update.isStreaming !== prevIsStreaming;
      const sessionChanged = update.session !== undefined && update.session !== prevSession;
      const statsChanged = update.stats !== undefined && update.stats !== prevStats;
      const activityChanged = update.activity !== undefined && update.activity !== prevActivity;
      if (streamingChanged || sessionChanged || statsChanged || activityChanged) {
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
        // ── Priorité au modal (Lot B) ──────────────────────────────
        // Si un overlay/modal/visionneuse est ouvert (pile centralisée
        // alimentée par useOverlayStack : ModalDialog, Graph3D/CbmStats,
        // visionneuse de ChatView), Échap ne fait que le FERMER — chaque
        // overlay gère sa propre fermeture, le plus récent d'abord.
        // Sinon, Échap interrompt le streaming (comportement historique).
        if (hasOpenOverlay()) return;
        if (isStreaming && activeProject) {
          e.preventDefault();
          send({ type: "pi_abort", projectId: activeProject.id });
        }
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
  }, [isStreaming, send, activeProject]);

  // ── Streaming watchdog + stall detector ──
  // Every 15s, check all projects:
  // - Stalled (>30s since last event): shown as stale in UI (orange dot)
  //
  // BUG-68 : on ne reset PLUS isStreaming automatiquement (le seul reset légitime
  // vient d'un vrai event agent_end). En revanche on calcule `stallMap` (vrai
  // streamingStalled) pour afficher un indicateur quand le projet actif est en
  // streaming sans aucun event reçu depuis 30s. L'utilisateur peut annuler (Esc).
  useEffect(() => {
    const STALL_THRESHOLD = 60 * 1000;  // 60s → show stale indicator (30s était trop agressif : faux positifs pendant thinking/tool calls longs)
    const CHECK_INTERVAL = 15 * 1000;   // check every 15s
    const interval = setInterval(() => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [pid, state] of projectSessionsRef.current) {
        if (state.isStreaming) {
          const elapsed = state.lastEventAt > 0 ? Date.now() - state.lastEventAt : Date.now();
          const stalled = elapsed > STALL_THRESHOLD;
          next[pid] = stalled;
          if (stalled) changed = true;
        } else {
          next[pid] = false;
        }
      }
      setStallMap(prev => {
        // Éviter un re-render inutile si rien n'a changé
        const diff = Object.keys(next).some(k => prev[k] !== next[k]);
        return diff ? next : prev;
      });
      if (changed) rerender();
    }, CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  // ── Load projects ──
  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody && errBody.error ? errBody.error : `HTTP ${res.status}`;
        console.error("Failed to load projects:", res.status, msg);
        setProjects([]);
        setProjectsError(msg);
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        console.error("Failed to load projects: response is not an array", data);
        setProjects([]);
        setProjectsError("Unexpected server response");
        return;
      }
      setProjects(data);
      setProjectsError(null);
      // No auto-activation — welcome page is shown on load/refresh
      // User picks a project from the welcome page or sidebar
    } catch (e) {
      console.error("Failed to load projects:", e);
      setProjects([]);
      setProjectsError(e instanceof Error ? e.message : String(e));
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
      if (!projectId) return;

      // Track last event time for stall detection
      const state = getProjectSession(projectId);
      state.lastEventAt = Date.now();

      switch (evt.type) {
        case "agent_start": {
          updateProjectSession(projectId, { isStreaming: true });
          break;
        }
        case "agent_settled": {
          // BUG-72 : agent_settled est la VRAIE fin du run (retry/compaction/drain
          // terminés). agent_end n'est pas la fin réelle — le SDK poursuit après,
          // donc on ne coupe PAS isStreaming sur agent_end (désync pendant
          // compaction/retry).
          updateProjectSession(projectId, { isStreaming: false, activity: null });
          break;
        }
        case "tool_execution_start": {
          // Le tool `delegate` (harness-orchestrator) porte la fonction de routage
          // sélectionnée (planning/execute/review/integrate) dans args.function.
          // → l'indicateur d'activité affiche la fonction en cours.
          const fn = typeof evt.args?.function === "string" ? evt.args.function : undefined;
          if (evt.toolName === "delegate") {
            updateProjectSession(projectId, { activity: { type: "routing", routingFunction: fn } });
          } else {
            updateProjectSession(projectId, { activity: { type: "tool", toolName: typeof evt.toolName === "string" ? evt.toolName : undefined } });
          }
          break;
        }
        case "tool_execution_end": {
          // Fin d'un outil → retour au libellé par défaut ; le prochain event
          // (thinking / text / nouvel outil) surchargera l'activité.
          updateProjectSession(projectId, { activity: null });
          break;
        }
        case "message_update": {
          const d = evt.assistantMessageEvent;
          if (!d) break;
          if (d.type === "thinking_delta") {
            updateProjectSession(projectId, { activity: { type: "thinking" } });
          } else if (d.type === "text_delta") {
            updateProjectSession(projectId, { activity: { type: "generating" } });
          }
          break;
        }
        case "heartbeat": {
          // BUG-72 : heartbeat applicatif émis par le backend pendant les phases
          // silencieuses d'un run actif (bash silencieux, thinking long,
          // compaction). lastEventAt est déjà rafraîchi en tête de handler pour
          // tout pi_event → le watchdog stalled ne déclenche plus de faux
          // "stalled" tant que le run tourne.
          break;
        }
        case "mode_change": {
          if (projectId === activeProject?.id) {
            setActiveMode(evt.mode);
          }
          if (typeof evt.mode === "string") {
            activeModeByProjectRef.current.set(projectId, evt.mode);
          }
          // Reload model library when mode changes (enabled state may have changed)
          setModelChangeVersion(v => v + 1);
          break;
        }
        case "turn_end": {
          if (evt.message?.usage) {
            const u = evt.message.usage;
            const state = getProjectSession(projectId);
            const prevStats = state.stats || { tokens: 0, contextPercent: 0, totalTokens: 0 };
            const lastInputTokens = u.input || 0;
            const lastOutputTokens = u.output || 0;
            const totalTokens = prevStats.totalTokens + lastInputTokens + lastOutputTokens;
            updateProjectSession(projectId, {
              stats: { ...prevStats, totalTokens },
            });
          }
          break;
        }
        case "session_update": {
          if (evt.session) {
            const state = getProjectSession(projectId);
            if (!state.stats) {
              state.stats = { tokens: 0, contextPercent: 0, totalTokens: 0 };
            }
            const cu = evt.session.contextUsage;
            if (cu && cu.tokens !== null && cu.contextWindow > 0) {
              const prevStats = state.stats;
              state.stats = {
                tokens: cu.tokens,
                contextPercent: Math.round(cu.percent ?? 0),
                totalTokens: prevStats.totalTokens,
              };
            }
            updateProjectSession(projectId, { session: evt.session });
            if (evt.session.activeMode) {
              activeModeByProjectRef.current.set(projectId, evt.session.activeMode);
            }
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

    // BUG-72 : le backend envoie un message "connected" à chaque connexion WS
    // (y compris les reconnexions) avec activeSessions contenant le VRAI
    // isStreaming (lu depuis le SDK). On resynchronise l'état frontend au
    // reload/reconnect au lieu de garder un flag stale.
    const unsubConnected = on("connected", (msg: any) => {
      const sessions = msg.data?.activeSessions || {};
      for (const [pid, info] of Object.entries(sessions) as [string, any][]) {
        if (!info) continue;
        // Mémoriser l'activeMode réel du backend pour CHAQUE projet (pas seulement
        // le projet actif) : au reload activeProject est null quand ce payload
        // arrive, le mode doit donc être conservé pour une resynchronisation
        // ultérieure au moment où le projet actif est sélectionné.
        if (info.activeMode) {
          activeModeByProjectRef.current.set(pid, info.activeMode);
        }
        const update: Partial<ProjectSessionState> = { session: info };
        if (typeof info.isStreaming === "boolean") {
          update.isStreaming = info.isStreaming;
        }
        updateProjectSession(pid, update);
        if (info.activeMode && pid === activeProject?.id) {
          setActiveMode(info.activeMode);
        }
      }
    });

    return () => {
      unsubPiEvent();
      unsubTerm();
      unsubError();
      unsubHistory();
      unsubStarted();
      unsubConnected();
    };
  }, [on, getProjectSession, updateProjectSession]);

  // ── Project selection ──
  const handleSelectProject = (project: Project) => {
    // Ferme le drawer sur mobile même si le projet est déjà actif (le tap doit fermer le drawer).
    if (isMobile) setSidebarOpen(false);
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

  // ── Resynchronisation du mode actif quand le projet actif devient connu ──
  // BUG mode-sync : `activeMode` démarre à "code" et le payload WS `connected`
  // (qui contient l'activeMode réel) arrive avant que le projet actif soit connu
  // → le mode réel était perdu au reload. Cet effet s'exécute à chaque changement
  // de projet actif : il applique d'abord le mode mémorisé depuis `connected`
  // (fast path, déjà dispo), puis re-fetch GET /mode comme source de vérité.
  useEffect(() => {
    const pid = activeProject?.id;
    if (!pid) return;
    const knownMode = activeModeByProjectRef.current.get(pid);
    if (knownMode) setActiveMode(knownMode);
    fetch(`/api/model-library/projects/${pid}/mode`)
      .then(r => r.json())
      .then(data => {
        if (data.activeMode) {
          setActiveMode(data.activeMode);
          activeModeByProjectRef.current.set(pid, data.activeMode);
        }
      })
      .catch(() => {});
  }, [activeProject?.id]);

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
      alert(t('error.deleteProject', e.message));
    }
  };

  // ── Quit to home screen ──
  const handleQuit = useCallback(() => {
    setActiveProject(null);
    localStorage.removeItem("pi-web-active-project");
  }, []);

  // ── Sidebar drawer (mobile) ──
  // Sur mobile la sidebar devient un drawer coulissant ; le state sidebarOpen
  // pilote son ouverture/fermeture. isMobile = true sous md:768px.
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toggleSidebar = () => setSidebarOpen((o) => !o);
  // Ferme le drawer si on repasse en desktop (>=768px) pour rester in-flow.
  useEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

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

  // ── WebSocket reconnection: restore session state when WS reconnects ──
  useEffect(() => {
    const unsub = on("_ws_reconnect", () => {
      console.log("[App] WebSocket reconnected — restoring session state");
      const now = Date.now();
      // Don't blindly reset isStreaming — agent may still be running.
      // Just update lastEventAt so the stall detector can monitor.
      for (const [, state] of projectSessionsRef.current) {
        state.lastEventAt = now;
      }
      rerender();
      // Re-request session state for the active project
      if (activeProject) {
        send({
          type: "pi_history_request",
          projectId: activeProject.id,
        });
        // Reload active mode and session state from backend (preserve isStreaming)
        fetch(`/api/settings/session?projectId=${activeProject.id}`)
          .then(r => r.json())
          .then(data => {
            if (data) {
              updateProjectSession(activeProject.id, { session: data });
              if (data.activeMode) {
                setActiveMode(data.activeMode);
                activeModeByProjectRef.current.set(activeProject.id, data.activeMode);
              }
            }
          })
          .catch(() => {});
      }
    });
    return () => unsub();
  }, [on, activeProject, send]);

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
          // BUG-16 fix: utiliser savePanels au lieu de setPanels pour persister dans localStorage
          const p = { ...panels };
          p[panelId] = { ...(p[panelId] ?? { visible: false, floating: false }), visible: true, floating: false };
          savePanels(p);
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
          <span className="text-hacker-accent text-xs font-bold tracking-widest">{t('header.standaloneTitle', standalonePanel.toUpperCase())}</span>
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
            title={t('header.closeRestore')}
          >
            {t('header.closeStandalone')}
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
                  streamingStalled={streamingStalled}
                  session={session}
                  projectId={activeProject?.id || ""}
                  activeMode={activeMode}
                  connected={connected}
                  pendingMessages={queueSize}
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
                <FileExplorer project={activeProject} onReferenceFile={handleReferenceFile} on={on} />
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
      {!isGecko && <div className="matrix-bg" />}

      {/* ── HEADER ── */}
      <header className="h-10 header-glow bg-hacker-surface flex items-center px-3 gap-2 z-10 shrink-0 overflow-x-auto">
        {/* Hamburger (mobile) — ouvre/ferme le drawer sidebar */}
        <button
          onClick={toggleSidebar}
          className="btn-hacker text-xs px-2 py-1 md:hidden"
          title={t(sidebarOpen ? 'header.closeSidebar' : 'header.openSidebar')}
          aria-label={t(sidebarOpen ? 'header.closeSidebar' : 'header.openSidebar')}
        >
          ☰
        </button>
        {/* Logo + connection */}
        <div onClick={handleQuit} title={t('header.returnToHome')} className="cursor-pointer hover:opacity-70 transition-opacity">
          <PiLogo className="text-hacker-accent w-6 h-6" />
        </div>
        <span
          className={`text-sm ${connected ? "text-hacker-accent" : "text-hacker-error"} ${connected ? "animate-pulse-subtle" : ""}`}
          title={connected ? t('header.connected') : t('header.offline')}
        >
          {connected ? "●" : "○"}
        </span>
        <span className="text-[10px] text-hacker-text-dim hidden md:inline">
          {connected ? t('header.connected') : t('header.offline')}
        </span>

        <div className="w-px h-4 bg-hacker-border-right" />

        {/* Background streaming count */}
        {backgroundStreamingProjects.length > 0 && (
          <>
            <span className="text-xs text-hacker-warn hidden md:inline"><PiLogo className="w-3.5 h-3.5 inline" />{backgroundStreamingProjects.length} bg</span>
            <div className="w-px h-4 bg-hacker-border-right hidden md:block" />
          </>
        )}

        <div className="flex-1" />

        {/* Mode chips — Modèle par défaut / ROUTING */}
        <div className="hidden md:block">
          <ModelQuickSwitch
            activeMode={activeMode}
            activeProjectId={activeProject?.id}
            modelChangeVersion={modelChangeVersion}
            session={activeProject ? getProjectSession(activeProject.id).session : undefined}
            onModeSwitch={(mode) => {
              if (activeProject) {
                send({ type: "mode_switch", projectId: activeProject.id, mode });
              }
            }}
            onModelApplied={handleModelApplied}
          />
        </div>

        <div className="w-px h-4 bg-hacker-border-right hidden md:block" />

        {/* Panel Switches (ON/OFF) */}
        {renderPanelSwitch("pi", "PI")}
        {renderPanelSwitch("terminal", "TERM")}
        {renderPanelSwitch("files", "FILES")}

        <div className="w-px h-4 bg-hacker-border-right hidden md:block" />

        {/* Graph 3D button */}
        <button
          onClick={() => setShowGraph3D(true)}
          className="hidden md:inline-flex text-xs px-2 py-1 border font-bold tracking-wide transition-all border-transparent text-hacker-text-dim hover:text-hacker-accent hover:border-hacker-border"
          title={t('header.graph3d')}
          aria-label={t('header.graph3d')}
        >
          📊
        </button>
        {/* CBM stats button */}
        <button
          onClick={() => setShowCbmStats(true)}
          className="hidden md:inline-flex text-xs px-2 py-1 border font-bold tracking-wide transition-all border-transparent text-hacker-text-dim hover:text-hacker-accent hover:border-hacker-border"
          title={t('header.cbmStats')}
          aria-label={t('header.cbmStats')}
        >
          📈
        </button>

        <div className="w-px h-4 bg-hacker-border-right hidden md:block" />

        {/* Zoom buttons */}
        <button onClick={zoomOut} className="btn-hacker text-xs px-1.5 py-1 hidden md:inline-flex" title={t('common.zoomOut')} aria-label={t('common.zoomOut')}>−</button>
        <span className="text-xs text-hacker-text-dim min-w-[28px] text-center hidden md:inline">{Math.round(zoomLevel * 100)}%</span>
        <button onClick={zoomIn} className="btn-hacker text-xs px-1.5 py-1 hidden md:inline-flex" title={t('common.zoomIn')} aria-label={t('common.zoomIn')}>+</button>

        <button onClick={toggleTheme} className="btn-hacker text-xs px-2 py-1" title={t('header.toggleTheme')} aria-label={t('header.toggleTheme')}>
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <div className="hidden md:block">
          <AccentPicker theme={theme} accent={accent} onAccentChange={setAccent} scanlines={scanlines} onScanlinesToggle={toggleScanlines} />
        </div>
        <button onClick={() => setShowSettings(true)} className="btn-hacker text-xs px-2 py-1" title={`${t('header.settings')} (Ctrl+L)`} aria-label={`${t('header.settings')} (Ctrl+L)`}>
          ⚙
        </button>

        {/* Menu mobile « ⋯ » — panneaux + mode + config routage */}
        <div className="md:hidden">
          <MobileHeaderMenu
            panels={panels}
            onTogglePanel={togglePanel}
            activeMode={activeMode}
            onModeSwitch={(mode) => {
              if (activeProject) {
                send({ type: "mode_switch", projectId: activeProject.id, mode });
              }
            }}
            activeProjectId={activeProject?.id}
            onModelApplied={handleModelApplied}
          />
        </div>
      </header>

      {/* ── MAIN BODY ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Overlay mobile — ferme le drawer au clic extérieur */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
        )}
        {/* Sidebar with tabs + project list — drawer coulissant sur mobile, in-flow sur desktop */}
        <div
          style={{ width: isMobile ? 256 : sidebarWidth }}
          className={`fixed z-50 top-10 bottom-0 left-0 transition-transform md:relative md:translate-x-0 md:z-auto md:shrink-0 md:top-auto md:bottom-auto md:left-auto overflow-y-auto ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
        >
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
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50 transition-colors hidden md:block"
            title={t('header.resizeSidebar')}
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
                  loadError={projectsError}
                  onSelectProject={handleSelectProject}
                  onAddProject={handleAddProject}
                />
              </div>
              <StatusBar
                activeProject={null}
                isStreaming={false}
                streamingStalled={false}
                stats={null}
                session={null}
                connected={connected}
                activeMode={activeMode}
                activity={null}
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
                    <ChatView send={send} on={on} activeProject={activeProject} isStreaming={isStreaming} streamingStalled={streamingStalled} session={session} projectId={activeProject?.id || ""} activeMode={activeMode} connected={connected} pendingMessages={queueSize} onQuit={handleQuit} />
                  ),
                  terminal: (
                    <TerminalView send={send} on={on} activeProject={activeProject} isActive={panels.terminal?.visible && !panels.terminal?.floating} />
                  ),
                  files: (
                    <FileExplorer project={activeProject} onReferenceFile={handleReferenceFile} on={on} />
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
                streamingStalled={streamingStalled}
                stats={stats}
                session={session}
                connected={connected}
                activeMode={activeMode}
                activity={activeActivity}
                onOpenUsage={() => setShowUsageStats(true)}
              />
            </>
          )}
        </div>
      </div>

      {/* FLOATING PANELS (Windows) */}
      {panels.pi?.visible && panels.pi?.floating && (
        <Window id="pi-float" title="PI" icon={<PiLogo className="w-4 h-4 text-hacker-accent" />} onClose={() => hidePanel("pi")} onDock={() => dockPanel("pi")}>
          <ChatView send={send} on={on} activeProject={activeProject} isStreaming={isStreaming} session={session} projectId={activeProject?.id || ""} activeMode={activeMode} connected={connected} pendingMessages={queueSize} onQuit={handleQuit} />
        </Window>
      )}
      {panels.terminal?.visible && panels.terminal?.floating && (
        <Window id="term-float" title="TERMINAL" icon="🖥" onClose={() => hidePanel("terminal")} onDock={() => dockPanel("terminal")}>
          <TerminalView send={send} on={on} activeProject={activeProject} isActive={false} />
        </Window>
      )}
      {panels.files?.visible && panels.files?.floating && (
        <Window id="files-float" title="FILES" icon="📁" onClose={() => hidePanel("files")} onDock={() => dockPanel("files")}>
          <FileExplorer project={activeProject} onReferenceFile={handleReferenceFile} on={on} />
        </Window>
      )}


      {/* ── MODALS ── */}
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
      {showUsageStats && (
        <UsageStatsModal onClose={() => setShowUsageStats(false)} />
      )}
      {showGraph3D && (
        <Graph3DModal onClose={() => setShowGraph3D(false)} />
      )}
      {showCbmStats && (
        <CbmStatsModal onClose={() => setShowCbmStats(false)} />
      )}
    </div>
  );
}

// Wrap with ErrorBoundary to prevent dark screen of death
export default function AppWithBoundary() {
  return <ErrorBoundary><I18nProvider><App /></I18nProvider></ErrorBoundary>;
}
