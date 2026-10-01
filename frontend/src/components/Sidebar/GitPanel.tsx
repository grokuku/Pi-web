import { useState, useEffect, useCallback, useRef } from "react";
import { PlusSquare } from "lucide-react";
import { HolafIcon } from "../icons/HolafIcon";
import type { Project } from "../../types";
import { CommitPushModal } from "../Modals/CommitPushModal";
import { GitAuthModal } from "../Modals/GitAuthModal";
import { useTranslation, type TFunction } from "../../i18n";
import { parseJsonResponse } from "../../utils/api";

// ── Libellés i18n pré-traduits pour parseJsonResponse ──
// (le helper utils n'a pas accès au hook useTranslation : on lui passe des
// libellés déjà résolus, cf. git.sessionExpired / git.serverError)
function apiErrorLabels(t: TFunction) {
  return {
    sessionExpired: t("git.sessionExpired"),
    serverError: (status: number) => t("git.serverError", status),
  };
}

interface GitStatusFull {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  deleted: string[];
  created: string[];
  conflict: string[];
  files: Array<{ path: string; status: string }>;
  isClean: boolean;
}

interface GitStatusNotRepo {
  notRepo: true;
  isEmpty: boolean;
}

type GitStatus = GitStatusFull | GitStatusNotRepo;

type ActionType = "pull" | "push" | "commit-push" | "clone" | "init";

// ── Auto-dépliage : état voulu d'une section pour un statut donné ──
// dirty (arbre de travail non propre) → déplié ; clean → replié.
// Un dépôt pas encore cloné (notRepo) est déplié aussi : sinon le bouton
// « Cloner » resterait caché derrière une ligne compacte sans action visible.
function autoExpandFor(status: GitStatus | undefined): boolean {
  if (!status) return false;
  if ("notRepo" in status) return true;
  return !status.isClean;
}

// ── Badge replié des modifications : ~N +M −K (+ ✓N staged / !N conflits) ──
// Ne liste que les compteurs non nuls pour rester compact.
function changeParts(s: GitStatusFull): string[] {
  const parts: string[] = [];
  if (s.modified.length) parts.push(`~${s.modified.length}`);
  if (s.created.length) parts.push(`+${s.created.length}`);
  if (s.deleted.length) parts.push(`−${s.deleted.length}`);
  if (s.staged.length) parts.push(`✓${s.staged.length}`);
  if (s.conflict.length) parts.push(`!${s.conflict.length}`);
  return parts;
}

// ── Badges d'état de la ligne compacte (branche exclue) ──
// dirty → ambre (~N +M…) · clean → vert (✓) · ahead → accent (↑K) ·
// behind → ambre (↓K) ; les badges coexistent si pertinent.
function CompactStateBadges({ status, t }: { status: GitStatus | null; t: TFunction }) {
  if (!status) return null;

  if ("notRepo" in status) {
    return (
      <span
        className="text-hacker-text-dim text-[0.6875rem] border border-hacker-border bg-hacker-bg/30 px-1 rounded font-mono shrink-0"
        title={t("gitPanel.notRepo")}
      >
        ∅
      </span>
    );
  }

  const parts = changeParts(status);
  return (
    <>
      {parts.length > 0 ? (
        <span
          className="text-hacker-warn text-[0.6875rem] border border-hacker-warn/40 bg-hacker-warn/5 px-1 rounded font-mono shrink-0"
          title={t("gitPanel.workingChanges")}
        >
          {parts.join(" ")}
        </span>
      ) : (
        <span
          className="text-hacker-accent text-[0.6875rem] border border-hacker-accent/40 bg-hacker-accent/5 px-1 rounded font-mono shrink-0"
          title={t("gitPanel.upToDate")}
        >
          ✓
        </span>
      )}
      {status.ahead > 0 && (
        <span
          className="text-hacker-accent text-[0.6875rem] border border-hacker-accent/40 px-1 rounded font-mono shrink-0"
          title={t("gitPanel.ahead", status.ahead)}
        >
          ↑{status.ahead}
        </span>
      )}
      {status.behind > 0 && (
        <span
          className="text-hacker-warn text-[0.6875rem] border border-hacker-warn/40 px-1 rounded font-mono shrink-0"
          title={t("gitPanel.behind", status.behind)}
        >
          ↓{status.behind}
        </span>
      )}
    </>
  );
}

