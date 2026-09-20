// ── Bloc repliable + contexte de repli (LOT 1 refonte chat) ─────────────────
// Règle d'expansion (cf. utils/collapse.ts) — précédence exacte :
//   overrideUtilisateur > auto-dépli (outil en cours) > auto-repli (réflexion
//   consommée : texte de réponse commencé) > auto-dépli (erreur) > réglage global.
// Les auto-états (isRunning / hasTextStarted) sont TRANSITOIRES et ne sont PAS
// des overrides : rien n'est mémorisé, une fois l'état passé la règle normale
// reprend (l'utilisateur garde le dernier mot via son override mémorisé).
//
// - CollapseProvider porte le réglage global (« détail d'affichage déplié »)
//   ET la Map d'overrides par bloc (clé = blockId, ex. "<msgId>:tool:<tcId>").
//   Il est monté UNE fois par liste de messages (GroupedMessages, remonté par
//   projet via key) → les overrides sont resettés au changement de projet.
// - OBJECTIF CLÉ : le réglage arrive par le CONTEXTE → changer Ctrl+T ou le
//   réglage Paramètres re-rend tous les blocs consommateurs, y compris ceux
//   DÉJÀ MONTÉS (le réglage est évalué au render, plus jamais figé dans un
//   useState d'initialisation).
// - La ligne d'en-tête reste TOUJOURS visible ; seul le contenu est replié.
// - Un clic mémorise un override par bloc qui prime sur le réglage global, les
//   auto-états (outil en cours / réflexion consommée) et l'auto-dépli d'erreur
//   (l'utilisateur décide, on ne l'écrase plus).

