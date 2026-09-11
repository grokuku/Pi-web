// ── ProjectSwitcher ──────────────────────────────────
// Bloc « projet actuel » en tête de sidebar : icône + nom du projet courant +
// chevron ▾. Le clic ouvre un dropdown listant TOUS les projets, avec :
//   - champ de recherche (filtrage par nom — indispensable au-delà de ~20
//     projets) ;
//   - l'actuel marqué ✓ ;
//   - une dot d'état par projet (diffusion en cours / bloquée, session
//     active) issue de `projectSessions` : l'état des sessions par projet est
//     déjà remonté par App.tsx pour la sidebar — aucun impact backend/WS ;
//   - suppression à la volée (poubelle au survol, confirmation portée par la
//     DeleteProjectModal de la Sidebar).
// Le clic sur un projet bascule via onSelectProject (mécanisme existant :
// les sessions des autres projets continuent de tourner en parallèle — ce
// composant ne change que le projet AFFICHÉ).
//
// Pattern dropdown : ModelQuickSwitch (createPortal(document.body) en
// position FIXED via useAnchorPosition, fermeture au clic extérieur et à
// Escape). Particularité : ancrage à GAUCHE du bloc — la sidebar est étroite,
// un ancrage à droite ferait sortir le menu de l'écran (même logique que
// LinkedProjectMenu) ; on borne donc la largeur et on clampe le bord gauche.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Folder, Link2, Trash2 } from "lucide-react";
import { useTranslation } from "../../i18n";
import { useAnchorPosition } from "../../hooks/useAnchorPosition";
import type { Project } from "../../types";

const MENU_WIDTH = 260;

// Sous-ensemble de l'état de session par projet (remonté par App.tsx via la
// prop projectSessions de la Sidebar) lu pour les indicateurs.
export interface ProjectSessionInfo {
  isStreaming: boolean;
  session: any;
  stats: any;
  lastEventAt: number;
}

// Dots d'état d'un projet (même convention qu'avant la refonte) :
//   - diffusion en cours : dot pulsée accent (verte dans le thème hacker) ;
//   - diffusion bloquée : dot ambre (BUG-72 : seuil 60s, cf. App.tsx) ;
//   - session active sans diffusion : dot info atténuée.
export function SessionDots({ state }: { state?: ProjectSessionInfo }) {
  const { t } = useTranslation();
  if (!state) return null;
  const isStreaming = state.isStreaming;
  const hasSession = !!state.session;
  const streamingStalled = isStreaming && state.lastEventAt
    ? Date.now() - state.lastEventAt > 60_000
    : false;
  return (
    <>
      {isStreaming && !streamingStalled && (
        <span className="pulse-dot w-1.5 h-1.5 rounded-full bg-hacker-accent shrink-0" title={t('sidebar.streaming')} />
      )}
      {isStreaming && streamingStalled && (
        <span className="w-1.5 h-1.5 rounded-full bg-hacker-warn shrink-0" title={t('sidebar.streamingStalled')} />
      )}
      {hasSession && !isStreaming && (
        <span className="w-1.5 h-1.5 rounded-full bg-hacker-info/50 shrink-0" title={t('sidebar.sessionActive')} />
      )}
    </>
  );
}

interface Props {
  projects: Project[];
  activeProject: Project | null;
  projectSessions?: Map<string, ProjectSessionInfo>;
  onSelectProject: (p: Project) => void;
  // Suppression : ouvre la modale de confirmation (détenue par Sidebar).
  onDeleteProject: (p: Project) => void;
  // Menu de gestion du placeholder LIÉ courant (lier/délier + toggle origines).
  onOpenLinkedMenu?: (p: Project, anchor: HTMLElement) => void;
}

