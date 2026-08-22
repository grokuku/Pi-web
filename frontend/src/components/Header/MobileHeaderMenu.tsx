// ── MobileHeaderMenu ─────────────────────────────────
// Menu « ⋯ » pour mobile (md:hidden) — rendu par l'appelant à droite du
// header. Le dropdown est rendu via createPortal(document.body) en position
// FIXED (calculée depuis le bouton) pour ne pas être clippé par le header
// (h-10 + overflow-x-auto). Fermeture au clic extérieur (pattern ModelQuickSwitch).
//
// Contenu :
//   1. Section PANNEAUX : 3 boutons compacts PI/TERM/FILES (toggle visible)
//   2. Section MODE : 2 chips default/harness (basculent le mode actif)
//   3. Bouton « ⚙ Configurer le routage » : ouvre RoutingConfigModal en
//      auto-chargeant /api/model-library et /api/providers, puis sauvegarde
//      via PUT /api/model-library/projects/{id}/mode (mode harness).

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../i18n";
import { useAnchorPosition } from "../../hooks/useAnchorPosition";
import { RoutingConfigModal } from "../Modals/RoutingConfigModal";
import type { PanelId, AgentMode, ModelLibrary, ProviderConfig, ProjectModeConfig, RoutingConfig } from "../../types";

export interface PanelState {
  visible: boolean;
  floating: boolean;
}

interface Props {
  panels: Record<PanelId, PanelState>;
  onTogglePanel: (id: PanelId) => void;
  activeMode?: string;
  onModeSwitch?: (mode: AgentMode) => void;
  activeProjectId?: string;
  onModelApplied?: () => void;
}

