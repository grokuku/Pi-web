/**
 * Tests Phase 2 — application réelle du limiteur de concurrence LLM.
 *
 * Couvre les garanties introduites en Phase 2 :
 *  - le PONT globalThis `__piWebConcurrency` (consommé par l'extension
 *    harness-orchestrator chargée par jiti) pointe bien sur le singleton du
 *    backend et expose la surface minimale attendue ;
 *  - pattern d'enveloppe (acquire → appel → release en finally) : AUCUNE fuite
 *    de slot en cas d'exception, d'abort et de timeout de file ;
 *  - provider inconnu → repli sur "__default__" et limite globale ;
 *  - deux providers distincts ne se bloquent pas ;
 *  - watchdog : un slot anormalement ancien est libéré de force (ERROR) et la
 *    file du provider est drainée.
 *
 * Les mécanismes de file FIFO par provider sont déjà couverts par
 * concurrency.test.ts (Phase 1) ; on ne teste ici que les ajouts Phase 2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  concurrencyManager as manager,
  CONCURRENCY_BRIDGE_KEY,
  DEFAULT_CONFIG,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_QUEUE_TIMEOUT_MS,
  LLM_SLOT_WATCHDOG_MIN_MS,
} from "./concurrency.js";

/** Vide les deux pools (chaque release draine la file → boucle jusqu'à stabilité). */
function vidangerPools(): void {
  for (;;) {
    const stats = manager.getStats();
    if (stats.active.length === 0 && stats.agents.length === 0) break;
    for (const slot of stats.active) manager.releaseLLMSlot(slot.slotKey);
    for (const slot of stats.agents) manager.releaseAgentSlot(slot.slotKey);
  }
}

beforeEach(() => {
  manager.setConfig({ ...DEFAULT_CONFIG, providerMaxLLMSlots: {} });
});

afterEach(() => {
  vidangerPools();
  manager.setConfig({ ...DEFAULT_CONFIG, providerMaxLLMSlots: {} });
  vidangerPools();
});

describe("pont globalThis __piWebConcurrency (consommé par l'extension jiti)", () => {
  it("est publié au chargement du module avec la surface minimale", () => {
    const bridge = (globalThis as any)[CONCURRENCY_BRIDGE_KEY];
    expect(bridge).toBeTruthy();
    expect(typeof bridge.acquireLLMSlot).toBe("function");
    expect(typeof bridge.releaseLLMSlot).toBe("function");
    expect(typeof bridge.getEffectiveLLMLimit).toBe("function");
    expect(typeof bridge.getStats).toBe("function");
  });

  it("acquiert/libère le MÊME singleton que le backend (pas une copie jiti)", async () => {
    const bridge = (globalThis as any)[CONCURRENCY_BRIDGE_KEY];
    // Acquisition via le pont → visible dans les stats du manager du backend.
    await bridge.acquireLLMSlot("bridge-slot", "bridge", "prov-x");
    expect(manager.getStats().active.map((s: any) => s.slotKey)).toContain("bridge-slot");
    // Release via le pont → libère bien le slot du manager du backend.
    bridge.releaseLLMSlot("bridge-slot");
    expect(manager.getStats().active.map((s: any) => s.slotKey)).not.toContain("bridge-slot");
  });
});

