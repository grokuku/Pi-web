// ── Utilitaires purs : concurrence LLM par provider ──
// PHASE B (UI) de la tâche « concurrence LLM par provider ».
// Le backend (PHASE A, validée) expose dans GET/PUT /api/settings/concurrency :
//   config.providerMaxLLMSlots?: Record<string, number>  — override de limite
//   LLM par providerId ; absent = hérite du défaut global (maxLLMSlots).
//
// Ce module centralise la logique de normalisation / fusion utilisée par
// SettingsModal, sous forme de fonctions PURES (sans DOM ni fetch) pour être
// testable sous Vitest node (voir concurrency.test.ts).

/**
 * Ligne affichée dans la sous-section « Limites par provider » :
 * un provider + sa limite effective dans le formulaire.
 * `value === null` → champ vide → hérite du défaut global (maxLLMSlots).
 */
export interface ProviderLimitRow {
  id: string;
  name: string;
  value: number | null;
}

/** Clés réservées JS : jamais acceptées (miroir de la validation backend). */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Normalise la map brute `providerMaxLLMSlots` renvoyée par l'API (ou saisie
 * par l'utilisateur) : ne conserve que les entrées { providerId → entier 1..20 }.
 * Tout le reste (undefined, non-objet, valeur ≤ 0 / non numérique / flottante /
 * hors bornes, clé vide ou réservée) est filtré — jamais levé d'exception.
 *
 * Miroir de la validation serveur (PUT /api/settings/concurrency) : entier
 * entre 1 et 20 inclus.
 */
export function normalizeProviderOverrides(
  raw: unknown | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Clé vide ou réservée JS → ignorée (protection pollution de prototype).
    if (!key || !key.trim() || RESERVED_KEYS.has(key)) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 1 || value > 20) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Fusionne la liste des providers (GET /api/providers) avec les overrides
 * normalisés : une ligne par provider, dans l'ordre de la liste.
 * `value: null` = pas d'override → le champ sera vide → « hérite du défaut ».
 */
export function mergeProviderLimits(
  providers: Array<{ id: string; name?: string }>,
  overrides: Record<string, number>
): ProviderLimitRow[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name || p.id, // nom d'affichage absent → fallback sur l'id
    value: Object.prototype.hasOwnProperty.call(overrides, p.id)
      ? overrides[p.id]
      : null,
  }));
}

/**
 * Construit le payload `providerMaxLLMSlots` pour le PUT /api/settings/concurrency
 * depuis les lignes du formulaire : les champs VIDES (value null) sont retirés
 * de la map → l'override est supprimé (le provider hérite à nouveau du défaut
 * global). Une map vide `{}` est valide côté serveur : elle efface tous les
 * overrides.
 * Retourne toujours un objet (jamais undefined) → le PUT écrase la map entière.
 */
export function buildProviderOverridesPayload(
  rows: ProviderLimitRow[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.value === null || row.value === undefined) continue;
    if (typeof row.value !== "number" || !Number.isInteger(row.value)) continue;
    if (row.value < 1 || row.value > 20) continue;
    out[row.id] = row.value;
  }
  return out;
}