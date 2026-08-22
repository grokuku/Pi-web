import { ModalDialog } from "../common/ModalDialog";
import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Power, Star, Settings } from "lucide-react";
import { PiLogo } from "../common/PiLogo";
import { useTranslation } from "../../i18n";
import { useAnchorPosition } from "../../hooks/useAnchorPosition";
import { RoutingConfigModal } from "../Modals/RoutingConfigModal";
import type { ModelLibrary, RegisteredModel, AgentMode, ProjectModeConfig, ProviderConfig, RoutingConfig } from "../../types";

const MODE_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string; activeBg: string; activeBorder: string }> = {
  code:   { icon: <PiLogo className="w-3.5 h-3.5 inline" />, label: "DEFAULT",  color: "text-hacker-accent",   activeBg: "bg-hacker-accent/20", activeBorder: "border-hacker-accent" },
  harness: { icon: "🏭", label: "ROUTING", color: "text-hacker-accent", activeBg: "bg-hacker-accent/20", activeBorder: "border-hacker-accent" },
};

interface Props {
  activeMode?: string;
  activeProjectId?: string;
  modelChangeVersion?: number;
  onModeSwitch?: (mode: AgentMode) => void;
  onModelApplied?: () => void;
  /** Current session info (for context usage checks) */
  session?: any;
}

