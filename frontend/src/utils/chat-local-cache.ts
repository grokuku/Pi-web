// ── Cache local du fil : façade unique (réglages, budget, éviction) ────────
// SÉMANTIQUE HONNÊTE : le backend est la SOURCE DE VÉRITÉ. Au rechargement,
// l'historique est rechargé depuis le serveur (`pi_history`, fenêtre des 300
// derniers messages + pagination `pi_history_page`). Ce cache ne sert qu'à
// peindre le fil plus vite au montage / au changement de projet, et à couvrir
// le court instant où le serveur n'a pas encore répondu.
// → Il ne peut donc RIEN perdre de définitif. La seule chose qu'il apporte en
//   propre est l'écho immédiat d'un message encore « en vol » (optimiste non
//   encore commité côté serveur) — d'où le message d'état qui parle de
//   « cache d'affichage », jamais de « messages perdus ».
//
// AUCUN RÉGLAGE, AUCUNE INTERFACE : le cache local du fil n'est pas exposé dans
// les Paramètres (décision produit — les valeurs ci-dessous sont figées). Le
// budget est GLOBAL (tous fils confondus) et appliqué par éviction LRU : quand
// il est dépassé, les fils les MOINS récemment écrits sont évincés — et la
// liste des projets évincés est REMONTÉE à l'appelant (jamais de purge
// silencieuse des autres projets).
import type { DisplayMessage } from "../types";
import { judgeChatCacheSnapshot, type ChatCacheSnapshot } from "./chat-cache";
import { fitMessagesToBudget, utf8Bytes, CHAT_CACHE_MAX_MESSAGES_DEFAULT } from "./chat-cache-budget";
import {
  createLocalStorageChatCacheStore,
  legacyKeyFor,
  openChatCacheStore,
  type ChatCacheBackendKind,
  type ChatCacheMeta,
  type ChatCacheStore,
  type ChatCacheStoreEnv,
  type WebStorageLike,
} from "./chat-cache-store";

// ── Valeurs FIGÉES (aucune interface ne les expose) ────

/** Budget GLOBAL du cache, tous fils confondus (octets) — IndexedDB. */
export const CHAT_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;             // 64 Mo
/**
 * Plafond réel du repli localStorage : le quota navigateur est d'environ 5 Mo
 * PAR ORIGINE et partagé avec les autres réglages (thème, disposition…). On
 * réserve donc ~4 Mo au fil — au-delà, QuotaExceededError est garanti.
 */
export const CHAT_CACHE_LOCALSTORAGE_BUDGET = 4 * 1024 * 1024;
/** Nombre de messages conservés par fil (les plus récents, blocs lourds tronqués). */
export const CHAT_CACHE_MAX_MESSAGES = CHAT_CACHE_MAX_MESSAGES_DEFAULT;

/**
 * Clé de réglage d'une version antérieure (onglet « Cache local » supprimé).
 * Elle n'est JAMAIS lue : un résidu est ignoré puis SUPPRIMÉ au premier usage
 * du cache, pour ne pas laisser de trace dans le stockage de l'utilisateur.
 */
const LEGACY_SETTINGS_KEY = "pi-web.chat-cache";

/** Stockage effectif : injecté (tests) ou localStorage global, sans exception. */
function safeStorage(storage?: WebStorageLike | null): WebStorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Supprime le réglage résiduel `pi-web.chat-cache`. Ne jette JAMAIS : un
 * stockage refusé (mode privé, quota) laisse simplement la clé en place.
 * `removeItem` sur une clé absente ne déclenche aucun événement `storage`.
 */
export function purgeLegacyChatCacheSettings(storage?: WebStorageLike | null): void {
  const store = safeStorage(storage);
  if (!store) return;
  try { store.removeItem(LEGACY_SETTINGS_KEY); } catch { /* stockage indisponible : rien à nettoyer */ }
}

/** Plafond dur du stockage : ce que le backend sait réellement encaisser. */
function hardCapFor(kind: ChatCacheBackendKind): number {
  return kind === "localstorage" ? CHAT_CACHE_LOCALSTORAGE_BUDGET : CHAT_CACHE_BUDGET_BYTES;
}

/** Budget effectif : défaut figé, plafonné par le stockage (surcharge = tests). */
function budgetFor(kind: ChatCacheBackendKind, override?: number): number {
  const wanted = typeof override === "number" && Number.isFinite(override) && override > 0
    ? override
    : CHAT_CACHE_BUDGET_BYTES;
  return Math.min(wanted, hardCapFor(kind));
}

