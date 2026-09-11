import {
  Plus,
  ArrowUpCircle,
} from "lucide-react";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { GitPanel } from "./GitPanel";
import { LinkedProjectMenu } from "./LinkedProjectMenu";
import { ProjectSwitcher, SessionDots, type ProjectSessionInfo } from "./ProjectSwitcher";
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
  projectSessions?: Map<string, ProjectSessionInfo>;
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

  // ── Placeholder lié : masquage des origines (option A) ──
  // Les sous-projets regroupés dans un placeholder LIÉ sont masqués par défaut
  // dans la section compacte ; le toggle du menu contextuel les ré-affiche.
  // Persistance : clé "pi-web.hide-linked-origins" — la valeur est le flag de
  // MASQUAGE (true/absent = masqué, "false" = affiché), en cohérence avec son
  // nom.
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

  // Ouverture du menu de gestion lié depuis le ProjectSwitcher (bouton lien
  // du projet LIÉ actif) — remplace l'ancien clic sur la ligne du placeholder.
  const handleOpenLinkedMenu = useCallback((p: Project, anchor: HTMLElement) => {
    linkedMenuAnchorRef.current = anchor;
    setLinkedMenuProject(p);
  }, []);

  // ── Sous-projets du placeholder LIÉ actif (section compacte) ──
  // Le regroupement existant est préservé : seules les origines du projet
  // courant sont listées sous le bloc (plus d'arbre complet des autres
  // projets — tous restent accessibles via le dropdown du ProjectSwitcher).
  // Le filtrage option A s'applique : masquées par défaut, ré-affichées via
  // le toggle pi-web.hide-linked-origins du LinkedProjectMenu.
  const linkedSubProjects = useMemo(() => {
    if (!activeProject || activeProject.storage !== "linked" || !Array.isArray(activeProject.linkedProjectIds)) return [];
    return activeProject.linkedProjectIds
      .map((id) => projects.find((p) => p.id === id))
      .filter((p): p is Project => !!p);
  }, [activeProject, projects]);

  const handleDeleteConfirm = (deleteFiles: boolean) => {
    if (projectToDelete) {
      onDeleteProject(projectToDelete, deleteFiles);
      setProjectToDelete(null);
    }
  };

  return (
    <aside className="h-full border-r border-hacker-border-bright sidebar-zone flex flex-col shrink-0 text-xs">
      {/* ── Projet actuel + sélecteur ── */}
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

        {/* Bloc « projet actuel » + dropdown de sélection (tous les projets).
            Les sessions des autres projets continuent de tourner en parallèle :
            ce sélecteur ne change que le projet affiché (backend/WS inchangés). */}
        <ProjectSwitcher
          projects={projects}
          activeProject={activeProject}
          projectSessions={projectSessions}
          onSelectProject={onSelectProject}
          onDeleteProject={setProjectToDelete}
          onOpenLinkedMenu={handleOpenLinkedMenu}
        />

        {/* ── Sous-projets linkés du projet actuel (compact) ── */}
        {/* Affichés uniquement quand le toggle origines est actif
            (pi-web.hide-linked-origins = "false") — filtrage option A préservé. */}
        {showLinkedOrigins && linkedSubProjects.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {linkedSubProjects.map((sub) => (
              <button
                key={sub.id}
                onClick={() => onSelectProject(sub)}
                className={`w-full flex items-center gap-1.5 pl-4 pr-1.5 py-1 text-left border border-transparent hover:bg-hacker-border/50 ${
                  activeProject?.id === sub.id ? "text-hacker-accent" : "text-hacker-text-dim/70"
                }`}
              >
                <span className="shrink-0 text-hacker-text-dim/50" aria-hidden>↳</span>
                <span className="truncate flex-1">{sub.name}</span>
                <SessionDots state={projectSessions?.get(sub.id)} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Git panel ── */}
      {activeProject && (activeProject.git?.remote || activeProject.storage === "linked") && (
        <GitPanel project={activeProject} linkedProjects={linkedSubProjects} onRefresh={onRefreshGit} />
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