/**
 * Tests unitaires de pi/concurrency.ts (ConcurrencyManager).
 *
 * Le singleton concurrencyManager est testé avec de la concurrence simulée :
 * sections critiques asynchrones (Promises + setTimeout courts), files
 * d'attente observées via getStats(), et fake timers pour le timeout de
 * file (queueTimeoutMs — configurable, donc simulé).
 *
 * Couverture :
 *  - configuration : valeurs par défaut, copie défensive, mise à jour
 *    partielle, rejet des valeurs invalides (<= 0) ;
 *  - slots LLM : acquisition immédiate, mise en file au-delà de la limite,
 *    exclusion mutuelle réelle, déblocage FIFO à la release, réentrance
 *    par slotKey, release par id, double-release idempotente ;
 *  - limites LLM PAR PROVIDER : isolation de deux providers à limites
 *    distinctes, fallback sur le défaut global (provider absent de la map),
 *    sentinelle "__default__", réentrance slotKey en présence de providers,
 *    drain FIFO par provider, setConfig partiel/remplacement de la map ;
 *  - timeout de file : délai configurable (queueTimeoutMs) honoré, rejet à
 *    expiration, tâche aborted ignorée par le drain, timer annulé pour une
 *    tâche servie avant expiration, repli sur le défaut si valeur invalide ;
 *  - drain via setConfig : augmenter une limite débloque la file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { concurrencyManager as manager, DEFAULT_CONFIG, DEFAULT_QUEUE_TIMEOUT_MS } from "./concurrency.js";
import {
  DEFAULT_AGENT_HARD_TIMEOUT_MS,
  DEFAULT_STREAM_SILENCE_TIMEOUT_MS,
} from "./stream-silence.js";

/** Forme attendue de la config par défaut (détecteur de silence inclus). */
const DEFAULTS = {
  maxLLMSlots: 3,
  queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
  streamSilenceTimeoutMs: DEFAULT_STREAM_SILENCE_TIMEOUT_MS,
  agentHardTimeoutMs: DEFAULT_AGENT_HARD_TIMEOUT_MS,
};

beforeEach(() => {
  // État frais : configuration par défaut (les slots sont nettoyés afterEach).
  // providerMaxLLMSlots: {} vide explicitement la map de limites par provider
  // (setConfig sans la clé la laisserait d'un test à l'autre).
  manager.setConfig({ ...DEFAULT_CONFIG, providerMaxLLMSlots: {} });
});

afterEach(() => {
  // Nettoyage du singleton : libère tout slot restant (release sur une clé
  // absente = no-op) puis restaure la configuration par défaut.
  // IMPORTANT : chaque release draine la file — une tâche servie devient un
  // NOUVEAU slot actif absent de la snapshot initiale. On boucle donc jusqu'à
  // vidage complet (terminaison garantie : chaque passe relâche au moins un
  // slot). Idem après setConfig, dont le drain peut encore servir des tâches.
  const vidangerPool = () => {
    for (;;) {
      const llm = manager.getStats().active;
      if (llm.length === 0) break;
      for (const slot of llm) manager.releaseLLMSlot(slot.slotKey);
    }
  };
  vidangerPool();
  manager.setConfig({ ...DEFAULT_CONFIG, providerMaxLLMSlots: {} });
  vidangerPool();
});

describe("configuration", () => {
  it("expose la configuration par défaut (3 slots LLM)", () => {
    expect(DEFAULT_CONFIG).toEqual(DEFAULTS);
    expect(manager.getConfig()).toEqual(DEFAULTS);
    expect(manager.getStats().llmSlots.max).toBe(3);
  });

  it("getConfig retourne une copie : muter le résultat ne modifie pas l'état interne", () => {
    const cfg = manager.getConfig();
    cfg.maxLLMSlots = 99;
    expect(manager.getConfig()).toEqual(DEFAULTS);
  });

  it("setConfig accepte une mise à jour partielle", () => {
    manager.setConfig({ maxLLMSlots: 7 });
    expect(manager.getConfig().maxLLMSlots).toBe(7);
    expect(manager.getConfig().queueTimeoutMs).toBe(DEFAULT_QUEUE_TIMEOUT_MS); // inchangé
  });

  it("setConfig ignore les valeurs invalides (0, négatif)", () => {
    manager.setConfig({ maxLLMSlots: 0 });
    expect(manager.getConfig()).toEqual(DEFAULTS);
    manager.setConfig({});
    expect(manager.getConfig()).toEqual(DEFAULTS);
  });
});

