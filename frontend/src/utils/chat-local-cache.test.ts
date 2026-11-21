// @vitest-environment jsdom
// ── Tests : façade du cache local du fil (aucun réseau) ───────────────────
// Couvre : persistance (lecture après écriture), plafond GLOBAL (les récents
// restent, les vieux fils sont évincés et SIGNALÉS), valeurs FIGÉES (budget
// global, messages par fil — plus aucune configurabilité), nettoyage du réglage
// résiduel des versions antérieures, et DÉGRADATION quand aucun stockage n'est
// disponible (mode privé) — sans blocage ni exception.
import { describe, it, expect, beforeEach } from "vitest";
import {
  CHAT_CACHE_BUDGET_BYTES,
  CHAT_CACHE_LOCALSTORAGE_BUDGET,
  chatCacheUsage,
  loadChatCache,
  resetChatCacheStore,
  saveChatCache,
} from "./chat-local-cache";
import {
  createIndexedDbChatCacheStore,
  createLocalStorageChatCacheStore,
  legacyKeyFor,
  openChatCacheStore,
} from "./chat-cache-store";
import { CHAT_CACHE_MAX_AGE_MS } from "./chat-cache";
import type { DisplayMessage } from "../types";

const NOW = 1_800_000_000_000;
const MB = 1024 * 1024;
/** Clé de réglage d'une version antérieure (onglet « Cache local » retiré). */
const SETTINGS_KEY = "pi-web.chat-cache";

