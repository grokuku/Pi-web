// ── Stockage du cache local du fil : IndexedDB, repli localStorage ─────────
// POURQUOI IndexedDB : localStorage est structurellement inadapté au contenu
// d'un fil (quota de ~5 Mo PAR ORIGINE, tout en UTF-16, écritures SYNCHRONES
// qui bloquent le thread principal et jettent QuotaExceededError en plein
// streaming). IndexedDB offre un quota de l'ordre de plusieurs centaines de
// Mo (basé sur l'espace disque), des écritures ASYNCHRONES et un stockage par
// clé (un enregistrement par projet) — sans aucune dépendance externe : l'API
// native suffit.
//
// REPLI : en navigation privée (Firefox) ou sur un navigateur ancien,
// `indexedDB` peut être absent ou refuser de s'ouvrir. On retombe alors sur un
// adaptateur localStorage de MÊME CONTRAT (format enveloppe, budget réduit
// appliqué par l'appelant), et si même localStorage est inutilisable le cache
// est simplement DÉSACTIVÉ (aucune exception ne remonte à l'UI : le serveur
// reste la source de vérité).
import type { DisplayMessage } from "../types";

/** Préfixe historique des snapshots localStorage (`pi-web-chat-<projectId>`). */
export const CHAT_CACHE_LEGACY_KEY_PREFIX = "pi-web-chat-";

export type ChatCacheBackendKind = "indexeddb" | "localstorage";

/** Entrée de cache telle que lue (messages déjà désérialisés). */
export interface ChatCacheEntry {
  projectId: string;
  savedAt: number;
  bytes: number;
  messages: DisplayMessage[];
  /** true → des blocs lourds ont été tronqués avant écriture. */
  truncated?: boolean;
}

/** Métadonnées seules (listing léger : ne charge pas les messages). */
export interface ChatCacheMeta {
  projectId: string;
  bytes: number;
  savedAt: number;
}

export interface ChatCacheStore {
  readonly kind: ChatCacheBackendKind;
  read(projectId: string): Promise<ChatCacheEntry | null>;
  write(entry: ChatCacheEntry): Promise<void>;
  remove(projectId: string): Promise<void>;
  clear(): Promise<void>;
  list(): Promise<ChatCacheMeta[]>;
}

export function legacyKeyFor(projectId: string): string {
  return `${CHAT_CACHE_LEGACY_KEY_PREFIX}${projectId}`;
}

// ── Adaptateur localStorage ────────────────────────────────────────────────

/** Enveloppe écrite sous `pi-web-chat-<projectId>` (v2). */
interface LocalCacheEnvelope {
  v: 2;
  savedAt: number;
  bytes?: number;
  truncated?: boolean;
  messages: DisplayMessage[];
}

/** Interface minimale de stockage (injectable pour les tests). */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * Adaptateur localStorage. Lit AUSSI le format historique (tableau nu) pour ne
 * pas jeter les snapshots déjà présents chez l'utilisateur.
 */
export function createLocalStorageChatCacheStore(storage: WebStorageLike = localStorage): ChatCacheStore {
  return {
    kind: "localstorage",
    async read(projectId) {
      const raw = storage.getItem(legacyKeyFor(projectId));
      if (!raw) return null;
      const parsed = parseEnvelope(raw);
      if (!parsed) return null;
      return { projectId, savedAt: parsed.savedAt, bytes: parsed.bytes ?? raw.length * 2, messages: parsed.messages, truncated: parsed.truncated };
    },
    async write(entry) {
      const envelope: LocalCacheEnvelope = {
        v: 2,
        savedAt: entry.savedAt,
        bytes: entry.bytes,
        truncated: entry.truncated,
        messages: entry.messages,
      };
      const raw = JSON.stringify(envelope);
      storage.setItem(legacyKeyFor(entry.projectId), raw);
    },
    async remove(projectId) {
      storage.removeItem(legacyKeyFor(projectId));
    },
    async clear() {
      for (const key of listLocalKeys(storage)) storage.removeItem(key);
    },
    async list() {
      const out: ChatCacheMeta[] = [];
      for (const key of listLocalKeys(storage)) {
        const raw = storage.getItem(key);
        const parsed = raw ? parseEnvelope(raw) : null;
        if (!parsed) continue;
        out.push({
          projectId: key.slice(CHAT_CACHE_LEGACY_KEY_PREFIX.length),
          savedAt: parsed.savedAt,
          bytes: parsed.bytes ?? raw!.length * 2,
        });
      }
      return out;
    },
  };
}

function listLocalKeys(storage: WebStorageLike): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(CHAT_CACHE_LEGACY_KEY_PREFIX)) keys.push(key);
    }
  } catch {
    // Stockage inaccessible (mode privé strict) : aucun snapshot à lister.
  }
  return keys;
}