export function MobileHeaderMenu({ panels, onTogglePanel, activeMode, onModeSwitch, activeProjectId, onModelApplied }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showRoutingConfig, setShowRoutingConfig] = useState(false);
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const ref = useRef<HTMLDivElement>(null);       // wrapper bouton (pour clic extérieur)
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Position « fixed » du dropdown porté — recalculée à l'ouverture, au scroll
  // et au resize tant que le menu est ouvert (pattern useAnchorPosition).
  const pos = useAnchorPosition(() => buttonRef.current, open);

  // Fermeture au clic extérieur (pattern ModelQuickSwitch). On vérifie à la
  // fois le wrapper du bouton ET le dropdown porté dans <body>.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside =
        (ref.current && ref.current.contains(target)) ||
        (dropdownRef.current && dropdownRef.current.contains(target));
      if (!inside) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLibrary(data && typeof data === "object" && !Array.isArray(data) ? data : null);
    } catch (e) { console.error("[MobileHeaderMenu] Failed to load model library:", e); }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProviders(Array.isArray(data) ? data : []);
    } catch (e) { console.error("[MobileHeaderMenu] Failed to load providers:", e); }
  }, []);

  // On pré-charge la bibliothèque/providers dès l'ouverture pour que le
  // RoutingConfigModal s'affiche avec les données à jour.
  useEffect(() => {
    if (showRoutingConfig) {
      loadLibrary();
      loadProviders();
    }
  }, [showRoutingConfig, loadLibrary, loadProviders]);

  const pm: ProjectModeConfig = activeProjectId
    ? (library?.projectModes?.[activeProjectId] || defaultProjectMode())
    : defaultProjectMode();

  const panelIds: PanelId[] = ["pi", "terminal", "files"];

  const toggle = () => {
    // La position du dropdown est calculée par useAnchorPosition à l'ouverture
    // (et re-suivie au scroll/resize), depuis le bouton ⋯.
    setOpen((o) => !o);
  };

  // Aligné sur la logique desktop de ModelQuickSwitch : pour HARNESS on fait
  // d'abord un PUT /api/model-library/projects/{id}/mode { mode, enabled }
  // PUIS on bascule le mode ; si désactivation du mode actif, on retombe sur
  // code. Le mode « code » est toujours activé → simple mode_switch.
  const handleToggleMode = async (mode: AgentMode) => {
    if (mode === "code") {
      onModeSwitch?.(mode);
      setOpen(false);
      return;
    }
    if (!activeProjectId) return;
    const modeCfg = (pm as any)[mode] as { enabled: boolean } | undefined;
    const newEnabled = !(modeCfg?.enabled ?? false);
    try {
      await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, enabled: newEnabled }),
      });
      await loadLibrary();
      onModelApplied?.();

      // Si on active HARNESS, basculer aussi vers ce mode
      if (newEnabled) {
        onModeSwitch?.(mode);
      }
      // Si on désactive le mode actif, on retombe sur code
      if (!newEnabled && activeMode === mode) {
        onModeSwitch?.("code");
      }
    } catch (e) { console.error("[MobileHeaderMenu] Failed to toggle mode:", e); }
    setOpen(false);
  };

  const handleTogglePanel = (id: PanelId) => {
    onTogglePanel(id);
    setOpen(false);
  };

  return (
    <>
      <div ref={ref} className="relative">
        {/* Bouton « ⋯ » */}
        <button
          ref={buttonRef}
          onClick={toggle}
          className="btn-hacker text-xs px-2 py-1"
          title={t('mobileMenu.label')}
          aria-label={t('mobileMenu.label')}
          aria-expanded={open}
        >
          ⋯
        </button>

        {/* Dropdown — porté dans <body> pour éviter le clipping par le header */}
        {open && pos &&
          createPortal(
            <div
              ref={dropdownRef}
              style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 60 }}
              className="w-[220px] bg-hacker-surface border border-hacker-border-bright shadow-lg"
            >
              {/* Section PANNEAUX */}
              <div className="px-3 pt-2 pb-1 text-[10px] text-hacker-text-dim font-bold tracking-wider">
                {t('mobileMenu.panels')}
              </div>
              <div className="px-2 pb-2 flex flex-col gap-1">
                {panelIds.map((id) => {
                  const panel = panels[id] ?? { visible: false, floating: false };
                  const isOn = panel.visible && !panel.floating;
                  return (
                    <button
                      key={id}
                      onClick={() => handleTogglePanel(id)}
                      className={`text-left text-xs px-2 py-1 border font-bold tracking-wide transition-all ${
                        isOn
                          ? "border-hacker-accent text-hacker-accent bg-hacker-accent/10"
                          : "border-transparent text-hacker-text-dim hover:text-hacker-text hover:border-hacker-border"
                      }`}
                      title={isOn ? t('header.hidePanel', PANEL_SHORT[id]) : t('header.showPanel', PANEL_SHORT[id])}
                    >
                      {isOn ? `[${PANEL_SHORT[id]}]` : PANEL_SHORT[id]}
                    </button>
                  );
                })}
              </div>

              <div className="border-t border-hacker-border/30" />

              {/* Section MODE */}
              <div className="px-3 pt-2 pb-1 text-[10px] text-hacker-text-dim font-bold tracking-wider">
                {t('mobileMenu.mode')}
              </div>
              <div className="px-2 pb-2 flex gap-1">
                {(["code", "harness"] as AgentMode[]).map((mode) => {
                  const isActive = activeMode === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => handleToggleMode(mode)}
                      className={`flex-1 text-xs px-2 py-1 border font-bold tracking-wide transition-all ${
                        isActive
                          ? "bg-hacker-accent/20 border-hacker-accent text-hacker-accent"
                          : "border-hacker-border text-hacker-text-dim hover:text-hacker-text"
                      }`}
                    >
                      {t('modelSwitch.' + mode)}
                    </button>
                  );
                })}
              </div>

              <div className="border-t border-hacker-border/30" />

              {/* Bouton Configurer le routage */}
              <button
                onClick={() => { setOpen(false); setShowRoutingConfig(true); }}
                className="w-full text-left px-3 py-2 text-xs text-hacker-text-dim hover:bg-hacker-accent/5 hover:text-hacker-text flex items-center gap-1.5"
              >
                {t('mobileMenu.configRouting')}
              </button>
            </div>,
            document.body
          )
        }
      </div>

      {/* RoutingConfigModal — logique identique à ModelQuickSwitch */}
      {showRoutingConfig && (
        <RoutingConfigModal
          onClose={() => setShowRoutingConfig(false)}
          onSave={async (routing: RoutingConfig) => {
            if (!activeProjectId) throw new Error("Aucun projet actif");
            const res = await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: "harness", routing }),
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || `HTTP ${res.status}`);
            }
            await loadLibrary();
            onModelApplied?.();
          }}
          models={library?.models || []}
          providers={providers}
          config={(pm as any)?.harness?.routing || null}
        />
      )}
    </>
  );
}

const PANEL_SHORT: Record<PanelId, string> = {
  pi: "PI",
  terminal: "TERM",
  files: "FILES",
};

function defaultProjectMode(): ProjectModeConfig {
  return {
    code: { modelId: null },
    harness: { modelId: null, enabled: false,
      config: { agents: [], synthesize: true } },
  };
}
