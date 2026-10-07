// ── ThemePicker — sélecteur de THÈME de Pi-Web ───────────────────────────────
// Pi-Web n'affiche QUE les thèmes de la brique `tokens` de holaf-lib : une
// FAMILLE (identité `matrix` puis les 6 familles couleur) + le MODE sombre/clair
// → preset appliqué `<famille>-<mode>` (défaut `matrix-dark`). Aucun thème maison.
//
// • Déclencheur : pastille de couleur + NOM de la famille courante (ex. « ● MATRIX »).
// • Panneau (createPortal + useAnchorPosition) :
//     – nom du preset réellement appliqué (ex. `matrix-dark`) ;
//     – mode segmenté Sombre / Clair — le bouton ☀/☾ du header passe par le
//       MÊME état (App.tsx), les deux restent donc synchronisés ;
//     – liste des familles : pastille + nom + sous-titre `<famille>-dark · <famille>-light`,
//       ligne active encadrée et cochée, badge « DÉFAUT » sur Matrix ;
//     – toggle Scanlines (conservé) ;
//     – note de migration des anciens accents/thèmes.
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../i18n";
import { useAnchorPosition } from "../../hooks/useAnchorPosition";
import {
  PI_WEB_THEMES,
  DEFAULT_THEME_ID,
  themePackNameFor,
  themeSwatchColor,
  type PiWebThemeId,
} from "../../theme/pi-web-theme";

export interface ThemePickerProps {
  theme: "dark" | "light";
  themeName: PiWebThemeId;
  scanlines: boolean;
  onThemeChange: (id: PiWebThemeId) => void;
  onModeChange: (mode: "dark" | "light") => void;
  onScanlinesToggle: () => void;
}