export function ProjectSwitcher({
  projects,
  activeProject,
  projectSessions,
  onSelectProject,
  onDeleteProject,
  onOpenLinkedMenu,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);   // bloc (pour clic extérieur)
  const buttonRef = useRef<HTMLButtonElement>(null); // zone cliquable ancre
  const dropdownRef = useRef<HTMLDivElement>(null);  // dropdown porté dans <body>
  const searchRef = useRef<HTMLInputElement>(null);

  // Position « fixed » du dropdown porté — recalculée à l'ouverture, au scroll
  // (capture) et au resize tant que le menu est ouvert (pattern ModelQuickSwitch).
  const pos = useAnchorPosition(() => buttonRef.current, open, 4, "project-switcher");
  // pos.right = clientWidth - rect.right → on en déduit le bord droit du bloc
  // (lecture de clientWidth au render : dérivée de pos, déjà ré-émise par le
  // hook au scroll/resize, donc re-render à chaque changement pertinent).
  const vw = pos ? document.documentElement.clientWidth : 0;
  const left = pos
    ? Math.max(8, Math.min(vw - pos.right - MENU_WIDTH, vw - MENU_WIDTH - 8))
    : 0;

  // Fermeture : clic extérieur (hors bloc ET hors dropdown porté) + Escape
  // (pattern ModelQuickSwitch/MobileHeaderMenu).
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside =
        (wrapperRef.current && wrapperRef.current.contains(target)) ||
        (dropdownRef.current && dropdownRef.current.contains(target));
      if (!inside) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // À l'ouverture : recherche réinitialisée + focus du champ (après montage
  // du portail) — le clavier est immédiatement opérationnel.
  useEffect(() => {
    if (!open) return;
    setSearch("");
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Filtrage par nom (insensible à la casse) — l'ordre de la liste backend
  // (ordre persisté) est préservé.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, search]);

  return (
    <div ref={wrapperRef} className="relative">
      {/* Bloc compact : icône + nom + [lien] + chevron */}
      <div
        className={`flex items-center gap-1 border rounded px-1 py-1 transition-colors ${
          open
            ? "border-hacker-accent/50 bg-hacker-accent/5"
            : "border-hacker-border bg-hacker-surface/40 hover:border-hacker-accent/40"
        }`}
      >
        <button
          ref={buttonRef}
          onClick={() => setOpen((o) => !o)}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
          title={t('sidebar.switchProject')}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <Folder size={12} className="text-hacker-accent shrink-0" />
          <span className="truncate text-xs font-bold text-hacker-text">
            {activeProject?.name ?? t('sidebar.noProjects')}
          </span>
        </button>

        {/* Projet LIÉ actif : accès direct au menu de gestion (lier/délier +
            toggle origines) — remplace l'ancien clic sur la ligne du placeholder.
            On ferme le dropdown pour éviter deux portails z-60 superposés. */}
        {activeProject?.storage === "linked" && onOpenLinkedMenu && (
          <button
            onClick={(e) => { setOpen(false); onOpenLinkedMenu(activeProject, e.currentTarget); }}
            className="p-0.5 text-hacker-text-dim/70 hover:text-hacker-accent shrink-0"
            title={t('sidebar.linkedMenu.menuHint')}
            aria-label={t('sidebar.linkedMenu.menuHint')}
          >
            <Link2 size={11} />
          </button>
        )}

        <ChevronDown
          size={12}
          className={`text-hacker-text-dim shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </div>

      {/* Dropdown — porté dans <body> en position FIXED pour éviter tout
          clipping par la sidebar (overflow-y-auto) ; z-index 60 au-dessus du
          drawer mobile z-50 / overlay z-40. Ancrage à gauche (cf. en-tête). */}
      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            top: pos.top,
            left,
            zIndex: 60,
            width: MENU_WIDTH,
            maxHeight: `calc(100vh - ${pos.top}px - 8px)`,
          }}
          className="flex flex-col bg-hacker-surface border border-hacker-border-bright shadow-lg"
        >
          {/* Recherche (filtre par nom) */}
          <div className="p-1.5 border-b border-hacker-border/50 shrink-0">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('sidebar.searchProject')}
              className="w-full bg-hacker-bg border border-hacker-border px-2 py-1 text-xs text-hacker-text placeholder:text-hacker-text-dim/50 focus:outline-none focus:border-hacker-accent/50"
              aria-label={t('sidebar.searchProject')}
            />
          </div>

          {/* Liste de TOUS les projets (l'ordre backend est conservé) */}
          <div className="flex-1 min-h-0 overflow-y-auto" role="listbox">
            {filtered.map((p) => {
              const isCurrent = activeProject?.id === p.id;
              return (
                <div key={p.id} className="flex items-center group">
                  <button
                    onClick={() => { onSelectProject(p); setOpen(false); }}
                    className={`flex-1 min-w-0 text-left pl-3 pr-1 py-1 flex items-center gap-1.5 text-xs ${
                      isCurrent
                        ? "text-hacker-accent"
                        : "text-hacker-text-dim hover:bg-hacker-border/30 hover:text-hacker-text"
                    }`}
                    role="option"
                    aria-selected={isCurrent}
                  >
                    {p.storage === "linked" && (
                      <Link2 size={10} className="shrink-0 opacity-60" />
                    )}
                    <span className="truncate flex-1">{p.name}</span>
                    <SessionDots state={projectSessions?.get(p.id)} />
                    {isCurrent && <Check size={12} className="shrink-0" />}
                  </button>
                  {/* Suppression (au survol) — la confirmation reste dans la
                      Sidebar via DeleteProjectModal ; on ferme le dropdown, la
                      modale prenant le focus. */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setOpen(false); onDeleteProject(p); }}
                    className="px-1.5 py-1 text-hacker-text-dim/0 group-hover:text-hacker-error/70 hover:!text-hacker-error transition-colors shrink-0"
                    title={t('sidebar.deleteProject')}
                    aria-label={t('sidebar.deleteProject')}
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[11px] italic text-hacker-text-dim">
                {t('sidebar.noProjects')}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}