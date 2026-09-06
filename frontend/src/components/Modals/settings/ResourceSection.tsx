import { Puzzle, Lightbulb, Package, Palette, ToggleLeft, ToggleRight } from "lucide-react";
import type { ResourceType } from "./types";

// ── Resource section ────────────────────────────────────

interface ResourceSectionProps {
  type: ResourceType;
  items: string[];
  available: string[];
  onToggle: (type: ResourceType, source: string, enabled: boolean) => void;
  onAdd: (source: string) => void;
  disabled: boolean;
}

const RESOURCE_ICONS: Record<ResourceType, typeof Package> = {
  extensions: Puzzle,
  skills: Lightbulb,
  prompts: Package,
  themes: Palette,
};

const RESOURCE_LABELS: Record<ResourceType, string> = {
  extensions: "Extensions",
  skills: "Skills",
  prompts: "Prompts",
  themes: "Themes",
};

function ResourceSection({ type, items, available, onToggle, onAdd, disabled }: ResourceSectionProps) {
  const Icon = RESOURCE_ICONS[type];
  const label = RESOURCE_LABELS[type];

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} className="text-hacker-accent" />
        <span className="text-xs text-hacker-text-bright font-bold tracking-wider">{label}</span>
        <span className="text-[10px] text-hacker-text-dim">({items.length})</span>
      </div>

      {items.length === 0 && available.length === 0 ? (
        <div className="text-[10px] text-hacker-text-dim pl-4 py-1">No {label.toLowerCase()} configured</div>
      ) : (
        <div className="space-y-1 pl-1">
          {items.map(source => (
            <div key={source} className="flex items-center gap-2 py-1">
              <button onClick={() => onToggle(type, source, false)} disabled={disabled}
                className="text-hacker-accent hover:text-hacker-error shrink-0" title="Disable">
                <ToggleRight size={14} />
              </button>
              <span className="text-xs text-hacker-text-bright font-mono truncate flex-1">{source}</span>
            </div>
          ))}
          {available.filter(a => !items.includes(a)).map(source => (
            <div key={source} className="flex items-center gap-2 py-1 opacity-60">
              <button onClick={() => onAdd(source)} disabled={disabled}
                className="text-hacker-text-dim hover:text-hacker-accent shrink-0" title="Enable">
                <ToggleLeft size={14} />
              </button>
              <span className="text-xs text-hacker-text-dim font-mono truncate flex-1">{source}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ResourceSection;
