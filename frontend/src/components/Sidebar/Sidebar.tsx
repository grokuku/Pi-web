import {
  Plus,
  Trash2,
  GripVertical,
  ArrowUpCircle,
  Link2,
} from "lucide-react";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { GitPanel } from "./GitPanel";
import { LinkedProjectMenu } from "./LinkedProjectMenu";
import { DeleteProjectModal } from "../Modals/DeleteProjectModal";
import { NewChatConfirmModal } from "../Modals/NewChatConfirmModal";
import { UpdateAgentModal } from "../Modals/UpdateAgentModal";
import type { Project } from "../../types";
import { useTranslation } from "../../i18n";

interface Props {
  projects: Project[];
  activeProject: Project | null;
  onSelectProject: (p: Project) => void;
  onAddProject: () => void;
  onDeleteProject: (p: Project, deleteFiles: boolean) => void;
  session: any;
  projectSessions?: Map<string, { isStreaming: boolean; session: any; stats: any; lastEventAt: number }>;
  onSendCommand: (cmd: string) => void;
  onRefreshGit?: () => void;
  // Rechargement de la liste des projets (après link/unlink d'un sous-projet).
  onProjectsChanged: () => void | Promise<void>;
}

export function Sidebar({
  projects,
  activeProject,
  onSelectProject,
  onAddProject,
  onDeleteProject,
  session,
  projectSessions,
  onSendCommand,
  onRefreshGit,
  onProjectsChanged,
}: Props) {
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [confirmNewChat, setConfirmNewChat] = useState(false);
  const [localProjects, setLocalProjects] = useState<Project[]>(projects);
  // Drag & drop par ID de projet (et non par index) : les lignes affichées
  // peuvent être un sous-ensemble réordonné de la liste complète (origines
  // masquées/imbriquées), voir visibleRows.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [updateAvailable, setUpdataAvailable] = useState(false);
  const [piWebVersion, setPiWebVersion] = useState("?");
  const [piAgentVersion, setPiAgentVersion] = useState("?");
  const [piAgentLatest, setPiAgentLatest] = useState("");
  const [piAgentCurrent, setPiAgentCurrent] = useState("");
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [cbmVersion, setCbmVersion] = useState<string | null>(null);
  const [cbmInstalled, setCbmInstalled] = useState(false);
  const [cbmUpdateAvailable, setCbmUpdateAvailable] = useState(false);
  const [cbmUpdating, setCbmUpdating] = useState(false);
  const { t } = useTranslation();

  // Check for updates on mount
  useEffect(() => {
    fetch("/api/settings/version").then(r => r.json()).then(data => {
      setPiWebVersion(data.piWeb || "?");
      setPiAgentVersion(data.piAgent || "?");
    }).catch(() => {});
    fetch("/api/settings/update-check").then(r => r.json()).then(data => {
      setUpdataAvailable(!!data.updateAvailable);
      if (data.latest) setPiAgentLatest(data.latest);
      if (data.current) setPiAgentCurrent(data.current);
    }).catch(() => {});
    // Check CBM status
    fetch("/api/cbm/status").then(r => r.json()).then(data => {
      setCbmInstalled(data.installed);
      setCbmVersion(data.version);
      setCbmUpdateAvailable(data.updateAvailable);
    }).catch(() => {});
  }, []);

  const handleCbmUpdate = useCallback(() => {
    setCbmUpdating(true);
    fetch("/api/cbm/update", { method: "POST" })
      .then(r => r.json())
      .then((data) => {
        if (data.newVersion) setCbmVersion(data.newVersion);
        setCbmUpdateAvailable(false);
        setCbmUpdating(false);
      })
      .catch(() => {
        setCbmUpdating(false);
      });
  }, []);

  const [projectListHeight, setProjectListHeight] = useState(() => {
    const saved = localStorage.getItem("pi-web-project-list-height");
    return saved ? parseInt(saved) : 180;
  });

  // ── Placeholder lié : masquage des origines (option A) ──
  // Les sous-projets regroupés dans un placeholder LIÉ sont masqués par défaut
  // dans la liste ; le toggle du menu contextuel les ré-affiche. Persistance :
  // clé "pi-web.hide-linked-origins" — la valeur est le flag de MASQUAGE
  // (true/absent = masqué, "false" = affiché), en cohérence avec son nom.
  const [showLinkedOrigins, setShowLinkedOrigins] = useState(
    () => localStorage.getItem("pi-web.hide-linked-origins") === "false"
  );
  const toggleShowLinkedOrigins = useCallback(() => {
    setShowLinkedOrigins((prev) => {
      const next = !prev;
      try { localStorage.setItem("pi-web.hide-linked-origins", String(!next)); } catch {}
      return next;
    });
  }, []);
  // Menu contextuel du placeholder lié (projet + ligne ancre du menu porté).
  const [linkedMenuProject, setLinkedMenuProject] = useState<Project | null>(null);
  const linkedMenuAnchorRef = useRef<HTMLElement | null>(null);

  const projectListHeightRef = useRef(projectListHeight);
  projectListHeightRef.current = projectListHeight;
  const isResizingProjects = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // Sync localProjects when the prop changes (but not during drag)
  if (dragId === null && localProjects !== projects) {
    setLocalProjects(projects);
  }

  // ── Lignes affichées (filtrage + imbrication des origines) ──
  // Option A : les sous-projets regroupés dans un placeholder LIÉ (storage
  // "linked") sont masqués par défaut ; le toggle du menu (showLinkedOrigins)
  // les ré-affiche, rendus juste sous leur placeholder (indentés). Le drag &
  // drop opère sur ces lignes puis handleDragEnd reconstruit l'ordre complet.
  const visibleRows = useMemo(() => {
    const originIds = new Set<string>();
    for (const p of localProjects) {
      if (p.storage === "linked" && Array.isArray(p.linkedProjectIds)) {
        for (const id of p.linkedProjectIds) originIds.add(id);
      }
    }
    const rows: { project: Project; isLinkedOrigin: boolean }[] = [];
    // `rendered` protège des doublons si des données incohérentes plaçaient un
    // même projet dans deux placeholders (le backend ne l'interdit pas).
    const rendered = new Set<string>();
    for (const p of localProjects) {
      if (!showLinkedOrigins && originIds.has(p.id)) continue; // origine masquée
      if (!rendered.has(p.id)) {
        rows.push({ project: p, isLinkedOrigin: false });
        rendered.add(p.id);
      }
      // Origines regroupées : rendues juste sous leur placeholder.
      if (showLinkedOrigins && p.storage === "linked" && Array.isArray(p.linkedProjectIds)) {
        for (const subId of p.linkedProjectIds) {
          if (rendered.has(subId)) continue;
          const sub = localProjects.find((x) => x.id === subId);
          if (sub) {
            rows.push({ project: sub, isLinkedOrigin: true });
            rendered.add(subId);
          }
        }
      }
    }
    return rows;
  }, [localProjects, showLinkedOrigins]);

  const handleDeleteConfirm = (deleteFiles: boolean) => {
    if (projectToDelete) {
      onDeleteProject(projectToDelete, deleteFiles);
      setProjectToDelete(null);
    }
  };

  // ── Drag and drop ──
  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    // Set a transparent drag image so only the grip icon feedback is visible
    const el = e.currentTarget as HTMLElement;
    e.dataTransfer.setDragImage(el, 16, 8);
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragId !== null && id !== dragId) {
      setDragOverId(id);
    }
  };

  const handleDragEnd = () => {
    if (dragId !== null && dragOverId !== null && dragId !== dragOverId) {
      const fromIdx = visibleRows.findIndex((r) => r.project.id === dragId);
      const toIdx = visibleRows.findIndex((r) => r.project.id === dragOverId);
      if (fromIdx !== -1 && toIdx !== -1) {
        const newVisible = [...visibleRows];
        const [moved] = newVisible.splice(fromIdx, 1);
        newVisible.splice(toIdx, 0, moved);
        // Reconstruction de l'ordre complet : les projets masqués (absents des
        // lignes visibles, ex. origines cachées) conservent leur créneau, les
        // projets visibles prennent leur nouvel ordre relatif. Le backend
        // /reorder valide tous les ids, on lui renvoie donc la liste entière.
        const visibleIds = new Set(visibleRows.map((r) => r.project.id));
        let vi = 0;
        const reordered = localProjects.map((p) =>
          visibleIds.has(p.id) ? (newVisible[vi++]?.project ?? p) : p
        );
        setLocalProjects(reordered);
        // Persist the new order
        fetch("/api/projects/reorder", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectIds: reordered.map((p) => p.id) }),
        }).catch((err) => console.error("Failed to persist project order:", err));
      }
    }
    setDragId(null);
    setDragOverId(null);
  };

  // ── Project list vertical resize ──
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingProjects.current = true;
    startY.current = e.clientY;
    startHeight.current = projectListHeight;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isResizingProjects.current) return;
      const delta = ev.clientY - startY.current;
      const newHeight = Math.max(80, Math.min(600, startHeight.current + delta));
      setProjectListHeight(newHeight);
    };

    const handleMouseUp = () => {
      if (isResizingProjects.current) {
        isResizingProjects.current = false;
        localStorage.setItem("pi-web-project-list-height", String(projectListHeightRef.current));
      }
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [projectListHeight]);

  return (
    <aside className="h-full border-r border-hacker-border-bright sidebar-zone flex flex-col shrink-0 text-xs">
      {/* ── Projects ── */}
      <div className="p-2 pb-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-hacker-accent text-[10px] tracking-widest">{t('sidebar.projects')}</span>
          <button
            onClick={onAddProject}
            className="text-hacker-text-dim hover:text-hacker-accent text-[10px] leading-none"
            title={t('addProject.title')}
            aria-label={t('addProject.title')}
          >
            <Plus size={10} />
          </button>
        </div>

        <div className="space-y-0.5 overflow-y-auto" style={{ maxHeight: projectListHeight }}>
          {visibleRows.map(({ project: p, isLinkedOrigin }) => {
            const pState = projectSessions?.get(p.id);
            const isThisStreaming = pState?.isStreaming ?? false;
            const hasSession = !!pState?.session;
            const streamingStalled = isThisStreaming && pState?.lastEventAt
              // BUG-72 : seuil uniformisé avec le watchdog App.tsx (60s) — 30s
              // déclenchait des faux positifs pendant thinking/tool calls longs.
              ? Date.now() - pState.lastEventAt > 60_000
              : false;
            const isDragging = dragId === p.id;
            const isDragTarget = dragOverId === p.id;
            return (
              <div
                key={p.id}
                className={`flex items-center group ${
                  activeProject?.id === p.id
                    ? "bg-hacker-accent/10 border border-hacker-accent/30"
                    : isDragTarget
                    ? "bg-hacker-accent/5 border border-hacker-accent/20 border-dashed"
                    : "hover:bg-hacker-border/50 border border-transparent"
                } ${isDragging ? "opacity-40" : ""}`}
              >
                {/* Drag handle */}
                <div
                  draggable
                  onDragStart={(e) => handleDragStart(e, p.id)}
                  onDragOver={(e) => handleDragOver(e, p.id)}
                  onDragEnd={handleDragEnd}
                  className="px-1 py-1 cursor-grab active:cursor-grabbing text-hacker-text-dim/0 group-hover:text-hacker-text-dim/60 hover:!text-hacker-text-dim shrink-0"
                  title={t('sidebar.dragToReorder')}
                >
                  <GripVertical size={10} />
                </div>

                {/* Project button — sur un placeholder LIÉ, le clic (ou le clic
                    droit) ouvre aussi le menu contextuel de gestion. */}
                <button
                  onClick={(e) => {
                    onSelectProject(p);
                    if (p.storage === "linked") {
                      linkedMenuAnchorRef.current = e.currentTarget;
                      setLinkedMenuProject(p);
                    }
                  }}
                  onContextMenu={(e) => {
                    if (p.storage === "linked") {
                      e.preventDefault();
                      onSelectProject(p);
                      linkedMenuAnchorRef.current = e.currentTarget;
                      setLinkedMenuProject(p);
                    }
                  }}
                  title={p.storage === "linked" ? t('sidebar.linkedMenu.menuHint') : undefined}
                  className={`flex-1 text-left px-1.5 py-1 flex items-center gap-1.5 ${
                    isLinkedOrigin ? "pl-4" : ""
                  } ${
                    activeProject?.id === p.id
                      ? "text-hacker-accent"
                      : isLinkedOrigin
                      ? "text-hacker-text-dim/70"
                      : "text-hacker-text-dim"
                  }`}>
                  {isLinkedOrigin && (
                    <span className="shrink-0 text-hacker-text-dim/50" aria-hidden>↳</span>
                  )}
                  {p.storage === "linked" && (
                    <Link2 size={10} className="shrink-0 opacity-60" />
                  )}
                  <span className="truncate flex-1">{p.name}</span>
                  {isThisStreaming && !streamingStalled && (
                    <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-hacker-accent shrink-0" title={t('sidebar.streaming')} />
                  )}
                  {isThisStreaming && streamingStalled && (
                    <span className="w-1.5 h-1.5 rounded-full bg-hacker-warn shrink-0" title={t('sidebar.streamingStalled')} />
                  )}
                  {hasSession && !isThisStreaming && (
                    <span className="w-1.5 h-1.5 rounded-full bg-hacker-info/50 shrink-0" title={t('sidebar.sessionActive')} />
                  )}
                </button>

                {/* Delete button */}
                <button
                  onClick={(e) => { e.stopPropagation(); setProjectToDelete(p); }}
                  className="px-1 py-1 text-hacker-text-dim/0 group-hover:text-hacker-error/70 hover:!text-hacker-error transition-colors"
                  title={t('sidebar.deleteProject')}
                  aria-label={t('sidebar.deleteProject')}
                >
                  <Trash2 size={10} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Resize handle for project list */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="h-1 cursor-row-resize hover:bg-hacker-accent/30 active:bg-hacker-accent/50 transition-colors border-b border-hacker-border-bright"
        title={t('sidebar.resizeProjectList')}
      />

      {/* ── Git panel ── */}
      {activeProject && (activeProject.git?.remote || activeProject.storage === "linked") && (
        <GitPanel project={activeProject} onRefresh={onRefreshGit} />
      )}

      {/* ── Commands ── */}
      <div className="p-2 mt-auto border-t border-hacker-border-bright">
        <div className="text-hacker-accent text-[10px] tracking-widest mb-1.5">{t('sidebar.commands')}</div>
        <div className="flex flex-wrap gap-1">
          {[
            { cmd: "/new", tip: t('sidebar.commandTips.newSession') },
            { cmd: "/compact", tip: t('sidebar.commandTips.compactContext') },
            { cmd: "/clear", tip: t('sidebar.commandTips.clearScreen') },
            { cmd: "/review", tip: t('sidebar.commandTips.reviewMode') },
            { cmd: "/quit", tip: t('sidebar.commandTips.returnToHome') },
            { cmd: "/help", tip: t('sidebar.commandTips.showHelp') },
          ].map(({ cmd, tip }) => (
            <button
              key={cmd}
              onClick={() => cmd === "/new" ? setConfirmNewChat(true) : onSendCommand(cmd)}
              className="text-xs font-bold tracking-wider px-2 py-1 border border-hacker-border text-hacker-text-dim hover:border-hacker-accent/50 hover:text-hacker-accent hover:bg-hacker-accent/5 transition-colors rounded"
              title={tip}
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>

      {/* ── Version footer ── */}
      <div className="border-t border-hacker-border-bright bg-hacker-surface/50 flex flex-col shrink-0">
        <div className="flex items-center justify-between px-2 py-1 text-[10px] text-hacker-text-dim">
          <span>pi-web</span>
          <span className="text-hacker-text-dim/50">v{piWebVersion}</span>
        </div>
        <div className="flex items-center justify-between px-2 py-1 text-[10px] text-hacker-text-dim border-t border-hacker-border/30">
          <span>pi-agent</span>
          {updateAvailable ? (
            /* Mise à jour à chaud : clic → modale de confirmation (audit préalable
               recommandé). Le backend persiste le pin puis redémarre le container. */
            <button
              onClick={() => setUpdateModalOpen(true)}
              className="text-hacker-warn hover:text-hacker-warn/80 flex items-center gap-0.5 font-bold cursor-pointer"
            >
              <ArrowUpCircle size={10} />
              {piAgentLatest ? `→${piAgentLatest}` : t('sidebar.updateBadge')}
            </button>
          ) : (
            <span className="text-hacker-text-dim/50">v{piAgentVersion}</span>
          )}
        </div>
        {cbmInstalled && (
          <div className="flex items-center justify-between px-2 py-1 text-[10px] text-hacker-text-dim border-t border-hacker-border/30">
            <span>cbm</span>
            {cbmUpdateAvailable ? (
              <button
                onClick={handleCbmUpdate}
                disabled={cbmUpdating}
                className="text-hacker-warn hover:text-hacker-warn/80 flex items-center gap-0.5 font-bold"
                title={t('sidebar.updateCbm')}
              >
                <ArrowUpCircle size={10} />
                {cbmUpdating ? "..." : t('sidebar.update')}
              </button>
            ) : (
              <span className="text-hacker-text-dim/50">{cbmVersion ? `v${cbmVersion}` : "..."}</span>
            )}
          </div>
        )}
      </div>

      {/* ── Menu contextuel du placeholder lié (lier/délier + toggle origines) ── */}
      {linkedMenuProject && (
        <LinkedProjectMenu
          key={linkedMenuProject.id}
          project={linkedMenuProject}
          projects={projects}
          anchor={linkedMenuAnchorRef.current}
          onClose={() => setLinkedMenuProject(null)}
          onProjectsChanged={onProjectsChanged}
          showOrigins={showLinkedOrigins}
          onToggleShowOrigins={toggleShowLinkedOrigins}
        />
      )}

      {/* ── Delete project modal ── */}
      <DeleteProjectModal
        project={projectToDelete}
        onClose={() => setProjectToDelete(null)}
        onConfirm={handleDeleteConfirm}
      />

      {/* ── New conversation confirmation modal (/new) ── */}
      <NewChatConfirmModal
        open={confirmNewChat}
        onClose={() => setConfirmNewChat(false)}
        onConfirm={() => { setConfirmNewChat(false); onSendCommand("/new"); }}
      />

      {/* ── Mise à jour à chaud du SDK pi-agent ── */}
      <UpdateAgentModal
        open={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        latestVersion={piAgentLatest}
        currentVersion={piAgentCurrent || piAgentVersion}
      />
    </aside>
  );
}