// ── GitProjectSection : section git d'UN projet (réutilisable) ──
// Ligne compacte (chevron + nom + badge branche cyan + badges d'état) qui
// sert de toggle manuel, et détail au dépliage (meta, trio, fichiers, actions).
// Le statut est chargé au montage (pour les badges + l'auto-dépliage), au
// dépliage et à chaque refreshKey incrémenté par le parent (⟳ manuel, fins
// d'activité de l'agent sur pi_event, retour au premier plan). Le polling 30 s
// ne concerne que le projet principal.
function GitProjectSection({
  project,
  isMain,
  isOpen,
  onToggle,
  onStatusChange,
  onLoadingChange,
  activeProjectId,
  refreshKey,
}: {
  project: Project;
  isMain: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onStatusChange: (status: GitStatus) => void;
  // Remonte l'état de chargement au parent : le spinner ⟳ reflète ainsi un
  // chargement RÉEL (et s'arrête à la fin), quel qu'en soit le déclencheur.
  onLoadingChange: (projectId: string, loading: boolean) => void;
  // Projet AFFICHÉ (session active) : cible du résumé de push injecté dans le chat.
  // = projet du GitPanel (placeholder lié) pour une section LIÉE, = projet sinon.
  activeProjectId: string;
  refreshKey: number;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<ActionType | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState<{ subject: string; body: string } | null>(null);
  const [pendingAuthAction, setPendingAuthAction] = useState<{ url: string; action: ActionType } | null>(null);
  const [showPushModal, setShowPushModal] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!project.git?.remote) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.id}/git/status`);
      // Blindage : parseJsonResponse lève une erreur lisible si la réponse
      // est du HTML (page de login Authentik) au lieu du JSON attendu.
      const data: GitStatus = await parseJsonResponse<GitStatus>(res, apiErrorLabels(t));
      setStatus(data);
      setLastFetchedAt(new Date().toISOString());
      // Remonte le statut au parent : badges + auto-dépliage (dirty→déplié).
      onStatusChange(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [project.id, project.git?.remote, t, onStatusChange]);

  // Réf toujours à jour vers fetchStatus : les effets/interval ne capturent
  // ainsi jamais une ancienne closure (changement de langue, etc.).
  const fetchRef = useRef(fetchStatus);
  useEffect(() => { fetchRef.current = fetchStatus; });

  // Notifie le parent à chaque transition de chargement (et à l'unmount) :
  // le parent compte les sections en vol pour le spinner ⟳.
  useEffect(() => {
    onLoadingChange(project.id, loading);
    return () => onLoadingChange(project.id, false);
  }, [onLoadingChange, project.id, loading]);

  // Seed au montage : renseigne le badge d'état et permet l'auto-dépliage,
  // y compris pour une section repliée (une seule requête, aucun polling).
  useEffect(() => {
    fetchRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dépliage (manuel ou auto) et refreshKey (⟳ manuel, événements, focus) :
  // refait un statut. On compare au refreshKey PRÉCÉDENT (et non à 0) pour ne
  // pas doubler le seed au montage quand le parent a déjà rafraîchi.
  // Un dépliage AUTO (statut dirty reçu) suit un fetch frais : inutile de
  // refetch. Seul un clic utilisateur sur la ligne justifie un refetch à
  // l'ouverture (fraîcheur demandée explicitement).
  const wasOpen = useRef(isOpen);
  const lastRefreshKey = useRef(refreshKey);
  const userToggledRef = useRef(false);
  useEffect(() => {
    const justOpened = isOpen && !wasOpen.current;
    wasOpen.current = isOpen;
    const userToggled = userToggledRef.current;
    userToggledRef.current = false;
    const refreshTriggered = refreshKey !== lastRefreshKey.current;
    lastRefreshKey.current = refreshKey;
    if (refreshTriggered || (justOpened && userToggled)) fetchRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, refreshKey]);

  // Polling 30 s : projet principal uniquement (comportement historique),
  // suspendu tant que l'onglet est caché (sonder un UI invisible est inutile ;
  // le retour au premier plan déclenche déjà un refetch côté parent).
  useEffect(() => {
    if (!isMain) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      fetchRef.current();
    }, 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMain]);

  const doAction = async (action: ActionType, url: string) => {
    setActionLoading(action);
    setError("");
    setMessage("");
    setCommitMessage(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await parseJsonResponse<any>(res, apiErrorLabels(t));

      if (action === "commit-push") {
        if (data.commitMessage) {
          setCommitMessage(data.commitMessage);
        }
        const parts: string[] = [];
        if (data.staged) parts.push(`${data.staged} staged`);
        if (data.commitResult) parts.push(data.commitResult);
        if (data.pushResult) parts.push(data.pushResult);
        setMessage(parts.join(" → ") || "Done");
      } else {
        setMessage(data.result || `${action} successful`);
      }

      await fetchStatus();
    } catch (err: any) {
      if (err?.data?.code === "GIT_AUTH_REQUIRED") {
        setPendingAuthAction({ url, action });
        setShowAuthModal(true);
        return;
      }
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  // Projet sans dépôt distant configuré : rien à afficher.
  if (!project.git?.remote) return null;

  const isNotRepo = !!status && "notRepo" in status;
  const dirIsEmpty = isNotRepo && !!(status as GitStatusNotRepo).isEmpty;
  const normalStatus = status && !("notRepo" in status) ? (status as GitStatusFull) : null;

  // Branche affichée dans le badge de la ligne compacte.
  const branchBadge = isNotRepo
    ? project.git.branch || "main"
    : normalStatus?.branch || project.git.branch || "…";

  // Dépôt distant affiché en clair (sans schéma ni .git).
  const remoteShort = project.git.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "");

  // Fraîcheur du statut affiché (moment de la dernière réponse /git/status).
  const freshness = lastFetchedAt ? (
    <span
      className="text-hacker-text-dim text-[0.6875rem] flex items-center gap-1 shrink-0"
      title={t("gitPanel.lastFetch")}
    >
      <HolafIcon name="clock" size={9} />
      {formatTimeAgo(lastFetchedAt, t)}
    </span>
  ) : null;

  // ── Ligne compacte : chevron + nom + badge branche (cyan) + badges d'état ──
  const header = (
    <div
      onClick={() => {
        // Marque l'ouverture comme pilotée par l'utilisateur (refetch au
        // dépliage) — à l'inverse de l'auto-dépliage consécutif à un statut.
        userToggledRef.current = true;
        onToggle();
      }}
      role="button"
      title={isOpen ? t("gitPanel.collapseSection") : t("gitPanel.expandSection")}
      className="flex items-center gap-1.5 group cursor-pointer hover:bg-hacker-border/40 mt-1 py-1 px-1 rounded transition-colors select-none"
    >
      {isOpen ? (
        <HolafIcon name="chevron-down" size={12} className="shrink-0 text-hacker-accent" />
      ) : (
        <HolafIcon name="chevron-right" size={12} className="shrink-0 text-hacker-text-dim group-hover:text-hacker-accent" />
      )}
      <span className="truncate flex-1 font-bold tracking-wide text-hacker-accent text-[0.75rem]">
        {project.name}
      </span>
      <span className="text-hacker-info text-[0.6875rem] border border-hacker-border bg-hacker-bg/30 px-1 rounded font-mono max-w-[90px] truncate shrink-0">
        <HolafIcon name="git-branch" size={9} className="inline mr-0.5 -mt-0.5" />
        {branchBadge}
      </span>
      <CompactStateBadges status={status} t={t} />
      {/* Échec de chargement : indicateur visible MÊME replié — sinon un seed
          en échec (ex. NetworkError INFRA-01) restait totalement silencieux.
          Le retry est automatique (prochain pi_event / retour au premier plan)
          ou via le ⟳ du panneau. */}
      {!isOpen && error && (
        <span
          className="text-hacker-error flex items-center shrink-0"
          title={error}
          aria-label={t("gitPanel.fetchError")}
        >
          <HolafIcon name="alert-triangle" size={10} />
        </span>
      )}
    </div>
  );

  if (!isOpen) {
    return <>{header}</>;
  }

  // ── Contenu (section DÉPLIÉE) ──
  return (
    <>
      {header}

      {loading && !status && (
        <div className="text-hacker-text-dim italic text-[0.75rem] flex items-center gap-1 px-1">
          <HolafIcon name="refresh" size={10} className="animate-spin" />
          {t("gitPanel.loading")}
        </div>
      )}

      {error && (
        <div className="text-hacker-error text-[0.75rem] mb-1.5 px-1 flex items-center gap-1">
          <HolafIcon name="alert-triangle" size={10} />
          {error}
        </div>
      )}

      {message && (
        <div className="text-hacker-accent text-[0.75rem] mb-1.5 px-1 flex items-center gap-1">
          <HolafIcon name="check" size={10} />
          {message}
        </div>
      )}

      {/* ── Not a repo yet : meta (remote + fraîcheur) puis clone/init ── */}
      {isNotRepo && (
        <div className="space-y-2 px-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-hacker-text-bright text-[0.6875rem] truncate" title={project.git.remote}>
              {remoteShort}
            </span>
            {freshness}
          </div>

          {dirIsEmpty ? (
            <>
              <div className="text-hacker-text-dim text-[0.75rem] flex items-center gap-1">
                <HolafIcon name="download" size={10} />
                {t("gitPanel.dirEmpty")}
              </div>
              <button
                onClick={() => doAction("clone", `/api/projects/${project.id}/git/clone`)}
                disabled={actionLoading !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-accent/50 text-hacker-accent text-[0.75rem] hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
              >
                {actionLoading === "clone" ? (
                  <HolafIcon name="refresh" size={10} className="animate-spin" />
                ) : (
                  <HolafIcon name="download" size={12} />
                )}
                {t("gitPanel.cloneRepo")}
              </button>
            </>
          ) : (
            <>
              <div className="text-hacker-warn text-[0.75rem] flex items-start gap-1 bg-hacker-bg/30 border border-hacker-warn/20 p-1.5">
                <HolafIcon name="alert-triangle" size={10} className="shrink-0 mt-0.5" />
                <span>{t("gitPanel.dirNotEmpty")}</span>
              </div>
              <button
                onClick={() => doAction("init", `/api/projects/${project.id}/git/init`)}
                disabled={actionLoading !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-border text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent text-[0.75rem] transition-colors disabled:opacity-40"
              >
                {actionLoading === "init" ? (
                  <HolafIcon name="refresh" size={10} className="animate-spin" />
                ) : (
                  <PlusSquare size={12} />
                )}
                {t("gitPanel.gitInitRemote")}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Normal repo ── */}
      {normalStatus && (
        <div className="space-y-1.5 px-1">
          {/* meta : remote (tronqué) + fraîcheur sur une seule ligne */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-hacker-text-bright text-[0.6875rem] truncate" title={project.git.remote}>
              {remoteShort}
            </span>
            {freshness}
          </div>

          {/* trio ~N +M −K (+ staged/conflits si présents) */}
          {!normalStatus.isClean && (
            <div className="flex items-center gap-2 text-[0.75rem] font-mono">
              <span className="text-hacker-warn" title={t("gitPanel.modified", normalStatus.modified.length)}>
                ~{normalStatus.modified.length}
              </span>
              <span className="text-hacker-info" title={t("gitPanel.created", normalStatus.created.length)}>
                +{normalStatus.created.length}
              </span>
              <span className="text-hacker-error" title={t("gitPanel.deleted", normalStatus.deleted.length)}>
                −{normalStatus.deleted.length}
              </span>
              {normalStatus.staged.length > 0 && (
                <span className="text-hacker-accent" title={t("gitPanel.staged", normalStatus.staged.length)}>
                  ✓{normalStatus.staged.length}
                </span>
              )}
              {normalStatus.conflict.length > 0 && (
                <span className="text-hacker-error font-bold" title={t("gitPanel.conflicts", normalStatus.conflict.length)}>
                  !{normalStatus.conflict.length}
                </span>
              )}
            </div>
          )}

          {(normalStatus.ahead > 0 || normalStatus.behind > 0) && (
            <div className="flex items-center gap-2">
              {normalStatus.behind > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-warn text-[0.75rem]">
                  <HolafIcon name="arrow-down" size={10} />
                  {t("gitPanel.behind", normalStatus.behind)}
                </span>
              )}
              {normalStatus.ahead > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-accent text-[0.75rem]">
                  <HolafIcon name="arrow-up" size={10} />
                  {t("gitPanel.ahead", normalStatus.ahead)}
                </span>
              )}
            </div>
          )}

          {/* liste des fichiers modifiés (max-height) */}
          {!normalStatus.isClean && (
            <div className="text-[0.75rem] bg-hacker-bg/30 border border-hacker-border p-1.5">
              <div className="max-h-[60px] overflow-y-auto">
                {normalStatus.files.slice(0, 5).map((f) => (
                  <div key={f.path} className="flex gap-1 text-hacker-text-dim/70 truncate">
                    <span className="text-hacker-accent text-[0.6875rem] w-5 shrink-0">{f.status}</span>
                    <span className="truncate">{f.path}</span>
                  </div>
                ))}
                {normalStatus.files.length > 5 && (
                  <div className="text-hacker-text-dim/50">
                    {t("gitPanel.filesMore", normalStatus.files.length - 5)}
                  </div>
                )}
              </div>
            </div>
          )}

          {normalStatus.isClean && normalStatus.ahead === 0 && normalStatus.behind === 0 && (
            <div className="text-hacker-text-dim text-[0.75rem] flex items-center gap-1">
              <HolafIcon name="check" size={10} className="text-hacker-accent" />
              {t("gitPanel.upToDate")}
            </div>
          )}

          {/* Commit message preview */}
          {commitMessage && (
            <div className="mt-1 text-[0.6875rem] bg-hacker-bg/30 border border-hacker-accent/20 p-1.5">
              <div className="text-hacker-accent font-bold mb-0.5">🚀 {commitMessage.subject}</div>
              {commitMessage.body && (
                <div className="text-hacker-text-dim whitespace-pre-wrap mt-0.5">{commitMessage.body}</div>
              )}
            </div>
          )}

          <div className="flex gap-1 pt-1">
            <button
              onClick={() => doAction("pull", `/api/projects/${project.id}/git/pull`)}
              disabled={actionLoading !== null}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-border text-[0.75rem] text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent transition-colors disabled:opacity-40"
              title="git pull"
            >
              {actionLoading === "pull" ? (
                <HolafIcon name="refresh" size={10} className="animate-spin" />
              ) : (
                <HolafIcon name="arrow-down" size={10} />
              )}
              {t("gitPanel.pull")}
            </button>
            <button
              onClick={() => setShowPushModal(true)}
              disabled={actionLoading !== null}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-accent/50 text-[0.75rem] text-hacker-accent hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
              title={t("gitPanel.pushTitle")}
            >
              {actionLoading === "commit-push" ? (
                <HolafIcon name="refresh" size={10} className="animate-spin" />
              ) : (
                <HolafIcon name="arrow-up" size={10} />
              )}
              {t("gitPanel.push")}
            </button>
          </div>
        </div>
      )}

      {/* ── Push modal (CE projectId) ── */}
      {showPushModal && (
        <CommitPushModal
          project={project}
          notifyProjectId={activeProjectId}
          onClose={() => setShowPushModal(false)}
          onDone={() => {
            fetchStatus();
            setTimeout(() => setShowPushModal(false), 1200);
          }}
        />
      )}

      {/* ── Auth modal ── */}
      {showAuthModal && (
        <GitAuthModal
          project={project}
          onClose={() => setShowAuthModal(false)}
          onConfigured={() => {
            setShowAuthModal(false);
            setError("");
            if (pendingAuthAction) {
              const { url, action } = pendingAuthAction;
              setPendingAuthAction(null);
              doAction(action, url);
            } else {
              fetchStatus();
            }
          }}
        />
      )}
    </>
  );
}

function formatTimeAgo(iso: string, t: TFunction): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t("gitPanel.timeNow");
  if (mins < 60) return t("gitPanel.timeMin", mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("gitPanel.timeHour", hours);
  const days = Math.floor(hours / 24);
  return t("gitPanel.timeDay", days);
}

interface Props {
  project: Project;
  // Projets LIÉS du projet actif (résolus par la Sidebar) — une section
  // accordéon par projet, statut rafraîchi par événements (pi_event) et au
  // retour au premier plan, sans polling périodique propre.
  linkedProjects?: Project[];
  onRefresh?: () => void;
  // Abonnement WS fourni par App (même contrat que FileExplorer) : sert à
  // refetch les statuts sur les fins d'activité de l'agent (pi_event).
  on?: (type: string, cb: (msg: any) => void) => () => void;
}

// Clé sessionStorage versionnée : contient désormais les OVERRIDES manuels
// (par projectId) et non plus l'état brut d'accordéon de l'ancien refactor.
const EXPANDED_KEY = "pi-web.gitpanel.expanded.v2";
const LEGACY_EXPANDED_KEY = "pi-web.gitpanel.expanded";

function loadOverrides(): Record<string, boolean> {
  try {
    // Purge l'ancienne clé (état brut) pour éviter toute confusion de schéma.
    sessionStorage.removeItem(LEGACY_EXPANDED_KEY);
    const raw = sessionStorage.getItem(EXPANDED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Ne restaure QUE les overrides « déplié » (true) : un « replié » (false)
    // écrit par une version antérieure masquerait un projet dirty après un F5
    // (cf. règle de persistance ci-dessous).
    const restored: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (value === true) restored[id] = true;
    }
    return restored;
  } catch {
    return {};
  }
}

// Fenêtre de coalescing des rafales de pi_event (fin de tour / fin de run) :
// un seul refetch par rafale.
const REFRESH_COALESCE_MS = 1200;

export function GitPanel({ project, linkedProjects = [], onRefresh, on }: Props) {
  const { t } = useTranslation();
  const [refreshKey, setRefreshKey] = useState(0);
  const [showPushAllModal, setShowPushAllModal] = useState(false);

  // ── Sections en chargement (ids projet) : le spinner ⟳ de l'en-tête reflète
  // un chargement RÉEL au lieu de rester bloqué sur « refreshKey > 0 » ──
  const loadingIdsRef = useRef<Set<string>>(new Set());
  const [isAnySectionLoading, setIsAnySectionLoading] = useState(false);
  const handleLoadingChange = useCallback((projectId: string, loading: boolean) => {
    const ids = loadingIdsRef.current;
    if (loading) ids.add(projectId);
    else ids.delete(projectId);
    setIsAnySectionLoading(ids.size > 0);
  }, []);

  // Un projet LIÉ est un placeholder (dossier de symlinks), PAS un dépôt git
  // indépendant. Sa « section principale » ne doit jamais être rendue comme
  // une section git pushable : son bouton Push passerait le placeholder au
  // backend (storage === "linked") qui déclencherait alors le mode agrégateur
  // et pousserait TOUS les sous-projets au lieu du seul visé. On ne montre donc
  // que les sections individuelles des sous-projets (projectId = sous-projet
  // réel) + le bouton « Push All » (sur le placeholder).
  const mainHasRepo = !!project.git?.remote && project.storage !== "linked";

  // ── Statuts connus (remontés par les sections) : badges + auto-dépliage ──
  const [statuses, setStatuses] = useState<Record<string, GitStatus>>({});
  // ── Overrides manuels (clic utilisateur), mémorisés en sessionStorage ──
  const [overrides, setOverrides] = useState<Record<string, boolean>>(loadOverrides);
  // Dernière catégorie (autoExpandFor) vue par projet : détecte dirty↔clean.
  const prevAutoRef = useRef<Record<string, boolean>>({});

  // ── Persistance des overrides (règle du correctif 3) ──
  // 1) Un override est purgé dès que la catégorie auto change (dirty↔clean),
  //    dans handleStatusChange ci-dessous : la section reprend l'auto-dépliage
  //    du nouvel état. Un dirty après une parenthèse clean se déplie donc à
  //    nouveau, même si l'utilisateur l'avait pliée pendant l'épisode dirty
  //    précédent.
  // 2) Seuls les overrides « DÉPLIÉ » (true) sont persistés en sessionStorage.
  //    Un « replié » (false) est une intention ponctuelle pour la session en
  //    cours : s'il survivait à un F5 alors que le projet est (re)devenu dirty,
  //    la section resterait repliée à vie — le bug à éviter. En mémoire, le pli
  //    manuel reste respecté tant que la catégorie ne change pas.
  useEffect(() => {
    try {
      const persisted: Record<string, boolean> = {};
      for (const [id, expanded] of Object.entries(overrides)) {
        if (expanded) persisted[id] = true;
      }
      sessionStorage.setItem(EXPANDED_KEY, JSON.stringify(persisted));
    } catch {}
  }, [overrides]);

  // Rapport de statut d'une section : met à jour les badges, et purge
  // l'override quand le projet change de catégorie (dirty↔clean). Sans purge,
  // le polling/refresh ré-ouvrirait ou refermerait la section sous les yeux de
  // l'utilisateur ; avec, un dirty APRÈS une parenthèse clean se déplie à
  // nouveau (règle 1 documentée avec la persistance ci-dessus).
  const handleStatusChange = useCallback((id: string, status: GitStatus) => {
    setStatuses((prev) => ({ ...prev, [id]: status }));
    const auto = autoExpandFor(status);
    const prevAuto = prevAutoRef.current[id];
    if (prevAuto !== undefined && prevAuto !== auto) {
      setOverrides((prev) => {
        if (prev[id] === undefined) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    prevAutoRef.current[id] = auto;
  }, []);

  // État voulu : override manuel s'il existe, sinon auto (dirty → déplié).
  const isExpanded = (id: string) =>
    overrides[id] !== undefined ? overrides[id] : autoExpandFor(statuses[id]);

  const toggleSection = (id: string) => {
    setOverrides((prev) => ({ ...prev, [id]: !isExpanded(id) }));
  };

  // Refetch des STATUTS uniquement (aucun git/sync, aucun rechargement de la
  // liste des projets) : chaque section re-teste son statut et réapplique
  // l'auto (celles sans override actif).
  const refreshSections = useCallback(() => setRefreshKey((k) => k + 1), []);

  // ── Rafales : les fins d'activité émettent plusieurs pi_event rapprochés
  // (turn_end puis agent_end puis agent_settled) → UN SEUL refetch par rafale.
  // Dé-bounce « trailing » : chaque nouvel événement repousse l'échéance, donc
  // aucun refetch pendant le streaming (uniquement à la fin) et un seul pour
  // des événements groupés. Pas de polling propre aux sections liées. ──
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefreshSections = useCallback(() => {
    if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refreshSections();
    }, REFRESH_COALESCE_MS);
  }, [refreshSections]);

  // Nettoyage du timer de coalescing au démontage.
  useEffect(() => () => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // ── TEMPS RÉEL : refetch sur les fins d'ACTIVITÉ de l'agent (pi_event) ──
  // Un workspace LIÉ est une session ouverte sur le projet PLACEHOLDER : les
  // frames pi_event portent le projectId du placeholder, PAS celui des
  // sous-projets. On filtre donc sur project.id et on refetch TOUTES les
  // sections affichées (impossible de rattacher le changement à un sous-projet).
  // Écoutés uniquement : turn_end (fin de tour), agent_end et agent_settled
  // (VRAIE fin du run, BUG-72) — jamais les chunks de streaming.
  useEffect(() => {
    if (!on) return;
    const unsub = on("pi_event", (msg: any) => {
      if (msg?.projectId !== project.id) return;
      const type = msg?.event?.type;
      if (type === "turn_end" || type === "agent_end" || type === "agent_settled") {
        scheduleRefreshSections();
      }
    });
    return () => unsub();
  }, [on, project.id, scheduleRefreshSections]);

  // ── Filet de sécurité peu coûteux : au retour au premier plan (onglet
  // redevenu visible) ou au focus fenêtre — le WS a pu manquer des frames
  // pendant l'arrière-plan, et un seed en échec doit pouvoir réessayer.
  // Passe par le même dé-bounce (visible + focus rapprochés = un seul refetch).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") scheduleRefreshSections();
    };
    const onFocus = () => scheduleRefreshSections();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [scheduleRefreshSections]);

  const refreshAll = () => {
    // ⟳ manuel : annule un refetch automatique en attente pour ne pas doubler
    // les requêtes, puis incrémente la clé (chaque section re-teste son statut
    // et réapplique l'auto, celles sans override actif) + git/sync des projets.
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setRefreshKey((k) => k + 1);
    onRefresh?.();
  };

  // Icône provider : le placeholder lié n'a pas de remote → icône lien.
  const providerIcon = mainHasRepo
    ? project.git!.provider === "github" ? "🐙" : project.git!.provider === "gitlab" ? "🦊" : "📦"
    : "🔗";

  const hasAnySection = mainHasRepo || linkedProjects.length > 0;

  return (
    <div className="p-2 border-b border-hacker-border">
      {/* En-tête global du panel : GIT + refresh (rafraîchit toutes les sections) */}
      <div className="text-hacker-accent text-[0.75rem] tracking-widest mb-1 flex items-center gap-1">
        <HolafIcon name="git-branch" size={12} />
        GIT {providerIcon}
        <div className="flex-1" />
        <button
          onClick={refreshAll}
          className="text-hacker-text-dim hover:text-hacker-accent transition-colors"
          title={t('gitPanel.refresh')}
        >
          <HolafIcon name="refresh" size={10} className={isAnySectionLoading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* ── Section du projet principal (même présentation, polling 30 s) ── */}
      {mainHasRepo && (
        <GitProjectSection
          key={project.id}
          project={project}
          isMain
          isOpen={isExpanded(project.id)}
          onToggle={() => toggleSection(project.id)}
          onStatusChange={(s) => handleStatusChange(project.id, s)}
          onLoadingChange={handleLoadingChange}
          activeProjectId={project.id}
          refreshKey={refreshKey}
        />
      )}

      {/* ── Une section accordéon par projet LIÉ (compacte par défaut) ── */}
      {linkedProjects.length > 0 && (
        <>
          <div className="mt-1.5 text-hacker-text-dim text-[0.625rem] tracking-widest uppercase mb-0.5 flex items-center gap-1">
            <HolafIcon name="link" size={9} />
            {t('gitPanel.linkedProjects')}
          </div>
          {linkedProjects.map((lp) => (
            <GitProjectSection
              key={lp.id}
              project={lp}
              isMain={false}
              isOpen={isExpanded(lp.id)}
              onToggle={() => toggleSection(lp.id)}
              onStatusChange={(s) => handleStatusChange(lp.id, s)}
              onLoadingChange={handleLoadingChange}
              activeProjectId={project.id}
              refreshKey={refreshKey}
            />
          ))}

          {/* ── Push ALL (en bas) : un commit + push pour CHAQUE projet lié ──
              Réutilise le CommitPushModal du placeholder : le backend détecte
              storage === "linked" et pousse chaque sous-projet séparément. */}
          <div className="pt-1.5">
            <button
              onClick={() => setShowPushAllModal(true)}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-accent/50 text-[0.75rem] text-hacker-accent hover:bg-hacker-accent/10 transition-colors"
              title={t('commitPush.linkedPushAll')}
            >
              <HolafIcon name="arrow-up" size={12} />
              {t('gitPanel.pushAll')}
            </button>
          </div>
        </>
      )}

      {/* Cas limite : placeholder sans lien résolu → note discrète */}
      {!hasAnySection && (
        <div className="text-hacker-text-dim text-[0.6875rem] italic flex items-start gap-1">
          <HolafIcon name="alert-triangle" size={10} className="shrink-0 mt-0.5" />
          <span>{t('gitPanel.emptyLinked')}</span>
        </div>
      )}

      {/* ── Push ALL modal (sur le placeholder : couvre tous les sous-projets) ── */}
      {showPushAllModal && (
        <CommitPushModal
          project={project}
          onClose={() => setShowPushAllModal(false)}
          onDone={() => {
            refreshAll();
            setTimeout(() => setShowPushAllModal(false), 1200);
          }}
        />
      )}
    </div>
  );
}