function msg(ts: number, i = 0, toolLen = 0): DisplayMessage {
  return {
    id: `m-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: "hello",
    thinking: "",
    toolCalls: toolLen
      ? [{ id: `tc-${i}`, name: "bash", args: {}, output: "z".repeat(toolLen), isError: false, isStreaming: false }]
      : [],
    timestamp: ts,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetChatCacheStore();
});

describe("persistance (lecture après écriture)", () => {
  it("écrit puis relit le fil (repli localStorage) — survit à un rechargement", async () => {
    const store = createLocalStorageChatCacheStore(localStorage);
    const thread = [msg(NOW - 2000, 0), msg(NOW - 1000, 1)];

    const res = await saveChatCache("p1", thread, { store, now: NOW });
    expect(res.status).toBe("ok");

    // « Rechargement » : nouveaux objets de stockage sur les mêmes données.
    const reloaded = await loadChatCache("p1", { store: createLocalStorageChatCacheStore(localStorage), now: NOW });
    expect(reloaded).not.toBeNull();
    expect(reloaded!.fresh).toBe(true);
    expect(reloaded!.messages.map((m) => m.id)).toEqual(["m-0", "m-1"]);
  });

  it("lit l'ANCIEN format (tableau nu) écrit par les versions précédentes", async () => {
    localStorage.setItem(legacyKeyFor("old"), JSON.stringify([msg(NOW - 1000, 0)]));
    const store = createLocalStorageChatCacheStore(localStorage);
    const snap = await loadChatCache("old", { store, now: NOW });
    expect(snap?.messages).toHaveLength(1);
  });

  it("snapshot de plus de 24 h → présent mais PAS frais (jamais affiché comme état courant)", async () => {
    const store = createLocalStorageChatCacheStore(localStorage);
    await saveChatCache("p1", [msg(NOW - CHAT_CACHE_MAX_AGE_MS - 60_000, 0)], { store, now: NOW });
    const snap = await loadChatCache("p1", { store, now: NOW });
    expect(snap).not.toBeNull();
    expect(snap!.fresh).toBe(false);
  });
});

describe("plafond GLOBAL et éviction LRU", () => {
  it("dépassement → le fil courant garde ses messages récents, les autres fils sont évincés et SIGNALÉS", async () => {
    const store = createLocalStorageChatCacheStore(localStorage);

    // Budget de 2 Mo : deux fils « anciens » de ~1 Mo le remplissent…
    const maxBytes = 2 * MB;
    const heavy = (ts: number) => Array.from({ length: 50 }, (_, i) => ({ ...msg(ts + i, i), content: "x".repeat(20_000) }));
    await saveChatCache("old1", heavy(NOW - 50_000), { store, budgetBytes: maxBytes, now: NOW - 50_000 });
    await saveChatCache("old2", heavy(NOW - 40_000), { store, budgetBytes: maxBytes, now: NOW - 40_000 });
    // … puis le fil courant, plus récent : le budget est dépassé.
    const res = await saveChatCache("cur", heavy(NOW), { store, budgetBytes: maxBytes, now: NOW });

    expect(res.status).toBe("ok");
    expect(res.evicted).toContain("old1"); // le plus ancien part le premier
    // Le fil courant est TOUJOURS écrit et lisible.
    const cur = await loadChatCache("cur", { store, now: NOW });
    expect(cur).not.toBeNull();
    const usage = await chatCacheUsage({ store });
    expect(usage.totalBytes).toBeLessThanOrEqual(maxBytes);
    expect(usage.entries.some((e) => e.projectId === "cur")).toBe(true);
  });

  it("un fil trop lourd est RÉDUIT (messages récents) au lieu d'être refusé en bloc", async () => {
    const store = createLocalStorageChatCacheStore(localStorage);
    // 200 messages de ~15 000 caractères = ~3 Mo pour un budget de 1 Mo.
    const thread = Array.from({ length: 200 }, (_, i) => ({ ...msg(NOW - 200_000 + i * 1000, i), content: "x".repeat(15_000) }));
    const res = await saveChatCache("p1", thread, { store, budgetBytes: 1 * MB, now: NOW });

    expect(res.status).toBe("ok");
    expect(res.dropped).toBeGreaterThan(0);
    const snap = await loadChatCache("p1", { store, now: NOW });
    expect(snap!.messages[snap!.messages.length - 1].id).toBe("m-199");
  });

  it("les sorties d'outils volumineuses sont tronquées avant écriture (truncated=true)", async () => {
    const store = createLocalStorageChatCacheStore(localStorage);
    const res = await saveChatCache("p1", [msg(NOW, 1, 500_000)], { store, budgetBytes: 4 * MB, now: NOW });
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeLessThan(100_000);
  });
});

describe("valeurs FIGÉES (plus aucun réglage d'interface)", () => {
  it("budget par défaut : 64 Mo en IndexedDB, plafonné à 4 Mo en repli localStorage", async () => {
    expect(CHAT_CACHE_BUDGET_BYTES).toBe(64 * MB);
    expect(CHAT_CACHE_LOCALSTORAGE_BUDGET).toBe(4 * MB);

    // AUCUNE surcharge : c'est le plafond localStorage qui s'applique.
    const store = createLocalStorageChatCacheStore(localStorage);
    const thread = Array.from({ length: 300 }, (_, i) => ({ ...msg(NOW - 300_000 + i * 1000, i), content: "x".repeat(19_000) }));
    const res = await saveChatCache("p1", thread, { store, now: NOW });

    expect(res.status).toBe("ok");
    expect(res.dropped).toBeGreaterThan(0);
    expect(res.bytes).toBeLessThanOrEqual(4 * MB);
  });

  it("un réglage résiduel `pi-web.chat-cache` est IGNORÉ puis SUPPRIMÉ (cache toujours actif)", async () => {
    const store = createLocalStorageChatCacheStore(localStorage);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ enabled: false, maxBytes: 1, maxMessages: -5 }));

    const res = await saveChatCache("p1", [msg(NOW, 0)], { store, now: NOW });

    expect(res.status).toBe("ok");
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it("réglage résiduel illisible (JSON invalide) → aucune exception, clé supprimée", async () => {
    const store = createLocalStorageChatCacheStore(localStorage);
    localStorage.setItem(SETTINGS_KEY, "{pas du json");

    const res = await saveChatCache("p1", [msg(NOW, 0)], { store, now: NOW });

    expect(res.status).toBe("ok");
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });
});

describe("dégradation gracieuse (aucun stockage disponible)", () => {
  it("store null → statut « unavailable », lecture null, usage vide (aucune exception)", async () => {
    expect((await saveChatCache("p1", [msg(NOW, 0)], { store: null, now: NOW })).status).toBe("unavailable");
    expect(await loadChatCache("p1", { store: null, now: NOW })).toBeNull();
    expect(await chatCacheUsage({ store: null })).toEqual({ backend: "none", totalBytes: 0, entries: [] });
  });

  it("IndexedDB en échec + localStorage refusé → cache désactivé silencieusement", async () => {
    const brokenIdb = { open: () => { throw new Error("blocked"); } } as unknown as IDBFactory;
    const brokenStorage = {
      getItem: () => null,
      setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
      removeItem: () => {},
      key: () => null,
      length: 0,
    };
    const store = await openChatCacheStore({ indexedDB: brokenIdb, localStorage: brokenStorage });
    expect(store).toBeNull();
  });

  it("sans IndexedDB → repli localStorage (l'app continue de fonctionner)", async () => {
    const store = await openChatCacheStore({ indexedDB: null, localStorage });
    expect(store?.kind).toBe("localstorage");
  });
});

describe("adaptateur IndexedDB (contrat)", () => {
  /** Mini faux IDBFactory : suffit au contrat utilisé par le store. */
  function fakeIndexedDb() {
    const data = new Map<string, Map<string, any>>();
    const storeOf = (name: string) => {
      if (!data.has(name)) data.set(name, new Map());
      return data.get(name)!;
    };
    const makeRequest = (fn: () => any) => {
      const req: any = { onsuccess: null, onerror: null, result: undefined };
      queueMicrotask(() => {
        try {
          req.result = fn();
          req.onsuccess?.();
        } catch (e) {
          req.onerror?.();
        }
      });
      return req;
    };
    const makeTx = (names: string | string[]) => {
      const tx: any = { oncomplete: null, onerror: null, onabort: null, error: null };
      const store = (name: string) => {
        const map = storeOf(name);
        return {
          put: (rec: any) => { map.set(rec.projectId, rec); return makeRequest(() => rec.projectId); },
          get: (key: string) => makeRequest(() => map.get(key)),
          delete: (key: string) => { map.delete(key); return makeRequest(() => undefined); },
          clear: () => { map.clear(); return makeRequest(() => undefined); },
          getAll: () => makeRequest(() => [...map.values()]),
        };
      };
      tx.objectStore = store;
      // `oncomplete` ne se déclenche qu'une fois les requêtes résolues :
      // quelques micro-tâches de marge suffisent pour ce faux minimal.
      const finish = () => { tx.oncomplete?.(); };
      queueMicrotask(() => { queueMicrotask(() => { queueMicrotask(finish); }); });
      return tx;
    };
    return { open: () => {
      const req: any = { onsuccess: null, onupgradeneeded: null, onerror: null, onblocked: null, result: null };
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          transaction: makeTx,
        };
        req.onsuccess?.();
      });
      return req;
    } } as unknown as IDBFactory;
  }

  it("écrit puis relit un fil dans IndexedDB (une clé par projet)", async () => {
    const store = createIndexedDbChatCacheStore(fakeIndexedDb());
    const res = await saveChatCache("p1", [msg(NOW, 0), msg(NOW + 1000, 1)], { store, now: NOW });
    expect(res.status).toBe("ok");
    const snap = await loadChatCache("p1", { store, now: NOW });
    expect(snap?.messages.map((m) => m.id)).toEqual(["m-0", "m-1"]);
    const usage = await chatCacheUsage({ store });
    expect(usage.backend).toBe("indexeddb");
    expect(usage.entries).toHaveLength(1);
  });
});