describe("slots LLM", () => {
  it("acquiert immédiatement tant que des slots sont disponibles", async () => {
    await manager.acquireLLMSlot("llm-a", "A");
    await manager.acquireLLMSlot("llm-b", "B");

    const stats = manager.getStats();
    expect(stats.llmSlots.used).toBe(2);
    expect(stats.llmSlots.queue).toBe(0);
    // Un slot acquis est tracé avec sa clé et son libellé.
    expect(stats.active).toContainEqual(
      expect.objectContaining({ slotKey: "llm-a", label: "A" })
    );
    expect(typeof stats.active[0].acquiredAt).toBe("number");
  });

  it("met en file d'attente le 4e appel quand les 3 slots sont pris", async () => {
    await manager.acquireLLMSlot("llm-a", "A");
    await manager.acquireLLMSlot("llm-b", "B");
    await manager.acquireLLMSlot("llm-c", "C");

    let acquired = false;
    const pending = manager.acquireLLMSlot("llm-d", "D").then(
      () => { acquired = true; },
      () => {}
    );
    await Promise.resolve(); // flush des microtasks

    expect(acquired).toBe(false); // toujours en attente
    expect(manager.getStats().llmSlots).toEqual({ used: 3, max: 3, queue: 1 });

    // Libère un slot : la tâche en file doit alors être servie.
    manager.releaseLLMSlot("llm-a");
    await pending;
    expect(acquired).toBe(true);
    expect(manager.getStats().llmSlots.used).toBe(3);
  });

  it("garantit l'exclusion mutuelle : jamais plus de 1 section critique simultanée", async () => {
    manager.setConfig({ maxLLMSlots: 1 });

    let concurrent = 0;
    let maxObserved = 0;
    const sectionCritique = async (key: string) => {
      await manager.acquireLLMSlot(key, key);
      concurrent++;
      maxObserved = Math.max(maxObserved, concurrent);
      // Simule un travail sous verrou (appel provider).
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      manager.releaseLLMSlot(key);
    };

    await Promise.all([
      sectionCritique("llm-w1"),
      sectionCritique("llm-w2"),
      sectionCritique("llm-w3"),
      sectionCritique("llm-w4"),
      sectionCritique("llm-w5"),
    ]);

    expect(maxObserved).toBe(1);
    expect(manager.getStats().llmSlots.used).toBe(0);
  });

  it("débloque les tâches en file dans l'ordre FIFO à chaque release", async () => {
    await manager.acquireLLMSlot("llm-a", "A");
    await manager.acquireLLMSlot("llm-b", "B");
    await manager.acquireLLMSlot("llm-c", "C");

    const order: string[] = [];
    const pD = manager.acquireLLMSlot("llm-d", "D").then(() => { order.push("d"); });
    const pE = manager.acquireLLMSlot("llm-e", "E").then(() => { order.push("e"); });
    const pF = manager.acquireLLMSlot("llm-f", "F").then(() => { order.push("f"); });
    await Promise.resolve();
    expect(manager.getStats().llmSlots.queue).toBe(3);

    // On attend les promesses chaînées elles-mêmes : elles ne se résolvent
    // qu'APRÈS l'exécution du order.push, ce qui rend l'ordre observable
    // déterministe (un simple await Promise.resolve() ne traverse pas toute
    // la chaîne de microtasks : promesse interne → wrapper async → then).
    manager.releaseLLMSlot("llm-a");
    await pD;
    expect(order).toEqual(["d"]);

    manager.releaseLLMSlot("llm-b");
    await pE;
    expect(order).toEqual(["d", "e"]);

    manager.releaseLLMSlot("llm-c");
    await pF;
    expect(order).toEqual(["d", "e", "f"]);
    expect(manager.getStats().llmSlots.used).toBe(3);
  });

  it("réentrance : une même slotKey ne consomme pas de slot supplémentaire", async () => {
    manager.setConfig({ maxLLMSlots: 1 });
    await manager.acquireLLMSlot("llm-r", "R");

    // Seconde acquisition avec la MÊME clé : résout immédiatement malgré
    // la capacité saturée (safety réentrance, cf. BUG-59).
    await manager.acquireLLMSlot("llm-r", "R");
    expect(manager.getStats().llmSlots.used).toBe(1);

    // Une autre clé est en revanche bien mise en attente.
    let resolved = false;
    const other = manager.acquireLLMSlot("llm-d", "D").then(
      () => { resolved = true; },
      () => {}
    );
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(manager.getStats().llmSlots.queue).toBe(1);

    manager.releaseLLMSlot("llm-r");
    await other;
    expect(resolved).toBe(true);
  });

  it("release par slotKey libère exactement le slot correspondant", async () => {
    await manager.acquireLLMSlot("llm-a", "A");
    await manager.acquireLLMSlot("llm-b", "B");

    manager.releaseLLMSlot("llm-b");
    const stats = manager.getStats();
    expect(stats.llmSlots.used).toBe(1);
    expect(stats.active.map((s) => s.slotKey)).toEqual(["llm-a"]);
  });

  it("double release : idempotente, ne vole pas le slot re-attribué à la file", async () => {
    manager.setConfig({ maxLLMSlots: 1 });
    await manager.acquireLLMSlot("llm-a", "A");

    const queued = manager.acquireLLMSlot("llm-b", "B");
    const done = queued.then(
      () => {},
      () => {}
    );
    await Promise.resolve();

    manager.releaseLLMSlot("llm-a"); // sert llm-b
    manager.releaseLLMSlot("llm-a"); // 2e release : no-op, ne doit rien casser

    await done;
    const stats = manager.getStats();
    expect(stats.llmSlots.used).toBe(1);
    expect(stats.active.map((s) => s.slotKey)).toEqual(["llm-b"]);
  });

  it("release sur une clé inconnue est un no-op silencieux", () => {
    expect(() => manager.releaseLLMSlot("inconnu")).not.toThrow();
    expect(manager.getStats().llmSlots.used).toBe(0);
  });
});

