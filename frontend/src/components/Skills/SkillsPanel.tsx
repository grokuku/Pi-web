// ── Panneau SKILLS ───────────────────────────────────────
// Liste des skills installées (livrée / écosystème / générée / personnelle),
// activation-désactivation (mécanisme existant `!<nom>` de /api/pi/toggle),
// éditeur de SKILL.md, restauration de la version de référence, création.
//
// Garde-fous repris du backend (pi/skills-store.ts) :
//   - les skills GÉNÉRÉES (codebase-memory, écrite par le binaire CBM) sont
//     VERROUILLÉES : éditeur en lecture seule + avertissement explicite, car
//     elles sont réécrites à chaque mise à jour de CBM ;
//   - « restaurer » n'est proposé que si une référence existe (livrée ou
//     écosystème) ET que la copie locale a divergé.
//
// RÈGLE DU REPLI : chaque ligne de skill est un CollapsibleBlock (description
// complète repliable) alimenté par le CollapseProvider du réglage utilisateur
// « Déplier le détail d'affichage par défaut » — le réglage s'applique donc ici
// comme dans le chat (subscribeDisplayDetail → application live).

import { useCallback, useEffect, useMemo, useState } from "react";
import { CollapseProvider, CollapsibleBlock } from "../Chat/CollapsibleBlock";
import { HolafIcon } from "../icons/HolafIcon";
import { useTranslation } from "../../i18n";
import { readDisplayDetailExpanded, subscribeDisplayDetail } from "../../utils/display-detail";
import { parseJsonResponse } from "../../utils/api";
import {
  createSkill,
  fetchSkill,
  fetchSkills,
  isSkillEnabledInList,
  isSkillNameValid,
  restoreSkill,
  saveSkill,
  toggleSkill,
  type SkillDetailResponse,
  type SkillInfo,
  type SkillStatus,
} from "./skills-api";

// ── Props ────────────────────────────────────────────────

export interface SkillsPanelProps {
  /** Projet actif (bouton « recharger la session ») ; absent en mode autonome. */
  activeProjectId?: string | null;
}

// ── Badges ───────────────────────────────────────────────

const STATUS_BADGE_CLASS: Record<SkillStatus, string> = {
  bundled: "border-hacker-accent/50 text-hacker-accent",
  ecosystem: "border-hacker-info/50 text-hacker-info",
  generated: "border-hacker-warn/50 text-hacker-warn",
  custom: "border-hacker-border text-hacker-text-dim",
};

function StatusBadge({ status }: { status: SkillStatus }) {
  const { t } = useTranslation();
  const labels: Record<SkillStatus, string> = {
    bundled: t("skillsPanel.statusBundled"),
    ecosystem: t("skillsPanel.statusEcosystem"),
    generated: t("skillsPanel.statusGenerated"),
    custom: t("skillsPanel.statusCustom"),
  };
  return (
    <span
      data-testid={`skill-status-${status}`}
      className={`text-[9px] px-1 border font-bold tracking-wider shrink-0 ${STATUS_BADGE_CLASS[status]}`}
      title={labels[status]}
    >
      {labels[status]}
    </span>
  );
}

function ModifiedBadge() {
  const { t } = useTranslation();
  return (
    <span
      data-testid="skill-modified-badge"
      className="text-[9px] px-1 border border-hacker-warn/50 text-hacker-warn font-bold tracking-wider shrink-0"
      title={t("skillsPanel.modifiedTitle")}
    >
      {t("skillsPanel.modified")}
    </span>
  );
}

// ── Panneau ──────────────────────────────────────────────

