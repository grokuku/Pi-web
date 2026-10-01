// ── HolafIcon — adaptateur React de la brique HolafIcons (holaf-lib v0.1.4) ──
//
// Rôle : rendre une icône de la brique `holaf-icons` (copie pinnée dans
// `src/vendor/holaf/holaf-icons.js`) sous une forme **compatible avec l'usage
// existant de lucide-react** dans Pi-Web, afin de migrer progressivement les
// icônes sans changer ni les tailles fines (9/10/12/14/16/20/32), ni les classes
// (`animate-spin`, `text-hacker-accent`, `mr-2`, …).
//
// CHOIX D'INJECTION (documenté) :
//   La brique renvoie une CHAÎNE SVG complète (`HolafIcons.get(name)`), dont les
//   tracés sont du contenu de confiance (écrit par nous, vendored, jamais issu
//   d'une entrée utilisateur). Pour retrouver un DOM identique à celui de lucide
//   (un unique `<svg>` racine — pas de `<span>` englobant qui casserait les
//   layouts flex/gap et les sélecteurs `querySelector("svg")`), on extrait le
//   CORPS du SVG (le contenu entre `<svg …>` et `</svg>`) et on le réinjecte via
//   `dangerouslySetInnerHTML` sur un `<svg>` que React possède. Les attributs du
//   wrapper (viewBox, stroke=currentColor, stroke-width=2, fill=none) sont
//   reproduits à l'identique, et `className` / `width` / `height` deviennent des
//   props React ordinaires — donc `className` atteint bien le SVG.
//   L'extraction est mise en cache par nom (une seule lecture de la brique).
//
// SÉCURITÉ : `dangerouslySetInnerHTML` n'est acceptable ici que parce que la
// chaîne provient EXCLUSIVEMENT de la brique locale. Ne JAMAIS passer un `name`
// construit à partir d'une entrée utilisateur non validée.

import { useMemo } from "react";
import { HolafIcons } from "../../vendor/holaf/holaf-icons.js";

/** Nom kebab-case d'une icône de la brique (ex. "gear", "chevron-down"). */
export type HolafIconName = string;

export interface HolafIconProps
  extends Omit<React.SVGProps<SVGSVGElement>, "name"> {
  /** Nom de l'icône dans la brique (cf. `HolafIcons.list()`). */
  name: HolafIconName;
  /**
   * Taille en pixels (carré). Défaut 12 = taille d'icône dominante observée
   * dans Pi-Web (les valeurs fines 9/10/12/14/16/20/32 sont respectées).
   */
  size?: number;
  /** Classe(s) appliquée(s) au `<svg>` (pour `animate-spin`, couleurs, marges…). */
  className?: string;
  /** Libellé accessible (sinon l'icône est marquée décorative, `aria-hidden`). */
  title?: string;
}

/** Corps SVG de la brique, extrait une seule fois par nom. */
const bodyCache = new Map<string, string>();
/** Noms déjà signalés comme inconnus (évite de spammer la console). */
const failedNames = new Set<string>();

/**
 * Extrait le corps interne du SVG renvoyé par la brique.
 * Retourne `null` (et journalise) si le nom est inconnu ou le format inattendu.
 */
function getBody(name: string): string | null {
  const cached = bodyCache.get(name);
  if (cached !== undefined) return cached;
  if (failedNames.has(name)) return null;

  let svg: string;
  try {
    svg = HolafIcons.get(name);
  } catch (err) {
    failedNames.add(name);
    console.error(`[HolafIcon] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // La brique produit toujours `<svg …>CORPS</svg>` ; on ne garde que CORPS.
  const match = /^<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!match) {
    failedNames.add(name);
    console.error(`[HolafIcon] format SVG inattendu pour "${name}".`);
    return null;
  }
  bodyCache.set(name, match[1]);
  return match[1];
}

/**
 * Icône SVG de la brique holaf, compatible avec l'usage lucide-react.
 *
 * ```tsx
 * <HolafIcon name="refresh" size={14} className={loading ? "animate-spin" : ""} />
 * ```
 */
export function HolafIcon({
  name,
  size = 12,
  className,
  title,
  ...rest
}: HolafIconProps) {
  const body = useMemo(() => getBody(name), [name]);
  if (body === null) return null;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body }}
      {...rest}
    />
  );
}