// ── Résolution du stockage (mémoïsée, injectable en test) ──────────────────

export interface ChatCacheDeps {
  /** Stockage explicite (tests). `null` → aucun stockage disponible. */
  store?: ChatCacheStore | null;
  now?: number;
  /** Environnement d'ouverture (tests : indexedDB/localStorage factices). */
  env?: ChatCacheStoreEnv;
  storage?: WebStorageLike | null;
  /** Surcharge du budget GLOBAL en octets (TESTS uniquement — jamais l'UI). */
  budgetBytes?: number;
  /** Surcharge du nombre de messages par fil (TESTS uniquement). */
  maxMessages?: number;
}

let storePromise: Promise<ChatCacheStore | null> | null = null;

/** Réinitialise le stockage mémoïsé (tests / changement de navigateur). */
export function resetChatCacheStore(): void {
  storePromise = null;
}

async function resolveStore(deps: ChatCacheDeps = {}): Promise<ChatCacheStore | null> {
  // Nettoyage du réglage résiduel d'une version antérieure, à chaque entrée
  // dans la façade (idempotent et sans effet si la clé n'existe pas).
  purgeLegacyChatCacheSettings(deps.storage);
  if (deps.store !== undefined) return deps.store;
  if (!storePromise) {
    storePromise = openChatCacheStore(deps.env).catch(() => null);
  }
  return storePromise;
}

function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

// ── Lecture / écriture ────────────────────────────────────────────────────

export type ChatCacheSaveStatus = "ok" | "unavailable" | "too-large" | "error";

export interface ChatCacheSaveResult {
  status: ChatCacheSaveStatus;
  /** Octets écrits (0 si rien n'a été écrit). */
  bytes: number;
  /** Messages les plus anciens évincés de CETTE entrée. */
  dropped: number;
  /** true si des blocs lourds ont été tronqués. */
  truncated: boolean;
  /** Projets dont l'entrée a été évincée pour tenir dans le budget global. */
  evicted: string[];
}

const NOTHING: ChatCacheSaveResult = { status: "ok", bytes: 0, dropped: 0, truncated: false, evicted: [] };

/**
 * Écrit le snapshot du fil courant.
 *
 * Ne jette JAMAIS : toutes les dégradations sont retournées en `status`.
 * Les messages récents sont conservés en priorité (le plafond retire les plus
 * anciens, puis, en dernier recours, évince les AUTRES projets les moins
 * récemment écrits — la liste `evicted` permet de le dire à l'utilisateur).
 */
export async function saveChatCache(
  projectId: string,
  messages: DisplayMessage[],
  deps: ChatCacheDeps = {}
): Promise<ChatCacheSaveResult> {
  if (!projectId || !Array.isArray(messages)) return { ...NOTHING };

  const store = await resolveStore(deps);
  if (!store) return { ...NOTHING, status: "unavailable" };

  if (messages.length === 0) {
    // Fil vidé (/clear, /new) → l'entrée de cache n'a plus de sens : on la
    // retire au lieu d'écrire un tableau vide (l'ancien code gaspillait un
    // enregistrement « [] » et laissait un snapshot périmé traîner).
    try { await store.remove(projectId); } catch { /* ignore */ }
    return { ...NOTHING };
  }

  const budget = budgetFor(store.kind, deps.budgetBytes);
  const hardCap = hardCapFor(store.kind);
  const maxMessages = deps.maxMessages ?? CHAT_CACHE_MAX_MESSAGES;
  const fit = fitMessagesToBudget(messages, { maxBytes: budget, maxMessages });
  if (fit.messages.length === 0) return { ...NOTHING, status: "too-large", dropped: fit.dropped, truncated: fit.truncated };
  if (!fit.fits && fit.bytes > hardCap) {
    // Même le dernier message dépasse ce que le stockage peut prendre : on
    // n'écrit rien (aucune exception, le serveur reste la source).
    return { ...NOTHING, status: "too-large", dropped: fit.dropped, truncated: fit.truncated };
  }

  const savedAt = deps.now ?? Date.now();
  const entry = { projectId, savedAt, bytes: fit.bytes, messages: fit.messages, truncated: fit.truncated };
  const evicted: string[] = [];

  const writeOnce = async () => {
    await store.write(entry);
  };

  try {
    await writeOnce();
  } catch (error) {
    if (!isQuotaError(error)) return { ...NOTHING, status: "error", dropped: fit.dropped, truncated: fit.truncated };
    // Quota atteint malgré le budget : on évince d'abord les AUTRES fils, puis
    // on retente UNE fois (aucune donnée du fil courant n'est sacrifiée).
    const others = await safeList(store);
    for (const meta of sortOldestFirst(others.filter((m) => m.projectId !== projectId))) {
      try { await store.remove(meta.projectId); evicted.push(meta.projectId); } catch { /* ignore */ }
    }
    try {
      await writeOnce();
    } catch {
      return { ...NOTHING, status: "error", dropped: fit.dropped, truncated: fit.truncated, evicted };
    }
  }

  // Budget GLOBAL : éviction LRU des autres fils jusqu'à tenir.
  const metas = await safeList(store);
  let total = metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
  for (const meta of sortOldestFirst(metas.filter((m) => m.projectId !== projectId))) {
    if (total <= budget) break;
    try {
      await store.remove(meta.projectId);
      evicted.push(meta.projectId);
      total -= meta.bytes || 0;
    } catch { /* ignore */ }
  }

  return { status: "ok", bytes: fit.bytes, dropped: fit.dropped, truncated: fit.truncated, evicted };
}

