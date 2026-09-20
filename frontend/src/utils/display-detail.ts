// ── Réglage « détail d'affichage déplié par défaut » (LOT 1 refonte chat) ────
// Renommage du réglage historique « réflexion dépliée par défaut » :
//   pi-web-thinking-expand → pi-web-display-detail
// Le réglage pilote désormais TOUS les blocs repliables du chat (réflexion,
// sorties d'outils, blocs sous-agent), pas seulement la réflexion.
//
// Migration ONE-SHOT : à la première lecture, si l'ancienne clé existe, sa
// valeur est copiée vers la nouvelle clé puis l'ancienne est SUPPRIMÉE (pour
// éviter une résurrection de la valeur au downgrade ou via un autre onglet).
//
// Synchronisation live : writeDisplayDetailExpanded notifie les abonnés
// (ChatView, SettingsModal) pour que le changement s'applique IMMÉDIATEMENT
// aux blocs déjà montés — c'est l'objectif clé du lot 1 (l'ancien code
// n'écrivait que le localStorage, sans effet sur l'UI affichée).

export const DISPLAY_DETAIL_KEY = "pi-web-display-detail";
export const LEGACY_THINKING_EXPAND_KEY = "pi-web-thinking-expand";

/** Défaut : déplié (comportement historique du réglage think-expand). */
export const DEFAULT_DISPLAY_DETAIL_EXPANDED = true;

/** Interface minimale de stockage (localStorage en prod) — injectable pour les tests node. */
export interface SettingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type DisplayDetailListener = (value: boolean) => void;
const listeners = new Set<DisplayDetailListener>();

/** Abonne un composant aux changements du réglage. Retourne la fonction de désabonnement. */
export function subscribeDisplayDetail(cb: DisplayDetailListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function notify(value: boolean): void {
  for (const cb of listeners) {
    try { cb(value); } catch { /* un abonné défaillant ne casse pas les autres */ }
  }
}

/** Migration one-shot : ancienne clé → nouvelle, puis suppression de l'ancienne. */
export function migrateDisplayDetailSetting(storage: SettingStorage = localStorage): void {
  const legacy = storage.getItem(LEGACY_THINKING_EXPAND_KEY);
  if (legacy === null) return;
  // On ne copie que si la nouvelle clé est absente (la valeur fraîche prime).
  if (storage.getItem(DISPLAY_DETAIL_KEY) === null) {
    try { storage.setItem(DISPLAY_DETAIL_KEY, legacy); } catch { /* quota : le défaut restera appliqué */ }
  }
  storage.removeItem(LEGACY_THINKING_EXPAND_KEY);
}

/** Lit le réglage (avec migration one-shot). Défaut : déplié. */
export function readDisplayDetailExpanded(storage: SettingStorage = localStorage): boolean {
  migrateDisplayDetailSetting(storage);
  const saved = storage.getItem(DISPLAY_DETAIL_KEY);
  return saved === null ? DEFAULT_DISPLAY_DETAIL_EXPANDED : saved === "true";
}

/** Écrit le réglage et notifie les abonnés (application live aux blocs montés). */
export function writeDisplayDetailExpanded(value: boolean, storage: SettingStorage = localStorage): void {
  try {
    storage.setItem(DISPLAY_DETAIL_KEY, String(value));
    // Idempotent : si l'ancienne clé traîne encore (écriture directe avant
    // toute lecture), on la supprime pour éviter toute résurrection.
    storage.removeItem(LEGACY_THINKING_EXPAND_KEY);
  } catch {
    // QuotaExceededError (navigation privée…) : le réglage reste applicatif
    // pour la session via la notification ci-dessous.
  }
  notify(value);
}