export function ModelQuickSwitch({ activeMode, activeProjectId, modelChangeVersion, onModeSwitch, onModelApplied, session }: Props) {
  const { t } = useTranslation();
  const [openMode, setOpenMode] = useState<AgentMode | null>(null);
  const [library, setLibrary] = useState<ModelLibrary | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [showRoutingConfig, setShowRoutingConfig] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Réf. des boutons par mode (pour calculer la position du dropdown porté)
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Position « fixed » du dropdown porté — recalculée au clic, au scroll et au
  // resize tant que le menu est ouvert (pattern useAnchorPosition).
  const pos = useAnchorPosition(() => (openMode ? buttonRefs.current[openMode] : null), !!openMode);

  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/model-library");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLibrary(data && typeof data === "object" && !Array.isArray(data) ? data : null);
    } catch (e) { console.error("[ModelQuickSwitch] Failed to load model library:", e); }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProviders(Array.isArray(data) ? data : []);
    } catch (e) { console.error("[ModelQuickSwitch] Failed to load providers:", e); }
  }, []);

  useEffect(() => { loadLibrary(); loadProviders(); }, [loadLibrary, loadProviders]);
  // Reload when models change externally (e.g. from ModelLibraryModal)
  useEffect(() => { loadLibrary(); }, [modelChangeVersion, loadLibrary]);

  // Close on click outside — vérifie à la fois le bouton (ref) et le dropdown
  // porté dans <body> (pattern MobileHeaderMenu).
  useEffect(() => {
    if (!openMode) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside =
        (ref.current && ref.current.contains(target)) ||
        (dropdownRef.current && dropdownRef.current.contains(target));
      if (!inside) setOpenMode(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openMode]);

  // Get project mode config
  const pm: ProjectModeConfig = activeProjectId
    ? (library?.projectModes?.[activeProjectId] || defaultProjectMode())
    : defaultProjectMode();

  const getModelForMode = (mode: AgentMode): RegisteredModel | null => {
    const modelId = (pm as any)[mode]?.modelId;
    if (modelId && library) {
      const m = library.models.find(m => m.id === modelId);
      if (m) return m;
    }
    // Fall back to default model
    if (library?.defaultModelId) {
      return library.models.find(m => m.id === library.defaultModelId) || null;
    }
    return library?.models[0] || null;
  };

  const [compactConfirm, setCompactConfirm] = useState<{ mode: AgentMode; modelId: string; currentTokens: number; newWindow: number } | null>(null);

  const handleSelectModel = async (mode: AgentMode, modelId: string) => {
    if (!activeProjectId) return;
    // Check context window size
    const targetModel = library?.models.find(m => m.id === modelId);
    const currentTokens = session?.contextUsage?.tokens;
    if (targetModel?.contextWindow && currentTokens && currentTokens > targetModel.contextWindow) {
      // Show confirmation dialog
      setCompactConfirm({ mode, modelId, currentTokens, newWindow: targetModel.contextWindow });
      return;
    }
    // No conflict — switch immediately
    await doSwitchModel(mode, modelId, false);
    setOpenMode(null);
  };

  /** Actually perform the model switch, optionally with compactToFit */
  const doSwitchModel = async (mode: AgentMode, modelId: string, compactToFit: boolean) => {
    if (!activeProjectId) return;
    try {
      await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, modelId, compactToFit }),
      });
      await loadLibrary();
      onModelApplied?.();
    } catch (e) { console.error("[ModelQuickSwitch] Failed to switch model:", e); }
  };

  const handleToggleMode = async (e: React.MouseEvent, mode: "harness") => {
    e.stopPropagation();
    if (!activeProjectId) return;
    const modeCfg = (pm as any)[mode] as { enabled: boolean };
    const newEnabled = !modeCfg.enabled;
    try {
      await fetch(`/api/model-library/projects/${activeProjectId}/mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, enabled: newEnabled }),
      });
      await loadLibrary();
      onModelApplied?.();

      // Si on active HARNESS, basculer aussi vers ce mode
      if (mode === "harness" && newEnabled) {
        onModeSwitch?.(mode);
      }

      // If disabling and was active, switch back to code
      if (!newEnabled && activeMode === mode) {
        onModeSwitch?.("code");
      }
    } catch (e) { console.error("[ModelQuickSwitch] Failed to toggle mode:", e); }
  };

  const handleChipClick = (mode: AgentMode) => {
    if (openMode === mode) { setOpenMode(null); return; }
    // La position du dropdown est calculée par useAnchorPosition à l'ouverture
    // (et re-suivie au scroll/resize), depuis le bouton du mode cliqué.
    setOpenMode(mode);
  };

  const getShortModelName = (model: RegisteredModel | null): string => {
    if (!model) return "—";
    return model.name || model.id;
  };

  const getProviderName = (providerId: string): string => {
    const p = providers.find(p => p.id === providerId);
    if (!p) return "";
    const name = p.name || p.type || providerId;
    if (name.length <= 15) return name;
    return name.slice(0, 12) + "…";
  };

  const modes: AgentMode[] = ["code", "harness"];

  return (
    <>
    <div ref={ref} className="flex items-center gap-1.5">
      {modes.map((mode) => {
        const cfg = MODE_CONFIG[mode];
        const model = getModelForMode(mode);
        const isCode = mode === "code";
        const modeCfg = mode !== "code" ? (pm as any)[mode] : null;
        const isEnabled = isCode || (modeCfg?.enabled ?? false);
        const isActive = activeMode === mode && isEnabled;
        const isDropdownOpen = openMode === mode;

        // Visual states
        const isHarnessActive = pm.harness.enabled && (activeMode === "harness");
        const isOverridden = !isCode && (isHarnessActive && mode !== "harness");
        // Seul le mode actif doit être visuellement allumé — pas juste "enabled"
        const isVisuallyActive = isActive;

        return (
          <div key={mode} className="relative">
            {/* Main button — integrated ON/OFF */}
            <button
              ref={(el) => { buttonRefs.current[mode] = el; }}
              className={`flex items-center border rounded transition-all ${
                isVisuallyActive
                  ? `${cfg.activeBg} ${cfg.activeBorder} ${cfg.color}`
                  : isOverridden
                  ? "bg-hacker-bg border-hacker-border/50 text-hacker-text-dim/50"
                  : isEnabled
                  ? "bg-hacker-bg border-hacker-border text-hacker-text-dim"
                  : "bg-hacker-bg border-hacker-border/40 text-hacker-text-dim/50"
              }`}
              onClick={() => handleChipClick(mode)}
            >
              {/* ON/OFF toggle zone (left part of button) */}
              {!isCode && (
                <div
                  onClick={(e) => handleToggleMode(e, mode as "harness")}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); handleToggleMode(e as any, mode as "harness"); } }}
                  className={`px-2 py-1 border-r transition-colors cursor-pointer ${
                    isEnabled
                      ? `border-hacker-border/60 ${cfg.color}`
                      : "border-hacker-border/20 text-hacker-text-dim/30 hover:text-hacker-text-dim"
                  }`}
                  title={isEnabled ? t('modelSwitch.disable', t('modelSwitch.' + mode)) : t('modelSwitch.enable', t('modelSwitch.' + mode))}
                >
                  <Power size={10} />
                </div>
              )}

              <div className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer ${
                isVisuallyActive ? "" : isOverridden ? "opacity-40" : ""
              }`}>
                <span className={`text-xs ${isVisuallyActive ? cfg.color : ""}`}>{cfg.icon}</span>
                <span className={`text-xs font-bold tracking-wide ${
                  isVisuallyActive ? cfg.color : "text-hacker-text-dim"
                }`}>
                  {t('modelSwitch.' + mode)}
                </span>
                {isVisuallyActive && (
                  <span className="text-xs text-hacker-text-dim">{getShortModelName(model)}</span>
                )}
                <ChevronDown size={10} className={`text-hacker-text-dim transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} />
              </div>
            </button>

            {/* Dropdown — porté dans <body> en position FIXED (calculée depuis
                le bouton) pour éviter le clipping par le header (h-10 +
                overflow-x-auto). z-index 60 au-dessus du drawer z-50 / overlay z-40. */}
            {isDropdownOpen && pos && createPortal(
              <div
                ref={dropdownRef}
                style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 60 }}
                className="w-[350px] bg-hacker-surface border border-hacker-border-bright shadow-lg"
              >
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-hacker-bg/50 border-b border-hacker-border/50">
                  <span className={`text-xs font-bold tracking-wider ${isEnabled ? cfg.color : "text-hacker-text-dim"}`}>
                    {cfg.icon} {t('modelSwitch.' + mode)} {isCode ? t('modelSwitch.alwaysOn') : isEnabled ? "● ON" : "○ OFF"}
                  </span>
                </div>

                {/* Modèle : affiché pour tous les modes (code ET harness/orchestrateur). */}
                {mode === "harness" && (
                  <div className="px-3 py-1.5 text-[11px] text-hacker-text-dim border-b border-hacker-border/30">
                    Orchestrateur — les fonctions utilisent les modèles du routage (⚙ ci-dessous)
                  </div>
                )}
                {library && library.models.length > 0 ? (
                  <div className="max-h-[300px] overflow-y-auto">
                    {[...library.models].sort((a, b) => a.name.localeCompare(b.name)).map((m) => {
                      const isModelSelected = m.id === (pm as any)[mode]?.modelId;
                      const isDefault = m.id === library.defaultModelId;
                      return (
                        <button
                          key={m.id}
                          onClick={() => handleSelectModel(mode, m.id)}
                          className={`w-full text-left px-3 py-1 text-xs flex items-center gap-1.5 ${
                            isModelSelected
                              ? `bg-hacker-accent/10 ${cfg.color}`
                              : "text-hacker-text-dim hover:bg-hacker-border/30 hover:text-hacker-text"
                          }`}>
                          <Star size={8} className={isDefault ? "text-hacker-accent fill-hacker-accent shrink-0" : "text-transparent shrink-0"} />
                          <span className="truncate flex-1">{m.name}</span>
                          {m.providerId && getProviderName(m.providerId) && <span className="text-[10px] text-hacker-text-dim shrink-0">({getProviderName(m.providerId)})</span>}
                          <span className="flex items-center gap-1 shrink-0">{m.vision && <span className="text-[10px]" title="Vision">👁️</span>}{m.reasoning && <span className="text-[10px]" title="Reasoning">🧠</span>}<span className="text-[8px] text-hacker-text-dim/60" title="Context window">{fmtCtx(m.contextWindow)}</span></span>
                          {isModelSelected && <span className={`${cfg.color} text-[10px] shrink-0`}>●</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-3 py-1.5 text-[11px] text-hacker-text-dim italic">
                    No models configured
                  </div>
                )}

                {/* Switch to mode button (if enabled and not active) */}
                {isEnabled && !isActive && model && (
                  <button
                    onClick={() => { onModeSwitch?.(mode); setOpenMode(null); }}
                    className={`w-full text-left px-3 py-1.5 text-xs ${cfg.color} font-bold border-t border-hacker-border/30 hover:bg-hacker-accent/5`}>
                    → {t('modelSwitch.switchTo', t('modelSwitch.' + mode))}
                  </button>
                )}

                {/* Bouton de configuration du routage */}
                {mode === "harness" && (
                  <button
                    onClick={() => { setShowRoutingConfig(true); setOpenMode(null); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-hacker-text-dim border-t border-hacker-border/30 hover:bg-hacker-accent/5 flex items-center gap-1.5"
                  >
                    <Settings size={10} />
                    ⚙ CONFIGURER LE ROUTAGE
                  </button>
                )}

              </div>,
              document.body
            )}
          </div>
        );
      })}

    </div>

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

      {/* Compact confirmation modal */}
      {compactConfirm && (
        <ModalDialog id="compact-confirm" onClose={() => setCompactConfirm(null)}>
          <div className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">📦</span>
              <span className="text-hacker-warn font-bold text-sm tracking-wider">
                CONTEXT TOO LARGE
              </span>
            </div>

            <div className="text-sm space-y-2 mb-6">
              <p className="text-hacker-text">
                This model has a <strong className="text-hacker-error">smaller context window</strong> than your current conversation size.
              </p>
              <div className="bg-hacker-bg/50 border border-hacker-border p-3 text-xs space-y-1">
                <div className="text-hacker-text-dim">
                  Current context: <span className="text-hacker-accent">{fmtCtx(compactConfirm.currentTokens)}</span>
                </div>
                <div className="text-hacker-text-dim">
                  New model's window: <span className="text-hacker-error">{fmtCtx(compactConfirm.newWindow)}</span>
                </div>
              </div>
              <p className="text-hacker-text-dim text-xs">
                You can compact the conversation first to fit within the smaller window, preserving key information.
              </p>
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => setCompactConfirm(null)} className="btn-hacker text-xs">
                CANCEL
              </button>
              <button
                onClick={async () => {
                  const { mode, modelId } = compactConfirm;
                  setCompactConfirm(null);
                  await doSwitchModel(mode, modelId, true);
                  setOpenMode(null);
                }}
                className="btn-hacker danger text-xs"
              >
                COMPACT &amp; SWITCH
              </button>
            </div>
          </div>
        </ModalDialog>
      )}
    </>
  );
}

function defaultProjectMode(): ProjectModeConfig {
  return {
    code: { modelId: null },
    harness: { modelId: null, enabled: false,
      config: { agents: [], synthesize: true } },
  };
}

function fmtCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
}