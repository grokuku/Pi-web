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
 * Plafond haut d'une limite de slots (global ou override par provider).
 * Volontairement large (permet un provider à très haute limite, ex. 2500),
 * mais borné et entier — miroir de la validation serveur.
 */
export const MAX_PROVIDER_LIMIT = 100_000;

/**
 * Normalise la map brute `providerMaxLLMSlots` renvoyée par l'API (ou saisie
 * par l'utilisateur) : ne conserve que les entrées
 * { providerId → entier 1..MAX_PROVIDER_LIMIT }.
 * Tout le reste (undefined, non-objet, valeur ≤ 0 / non numérique / flottante /
 * hors bornes, clé vide ou réservée) est filtré — jamais levé d'exception.
 *
 * Miroir de la validation serveur (PUT /api/settings/concurrency).
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
    if (value < 1 || value > MAX_PROVIDER_LIMIT) continue;
    out[key] = value;
  }
  return out;
}

/** Identifiant de provider valide : chaîne non vide, non réservée JS. */
export function isValidProviderId(id: unknown): id is string {
  return typeof id === "string" && !!id.trim() && !RESERVED_KEYS.has(id.trim());
}

/**
 * Normalise la saisie d'un champ de limite : "" (ou valeur invalide) → null
 * (= champ vide → hérite du défaut global) ; entier 1..MAX → nombre.
 */
export function normalizeProviderLimitInput(raw: unknown): number | null {
  if (raw === "" || raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PROVIDER_LIMIT) return null;
  return n;
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
 * Variante de `mergeProviderLimits` utilisée par le formulaire : EN PLUS de la
 * liste des providers connus (GET /api/providers), elle ajoute en fin de tableau
 * les overrides dont le provider n'apparaît PAS dans la liste (provider
 * enregistré dynamiquement par une extension, absent de l'UI). Sans cela, ces
 * overrides seraient silencieusement perdus au save (la map est remplacée).
 */
export function mergeProviderLimitsIncludingOverrides(
  providers: Array<{ id: string; name?: string }>,
  overrides: Record<string, number>
): ProviderLimitRow[] {
  const rows = mergeProviderLimits(providers, overrides);
  const known = new Set(rows.map((r) => r.id));
  for (const [id, value] of Object.entries(overrides)) {
    if (known.has(id)) continue;
    rows.push({ id, name: id, value });
  }
  return rows;
}

/**
 * Ajoute une ligne de provider saisie manuellement (identifiant libre).
 * Sans effet si l'id est vide/réservé ou déjà présent (pas de doublon).
 * Retourne un NOUVEAU tableau (immutabilité).
 */
export function addProviderLimitRow(
  rows: ProviderLimitRow[],
  id: unknown,
  name?: string
): ProviderLimitRow[] {
  if (!isValidProviderId(id)) return rows;
  const trimmed = id.trim();
  if (rows.some((r) => r.id === trimmed)) return rows;
  return [...rows, { id: trimmed, name: name?.trim() || trimmed, value: null }];
}

/** Supprime la ligne d'un provider. Retourne un NOUVEAU tableau. */
export function removeProviderLimitRow(
  rows: ProviderLimitRow[],
  id: string
): ProviderLimitRow[] {
  return rows.filter((r) => r.id !== id);
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
    if (!isValidProviderId(row.id)) continue;
    if (row.value === null || row.value === undefined) continue;
    if (typeof row.value !== "number" || !Number.isInteger(row.value)) continue;
    if (row.value < 1 || row.value > MAX_PROVIDER_LIMIT) continue;
    out[row.id] = row.value;
  }
  return out;
}