/** Parse l'enveloppe v2 OU l'ancien format (tableau nu de messages). */
function parseEnvelope(raw: string): { messages: DisplayMessage[]; savedAt: number; bytes?: number; truncated?: boolean } | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Ancien format : pas d'horodatage propre, celui du dernier message sert
      // de date d'écriture (comportement historique de parseChatCacheSnapshot).
      const stamps = parsed
        .map((m: any) => m?.timestamp)
        .filter((t: unknown): t is number => typeof t === "number" && Number.isFinite(t));
      const savedAt = stamps.length > 0 ? Math.max(...stamps) : 0;
      return { messages: parsed as DisplayMessage[], savedAt: savedAt || Date.now(), bytes: raw.length * 2 };
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as LocalCacheEnvelope).messages)) {
      const env = parsed as LocalCacheEnvelope;
      return {
        messages: env.messages,
        savedAt: typeof env.savedAt === "number" && Number.isFinite(env.savedAt) ? env.savedAt : Date.now(),
        bytes: typeof env.bytes === "number" ? env.bytes : raw.length * 2,
        truncated: env.truncated,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Adaptateur IndexedDB ───────────────────────────────────────────────────

const IDB_NAME = "pi-web-chat-cache";
const IDB_VERSION = 1;
const IDB_THREADS = "threads";
const IDB_META = "meta";

/** Enregistrement `threads` : messages sérialisés (une clé par projet). */
interface IdbThreadRecord {
  projectId: string;
  savedAt: number;
  bytes: number;
  truncated?: boolean;
  raw: string;
}

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_THREADS)) db.createObjectStore(IDB_THREADS, { keyPath: "projectId" });
      if (!db.objectStoreNames.contains(IDB_META)) db.createObjectStore(IDB_META, { keyPath: "projectId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Adaptateur IndexedDB (le `db` est ouvert à la première opération). */
export function createIndexedDbChatCacheStore(factory: IDBFactory = indexedDB): ChatCacheStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    if (!dbPromise) {
      dbPromise = openDb(factory).catch((err) => {
        dbPromise = null; // une ouverture ratée ne condamne pas les suivantes
        throw err;
      });
    }
    return dbPromise;
  };

  return {
    kind: "indexeddb",
    async read(projectId) {
      const database = await db();
      const tx = database.transaction(IDB_THREADS, "readonly");
      const rec = await requestAsPromise<IdbThreadRecord | undefined>(
        tx.objectStore(IDB_THREADS).get(projectId) as IDBRequest<IdbThreadRecord | undefined>
      );
      if (!rec || typeof rec.raw !== "string") return null;
      try {
        const messages = JSON.parse(rec.raw) as DisplayMessage[];
        if (!Array.isArray(messages) || messages.length === 0) return null;
        return { projectId, savedAt: rec.savedAt, bytes: rec.bytes, messages, truncated: rec.truncated };
      } catch {
        return null; // enregistrement corrompu : ignoré (le serveur fera foi)
      }
    },
    async write(entry) {
      const database = await db();
      const raw = JSON.stringify(entry.messages);
      const rec: IdbThreadRecord = {
        projectId: entry.projectId,
        savedAt: entry.savedAt,
        bytes: entry.bytes,
        truncated: entry.truncated,
        raw,
      };
      const tx = database.transaction([IDB_THREADS, IDB_META], "readwrite");
      tx.objectStore(IDB_THREADS).put(rec);
      tx.objectStore(IDB_META).put({ projectId: entry.projectId, bytes: entry.bytes, savedAt: entry.savedAt });
      await txDone(tx);
    },
    async remove(projectId) {
      const database = await db();
      const tx = database.transaction([IDB_THREADS, IDB_META], "readwrite");
      tx.objectStore(IDB_THREADS).delete(projectId);
      tx.objectStore(IDB_META).delete(projectId);
      await txDone(tx);
    },
    async clear() {
      const database = await db();
      const tx = database.transaction([IDB_THREADS, IDB_META], "readwrite");
      tx.objectStore(IDB_THREADS).clear();
      tx.objectStore(IDB_META).clear();
      await txDone(tx);
    },
    async list() {
      const database = await db();
      const tx = database.transaction(IDB_META, "readonly");
      const rows = await requestAsPromise<ChatCacheMeta[]>(
        tx.objectStore(IDB_META).getAll() as IDBRequest<ChatCacheMeta[]>
      );
      return (rows || []).map((r) => ({ projectId: r.projectId, bytes: r.bytes ?? 0, savedAt: r.savedAt ?? 0 }));
    },
  };
}

// ── Ouverture : IndexedDB si possible, sinon localStorage, sinon rien ──────

export interface ChatCacheStoreEnv {
  indexedDB?: IDBFactory | null;
  localStorage?: WebStorageLike | null;
}

/**
 * Renvoie le meilleur stockage disponible, ou `null` si aucun ne fonctionne
 * (mode privé strict). Ne JETTE jamais : l'appelant dégrade en silence.
 */
export async function openChatCacheStore(env: ChatCacheStoreEnv = {}): Promise<ChatCacheStore | null> {
  const factory =
    env.indexedDB !== undefined
      ? env.indexedDB
      : typeof globalThis.indexedDB !== "undefined"
        ? globalThis.indexedDB
        : null;

  if (factory) {
    try {
      const store = createIndexedDbChatCacheStore(factory);
      await store.list(); // sonde : ouverture réelle (bloquée en mode privé)
      return store;
    } catch {
      // IndexedDB indisponible → repli localStorage ci-dessous.
    }
  }

  const storage =
    env.localStorage !== undefined
      ? env.localStorage
      : typeof globalThis.localStorage !== "undefined"
        ? globalThis.localStorage
        : null;

  if (storage) {
    try {
      // Sonde d'écriture : certains navigateurs exposent localStorage mais le
      // refusent (QuotaExceededError immédiat en mode privé).
      const probeKey = `${CHAT_CACHE_LEGACY_KEY_PREFIX}__probe__`;
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      return createLocalStorageChatCacheStore(storage);
    } catch {
      // localStorage inutilisable → cache désactivé.
    }
  }

  return null;
}