import { createContext, memo, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { resolveExpanded, type UserOverride } from "../../utils/collapse";

// ── Contexte ─────────────────────────────────────────────────────────────────

export interface CollapseOverrides {
  get(id: string): boolean | undefined;
  set(id: string, value: boolean | undefined): void;
}

export interface CollapseState {
  /** Réglage global « détail d'affichage déplié par défaut » (pi-web-display-detail). */
  defaultDetailExpanded: boolean;
  /** Overrides utilisateur par bloc — mémorisés tant que la liste est montée. */
  overrides: CollapseOverrides;
  /** Bump à chaque mutation d'override → invalide le memo de la valeur de contexte. */
  version: number;
}

const CollapseContext = createContext<CollapseState>({
  defaultDetailExpanded: true,
  overrides: { get: () => undefined, set: () => {} },
  version: 0,
});

export function CollapseProvider({ defaultDetailExpanded, children }: {
  defaultDetailExpanded: boolean;
  children: ReactNode;
}) {
  // Map des overrides : clé = blockId, valeur = true (déplié) / false (replié).
  // Ref (stable) + compteur de version : seule la version change l'identité du
  // contexte → les consumers re-rendent uniquement quand un override change ou
  // que le réglage global change.
  const overridesRef = useRef(new Map<string, boolean>());
  const [version, setVersion] = useState(0);

  const state = useMemo<CollapseState>(() => ({
    defaultDetailExpanded,
    version,
    overrides: {
      get: (id) => overridesRef.current.get(id),
      set: (id, value) => {
        if (value === undefined) overridesRef.current.delete(id);
        else overridesRef.current.set(id, value);
        setVersion((v) => v + 1);
      },
    },
  }), [defaultDetailExpanded, version]);

  return <CollapseContext.Provider value={state}>{children}</CollapseContext.Provider>;
}

/**
 * Hook d'expansion partagé : applique la règle et expose le toggle qui
 * mémorise l'override par bloc (l'opposé de l'état courant).
 * NB : un toggle (comme un changement de réglage global) re-rend TOUS les
 * blocs consommateurs du contexte — accepté : c'est un clic utilisateur, pas
 * une boucle de streaming, et le rendu d'un bloc est léger.
 */
export function useCollapsible(blockId: string, isError: boolean, isRunning = false, hasTextStarted = false): {
  expanded: boolean;
  toggle: () => void;
  hasUserOverride: boolean;
} {
  const { defaultDetailExpanded, overrides, version } = useContext(CollapseContext);
  const userOverride: UserOverride = overrides.get(blockId);
  const expanded = resolveExpanded({ userOverride, defaultDetailExpanded, isError, isRunning, hasTextStarted });
  const toggle = useCallback(() => {
    overrides.set(blockId, expanded ? false : true);
  }, [overrides, blockId, expanded]);
  // `version` garantit la re-souscription à la Map mutée à chaque mutation.
  void version;
  return { expanded, toggle, hasUserOverride: userOverride !== undefined };
}

// ── Composant générique ──────────────────────────────────────────────────────

interface CollapsibleBlockProps {
  /** Clé d'override par bloc (stable tant que le bloc est monté). */
  blockId: string;
  /** Auto-dépli forcé (échec d'outil / de turn / de sous-agent). */
  isError?: boolean;
  /** Outil/sous-agent EN COURS d'exécution → auto-dépli (sortie live tail -f). */
  isRunning?: boolean;
  /** Réflexion consommée (texte de réponse commencé, tour encore actif) → auto-repli. */
  hasTextStarted?: boolean;
  /** Ligne d'en-tête — TOUJOURS visible. Peut dépendre de l'état déplié. */
  header: ReactNode | ((state: { expanded: boolean }) => ReactNode);
  /** Actions d'en-tête (ex. bouton copier) — clics NE replient PAS le bloc. */
  headerActions?: ReactNode;
  /** Contenu repliable. null/undefined → bloc non repliable (en-tête seul). */
  children?: ReactNode;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  chevronPosition?: "left" | "right";
  title?: string;
}

export const CollapsibleBlock = memo(function CollapsibleBlock({
  blockId,
  isError = false,
  isRunning = false,
  hasTextStarted = false,
  header,
  headerActions,
  children,
  className,
  headerClassName,
  contentClassName,
  chevronPosition = "left",
  title,
}: CollapsibleBlockProps) {
  const { expanded, toggle } = useCollapsible(blockId, isError, isRunning, hasTextStarted);
  const hasContent = children !== undefined && children !== null;

  const resolvedHeader = typeof header === "function" ? header({ expanded }) : header;
  const chevron = hasContent
    ? (expanded ? <ChevronDown size={10} className="shrink-0" /> : <ChevronRight size={10} className="shrink-0" />)
    : null;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  }, [toggle]);

  // Chevrons à gauche : le chevron est GROUPÉ avec l'en-tête (un seul enfant
  // flex à gauche) pour survivre aux layouts justify-between du CSS existant
  // (.thinking-block-header). À droite : chevron en fin de ligne (ToolCallRow).
  const leftGroup = (
    <span className="inline-flex items-center gap-[3px] min-w-0">
      {chevron}
      {resolvedHeader}
    </span>
  );

  const headerRow = (
    <div
      role={hasContent ? "button" : undefined}
      tabIndex={hasContent ? 0 : undefined}
      aria-expanded={hasContent ? expanded : undefined}
      onClick={hasContent ? toggle : undefined}
      onKeyDown={hasContent ? handleKeyDown : undefined}
      title={title}
      className={headerClassName}
    >
      {chevronPosition === "left" ? leftGroup : resolvedHeader}
      {headerActions && (
        // stopPropagation : une action d'en-tête (copier…) ne doit pas replier.
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {headerActions}
        </span>
      )}
      {chevronPosition === "right" && chevron}
    </div>
  );

  if (!hasContent) {
    // Toujours visible : pas de contenu → pas de repli possible.
    return <div className={className}>{headerRow}</div>;
  }

  return (
    <div className={className}>
      {headerRow}
      {expanded && <div className={contentClassName}>{children}</div>}
    </div>
  );
});