describe("aucune fuite de slot (acquire → appel → release en finally)", () => {
  /** Reproduit l'enveloppe Phase 2 (session.ts:withLLMSlot / extension). */
  async function withSlot<T>(key: string, provider: string, fn: () => Promise<T>): Promise<T> {
    await manager.acquireLLMSlot(key, "test", provider);
    try {
      return await fn();
    } finally {
      manager.releaseLLMSlot(key);
    }
  }

  it("libère le slot quand l'appel sous-jacent THROW", async () => {
    await expect(
      withSlot("ex-1", "prov-a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Aucun slot fantôme : la limite est de nouveau disponible.
    expect(manager.getStats().llmByProvider["prov-a"]?.used ?? 0).toBe(0);
    await manager.acquireLLMSlot("ex-1b", "test", "prov-a");
    expect(manager.getStats().llmByProvider["prov-a"]?.used).toBe(1);
  });

  it("libère le slot quand l'appel est ABORTÉ (rejet asynchrone)", async () => {
    const controller = new AbortController();
    const p = withSlot("ab-1", "prov-a", () =>
      new Promise<void>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    // Le slot est bien détenu pendant l'appel…
    await Promise.resolve();
    expect(manager.getStats().llmByProvider["prov-a"]?.used).toBe(1);
    controller.abort();
    await expect(p).rejects.toThrow("aborted");
    // …et libéré après l'abort.
    expect(manager.getStats().llmByProvider["prov-a"]?.used ?? 0).toBe(0);
  });

  it("libère sans tâche fantôme après TIMEOUT de file (rejet + file vidée)", async () => {
    vi.useFakeTimers();
    try {
      manager.setConfig({ maxLLMSlots: 1, providerMaxLLMSlots: {}, queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS });
      manager.setConfig({ queueTimeoutMs: 5_000 });
      // Le détenteur occupe l'unique slot.
      await manager.acquireLLMSlot("hold", "hold", "prov-a");
      const pending = manager.acquireLLMSlot("waiting", "waiting", "prov-a");
      const expectation = expect(pending).rejects.toThrow(/timed out/);
      expect(manager.getStats().llmByProvider["prov-a"]!.queue).toBe(1);
      // Expiration du timer de file (vrai setTimeout, fake timers).
      await vi.advanceTimersByTimeAsync(5_000);
      await expectation;
      // File vidée : AUCUNE tâche fantôme ne sera servie par le prochain release.
      expect(manager.getStats().llmByProvider["prov-a"]!.queue).toBe(0);
      manager.releaseLLMSlot("hold");
      expect(manager.getStats().llmByProvider["prov-a"]?.used ?? 0).toBe(0);
      expect(manager.getStats().llmByProvider["prov-a"]?.queue ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("provider inconnu / isolation des providers", () => {
  it("provider inconnu → repli sur la limite globale (jamais de rejet)", async () => {
    manager.setConfig({ maxLLMSlots: 2, providerMaxLLMSlots: { "prov-a": 1 } });
    expect(manager.getEffectiveLLMLimit("inexistant")).toBe(2);
    expect(manager.getEffectiveLLMLimit(DEFAULT_LLM_PROVIDER)).toBe(2);
    await manager.acquireLLMSlot("u-1", "u1", "inexistant");
    await manager.acquireLLMSlot("u-2", "u2", "inexistant");
    expect(manager.getStats().llmByProvider["inexistant"]).toEqual({ used: 2, max: 2, queue: 0 });
  });

  it("deux providers différents ne se bloquent pas mutuellement", async () => {
    manager.setConfig({ maxLLMSlots: 1, providerMaxLLMSlots: { "prov-a": 1, "prov-b": 1 } });
    await manager.acquireLLMSlot("a", "A", "prov-a");
    // prov-a saturé, prov-b doit pouvoir acquérir immédiatement.
    await manager.acquireLLMSlot("b", "B", "prov-b");
    expect(manager.getStats().llmByProvider["prov-a"]!.used).toBe(1);
    expect(manager.getStats().llmByProvider["prov-b"]!.used).toBe(1);
  });
});

describe("watchdog anti-blocage", () => {
  it("seuil = max(30 min, 3 × queueTimeoutMs)", () => {
    // 5 min → 15 min < 30 min : le plancher de 30 min s'applique.
    manager.setConfig({ queueTimeoutMs: 300_000 });
    expect(manager.getSlotWatchdogMs()).toBe(LLM_SLOT_WATCHDOG_MIN_MS);
    manager.setConfig({ queueTimeoutMs: 3_600_000 }); // 1 h → 3 h > 30 min
    expect(manager.getSlotWatchdogMs()).toBe(3 * 3_600_000);
  });

  it("libère de FORCE un slot trop ancien et draine la file du provider", async () => {
    manager.setConfig({ maxLLMSlots: 1, providerMaxLLMSlots: {}, queueTimeoutMs: 600_000 });
    await manager.acquireLLMSlot("old", "old", "prov-a");
    const pending = manager.acquireLLMSlot("new", "new", "prov-a");
    await Promise.resolve();
    expect(manager.getStats().llmByProvider["prov-a"]).toEqual({ used: 1, max: 1, queue: 1 });

    // Simule un slot détenu depuis plus que le seuil du watchdog.
    const freed = manager.forceReleaseStaleLLMSlots(Date.now() + manager.getSlotWatchdogMs() + 1_000);
    expect(freed).toEqual(["old"]);
    // Le slot est libéré et la tâche en file démarre (drain).
    await pending;
    expect(manager.getStats().llmByProvider["prov-a"]).toEqual({ used: 1, max: 1, queue: 0 });
    manager.releaseLLMSlot("new");
  });

  it("ne touche pas un slot récent", async () => {
    await manager.acquireLLMSlot("fresh", "fresh", "prov-a");
    const freed = manager.forceReleaseStaleLLMSlots(Date.now());
    expect(freed).toEqual([]);
    expect(manager.getStats().active.map((s: any) => s.slotKey)).toContain("fresh");
  });
});
