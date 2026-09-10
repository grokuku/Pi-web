// ── LinkedProjectMenu ────────────────────────────────
// Menu contextuel du placeholder LIÉ (storage === "linked") dans la sidebar.
// Ouverture : clic (ou clic droit) sur la ligne du projet lié — voir Sidebar.
//
// Contenu :
//   1. « Lier un projet… » → mode pick : liste des projets éligibles
//      (local/SMB uniquement, contrainte backend ; pas déjà regroupés)
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

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Link2, Unlink, X } from "lucide-react";
import { useTranslation } from "../../i18n";
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

  // Sous-projets regroupés (objets résolus depuis la liste complète).
  const subs = (project.linkedProjectIds || [])
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => !!p);

  // Candidats à la liaison : contraintes backend (local ou SMB monté, pas un
  // placeholder — l'imbrication est refusée) + on exclut les projets déjà
  // regroupés dans n'importe quel placeholder (un sous-projet = un seul groupe).
  const linkedEverywhere = new Set<string>();
  for (const p of projects) {
    if (p.storage === "linked" && Array.isArray(p.linkedProjectIds)) {
      for (const id of p.linkedProjectIds) linkedEverywhere.add(id);
    }
  }
  const candidates = projects.filter(
    (p) =>
      p.id !== project.id &&
      !linkedEverywhere.has(p.id) &&
      (p.storage === "local" || p.storage === "smb")
  );

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
      alert(t('sidebar.linkedMenu.linkError', e?.message ?? String(e)));
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
      alert(t('sidebar.linkedMenu.unlinkError', e?.message ?? String(e)));
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
      className="bg-hacker-surface border border-hacker-border-bright shadow-lg overflow-y-auto"
    >
      {mode === "main" ? (
        <>
          {/* En-tête : nom du placeholder */}
          <div className="px-3 pt-2 pb-1 text-[10px] text-hacker-text-dim font-bold tracking-wider flex items-center gap-1">
            <Link2 size={10} className="text-hacker-accent shrink-0" />
            <span className="truncate">{project.name}</span>
          </div>

          {/* Lier un projet… → bascule en mode pick */}
          <button
            onClick={() => setMode("pick")}
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
        </>
      ) : (
        <>
          {/* Mode pick : choisir un projet à lier */}
          <div className="px-2 pt-2 pb-1 flex items-center gap-1">
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
          <div className="px-2 pb-2 flex flex-col gap-0.5">
            {candidates.map((p) => (
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
                <span className="text-[9px] text-hacker-text-dim/50 uppercase shrink-0">{p.storage}</span>
              </button>
            ))}
            {candidates.length === 0 && (
              <div className="px-2 py-2 text-[11px] text-hacker-warn">
                {t('addProject.linkedNoCandidates')}
              </div>
            )}
          </div>
        </>
      )}
    </div>,
    document.body
  );
}