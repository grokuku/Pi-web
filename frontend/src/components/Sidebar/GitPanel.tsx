import { useState, useEffect, useCallback } from "react";
import {
  GitBranch, ArrowDown, ArrowUp, RefreshCw, AlertTriangle, Check,
  Clock, Download, PlusSquare, ChevronRight, ChevronDown, Link2,
} from "lucide-react";
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

// ── GitProjectSection : section git d'UN projet (réutilisable) ──
// Rendu pour le projet principal (isMain, déroulé, polling 30 s) ou pour
// chaque projet LIÉ (accordéon replié par défaut, lazy — le statut n'est
// chargé QUE quand la section est déroulée).
function GitProjectSection({
  project,
  isMain,
  isOpen,
  onToggle,
  refreshKey,
}: {
  project: Project;
  isMain: boolean;
  isOpen: boolean;
  onToggle?: () => void;
  refreshKey: number;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<ActionType | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [project.id, project.git?.remote, t]);

  // Chargement LAZY : seulement quand la section est DÉROULÉE.
  // Le projet principal poll en plus toutes les 30 s (comportement historique).
  // Une section linkée repliée → aucun fetch tant qu'elle n'est pas ouverte ;
  // une fois repliée, sa section est démontée (plus de polling permanent).
  useEffect(() => {
    if (!isOpen) return;
    fetchStatus();
    const interval = isMain ? setInterval(fetchStatus, 30_000) : null;
    return () => { if (interval) clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isMain]);

  // Rafraîchissement global du panel (bouton refresh en haut).
  useEffect(() => {
    if (isOpen && refreshKey > 0) fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, isOpen]);

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

  // Projet sans dépôt : la section ne s'affiche que si elle est ouverte.
  if (!project.git?.remote) {
    if (!isOpen) return null;
    return (
      <div className="text-hacker-text-dim text-[0.75rem] italic py-1 flex items-center gap-1">
        <AlertTriangle size={10} />
        {project.name} — no git remote
      </div>
    );
  }

  const isNotRepo = status && "notRepo" in status;
  const dirIsEmpty = status && "notRepo" in status && status.isEmpty;
  const normalStatus = isNotRepo ? null : (status as GitStatusFull);
  const totalChanges = normalStatus
    ? normalStatus.staged.length + normalStatus.modified.length + normalStatus.deleted.length + normalStatus.created.length
    : 0;

  // Branche affichée dans le badge de l'en-tête (résolue dès le statut chargé).
  const branchBadge = isNotRepo
    ? project.git.branch || "main"
    : normalStatus?.branch || project.git.branch || "…";

  // ── En-tête de section : chevron + nom + badge branch ──
  // Le projet principal (isMain) est déroulé et non repliable (pas de onToggle).
  const header = (
    <div
      onClick={onToggle}
      role={onToggle ? "button" : undefined}
      title={onToggle ? (isOpen ? t('gitPanel.collapse') : t('gitPanel.expand')) : undefined}
      className={`flex items-center gap-1.5 group ${onToggle ? "cursor-pointer hover:bg-hacker-border/40" : ""} ${isMain ? "mt-1" : "mt-1.5"} py-1 px-1 rounded transition-colors select-none`}
    >
      {isOpen ? (
        <ChevronDown size={12} className="shrink-0 text-hacker-accent" />
      ) : (
        <ChevronRight size={12} className="shrink-0 text-hacker-text-dim group-hover:text-hacker-accent" />
      )}
      <span className={`truncate flex-1 font-bold tracking-wide ${isMain ? "text-hacker-accent text-[0.75rem]" : "text-hacker-accent text-[0.75rem]"}`}>
        {project.name}
      </span>
      <span className="text-hacker-info text-[0.6875rem] border border-hacker-border bg-hacker-bg/30 px-1 rounded font-mono max-w-[90px] truncate">
        <GitBranch size={9} className="inline mr-0.5 -mt-0.5" />
        {branchBadge}
      </span>
    </div>
  );

  if (!isOpen) {
    return <>{header}</>;
  }

  // ── Contenu (section DÉROULÉE) ──
  return (
    <>
      {header}

      {loading && !status && (
        <div className="text-hacker-text-dim italic text-[0.75rem] flex items-center gap-1 px-1">
          <RefreshCw size={10} className="animate-spin" />
          Loading...
        </div>
      )}

      {error && (
        <div className="text-hacker-error text-[0.75rem] mb-1.5 px-1 flex items-center gap-1">
          <AlertTriangle size={10} />
          {error}
        </div>
      )}

      {message && (
        <div className="text-hacker-accent text-[0.75rem] mb-1.5 px-1 flex items-center gap-1">
          <Check size={10} />
          {message}
        </div>
      )}

      {/* ── Not a repo yet ── */}
      {isNotRepo && (
        <div className="space-y-2 px-1">
          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Remote</span>
            <span className="text-hacker-text-bright text-[0.6875rem] truncate max-w-[100px] text-right">
              {project.git.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Branch</span>
            <span className="text-hacker-info">{project.git.branch || "main"}</span>
          </div>

          {dirIsEmpty ? (
            <>
              <div className="text-hacker-text-dim text-[0.75rem] flex items-center gap-1">
                <Download size={10} />
                Directory is empty — ready to clone
              </div>
              <button
                onClick={() => doAction("clone", `/api/projects/${project.id}/git/clone`)}
                disabled={actionLoading !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-accent/50 text-hacker-accent text-[0.75rem] hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
              >
                {actionLoading === "clone" ? (
                  <RefreshCw size={10} className="animate-spin" />
                ) : (
                  <Download size={12} />
                )}
                Clone Repository
              </button>
            </>
          ) : (
            <>
              <div className="text-hacker-warn text-[0.75rem] flex items-start gap-1 bg-hacker-bg/30 border border-hacker-warn/20 p-1.5">
                <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                <span>Directory not empty — cannot clone. Initialize git + add remote instead.</span>
              </div>
              <button
                onClick={() => doAction("init", `/api/projects/${project.id}/git/init`)}
                disabled={actionLoading !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 border border-hacker-border text-hacker-text-dim hover:border-hacker-accent hover:text-hacker-accent text-[0.75rem] transition-colors disabled:opacity-40"
              >
                {actionLoading === "init" ? (
                  <RefreshCw size={10} className="animate-spin" />
                ) : (
                  <PlusSquare size={12} />
                )}
                git init + Add Remote
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Normal repo ── */}
      {normalStatus && (
        <div className="space-y-1.5 px-1">
          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Branch</span>
            <span className="text-hacker-info">{normalStatus.branch}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-hacker-text-dim">Remote</span>
            <span className="text-hacker-text-bright text-[0.6875rem] truncate max-w-[100px] text-right">
              {project.git.remote.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
            </span>
          </div>

          {(normalStatus.ahead > 0 || normalStatus.behind > 0) && (
            <div className="flex items-center gap-2">
              {normalStatus.behind > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-warn text-[0.75rem]">
                  <ArrowDown size={10} />
                  {normalStatus.behind} behind
                </span>
              )}
              {normalStatus.ahead > 0 && (
                <span className="flex items-center gap-0.5 text-hacker-info text-[0.75rem]">
                  <ArrowUp size={10} />
                  {normalStatus.ahead} ahead
                </span>
              )}
            </div>
          )}

          {!normalStatus.isClean && (
            <div className="text-[0.75rem] space-y-0.5 bg-hacker-bg/30 border border-hacker-border p-1.5">
              {normalStatus.staged.length > 0 && (
                <div className="text-hacker-accent">✓ {normalStatus.staged.length} staged</div>
              )}
              {normalStatus.modified.length > 0 && (
                <div className="text-hacker-warn">~ {normalStatus.modified.length} modified</div>
              )}
              {normalStatus.created.length > 0 && (
                <div className="text-hacker-info">+ {normalStatus.created.length} new</div>
              )}
              {normalStatus.deleted.length > 0 && (
                <div className="text-hacker-error">- {normalStatus.deleted.length} deleted</div>
              )}
              {normalStatus.conflict.length > 0 && (
                <div className="text-hacker-error font-bold">! {normalStatus.conflict.length} conflicts</div>
              )}

              <div className="mt-1 max-h-[60px] overflow-y-auto">
                {normalStatus.files.slice(0, 5).map((f) => (
                  <div key={f.path} className="flex gap-1 text-hacker-text-dim/70 truncate">
                    <span className="text-hacker-accent text-[0.6875rem] w-5 shrink-0">{f.status}</span>
                    <span className="truncate">{f.path}</span>
                  </div>
                ))}
                {normalStatus.files.length > 5 && (
                  <div className="text-hacker-text-dim/50">
                    +{normalStatus.files.length - 5} more files
                  </div>
                )}
              </div>
            </div>
          )}

          {normalStatus.isClean && totalChanges === 0 && !normalStatus.ahead && !normalStatus.behind && (
            <div className="text-hacker-text-dim text-[0.75rem] flex items-center gap-1">
              <Check size={10} className="text-hacker-accent" />
              Up to date
            </div>
          )}

          {project.git.lastSync && (
            <div className="text-hacker-text-dim text-[0.6875rem] flex items-center gap-1">
              <Clock size={9} />
              {formatTimeAgo(project.git.lastSync)}
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
                <RefreshCw size={10} className="animate-spin" />
              ) : (
                <ArrowDown size={10} />
              )}
              Pull
            </button>
            <button
              onClick={() => setShowPushModal(true)}
              disabled={actionLoading !== null}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 border border-hacker-accent/50 text-[0.75rem] text-hacker-accent hover:bg-hacker-accent/10 transition-colors disabled:opacity-40"
              title="Stage all → commit → push"
            >
              {actionLoading === "commit-push" ? (
                <RefreshCw size={10} className="animate-spin" />
              ) : (
                <ArrowUp size={10} />
              )}
              Push
            </button>
          </div>
        </div>
      )}

      {/* ── Push modal (CE projectId) ── */}
      {showPushModal && (
        <CommitPushModal
          project={project}
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

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface Props {
  project: Project;
  // Projets LIÉS du projet actif (résolus par la Sidebar) — une section
  // accordéon par projet, chargée lazy au dépliage.
  linkedProjects?: Project[];
  onRefresh?: () => void;
}

const EXPANDED_KEY = "pi-web.gitpanel.expanded";

export function GitPanel({ project, linkedProjects = [], onRefresh }: Props) {
  const { t } = useTranslation();
  const [refreshKey, setRefreshKey] = useState(0);
  const [showPushAllModal, setShowPushAllModal] = useState(false);

  const mainHasRepo = !!project.git?.remote;

  // ── État accordéon des sections linkées (mémorisé en sessionStorage) ──
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(EXPANDED_KEY) || "{}");
    } catch {
      return {};
    }
  });
  const persistExpanded = (next: Record<string, boolean>) => {
    try { sessionStorage.setItem(EXPANDED_KEY, JSON.stringify(next)); } catch {}
    setExpanded(next);
  };
  const toggleSection = (id: string) => {
    persistExpanded({ ...expanded, [id]: !expanded[id] });
  };

  const refreshAll = () => {
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
      {/* En-tête global du panel : GIT + refresh (rafraîchit toutes les sections ouvertes) */}
      <div className="text-hacker-accent text-[0.75rem] tracking-widest mb-1 flex items-center gap-1">
        <GitBranch size={12} />
        GIT {providerIcon}
        <div className="flex-1" />
        <button
          onClick={refreshAll}
          className="text-hacker-text-dim hover:text-hacker-accent transition-colors"
          title={t('gitPanel.refresh')}
        >
          <RefreshCw size={10} className={refreshKey > 0 && hasAnySection ? "animate-spin" : ""} />
        </button>
      </div>

      {/* ── Section du projet principal (déroulée, avec polling) ── */}
      {mainHasRepo && (
        <GitProjectSection
          key={project.id}
          project={project}
          isMain
          isOpen
          refreshKey={refreshKey}
        />
      )}

      {/* ── Une section accordéon par projet LIÉ (repliée par défaut, lazy) ── */}
      {linkedProjects.length > 0 && (
        <>
          <div className="mt-1.5 text-hacker-text-dim text-[0.625rem] tracking-widest uppercase mb-0.5 flex items-center gap-1">
            <Link2 size={9} />
            {t('gitPanel.linkedProjects')}
          </div>
          {linkedProjects.map((lp) => (
            <GitProjectSection
              key={lp.id}
              project={lp}
              isMain={false}
              isOpen={!!expanded[lp.id]}
              onToggle={() => toggleSection(lp.id)}
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
              <ArrowUp size={12} />
              {t('gitPanel.pushAll')}
            </button>
          </div>
        </>
      )}

      {/* Cas limite : placeholder sans lien résolu → note discrète */}
      {!hasAnySection && (
        <div className="text-hacker-text-dim text-[0.6875rem] italic flex items-start gap-1">
          <AlertTriangle size={10} className="shrink-0 mt-0.5" />
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