export function ThemePicker({
  theme,
  themeName,
  scanlines,
  onThemeChange,
  onModeChange,
  onScanlinesToggle,
}: ThemePickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null); // wrapper bouton (clic extérieur)
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Position « fixed » du menu porté dans <body> — calculée depuis le bouton et
  // re-suivie au scroll/resize tant que le menu est ouvert (pattern
  // ModelQuickSwitch/MobileHeaderMenu/ancien AccentPicker).
  const pos = useAnchorPosition(() => buttonRef.current, open);

  // Fermeture au clic extérieur : on vérifie le wrapper du bouton ET le menu
  // porté (hors du wrapper, dans <body>).
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

  const current = PI_WEB_THEMES.find((def) => def.id === themeName) ?? PI_WEB_THEMES[0];
  const currentLabel = t(current.labelKey);
  const currentColor = themeSwatchColor(current.id, theme);
  const currentPack = themePackNameFor(current.id, theme);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className="btn-hacker text-xs px-1.5 py-0.5 flex items-center gap-1"
        title={t('themes.trigger')}
        aria-label={`${t('themes.trigger')} — ${currentLabel}`}
        aria-expanded={open}
        data-testid="theme-picker-trigger"
      >
        <span
          className="inline-block w-2.5 h-2.5 rounded-full border border-hacker-border-bright shrink-0"
          style={{ backgroundColor: currentColor }}
        />
        <span data-testid="theme-picker-current">{currentLabel}</span>
      </button>

      {/* Menu porté dans <body> (createPortal) : sans ça, le header étant en
          `overflow-x-auto`, le menu absolu débordait de la barre et y faisait
          apparaître une barre de défilement. */}
      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          data-testid="theme-picker-panel"
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 60 }}
          className="p-2 border border-hacker-border bg-hacker-surface-raised shadow-lg space-y-2 w-[262px] max-h-[75vh] overflow-y-auto"
        >
          {/* En-tête : titre + preset de la brique réellement appliqué */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] tracking-widest text-hacker-accent">{t('themes.title')}</span>
            <span className="text-[9px] text-hacker-text-dim truncate" data-testid="theme-picker-pack">
              {currentPack}
            </span>
          </div>

          {/* Mode sombre / clair — MÊME état que le bouton ☀/☾ du header */}
          <div className="flex border border-hacker-border" role="group" aria-label={t('themes.mode')}>
            <button
              type="button"
              onClick={() => onModeChange("dark")}
              aria-pressed={theme === "dark"}
              data-testid="theme-mode-dark"
              className={`flex-1 text-[11px] py-0.5 transition-colors ${
                theme === "dark"
                  ? "text-hacker-accent bg-hacker-accent/10 shadow-[inset_0_-2px_0_var(--accent)]"
                  : "text-hacker-text-dim hover:text-hacker-text"
              }`}
            >
              ☾ {t('themes.dark')}
            </button>
            <button
              type="button"
              onClick={() => onModeChange("light")}
              aria-pressed={theme === "light"}
              data-testid="theme-mode-light"
              className={`flex-1 text-[11px] py-0.5 transition-colors ${
                theme === "light"
                  ? "text-hacker-accent bg-hacker-accent/10 shadow-[inset_0_-2px_0_var(--accent)]"
                  : "text-hacker-text-dim hover:text-hacker-text"
              }`}
            >
              ☀ {t('themes.light')}
            </button>
          </div>

          {/* Familles de la brique holaf-lib (identité Matrix + familles couleur) */}
          <div className="space-y-0.5">
            {PI_WEB_THEMES.map((def) => {
              const isActive = def.id === themeName;
              return (
                <button
                  type="button"
                  key={def.id}
                  onClick={() => onThemeChange(def.id)}
                  aria-pressed={isActive}
                  data-testid={`theme-option-${def.id}`}
                  className={`w-full flex items-center gap-2 px-1.5 py-1 border text-left transition-colors ${
                    isActive
                      ? "border-hacker-accent bg-hacker-accent/10"
                      : "border-transparent hover:border-hacker-border hover:bg-hacker-border/20"
                  }`}
                >
                  <span
                    className="inline-block w-3 h-3 rounded-full border border-hacker-border-bright shrink-0"
                    style={{ backgroundColor: themeSwatchColor(def.id, theme) }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-xs truncate ${isActive ? "text-hacker-accent" : "text-hacker-text-bright"}`}>
                      {t(def.labelKey)}
                      {def.id === DEFAULT_THEME_ID && (
                        <span className="ml-1 text-[8px] px-1 border border-hacker-accent/60 text-hacker-accent tracking-wider align-middle">
                          {t('themes.defaultBadge')}
                        </span>
                      )}
                    </span>
                    <span className="block text-[9px] text-hacker-text-dim truncate">
                      {`${def.id}-dark · ${def.id}-light`}
                    </span>
                  </span>
                  <span className="text-hacker-accent text-[11px] w-3 text-center shrink-0">{isActive ? "✓" : ""}</span>
                </button>
              );
            })}
          </div>

          {/* Scanlines — toggle conservé à l'identique */}
          <button
            type="button"
            onClick={onScanlinesToggle}
            data-testid="theme-scanlines-toggle"
            className={`w-full flex items-center gap-2 px-1 py-0.5 pt-1.5 text-xs border-t border-hacker-border transition-colors ${
              scanlines ? "text-hacker-accent" : "text-hacker-text-dim"
            }`}
          >
            <span className={`w-3 h-3 rounded border flex items-center justify-center text-[8px] ${
              scanlines ? "border-hacker-accent bg-hacker-accent/20" : "border-hacker-border"
            }`}>
              {scanlines ? "✓" : ""}
            </span>
            {t('themes.scanlines')}
          </button>

          {/* Note de migration (anciens accents/thèmes repris en familles de la brique) */}
          <div className="text-[9px] leading-snug text-hacker-text-dim border-l-2 border-hacker-accent/60 bg-hacker-bg/40 px-1.5 py-1">
            {t('themes.migrationNote')}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