describe("timeout de file (queueTimeoutMs configurable, simulé avec fake timers)", () => {
  // Les tests historiques avancent de 60 s : on fixe explicitement 60 s.
  beforeEach(() => {
    manager.setConfig({ queueTimeoutMs: 60_000 });
  });

  it("honore le délai configuré : expire après queueTimeoutMs, pas après 60 s", async () => {
    vi.useFakeTimers();
    try {
      manager.setConfig({ queueTimeoutMs: 120_000 });
      await manager.acquireLLMSlot("llm-a", "A");
      await manager.acquireLLMSlot("llm-b", "B");
      await manager.acquireLLMSlot("llm-c", "C");

      const late = manager.acquireLLMSlot("llm-late", "Late");
      const assertion = expect(late).rejects.toThrow(/timed out/);

      // À 60 s : toujours en attente (délai effectif = 120 s).
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.getStats().llmSlots.queue).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(manager.getStats().llmSlots.queue).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("valeur invalide → repli sur le défaut (1 h)", () => {
    manager.setConfig({ queueTimeoutMs: -5 });
    expect(manager.getQueueTimeoutMs()).toBe(DEFAULT_QUEUE_TIMEOUT_MS);
    manager.setConfig({ queueTimeoutMs: 1.5 });
    expect(manager.getQueueTimeoutMs()).toBe(DEFAULT_QUEUE_TIMEOUT_MS);
    manager.setConfig({ queueTimeoutMs: 1_000 }); // sous le minimum (5 s)
    expect(manager.getQueueTimeoutMs()).toBe(DEFAULT_QUEUE_TIMEOUT_MS);
  });

  it("rejette l'acquisition après le timeout de file de 60 s", async () => {
    vi.useFakeTimers();
    try {
      await manager.acquireLLMSlot("llm-a", "A");
      await manager.acquireLLMSlot("llm-b", "B");
      await manager.acquireLLMSlot("llm-c", "C");

      // Handler attaché immédiatement pour éviter un rejet non géré.
      const late = manager.acquireLLMSlot("llm-late", "Late");
      const assertion = expect(late).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      // La tâche a été retirée de la file, les slots restent inchangés.
      expect(manager.getStats().llmSlots.queue).toBe(0);
      expect(manager.getStats().llmSlots.used).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("une tâche timeoutée (aborted) ne récupère pas le slot libéré ensuite", async () => {
    vi.useFakeTimers();
    try {
      await manager.acquireLLMSlot("llm-a", "A");
      await manager.acquireLLMSlot("llm-b", "B");
      await manager.acquireLLMSlot("llm-c", "C");

      const late = manager.acquireLLMSlot("llm-late", "Late");
      const lateRejected = expect(late).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60_000);
      await lateRejected;

      // Nouvelle tâche en file (timer frais de 60 s).
      let nextResolved = false;
      let nextRejected = false;
      const nextDone = manager.acquireLLMSlot("llm-next", "Next").then(
        () => { nextResolved = true; },
        () => { nextRejected = true; }
      );
      await Promise.resolve();
      expect(manager.getStats().llmSlots.queue).toBe(1);

      // Le drain doit ignorer la tâche aborted ("llm-late") et servir "next".
      manager.releaseLLMSlot("llm-a");
      await nextDone;

      expect(nextResolved).toBe(true);
      expect(nextRejected).toBe(false);
      const active = manager.getStats().active.map((s) => s.slotKey);
      expect(active).toContain("llm-next");
      expect(active).not.toContain("llm-late");
    } finally {
      vi.useRealTimers();
    }
  });

  it("une tâche servie avant expiration ne rejette pas ensuite (timer annulé)", async () => {
    vi.useFakeTimers();
    try {
      await manager.acquireLLMSlot("llm-a", "A");
      await manager.acquireLLMSlot("llm-b", "B");
      await manager.acquireLLMSlot("llm-c", "C");

      let rejected = false;
      const nextDone = manager.acquireLLMSlot("llm-next", "Next").then(
        () => {},
        () => { rejected = true; }
      );

      // Juste avant l'expiration : un slot se libère et sert la tâche.
      await vi.advanceTimersByTimeAsync(59_000);
      manager.releaseLLMSlot("llm-a");
      await nextDone;
      expect(rejected).toBe(false);

      // Le timer de la tâche servie a été annulé : avancer au-delà de 60 s
      // ne doit déclencher aucune rejection tardive.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rejected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un sous-agent qui attend un slot 45 min n'est PAS rejeté (défaut 1 h)", async () => {
    vi.useFakeTimers();
    try {
      // Défaut : 1 h — largement au-dessus des 45 min d'attente simulées.
      manager.setConfig({ queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS });
      await manager.acquireLLMSlot("llm-a", "A");
      await manager.acquireLLMSlot("llm-b", "B");
      await manager.acquireLLMSlot("llm-c", "C");

      let resolved = false;
      let rejected = false;
      const waiting = manager.acquireLLMSlot("llm-sub", "sub-agent").then(
        () => { resolved = true; },
        () => { rejected = true; }
      );

      // 45 min d'attente : toujours en file, aucune expiration de file.
      await vi.advanceTimersByTimeAsync(45 * 60_000);
      expect(rejected).toBe(false);
      expect(resolved).toBe(false);
      expect(manager.getStats().llmSlots.queue).toBe(1);

      // Un slot se libère enfin : le sous-agent le récupère (pas de rejet).
      manager.releaseLLMSlot("llm-a");
      await waiting;
      expect(resolved).toBe(true);
      expect(rejected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("drain de file via setConfig", () => {
  it("augmenter une limite débloque immédiatement les tâches en file", async () => {
    await manager.acquireLLMSlot("llm-a", "A");
    await manager.acquireLLMSlot("llm-b", "B");
    await manager.acquireLLMSlot("llm-c", "C");

    const queued = manager.acquireLLMSlot("llm-d", "D");
    const done = queued.then(
      () => {},
      () => {}
    );
    await Promise.resolve();
    expect(manager.getStats().llmSlots.queue).toBe(1);

    manager.setConfig({ maxLLMSlots: 4 }); // drain des files
    await done;

    expect(manager.getStats().llmSlots.used).toBe(4);
    expect(manager.getStats().llmSlots.queue).toBe(0);
  });
});

// ── Limites LLM par provider ──────────────────────────────────
// Limite effective = providerMaxLLMSlots[providerId] ?? maxLLMSlots.
// Provider inconnu (ou sentinelle "__default__") → défaut global : on ne
// rejette jamais un appel pour cause de provider inconnu.

describe("limites LLM par provider", () => {
  it("deux providers à limites distinctes : A plein ne bloque pas B", async () => {
    manager.setConfig({ maxLLMSlots: 2, providerMaxLLMSlots: { "prov-a": 1 } });

    // prov-a : 1/1 (limite propre atteinte)
    await manager.acquireLLMSlot("a-1", "A1", "prov-a");
    expect(manager.getStats().llmByProvider["prov-a"]).toEqual({ used: 1, max: 1, queue: 0 });

    // prov-b (absent de la map) utilise le défaut global (2) : indépendant
    await manager.acquireLLMSlot("b-1", "B1", "prov-b");

    // Une 2e tâche prov-a est mise en file SANS impacter prov-b
    let a2Resolved = false;
    const a2 = manager.acquireLLMSlot("a-2", "A2", "prov-a").then(
      () => { a2Resolved = true; },
      () => {}
    );
    await Promise.resolve();
    expect(a2Resolved).toBe(false);
    expect(manager.getStats().llmByProvider["prov-a"]).toEqual({ used: 1, max: 1, queue: 1 });

    // prov-b consomme librement son 2e slot pendant que prov-a est saturé
    await manager.acquireLLMSlot("b-2", "B2", "prov-b");
    // Isolation : 3 slots actifs au total (1 + 2), au-delà de la limite globale
    // de 2 qui ne s'applique qu'aux providers sans override.
    expect(manager.getStats().llmSlots.used).toBe(3);
    expect(manager.getStats().llmSlots.queue).toBe(1);

    // Libérer un slot prov-a ne réveille que la file prov-a
    manager.releaseLLMSlot("a-1");
    await a2;
    expect(a2Resolved).toBe(true);
    const after = manager.getStats();
    expect(after.llmByProvider["prov-a"]).toEqual({ used: 1, max: 1, queue: 0 });
    expect(after.llmByProvider["prov-b"]).toEqual({ used: 2, max: 2, queue: 0 });
  });

  it("fallback sur le défaut global quand le provider est absent de la map", async () => {
    manager.setConfig({ maxLLMSlots: 2, providerMaxLLMSlots: { "prov-a": 1 } });

    // "prov-x" absent de la map → limite = défaut global (2)
    await manager.acquireLLMSlot("x-1", "X1", "prov-x");
    await manager.acquireLLMSlot("x-2", "X2", "prov-x");

    let x3Resolved = false;
    const x3 = manager.acquireLLMSlot("x-3", "X3", "prov-x").then(
      () => { x3Resolved = true; },
      () => {}
    );
    await Promise.resolve();
    expect(x3Resolved).toBe(false);
    expect(manager.getStats().llmByProvider["prov-x"]).toEqual({ used: 2, max: 2, queue: 1 });

    manager.releaseLLMSlot("x-1");
    await x3;
    expect(manager.getStats().llmByProvider["prov-x"].used).toBe(2);
  });

  it("getEffectiveLLMLimit : override par provider, sinon défaut global", () => {
    manager.setConfig({ maxLLMSlots: 7, providerMaxLLMSlots: { "prov-a": 2 } });
    expect(manager.getEffectiveLLMLimit("prov-a")).toBe(2);
    expect(manager.getEffectiveLLMLimit("prov-inconnu")).toBe(7);
  });

  it("provider \"__default__\" : les appels sans provider partagent la sentinelle", async () => {
    manager.setConfig({ maxLLMSlots: 1, providerMaxLLMSlots: { "prov-a": 1 } });

    // Pas de provider → pool "__default__" (limite = défaut global 1)
    await manager.acquireLLMSlot("d-1", "D1");
    expect(manager.getStats().llmByProvider["__default__"]).toEqual({ used: 1, max: 1, queue: 0 });

    // La sentinelle est pleine, mais prov-a garde son propre pool
    await manager.acquireLLMSlot("a-1", "A1", "prov-a");

    // Un 2e appel sans provider est mis en file "__default__"
    let d2Resolved = false;
    const d2 = manager.acquireLLMSlot("d-2", "D2").then(
      () => { d2Resolved = true; },
      () => {}
    );
    await Promise.resolve();
    expect(d2Resolved).toBe(false);
    expect(manager.getStats().llmByProvider["__default__"].queue).toBe(1);

    // Le provider explicite "__default__" réutilise le même pool (réentrance incluse)
    await manager.acquireLLMSlot("d-1", "D1", "__default__");
    expect(manager.getStats().llmByProvider["__default__"].used).toBe(1);

    manager.releaseLLMSlot("d-1");
    await d2;
    expect(manager.getStats().llmByProvider["__default__"]).toEqual({ used: 1, max: 1, queue: 0 });
    expect(manager.getStats().llmByProvider["prov-a"].used).toBe(1);
  });

  it("réentrance par slotKey préservée, y compris en présence de providers", async () => {
    manager.setConfig({ maxLLMSlots: 1 });
    await manager.acquireLLMSlot("k-1", "K1", "prov-a");

    // Même slotKey, même provider : résout immédiatement (pas de 2e slot)
    await manager.acquireLLMSlot("k-1", "K1", "prov-a");
    expect(manager.getStats().llmSlots.used).toBe(1);

    // Même slotKey avec un autre provider : la réentrance safety reste basée
    // sur la slotKey (clé interne) — pas de 2e slot, même si prov-b est libre.
    await manager.acquireLLMSlot("k-1", "K1", "prov-b");
    expect(manager.getStats().llmSlots.used).toBe(1);

    // Une autre clé est bien mise en file du provider prov-a
    let k2Resolved = false;
    const k2 = manager.acquireLLMSlot("k-2", "K2", "prov-a").then(
      () => { k2Resolved = true; },
      () => {}
    );
    await Promise.resolve();
    expect(k2Resolved).toBe(false);

    // Release par slotKey seul : libère le slot (provider retrouvé via SlotInfo)
    manager.releaseLLMSlot("k-1");
    await k2;
    expect(k2Resolved).toBe(true);
    expect(manager.getStats().llmSlots.used).toBe(1);
  });

  it("drain FIFO par provider : libérer prov-a ne réveille que la file de prov-a", async () => {
    manager.setConfig({ maxLLMSlots: 5, providerMaxLLMSlots: { "prov-a": 1, "prov-b": 1 } });

    await manager.acquireLLMSlot("a-1", "A1", "prov-a");
    await manager.acquireLLMSlot("b-1", "B1", "prov-b");

    const order: string[] = [];
    const a2 = manager.acquireLLMSlot("a-2", "A2", "prov-a").then(() => order.push("a2"));
    const a3 = manager.acquireLLMSlot("a-3", "A3", "prov-a").then(() => order.push("a3"));
    const b2 = manager.acquireLLMSlot("b-2", "B2", "prov-b").then(() => order.push("b2"));
    await Promise.resolve();

    // File globale = somme des files provider ; files isolées par provider
    expect(manager.getStats().llmSlots.queue).toBe(3);
    expect(manager.getStats().llmByProvider["prov-a"]).toEqual({ used: 1, max: 1, queue: 2 });
    expect(manager.getStats().llmByProvider["prov-b"]).toEqual({ used: 1, max: 1, queue: 1 });

    // Libère prov-a : seule la file prov-a est servie (FIFO)
    manager.releaseLLMSlot("a-1");
    await a2;
    expect(order).toEqual(["a2"]);
    expect(manager.getStats().llmByProvider["prov-a"]).toEqual({ used: 1, max: 1, queue: 1 });
    expect(manager.getStats().llmByProvider["prov-b"]).toEqual({ used: 1, max: 1, queue: 1 });

    // Libère prov-b : b2 servi, files prov-a intactes
    manager.releaseLLMSlot("b-1");
    await b2;
    expect(order).toEqual(["a2", "b2"]);
    expect(manager.getStats().llmByProvider["prov-a"].queue).toBe(1);

    // Puis FIFO dans la file prov-a
    manager.releaseLLMSlot("a-2");
    await a3;
    expect(order).toEqual(["a2", "b2", "a3"]);
  });

  it("stats : agrégats globaux llmSlots préservés + détail llmByProvider", async () => {
    manager.setConfig({ maxLLMSlots: 3, providerMaxLLMSlots: { "prov-a": 2 } });
    await manager.acquireLLMSlot("a-1", "A1", "prov-a");
    await manager.acquireLLMSlot("a-2", "A2", "prov-a");
    const q = manager.acquireLLMSlot("a-3", "A3", "prov-a");
    q.catch(() => {}); // pas de rejet non géré
    await Promise.resolve();

    const stats = manager.getStats();
    // Champs consommés par l'UI (SettingsModal) : forme inchangée
    expect(stats.llmSlots).toEqual({ used: 2, max: 3, queue: 1 });
    expect(stats.llmByProvider).toEqual({ "prov-a": { used: 2, max: 2, queue: 1 } });
    // Slots actifs enrichis du provider, champs historiques conservés
    expect(stats.active[0]).toEqual(
      expect.objectContaining({ slotKey: "a-1", label: "A1", providerId: "prov-a" })
    );
    expect(typeof stats.active[0].acquiredAt).toBe("number");

    manager.releaseLLMSlot("a-1");
    manager.releaseLLMSlot("a-2");
    manager.releaseLLMSlot("a-3");
  });
});

describe("setConfig avec map de limites par provider", () => {
  it("update partiel : maxLLMSlots seul préserve la map existante", () => {
    manager.setConfig({ providerMaxLLMSlots: { "prov-a": 2 } });
    manager.setConfig({ maxLLMSlots: 4 });
    expect(manager.getConfig()).toEqual({
      maxLLMSlots: 4,
      providerMaxLLMSlots: { "prov-a": 2 },
      queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
      streamSilenceTimeoutMs: DEFAULT_STREAM_SILENCE_TIMEOUT_MS,
      agentHardTimeoutMs: DEFAULT_AGENT_HARD_TIMEOUT_MS,
    });
    expect(manager.getEffectiveLLMLimit("prov-a")).toBe(2);
  });

  it("fournir une map remplace l'ancienne (et {} la vide)", () => {
    manager.setConfig({ providerMaxLLMSlots: { "prov-a": 2, "prov-b": 3 } });
    manager.setConfig({ providerMaxLLMSlots: { "prov-c": 1 } });
    expect(manager.getConfig().providerMaxLLMSlots).toEqual({ "prov-c": 1 });

    // Map vide = plus aucun override : getConfig retombe sur la forme historique.
    manager.setConfig({ providerMaxLLMSlots: {} });
    expect(manager.getConfig()).toEqual(DEFAULTS);
    expect(manager.getEffectiveLLMLimit("prov-a")).toBe(3); // défaut global
  });

  it("ignore les entrées invalides de la map (0, négatif, non entier, clé réservée)", () => {
    // JSON brut : simule un payload API (own property "__proto__" incluse).
    const raw = JSON.parse('{"ok":2,"zero":0,"neg":-3,"flottant":1.5,"__proto__":9,"constructor":4}');
    manager.setConfig({ providerMaxLLMSlots: raw });
    expect(manager.getConfig().providerMaxLLMSlots).toEqual({ ok: 2 });
    // Aucune pollution de prototype.
    expect(({} as any).polluted).toBeUndefined();
  });

  it("augmenter la limite d'un provider débloque sa file (drain via setConfig)", async () => {
    manager.setConfig({ maxLLMSlots: 5, providerMaxLLMSlots: { "prov-a": 1 } });
    await manager.acquireLLMSlot("a-1", "A1", "prov-a");

    const queued = manager.acquireLLMSlot("a-2", "A2", "prov-a");
    const done = queued.then(
      () => {},
      () => {}
    );
    await Promise.resolve();
    expect(manager.getStats().llmSlots.queue).toBe(1);

    manager.setConfig({ providerMaxLLMSlots: { "prov-a": 2 } }); // drain de la file prov-a
    await done;
    expect(manager.getStats().llmSlots.queue).toBe(0);
    expect(manager.getStats().llmByProvider["prov-a"]).toEqual({ used: 2, max: 2, queue: 0 });
  });
});