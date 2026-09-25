// ── Déduplication des textes de fin d'un run sous-agent (P5) ───────────────
// Le « travail récupéré » d'un run interrompu pouvait apparaître TROIS fois :
//   1. `run.messages` (narration live du mini-fil),
//   2. `run.end.errorMessage` (qui embarquait le partiel),
//   3. `run.end.responsePreview` (= collectExpertResponse du backend).
//
// Côté backend, errorMessage ne porte plus qu'un motif court (abort-session /
// timeout) avec le nombre de chars récupérés. Côté frontend, on masque aussi
// toute source dont le texte est DÉJÀ présent dans le mini-fil (runs LEGACY
// persistés avec un errorMessage long, ou responsePreview identique au dernier
// message assistant). Helper pur → testable en environnement node.

import type { SubAgentRun } from "../types";

export interface SubAgentEndTextVisibility {
  /** Afficher `run.end.errorMessage` ? */
  showErrorMessage: boolean;
  /** Afficher `run.end.responsePreview` ? */
  showResponsePreview: boolean;
}

/** Normalise pour comparaison : espaces multiples réduits, trim. */
function normalize(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

/** Deux textes se recouvrent-ils (l'un contient l'autre) ? */
function overlaps(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

/**
 * Décide quelles sources de texte du `subagent_end` afficher SANS doublon.
 * Priorité au mini-fil (`run.messages`) : une source déjà contenue dans un
 * message est masquée. `responsePreview` est également masqué s'il est contenu
 * dans `errorMessage`.
 */
export function dedupeSubAgentEndTexts(run?: SubAgentRun): SubAgentEndTextVisibility {
  const end = run?.end;
  if (!end) return { showErrorMessage: false, showResponsePreview: false };

  const messageTexts = (run?.messages || [])
    .map((m) => normalize(m.text))
    .filter((t) => t.length > 0);
  const errorText = normalize(end.errorMessage);
  const previewText = normalize(end.responsePreview);

  const errorInMessages = messageTexts.some((t) => overlaps(t, errorText));
  const previewInMessages = messageTexts.some((t) => overlaps(t, previewText));
  const previewInError = overlaps(errorText, previewText);

  return {
    showErrorMessage: !errorInMessages,
    showResponsePreview: !previewInMessages && !previewInError,
  };
}
