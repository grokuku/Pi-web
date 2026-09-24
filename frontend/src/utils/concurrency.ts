// ── Utilitaires purs : limite de concurrence LLM par provider ──
// La limite est désormais portée PAR LE PROVIDER (champ `maxConcurrentCalls`,
// défaut 3) et éditée dans sa fiche (ModelLibraryModal → ProviderEditPanel).
// Le backend en dérive la map moteur `concurrency.providerMaxLLMSlots`.
//
// Ce module ne garde que la logique de validation/normalisation du champ,
// sous forme de fonctions PURES (sans DOM ni fetch), testables sous Vitest node.

/**
 * Plafond haut d'une limite de slots (global ou par provider).
 * Volontairement large (permet un provider à très haute limite, ex. 2500),
 * mais borné et entier — miroir de la validation serveur (MAX_CONCURRENT_CALLS).
 */
export const MAX_PROVIDER_LIMIT = 100_000;

/** Valeur par défaut d'un provider sans limite explicite (miroir backend). */
export const DEFAULT_MAX_CONCURRENT_CALLS = 3;

/**
 * Normalise la saisie du champ « appels simultanés » d'un provider.
 * Retourne un entier 1..MAX_PROVIDER_LIMIT, ou null si la saisie est vide ou
 * invalide (≤ 0, flottante, texte, hors plafond) — l'appelant affiche alors un
 * message d'erreur explicite.
 */
export function normalizeProviderCallsInput(raw: unknown): number | null {
  if (raw === "" || raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PROVIDER_LIMIT) return null;
  return n;
}

/**
 * Limite effective affichée pour un provider : sa valeur si valide, sinon le
 * défaut (3). Utilisé pour pré-remplir le champ d'édition.
 */
export function effectiveProviderCalls(value: unknown): number {
  return normalizeProviderCallsInput(value) ?? DEFAULT_MAX_CONCURRENT_CALLS;
}
