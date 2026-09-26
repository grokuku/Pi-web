// ── LinkedProjectMenu ────────────────────────────────
// Menu contextuel du placeholder LIÉ (storage === "linked") dans la sidebar.
// Ouverture : clic (ou clic droit) sur la ligne du projet lié — voir Sidebar.
//
// Contenu :
//   1. « Lier un projet… » → mode pick : champ de recherche + case « Masquer
//      les projets déjà liés à un groupe » (cochée par défaut, état recréé à
//      chaque ouverture), puis liste des projets éligibles (local/SMB
//      uniquement, contrainte backend ; hors doublons du groupe courant —
//      décochée, un projet déjà membre d'un AUTRE groupe reste proposable
//      avec le badge « lié ×N »)
//      → POST /api/projects/:id/linked { subProjectId }
//   2. « Délier » : un item par sous-projet regroupé
//      → DELETE /api/projects/:id/linked/:subId
//   3. Toggle « Afficher les origines masquées » (état persisté côté Sidebar,
//      clé localStorage pi-web.hide-linked-origins).
//
// Rendu via createPortal(document.body) en position FIXED ancrée sous le bord
// bas-GAUCHE de la ligne : la sidebar est étroite, un ancrage à droite ferait
// sortir le menu de l'écran — il s'étend donc vers la droite, au-dessus du
// contenu. Recalcul au scroll (phase de capture) et au resize tant que le
// menu est ouvert (pattern useAnchorPosition). Fermeture au clic extérieur
// et à la touche Escape (pattern ModelQuickSwitch/MobileHeaderMenu).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Link2, Unlink, X } from "lucide-react";
import { useTranslation } from "../../i18n";
import { toast } from "../../utils/holaf-toast";
import { buildLinkCandidates } from "../../utils/linked-projects";
import type { Project } from "../../types";

const MENU_WIDTH = 240;

interface Props {
  project: Project;              // placeholder lié concerné
  projects: Project[];           // liste complète (candidats + noms des sous-projets)
  anchor: HTMLElement | null;    // ligne déclenchante (bouton du projet)
  onClose: () => void;
  onProjectsChanged: () => void | Promise<void>;
  showOrigins: boolean;
  onToggleShowOrigins: () => void;
}

