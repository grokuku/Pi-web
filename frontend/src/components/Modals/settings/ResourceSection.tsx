import { HolafIcon } from "../../icons/HolafIcon";
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

// Nom d'icône de la brique holaf par type de ressource (les icônes sont
// rendues via <HolafIcon>, pas des composants importés).
const RESOURCE_ICONS: Record<ResourceType, string> = {
  extensions: "puzzle",
  skills: "lightbulb",
  prompts: "package",
  themes: "palette",
};

const RESOURCE_LABELS: Record<ResourceType, string> = {
  extensions: "Extensions",
  skills: "Skills",
  prompts: "Prompts",
  themes: "Themes",
};

// Une entrée peut être un motif d'exclusion SDK (« !nom » pour un nom nu,
// « -chemin » pour un chemin exact) : la ressource est alors DÉSACTIVÉE à la
// découverte (docs SDK settings.md). On l'affiche comme telle, sans préfixe.
function parseItem(raw: string): { label: string; disabled: boolean } {
  return raw.startsWith("!") || raw.startsWith("-")
    ? { label: raw.slice(1), disabled: true }
    : { label: raw, disabled: false };
}

function ResourceSection({ type, items, available, onToggle, onAdd, disabled }: ResourceSectionProps) {
  const label = RESOURCE_LABELS[type];
  const itemLabels = items.map(i => parseItem(i).label);

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <HolafIcon name={RESOURCE_ICONS[type]} size={12} className="text-hacker-accent" />
        <span className="text-xs text-hacker-text-bright font-bold tracking-wider">{label}</span>
        <span className="text-[10px] text-hacker-text-dim">({items.length})</span>
      </div>

      {items.length === 0 && available.length === 0 ? (
        <div className="text-[10px] text-hacker-text-dim pl-4 py-1">No {label.toLowerCase()} configured</div>
      ) : (
        <div className="space-y-1 pl-1">
          {items.map(raw => {
            const { label: itemLabel, disabled: isDisabled } = parseItem(raw);
            return isDisabled ? (
              <div key={raw} className="flex items-center gap-2 py-1 opacity-60">
                <button onClick={() => onToggle(type, itemLabel, true)} disabled={disabled}
                  className="text-hacker-text-dim hover:text-hacker-accent shrink-0" title="Enable">
                  <HolafIcon name="toggle-left" size={14} />
                </button>
                <span className="text-xs text-hacker-text-dim font-mono truncate flex-1">{itemLabel}</span>
              </div>
            ) : (
              <div key={raw} className="flex items-center gap-2 py-1">
                <button onClick={() => onToggle(type, itemLabel, false)} disabled={disabled}
                  className="text-hacker-accent hover:text-hacker-error shrink-0" title="Disable">
                  <HolafIcon name="toggle-right" size={14} />
                </button>
                <span className="text-xs text-hacker-text-bright font-mono truncate flex-1">{itemLabel}</span>
              </div>
            );
          })}
          {available.filter(a => !itemLabels.includes(a)).map(source => (
            <div key={source} className="flex items-center gap-2 py-1 opacity-60">
              <button onClick={() => onAdd(source)} disabled={disabled}
                className="text-hacker-text-dim hover:text-hacker-accent shrink-0" title="Enable">
                <HolafIcon name="toggle-left" size={14} />
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
