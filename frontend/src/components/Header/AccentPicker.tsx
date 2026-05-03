import { useState, useRef, useEffect } from "react";

const ACCENT_PRESETS = [
  { id: "green", label: "Vert", dark: "#00ff41", light: "#16a34a" },
  { id: "purple", label: "Violet", dark: "#c084fc", light: "#8b5cf6" },
  { id: "orange", label: "Orange", dark: "#fb923c", light: "#ea580c" },
  { id: "cyan", label: "Cyan", dark: "#22d3ee", light: "#0891b2" },
  { id: "rose", label: "Rose", dark: "#f472b6", light: "#db2777" },
];

interface AccentPickerProps {
  theme: "dark" | "light";
  accent: string;
  onAccentChange: (id: string) => void;
}

export function AccentPicker({ theme, accent, onAccentChange }: AccentPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const current = ACCENT_PRESETS.find((p) => p.id === accent) || ACCENT_PRESETS[0];
  const displayColor = theme === "dark" ? current.dark : current.light;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="btn-hacker text-xs px-1.5 py-0.5 flex items-center gap-1"
        title="Accent color"
      >
        <span
          className="inline-block w-2.5 h-2.5 rounded-full border border-hacker-border-bright"
          style={{ backgroundColor: displayColor }}
        />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 p-1.5 border border-hacker-border bg-hacker-surface-raised shadow-lg z-50 flex gap-1.5">
          {ACCENT_PRESETS.map((p) => {
            const color = theme === "dark" ? p.dark : p.light;
            const isActive = accent === p.id;
            return (
              <button
                key={p.id}
                onClick={() => { onAccentChange(p.id); setOpen(false); }}
                className="w-5 h-5 rounded-full transition-transform hover:scale-110 flex items-center justify-center"
                style={{ backgroundColor: color }}
                title={p.label}
              >
                {isActive && (
                  <span className="text-white text-[8px] font-bold drop-shadow-sm">✓</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}