async function safeList(store: ChatCacheStore): Promise<ChatCacheMeta[]> {
  try { return await store.list(); } catch { return []; }
}

function sortOldestFirst(metas: ChatCacheMeta[]): ChatCacheMeta[] {
  return [...metas].sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
}

/**
 * Lit le snapshot d'un fil et juge sa fraîcheur (garde des 24 h).
 * Migre au passage l'ancien snapshot localStorage vers IndexedDB.
 * Ne jette jamais : stockage indisponible → null.
 */
export async function loadChatCache(projectId: string, deps: ChatCacheDeps = {}): Promise<ChatCacheSnapshot | null> {
  if (!projectId) return null;
  const store = await resolveStore(deps);
  if (!store) return null;

  const now = deps.now ?? Date.now();
  let entry = null;
  try { entry = await store.read(projectId); } catch { entry = null; }

  if (!entry && store.kind === "indexeddb") {
    // MIGRATION : snapshot écrit par l'ancienne version (localStorage) →
    // recopié dans IndexedDB puis supprimé du localStorage pour rendre le
    // quota local à ses autres usages.
    const legacy = await readLegacySnapshot(projectId, deps);
    if (legacy) {
      try {
        await saveChatCache(projectId, legacy, { ...deps, store, now });
        removeLegacyKey(projectId, deps);
      } catch { /* la migration est un bonus : jamais bloquante */ }
      return judgeChatCacheSnapshot(legacy, now);
    }
    return null;
  }

  if (!entry) return null;
  return judgeChatCacheSnapshot(entry.messages, now);
}

async function readLegacySnapshot(projectId: string, deps: ChatCacheDeps): Promise<DisplayMessage[] | null> {
  const storage = deps.storage !== undefined ? deps.storage : typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
  if (!storage) return null;
  try {
    const entry = await createLocalStorageChatCacheStore(storage).read(projectId);
    if (!entry || entry.messages.length === 0) return null;
    return entry.messages;
  } catch {
    return null;
  }
}

function removeLegacyKey(projectId: string, deps: ChatCacheDeps): void {
  const storage = deps.storage !== undefined ? deps.storage : typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
  try { storage?.removeItem(legacyKeyFor(projectId)); } catch { /* ignore */ }
}

// ── Usage ─────────────────────────────────────────────────────────────────

export interface ChatCacheUsage {
  /** Stockage réellement utilisé, ou "none" si rien n'est disponible. */
  backend: ChatCacheBackendKind | "none";
  totalBytes: number;
  entries: ChatCacheMeta[];
}

/** Espace utilisé (octets) et détail par projet, sans charger les messages. */
export async function chatCacheUsage(deps: ChatCacheDeps = {}): Promise<ChatCacheUsage> {
  const store = await resolveStore(deps);
  if (!store) return { backend: "none", totalBytes: 0, entries: [] };
  const entries = sortOldestFirst(await safeList(store));
  return {
    backend: store.kind,
    totalBytes: entries.reduce((sum, m) => sum + (m.bytes || 0), 0),
    entries,
  };
}

/** Taille sérialisée d'un ensemble de messages (utile aux tests / au diagnostic). */
export { utf8Bytes };
