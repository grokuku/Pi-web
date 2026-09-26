import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../i18n";
import { useAnchorPosition } from "../../hooks/useAnchorPosition";

// Les labels affichables sont i18nisés via le namespace accentColors.* (clé = id)
const ACCENT_PRESETS = [
  { id: "green", dark: "#00ff41", light: "#166534" },
  { id: "purple", dark: "#c084fc", light: "#8b5cf6" },
  { id: "orange", dark: "#fb923c", light: "#ea580c" },
  { id: "cyan", dark: "#22d3ee", light: "#0891b2" },
  { id: "rose", dark: "#f472b6", light: "#db2777" },
];

interface AccentPickerProps {
  theme: "dark" | "light";
  accent: string;
  scanlines: boolean;
  onAccentChange: (id: string) => void;
  onScanlinesToggle: () => void;
}

export function AccentPicker({ theme, accent, scanlines, onAccentChange, onScanlinesToggle }: AccentPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);      // wrapper bouton (clic extérieur)
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Position « fixed » du menu porté dans <body> — calculée depuis le bouton et
  // re-suivie au scroll/resize tant que le menu est ouvert (pattern
  // ModelQuickSwitch/MobileHeaderMenu).
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

  const current = ACCENT_PRESETS.find((p) => p.id === accent) || ACCENT_PRESETS[0];
  const displayColor = theme === "dark" ? current.dark : current.light;

  return (
    <div className="relative" ref={ref}>
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className="btn-hacker text-xs px-1.5 py-0.5 flex items-center gap-1"
        title={t('header.accentColor')}
        aria-label={t('header.accentColor')}
      >
        <span
          className="inline-block w-2.5 h-2.5 rounded-full border border-hacker-border-bright"
          style={{ backgroundColor: displayColor }}
        />
      </button>

      {/* Menu porté dans <body> (createPortal) : sans ça, le header étant en
          `overflow-x-auto`, le menu absolu débordait de la barre et y faisait
          apparaître une barre de défilement. */}
      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 60 }}
          className="p-2 border border-hacker-border bg-hacker-surface-raised shadow-lg space-y-2 min-w-[140px]"
        >
          {/* Scanlines toggle */}
          <button
            onClick={onScanlinesToggle}
            className={`w-full flex items-center gap-2 px-1 py-0.5 text-xs rounded transition-colors ${
              scanlines ? "text-hacker-accent" : "text-hacker-text-dim"
            }`}
          >
            <span className={`w-3 h-3 rounded border flex items-center justify-center text-[8px] ${
              scanlines ? "border-hacker-accent bg-hacker-accent/20" : "border-hacker-border"
            }`}>
              {scanlines ? "✓" : ""}
            </span>
            Scanlines
          </button>

          {/* Accent colors */}
          <div className="flex gap-1.5 justify-center">
            {ACCENT_PRESETS.map((p) => {
              const color = theme === "dark" ? p.dark : p.light;
              const isActive = accent === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => { onAccentChange(p.id); }}
                  className="w-5 h-5 rounded-full transition-transform hover:scale-110 flex items-center justify-center"
                  style={{ backgroundColor: color }}
                  title={t(`accentColors.${p.id}`)}
                  aria-label={t(`accentColors.${p.id}`)}
                >
                  {isActive && (
                    <span className="text-white text-[8px] font-bold drop-shadow-sm">✓</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}