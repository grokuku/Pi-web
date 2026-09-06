/**
 * Tests unitaires de pi/concurrency.ts (ConcurrencyManager).
 *
 * Le singleton concurrencyManager est testé avec de la concurrence simulée :
 * sections critiques asynchrones (Promises + setTimeout courts), files
 * d'attente observées via getStats(), et fake timers pour le timeout de
 * file de 60 s (QUEUE_TIMEOUT_MS — non configurable, donc simulé).
 *
 * Couverture :
 *  - configuration : valeurs par défaut, copie défensive, mise à jour
 *    partielle, rejet des valeurs invalides (<= 0) ;
 *  - slots LLM : acquisition immédiate, mise en file au-delà de la limite,
 *    exclusion mutuelle réelle, déblocage FIFO à la release, réentrance
 *    par slotKey, release par id, double-release idempotente ;
 *  - timeout de file : rejet après 60 s, tâche aborted ignorée par le
 *    drain, timer annulé pour une tâche servie avant expiration ;
 *  - drain via setConfig : augmenter une limite débloque la file ;
 *  - slots agent : même sémantique, pools indépendants ;
 *  - charge mixte : Promise.all de tâches LLM et agent simultanées.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { concurrencyManager as manager, DEFAULT_CONFIG } from "./concurrency.js";

beforeEach(() => {
  // État frais : configuration par défaut (les slots sont nettoyés afterEach).
  manager.setConfig(DEFAULT_CONFIG);
});

afterEach(() => {
  // Nettoyage du singleton : libère tout slot restant (release sur une clé
  // absente = no-op) puis restaure la configuration par défaut.
  // IMPORTANT : chaque release draine la file — une tâche servie devient un
  // NOUVEAU slot actif absent de la snapshot initiale. On boucle donc jusqu'à
  // vidage complet des deux pools (terminaison garantie : chaque passe relâche
  // au moins un slot). Idem après setConfig, dont le drain peut encore servir
  // des tâches en file.
  const vidangerPools = () => {
    for (;;) {
      const llm = manager.getStats().active;
      const agents = manager.getStats().agents;
      if (llm.length === 0 && agents.length === 0) break;
      for (const slot of llm) manager.releaseLLMSlot(slot.slotKey);
      for (const slot of agents) manager.releaseAgentSlot(slot.slotKey);
    }
  };
  vidangerPools();
  manager.setConfig(DEFAULT_CONFIG);
  vidangerPools();
});

describe("configuration", () => {
  it("expose la configuration par défaut (3 slots LLM, 5 slots agent)", () => {
    expect(DEFAULT_CONFIG).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5 });
    expect(manager.getConfig()).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5 });
    expect(manager.getStats().llmSlots.max).toBe(3);
    expect(manager.getStats().agentSlots.max).toBe(5);
  });

  it("getConfig retourne une copie : muter le résultat ne modifie pas l'état interne", () => {
    const cfg = manager.getConfig();
    cfg.maxLLMSlots = 99;
    cfg.maxAgentSlots = 99;
    expect(manager.getConfig()).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5 });
  });

  it("setConfig accepte une mise à jour partielle", () => {
    manager.setConfig({ maxAgentSlots: 7 });
    expect(manager.getConfig().maxAgentSlots).toBe(7);
    expect(manager.getConfig().maxLLMSlots).toBe(3); // inchangé
  });

  it("setConfig ignore les valeurs invalides (0, négatif)", () => {
    manager.setConfig({ maxLLMSlots: 0, maxAgentSlots: -1 });
    expect(manager.getConfig()).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5 });
    manager.setConfig({});
    expect(manager.getConfig()).toEqual({ maxLLMSlots: 3, maxAgentSlots: 5 });
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
    expect(() => manager.releaseAgentSlot("inconnu")).not.toThrow();
    expect(manager.getStats().llmSlots.used).toBe(0);
    expect(manager.getStats().agentSlots.used).toBe(0);
  });
});

describe("timeout de file (60 s, simulé avec fake timers)", () => {
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

describe("slots agent (pool indépendant)", () => {
  it("les deux pools sont indépendants : des slots LLM pleins ne bloquent pas les agents", async () => {
    await manager.acquireLLMSlot("llm-a", "A");
    await manager.acquireLLMSlot("llm-b", "B");
    await manager.acquireLLMSlot("llm-c", "C");

    await manager.acquireAgentSlot("agent-1", "Agent 1");

    const stats = manager.getStats();
    expect(stats.llmSlots.used).toBe(3);
    expect(stats.llmSlots.queue).toBe(0);
    expect(stats.agentSlots.used).toBe(1);
  });

  it("file d'attente et FIFO propres au pool agent", async () => {
    manager.setConfig({ maxAgentSlots: 1 });
    await manager.acquireAgentSlot("agent-1", "Agent 1");

    const order: number[] = [];
    const p2 = manager.acquireAgentSlot("agent-2", "Agent 2").then(() => order.push(2));
    const p3 = manager.acquireAgentSlot("agent-3", "Agent 3").then(() => order.push(3));
    await Promise.resolve();
    expect(manager.getStats().agentSlots.queue).toBe(2);

    // Promesses chaînées : ordre FIFO observable de façon déterministe.
    // Un seul slot : chaque release sert exactement une tâche de la file.
    manager.releaseAgentSlot("agent-1");
    await p2;
    expect(order).toEqual([2]);

    manager.releaseAgentSlot("agent-2");
    await p3;
    expect(order).toEqual([2, 3]);
  });

  it("garantit l'exclusion mutuelle sur 2 slots agent simultanés", async () => {
    manager.setConfig({ maxAgentSlots: 2 });

    let concurrent = 0;
    let maxObserved = 0;
    const session = async (key: string) => {
      await manager.acquireAgentSlot(key, key);
      concurrent++;
      maxObserved = Math.max(maxObserved, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      manager.releaseAgentSlot(key);
    };

    await Promise.all([
      session("agent-1"),
      session("agent-2"),
      session("agent-3"),
      session("agent-4"),
    ]);

    expect(maxObserved).toBe(2);
    expect(manager.getStats().agentSlots.used).toBe(0);
  });
});

describe("charge mixte (intégration)", () => {
  it("Promise.all de tâches LLM et agent : chaque pool respecte sa propre limite", async () => {
    manager.setConfig({ maxLLMSlots: 2, maxAgentSlots: 3 });

    let llmConcurrent = 0;
    let llmMax = 0;
    let agentConcurrent = 0;
    let agentMax = 0;

    const llmTask = async (i: number) => {
      const key = `llm-mix-${i}`;
      await manager.acquireLLMSlot(key, key);
      llmConcurrent++;
      llmMax = Math.max(llmMax, llmConcurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      llmConcurrent--;
      manager.releaseLLMSlot(key);
    };

    const agentTask = async (i: number) => {
      const key = `agent-mix-${i}`;
      await manager.acquireAgentSlot(key, key);
      agentConcurrent++;
      agentMax = Math.max(agentMax, agentConcurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      agentConcurrent--;
      manager.releaseAgentSlot(key);
    };

    await Promise.all([
      llmTask(1), llmTask(2), llmTask(3), llmTask(4),
      agentTask(1), agentTask(2), agentTask(3), agentTask(4), agentTask(5),
    ]);

    expect(llmMax).toBeLessThanOrEqual(2);
    expect(agentMax).toBeLessThanOrEqual(3);
    expect(manager.getStats().llmSlots.used).toBe(0);
    expect(manager.getStats().agentSlots.used).toBe(0);
    expect(manager.getStats().llmSlots.queue).toBe(0);
    expect(manager.getStats().agentSlots.queue).toBe(0);
  });
});