export function LinkedProjectMenu({
  project,
  projects,
  anchor,
  onClose,
  onProjectsChanged,
  showOrigins,
  onToggleShowOrigins,
}: Props) {
  const { t } = useTranslation();
  // mode "main" : actions ; mode "pick" : choix du projet à lier.
  const [mode, setMode] = useState<"main" | "pick">("main");
  const [busyId, setBusyId] = useState<string | null>(null); // link/unlink en cours
  const [search, setSearch] = useState(""); // filtre par nom dans le mode pick
  // Case « Masquer les projets déjà liés à un groupe » — cochée par défaut.
  // Le menu est démonté à sa fermeture (Sidebar : rendu conditionnel `&&`), donc
  // l'état est recréé (= coché) à chaque ouverture ; volontairement NON persisté
  // (filtre de confort, pas une préférence d'application).
  const [hideAlreadyLinked, setHideAlreadyLinked] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Position « fixed » (top/left + hauteur max) — recalculée au scroll en
  // capture et au resize tant que le menu est ouvert.
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useEffect(() => {
    if (!anchor) { setPos(null); return; }
    const compute = () => {
      const rect = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      // Ancrage à gauche de la ligne, clamp pour ne pas sortir de l'écran ;
      // la hauteur max laisse toujours ~132px visibles (scroll interne).
      const left = Math.max(8, Math.min(rect.left, vw - MENU_WIDTH - 8));
      const top = Math.max(8, Math.min(rect.bottom + 4, vh - 140));
      setPos({ top, left, maxHeight: vh - top - 8 });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [anchor]);

  // Fermeture : clic extérieur (hors dropdown — un clic sur la ligne ancre
  // ferme puis la Sidebar rouvre/repositionne, cf. onClick de la ligne) et
  // touche Escape.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && dropdownRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // À l'entrée en mode pick, le champ de recherche prend le focus (clavier
  // immédiatement opérationnel — même pattern que ProjectSwitcher).
  useEffect(() => {
    if (mode !== "pick") return;
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  // Sous-projets regroupés (objets résolus depuis la liste complète).
  const subs = (project.linkedProjectIds || [])
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => !!p);

  // Candidats à la liaison (logique pure testée dans utils/linked-projects.ts) :
  // contraintes backend (local ou SMB monté, pas un placeholder — l'imbrication
  // est refusée) + exclusion du projet lui-même et des doublons du groupe
  // COURANT. `hideAlreadyLinked` (case cochée par défaut) retire EN PLUS les
  // projets déjà membres d'un AUTRE groupe.
  const candidates = useMemo(
    () => buildLinkCandidates(project, projects, hideAlreadyLinked),
    [project, projects, hideAlreadyLinked]
  );
  // Même liste SANS le filtre de la case : sert au compteur de projets masqués
  // affiché sous la case (uniquement quand elle est cochée).
  const allCandidates = useMemo(
    () => buildLinkCandidates(project, projects, false),
    [project, projects]
  );
  const hiddenCount = useMemo(
    () => allCandidates.filter((c) => c.linkedGroupCount > 0).length,
    [allCandidates]
  );
  // Recherche par nom appliquée PAR-DESSUS le filtrage métier + case.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.project.name.toLowerCase().includes(q));
  }, [candidates, search]);
  // Message d'état vide : sans recherche, distingue « aucun projet éligible »
  // de « tout est masqué par la case » (sinon le message serait trompeur).
  const emptyMessage = search.trim()
    ? t('sidebar.linkedMenu.noMatch')
    : hideAlreadyLinked && hiddenCount > 0
      ? t('sidebar.linkedMenu.allHidden')
      : t('addProject.linkedNoCandidates');

  const handleLink = async (subProjectId: string) => {
    if (busyId) return;
    setBusyId(subProjectId);
    try {
      const res = await fetch(`/api/projects/${project.id}/linked`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subProjectId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await onProjectsChanged();
      onClose();
    } catch (e: any) {
      console.error("[LinkedProjectMenu] Link failed:", e);
      toast(t('sidebar.linkedMenu.linkError', e?.message ?? String(e)), "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleUnlink = async (subId: string) => {
    if (busyId) return;
    setBusyId(subId);
    try {
      const res = await fetch(`/api/projects/${project.id}/linked/${subId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await onProjectsChanged();
      onClose();
    } catch (e: any) {
      console.error("[LinkedProjectMenu] Unlink failed:", e);
      toast(t('sidebar.linkedMenu.unlinkError', e?.message ?? String(e)), "error");
    } finally {
      setBusyId(null);
    }
  };

  return createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: "fixed",
        top: pos?.top,
        left: pos?.left,
        maxHeight: pos?.maxHeight,
        width: MENU_WIDTH,
        zIndex: 60,
      }}
      className="flex flex-col bg-hacker-surface border border-hacker-border-bright shadow-lg overflow-hidden"
    >
      {mode === "main" ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* En-tête : nom du placeholder */}
          <div className="px-3 pt-2 pb-1 text-[10px] text-hacker-text-dim font-bold tracking-wider flex items-center gap-1">
            <Link2 size={10} className="text-hacker-accent shrink-0" />
            <span className="truncate">{project.name}</span>
          </div>

          {/* Lier un projet… → bascule en mode pick. On recharge la liste des
              projets à l'entrée : les candidats doivent refléter les créations/
              éditions récentes d'autres projets liés (pas d'état périmé). */}
          <button
            onClick={() => {
              setMode("pick");
              void onProjectsChanged();
            }}
            className="w-full text-left px-3 py-2 text-xs text-hacker-text-dim hover:bg-hacker-accent/5 hover:text-hacker-text flex items-center gap-1.5"
          >
            <Link2 size={12} className="shrink-0" />
            {t('sidebar.linkedMenu.linkProject')}
          </button>

          {/* Délier — un item par sous-projet regroupé */}
          {subs.length > 0 && (
            <>
              <div className="border-t border-hacker-border/30" />
              <div className="px-3 pt-2 pb-1 text-[10px] text-hacker-text-dim font-bold tracking-wider flex items-center gap-1">
                <Unlink size={10} className="shrink-0" />
                {t('sidebar.linkedMenu.unlinkSection')}
              </div>
              <div className="px-2 pb-2 flex flex-col gap-0.5">
                {subs.map((sub) => (
                  <button
                    key={sub.id}
                    onClick={() => handleUnlink(sub.id)}
                    disabled={!!busyId}
                    title={sub.cwd}
                    className="group w-full text-left px-2 py-1 text-xs text-hacker-text-dim hover:text-hacker-error hover:bg-hacker-error/5 flex items-center gap-1.5 disabled:opacity-40"
                  >
                    <span className="text-hacker-text-dim/60 shrink-0">↳</span>
                    <span className="truncate flex-1">{sub.name}</span>
                    <X size={10} className="shrink-0 opacity-40 group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="border-t border-hacker-border/30" />

          {/* Toggle « Afficher les origines masquées » — reste ouvert après clic */}
          <button
            onClick={onToggleShowOrigins}
            title={t('sidebar.linkedMenu.showOriginsHint')}
            className="w-full text-left px-3 py-2 text-xs text-hacker-text-dim hover:bg-hacker-accent/5 hover:text-hacker-text flex items-center gap-1.5"
          >
            <span className="w-3 text-center shrink-0">{showOrigins ? "☑" : "☐"}</span>
            <span className="truncate">{t('sidebar.linkedMenu.showOrigins')}</span>
          </button>
        </div>
      ) : (
        <>
          {/* Mode pick : choisir un projet à lier */}
          <div className="px-2 pt-2 pb-1 flex items-center gap-1 shrink-0">
            <button
              onClick={() => setMode("main")}
              className="p-0.5 text-hacker-text-dim hover:text-hacker-accent"
              title={t('sidebar.linkedMenu.pickBack')}
              aria-label={t('sidebar.linkedMenu.pickBack')}
            >
              <ChevronLeft size={12} />
            </button>
            <span className="text-[10px] text-hacker-text-dim font-bold tracking-wider truncate">
              {t('sidebar.linkedMenu.pickTitle', project.name)}
            </span>
          </div>

          {/* Recherche par nom — placée juste AU-DESSUS de la case de masquage. */}
          <div className="px-2 pb-1 shrink-0">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('sidebar.searchProject')}
              className="w-full bg-hacker-bg border border-hacker-border px-2 py-1 text-xs text-hacker-text placeholder:text-hacker-text-dim/50 focus:outline-none focus:border-hacker-accent/50"
              aria-label={t('sidebar.searchProject')}
            />
          </div>

          {/* Case « Masquer les projets déjà liés à un groupe » : cochée par
              défaut, elle retire de la liste les projets membres d'un AUTRE
              groupe. Décochée, ils réapparaissent avec le badge « lié ×N » et
              son infobulle (avertissement de multi-appartenance). */}
          <label className="px-2 pb-1.5 flex items-start gap-1.5 cursor-pointer shrink-0 border-b border-hacker-border/30">
            <input
              type="checkbox"
              checked={hideAlreadyLinked}
              onChange={(e) => setHideAlreadyLinked(e.target.checked)}
              className="mt-px accent-hacker-accent shrink-0"
              data-testid="hide-already-linked"
            />
            <span className="text-[10px] leading-tight text-hacker-text-dim">
              {t('sidebar.linkedMenu.hideAlreadyLinked')}
              {hideAlreadyLinked && hiddenCount > 0 && (
                <span className="text-hacker-warn/80">
                  {" · "}
                  {t('sidebar.linkedMenu.hiddenCount', hiddenCount)}
                </span>
              )}
            </span>
          </label>

          {/* Liste des candidats — recherche + case + règles métier cumulées. */}
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pt-1.5 pb-2 flex flex-col gap-0.5">
            {filtered.map(({ project: p, linkedGroupCount }) => (
              <button
                key={p.id}
                onClick={() => handleLink(p.id)}
                disabled={!!busyId}
                title={p.cwd}
                className="w-full text-left px-2 py-1 text-xs text-hacker-text-dim hover:text-hacker-accent hover:bg-hacker-accent/5 flex items-center gap-1.5 disabled:opacity-40"
              >
                <span className="w-3 text-center shrink-0 text-hacker-text-dim/60">
                  {busyId === p.id ? "…" : "+"}
                </span>
                <span className="truncate flex-1">{p.name}</span>
                {/* Multi-appartenance autorisée : on signale un projet déjà
                    regroupé ailleurs au lieu de le faire disparaître. */}
                {linkedGroupCount > 0 && (
                  <span
                    className="text-[9px] text-hacker-warn/80 shrink-0"
                    title={t('sidebar.linkedMenu.linkedElsewhereHint', p.name, linkedGroupCount)}
                  >
                    {t('sidebar.linkedMenu.linkedElsewhereBadge', linkedGroupCount)}
                  </span>
                )}
                <span className="text-[9px] text-hacker-text-dim/50 uppercase shrink-0">{p.storage}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-2 text-[11px] text-hacker-warn">
                {emptyMessage}
              </div>
            )}
          </div>
        </>
      )}
    </div>,
    document.body
  );
}