export function SkillsPanel({ activeProjectId }: SkillsPanelProps) {
  const { t } = useTranslation();
  const labels = useMemo(
    () => ({
      sessionExpired: t("git.sessionExpired"),
      serverError: (status: number) => t("git.serverError", status),
    }),
    [t],
  );

  // Réglage global de repli (identique au chat) — appliqué en live.
  const [defaultDetailExpanded, setDefaultDetailExpanded] = useState(() => readDisplayDetailExpanded());
  useEffect(() => subscribeDisplayDetail(setDefaultDetailExpanded), []);

  // ── État liste ──
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [reloadStatus, setReloadStatus] = useState<"idle" | "reloading" | "done">("idle");

  // ── État éditeur ──
  const [editing, setEditing] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetailResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  // ── État création ──
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await fetchSkills(labels));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [labels]);

  useEffect(() => {
    load();
  }, [load]);

  // Feedback « ✓ ENREGISTRÉ » transitoire + confirmation de restauration qui expire.
  useEffect(() => {
    if (savedAt === null) return;
    const id = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(id);
  }, [savedAt]);
  useEffect(() => {
    if (!confirmRestore) return;
    const id = setTimeout(() => setConfirmRestore(false), 4000);
    return () => clearTimeout(id);
  }, [confirmRestore]);

  // ── Actions ──

  const openEditor = useCallback(
    async (name: string) => {
      setEditing(name);
      setDetail(null);
      setDraft("");
      setConfirmRestore(false);
      setError(null);
      try {
        const d = await fetchSkill(name, labels);
        setDetail(d);
        setDraft(d.content);
      } catch (e: any) {
        setError(e.message);
      }
    },
    [labels],
  );

  const closeEditor = useCallback(() => {
    setEditing(null);
    setDetail(null);
    setDraft("");
    setConfirmRestore(false);
  }, []);

  const handleToggle = useCallback(
    async (skill: SkillInfo) => {
      setBusy(`toggle:${skill.name}`);
      try {
        // Mécanisme existant : /api/pi/toggle écrit `!<nom>` (désactivation).
        const list = await toggleSkill(skill.name, !skill.enabled, labels);
        setSkills((prev) =>
          prev.map((s) => (s.name === skill.name ? { ...s, enabled: isSkillEnabledInList(list, s.name) } : s)),
        );
        setNeedsReload(true);
        setError(null);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusy(null);
      }
    },
    [labels],
  );

  const handleSave = useCallback(async () => {
    if (!detail || !detail.skill.editable || draft === detail.content) return;
    setBusy("save");
    try {
      const d = await saveSkill(detail.skill.name, draft, labels);
      setDetail(d);
      setDraft(d.content);
      setSavedAt(Date.now());
      setNeedsReload(true);
      setError(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }, [detail, draft, labels, load]);

  const handleRestore = useCallback(async () => {
    if (!detail) return;
    // Double clic de confirmation (pas de modale : action inline réversible ? non,
    // mais l'aide contextuelle décrit précisément l'effet).
    if (!confirmRestore) {
      setConfirmRestore(true);
      return;
    }
    setBusy("restore");
    try {
      const d = await restoreSkill(detail.skill.name, labels);
      setDetail(d);
      setDraft(d.content);
      setConfirmRestore(false);
      setNeedsReload(true);
      setError(null);
      await load();
    } catch (e: any) {
      setError(e.message);
      setConfirmRestore(false);
    } finally {
      setBusy(null);
    }
  }, [detail, confirmRestore, labels, load]);

  const resetCreate = useCallback(() => {
    setShowCreate(false);
    setNewName("");
    setNewDesc("");
    setCreateError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    const description = newDesc.trim();
    if (!isSkillNameValid(name)) {
      setCreateError(t("skillsPanel.invalidName"));
      return;
    }
    if (!description) {
      setCreateError(t("skillsPanel.descriptionRequired"));
      return;
    }
    setBusy("create");
    try {
      const d = await createSkill(name, description, labels);
      setCreateError(null);
      setNeedsReload(true);
      await load();
      resetCreate();
      openEditor(d.skill.name);
    } catch (e: any) {
      setCreateError(e.message);
    } finally {
      setBusy(null);
    }
  }, [newName, newDesc, labels, load, resetCreate, openEditor, t]);

  const reloadSession = useCallback(async () => {
    if (!activeProjectId) return;
    setReloadStatus("reloading");
    try {
      const res = await fetch("/api/pi/reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProjectId }),
      });
      await parseJsonResponse<{ success?: boolean }>(res, labels);
      setReloadStatus("done");
      setNeedsReload(false);
      setTimeout(() => setReloadStatus("idle"), 3000);
    } catch (e: any) {
      setError(e.message);
      setReloadStatus("idle");
    }
  }, [activeProjectId, labels]);

  // ── Rendu ──

  const dirty = detail !== null && draft !== detail.content;

  return (
    <CollapseProvider defaultDetailExpanded={defaultDetailExpanded}>
      <div data-testid="skills-panel" className="h-full min-h-0 flex flex-col bg-hacker-surface/30">
        {editing === null ? (
          <>
            {/* Barre d'outils de la liste */}
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-hacker-border/60 bg-hacker-bg/40 shrink-0">
              <HolafIcon name="lightbulb" size={12} className="text-hacker-accent shrink-0" />
              <span className="text-[10px] font-bold tracking-widest text-hacker-text-bright">
                {t("skillsPanel.title")}
              </span>
              <span className="text-[10px] text-hacker-text-dim">({skills.length})</span>
              <div className="flex-1" />
              <button
                data-testid="skills-refresh"
                onClick={load}
                disabled={loading}
                className="p-1 text-hacker-text-dim hover:text-hacker-accent disabled:opacity-40"
                title={t("skillsPanel.refresh")}
                aria-label={t("skillsPanel.refresh")}
              >
                <HolafIcon name="refresh" size={12} className={loading ? "animate-spin" : ""} />
              </button>
              <button
                data-testid="skills-new"
                onClick={() => (showCreate ? resetCreate() : setShowCreate(true))}
                className="btn-hacker text-[10px] px-1.5 py-0.5 inline-flex items-center gap-1"
                title={t("skillsPanel.createTitle")}
              >
                <HolafIcon name="plus" size={10} />
                {t("skillsPanel.newSkill")}
              </button>
            </div>

            {/* Formulaire de création */}
            {showCreate && (
              <div
                data-testid="skill-create-form"
                className="px-2 py-2 border-b border-hacker-border/60 bg-hacker-accent/5 space-y-1.5 shrink-0"
              >
                <div className="text-[10px] font-bold tracking-wider text-hacker-accent">
                  {t("skillsPanel.createTitle")}
                </div>
                <input
                  data-testid="skill-create-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t("skillsPanel.createName")}
                  className="w-full bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-2 py-1 focus:border-hacker-accent outline-none"
                />
                <textarea
                  data-testid="skill-create-desc"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  rows={2}
                  placeholder={t("skillsPanel.createDescription")}
                  className="w-full resize-none bg-hacker-bg border border-hacker-border text-hacker-text-bright text-xs px-2 py-1 focus:border-hacker-accent outline-none"
                />
                <div className="flex items-center gap-2">
                  <button
                    data-testid="skill-create-submit"
                    onClick={handleCreate}
                    disabled={busy === "create" || !newName.trim() || !newDesc.trim()}
                    className="btn-hacker text-[10px] px-2 py-0.5"
                  >
                    {t("skillsPanel.createBtn")}
                  </button>
                  <button onClick={resetCreate} className="text-[10px] text-hacker-text-dim hover:text-hacker-text">
                    {t("common.cancel")}
                  </button>
                  {createError && (
                    <span className="text-[10px] text-hacker-error truncate" title={createError}>
                      {createError}
                    </span>
                  )}
                </div>
                <div className="text-[9px] text-hacker-text-dim">{t("skillsPanel.createHint")}</div>
              </div>
            )}

            {/* Erreur globale */}
            {error && (
              <div
                data-testid="skills-error"
                className="px-2 py-1 text-[10px] text-hacker-error border-b border-hacker-error/30 bg-hacker-error/5 shrink-0"
              >
                {error}
              </div>
            )}

            {/* Liste */}
            <div className="flex-1 min-h-0 overflow-auto">
              {loading && skills.length === 0 ? (
                <div className="text-[10px] text-hacker-text-dim text-center py-6">{t("common.loading")}</div>
              ) : skills.length === 0 ? (
                <div data-testid="skills-empty" className="text-[10px] text-hacker-text-dim text-center py-6">
                  {t("skillsPanel.empty")}
                </div>
              ) : (
                skills.map((skill) => (
                  <CollapsibleBlock
                    key={skill.name}
                    blockId={`skill:${skill.name}`}
                    className="border-b border-hacker-border/30"
                    headerClassName="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer select-none hover:bg-hacker-accent/5"
                    contentClassName="px-2 pb-2 pl-6"
                    title={skill.description || skill.name}
                    header={
                      <>
                        <span
                          data-testid={`skill-name-${skill.name}`}
                          className="font-mono text-xs font-bold text-hacker-text-bright truncate"
                        >
                          {skill.name}
                        </span>
                        <StatusBadge status={skill.status} />
                        {skill.modified && <ModifiedBadge />}
                        {!skill.enabled && (
                          <span className="text-[9px] text-hacker-text-dim shrink-0">({t("common.off")})</span>
                        )}
                      </>
                    }
                    headerActions={
                      <>
                        <button
                          data-testid={`skill-toggle-${skill.name}`}
                          onClick={() => handleToggle(skill)}
                          disabled={busy === `toggle:${skill.name}`}
                          className={`p-0.5 shrink-0 ${
                            skill.enabled
                              ? "text-hacker-accent hover:text-hacker-error"
                              : "text-hacker-text-dim hover:text-hacker-accent"
                          }`}
                          title={skill.enabled ? t("skillsPanel.enabled") : t("skillsPanel.disabled")}
                          aria-label={skill.enabled ? t("skillsPanel.enabled") : t("skillsPanel.disabled")}
                        >
                          <HolafIcon name={skill.enabled ? "toggle-right" : "toggle-left"} size={14} />
                        </button>
                        <button
                          data-testid={`skill-edit-${skill.name}`}
                          onClick={() => openEditor(skill.name)}
                          className="p-0.5 shrink-0 text-hacker-text-dim hover:text-hacker-accent"
                          title={t("skillsPanel.edit")}
                          aria-label={t("skillsPanel.edit")}
                        >
                          <HolafIcon name="pencil" size={12} />
                        </button>
                      </>
                    }
                  >
                    <div className="text-[11px] text-hacker-text-dim whitespace-pre-wrap break-words">
                      {skill.description || t("skillsPanel.noDescription")}
                    </div>
                    {skill.invalid && (
                      <div className="mt-1 flex items-start gap-1 text-[10px] text-hacker-warn">
                        <HolafIcon name="alert-triangle" size={10} className="mt-0.5 shrink-0" />
                        <span>
                          {t("skillsPanel.invalid")} {skill.invalid}
                        </span>
                      </div>
                    )}
                  </CollapsibleBlock>
                ))
              )}
            </div>

            {/* Pied : rappel + rechargement de session */}
            <div className="shrink-0 border-t border-hacker-border/60 bg-hacker-bg/30 px-2 py-1 flex items-center gap-2">
              <span className="text-[9px] text-hacker-text-dim flex-1 min-w-0">
                {needsReload ? t("skillsPanel.reloadNeeded") : t("skillsPanel.reloadTitle")}
              </span>
              {activeProjectId && (
                <button
                  data-testid="skills-reload-session"
                  onClick={reloadSession}
                  disabled={reloadStatus === "reloading"}
                  className={`btn-hacker text-[10px] px-1.5 py-0.5 shrink-0 ${
                    reloadStatus === "done" ? "!text-green-400 !border-green-600/50" : ""
                  }`}
                >
                  {reloadStatus === "done"
                    ? t("skillsPanel.reloaded")
                    : reloadStatus === "reloading"
                      ? t("skillsPanel.reloading")
                      : t("skillsPanel.reload")}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Barre d'outils de l'éditeur */}
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-hacker-border/60 bg-hacker-bg/40 shrink-0">
              <button
                data-testid="skill-editor-back"
                onClick={closeEditor}
                className="p-1 shrink-0 text-hacker-text-dim hover:text-hacker-accent"
                title={t("skillsPanel.back")}
                aria-label={t("skillsPanel.back")}
              >
                <HolafIcon name="arrow-left" size={12} />
              </button>
              <span className="font-mono text-xs font-bold text-hacker-text-bright truncate">{editing}</span>
              {detail && <StatusBadge status={detail.skill.status} />}
              {detail?.skill.modified && <ModifiedBadge />}
              <div className="flex-1" />
              {detail?.skill.editable && (
                <button
                  data-testid="skill-save"
                  onClick={handleSave}
                  disabled={busy === "save" || !dirty}
                  className={`btn-hacker text-[10px] px-1.5 py-0.5 shrink-0 inline-flex items-center gap-1 ${
                    savedAt !== null ? "!text-green-400 !border-green-600/50" : ""
                  }`}
                >
                  <HolafIcon name="save" size={10} />
                  {savedAt !== null ? t("skillsPanel.saved") : t("skillsPanel.save")}
                </button>
              )}
            </div>

            {/* Erreur globale */}
            {error && (
              <div
                data-testid="skills-error"
                className="px-2 py-1 text-[10px] text-hacker-error border-b border-hacker-error/30 bg-hacker-error/5 shrink-0"
              >
                {error}
              </div>
            )}

            {/* Skill générée : verrouillée */}
            {detail?.skill.status === "generated" && (
              <div
                data-testid="skill-generated-warning"
                className="px-2 py-1.5 border-b border-hacker-warn/30 bg-hacker-warn/5 flex items-start gap-1.5 shrink-0"
              >
                <HolafIcon name="alert-triangle" size={12} className="text-hacker-warn mt-0.5 shrink-0" />
                <div className="text-[10px] text-hacker-warn">
                  <div className="font-bold tracking-wider">{t("skillsPanel.generatedLockedTitle")}</div>
                  <div className="text-hacker-text-dim">{t("skillsPanel.generatedLockedBody")}</div>
                </div>
              </div>
            )}

            {/* Restauration (référence connue + copie divergente) */}
            {detail && detail.skill.editable && detail.skill.reference && detail.skill.modified && (
              <div
                data-testid="skill-restore-bar"
                className="px-2 py-1.5 border-b border-hacker-border/60 bg-hacker-bg/30 flex items-center gap-2 shrink-0"
              >
                <span className="text-[9px] text-hacker-text-dim flex-1 min-w-0">
                  {detail.skill.reference.kind === "bundled"
                    ? t("skillsPanel.restoreHintBundled")
                    : t("skillsPanel.restoreHintEcosystem")}
                </span>
                <button
                  data-testid="skill-restore"
                  onClick={handleRestore}
                  disabled={busy === "restore"}
                  className={`btn-hacker text-[10px] px-1.5 py-0.5 shrink-0 inline-flex items-center gap-1 ${
                    confirmRestore ? "danger" : ""
                  }`}
                >
                  <HolafIcon name="undo-2" size={10} />
                  {confirmRestore ? t("skillsPanel.restoreConfirm") : t("skillsPanel.restore")}
                </button>
              </div>
            )}

            {/* Contenu de la fiche */}
            {detail === null ? (
              <div className="flex-1 flex items-center justify-center text-[10px] text-hacker-text-dim">
                {t("common.loading")}
              </div>
            ) : (
              <textarea
                data-testid="skill-content-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                readOnly={!detail.skill.editable}
                spellCheck={false}
                className="flex-1 min-h-0 w-full resize-none bg-hacker-bg/60 text-hacker-text-bright font-mono text-xs p-2 outline-none border-0"
              />
            )}

            {/* Pied : état de sauvegarde */}
            <div className="shrink-0 border-t border-hacker-border/60 bg-hacker-bg/30 px-2 py-1 flex items-center gap-2">
              <span className="text-[9px] text-hacker-text-dim flex-1 min-w-0">
                {detail?.skill.editable
                  ? dirty
                    ? t("skillsPanel.dirty")
                    : t("skillsPanel.noChanges")
                  : t("skillsPanel.readOnly")}
              </span>
              {needsReload && activeProjectId && (
                <button
                  data-testid="skills-reload-session-editor"
                  onClick={reloadSession}
                  disabled={reloadStatus === "reloading"}
                  className={`btn-hacker text-[10px] px-1.5 py-0.5 shrink-0 ${
                    reloadStatus === "done" ? "!text-green-400 !border-green-600/50" : ""
                  }`}
                >
                  {reloadStatus === "done"
                    ? t("skillsPanel.reloaded")
                    : reloadStatus === "reloading"
                      ? t("skillsPanel.reloading")
                      : t("skillsPanel.reload")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </CollapseProvider>
  );
}
