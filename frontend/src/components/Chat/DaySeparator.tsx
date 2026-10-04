// ── Séparateur de journée (« repère de date ») dans le fil de conversation ──
// Rendu UNIQUEMENT au changement de jour, inséré par GroupedMessages (ChatView)
// — donc présent à l'identique dans le fil live ET dans le lecteur de
// conversation passée, qui partagent ce point de rendu.
//
// Apparence : ligne fine pleine largeur INTERROMPUE AU CENTRE par le libellé
// (voir utils/day-separator.ts). Deux segments jumeaux `flex-1` encadrent la
// date → centrage horizontal exact quelle que soit la largeur, le libellé est
// « au milieu de la ligne ». Style volontairement sobre, aligné sur le thème
// terminal de Pi-Web (hacker-border / hacker-text-dim) : c'est un repère, pas
// un élément dominant.
import { memo } from "react";
import { useTranslation } from "../../i18n";
import { formatDayLabel } from "../../utils/day-separator";

export const DaySeparator = memo(function DaySeparator({ timestamp }: { timestamp: number }) {
  const { lang } = useTranslation();
  // Timestamp illisible → libellé vide → aucun rendu (défense en profondeur :
  // les marqueurs `day` ne sont déjà posés que sur des entrées datées).
  const label = formatDayLabel(timestamp, lang);
  if (!label) return null;
  return (
    <div
      role="separator"
      aria-label={label}
      data-testid="day-separator"
      className="flex items-center gap-2 my-3 select-none"
    >
      <span aria-hidden className="flex-1 h-px bg-hacker-border" />
      <span className="text-[10px] tracking-wide text-hacker-text-dim whitespace-nowrap">{label}</span>
      <span aria-hidden className="flex-1 h-px bg-hacker-border" />
    </div>
  );
});
