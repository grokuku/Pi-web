/**
 * Tests unitaires du mutex : délai maximal d'attente (`acquireTimeoutMs`).
 *
 * Contexte : une opération git coincée (git qui attend un mot de passe) retenait
 * le verrou du dépôt SANS limite — toutes les opérations suivantes attendaient
 * indéfiniment, sans le moindre message. Avec un délai maximal, l'attente
 * ÉCHOUE avec un message au lieu de bloquer le dépôt.
 *
 * Aucun timer réel long : les délais testés sont de quelques dizaines de ms.
 */
import { describe, expect, it } from "vitest";
import { Mutex, MutexTimeoutError } from "./mutex.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Mutex — comportement nominal (non-régression)", () => {
  it("acquire() puis release() : le verrou se reprend", async () => {
    const m = new Mutex();
    await m.acquire();
    m.release();
    await m.acquire(); // ne doit pas pendre
    m.release();
  });

  it("sans délai max, un demandeur attend puis obtient le verrou", async () => {
    const m = new Mutex();
    await m.acquire();

    let acquired = false;
    const waiter = m.acquire().then(() => {
      acquired = true;
    });

    await delay(20);
    expect(acquired).toBe(false); // toujours en attente, sans erreur

    m.release();
    await waiter;
    expect(acquired).toBe(true);
    m.release();
  });

  it("run() libère le verrou même si la fonction échoue", async () => {
    const m = new Mutex();
    await expect(m.run(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    // Le verrou est libre : une seconde exécution passe immédiatement.
    await expect(m.run(() => "ok")).resolves.toBe("ok");
  });

  it("sérialise deux exécutions (pas de recouvrement)", async () => {
    const m = new Mutex();
    const order: string[] = [];
    await Promise.all([
      m.run(async () => {
        order.push("a-start");
        await delay(10);
        order.push("a-end");
      }),
      m.run(async () => {
        order.push("b-start");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });
});

describe("Mutex — délai maximal d'attente", () => {
  it("acquire(ms) rejette avec MutexTimeoutError quand le verrou ne vient pas", async () => {
    const m = new Mutex();
    await m.acquire(); // verrou retenu (simule une opération coincée)

    const start = Date.now();
    await expect(m.acquire(30)).rejects.toBeInstanceOf(MutexTimeoutError);
    // Rejet rapide : on n'attend pas indéfiniment.
    expect(Date.now() - start).toBeLessThan(1000);

    m.release();
  });

  it("le message explique l'attente, sans jargon sans issue", async () => {
    const m = new Mutex();
    await m.acquire();

    const err = (await m.acquire(20).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(MutexTimeoutError);
    expect(err.name).toBe("MutexTimeoutError");
    expect(err.message).toMatch(/waiting for a lock/i);
    expect(err.message).toMatch(/stuck/i);

    m.release();
  });

  it("acquireTimeoutMs du constructeur s'applique (git : verrou par dépôt)", async () => {
    const m = new Mutex({ acquireTimeoutMs: 25 });
    await m.acquire();

    await expect(m.acquire()).rejects.toBeInstanceOf(MutexTimeoutError);

    m.release();
  });

  it("un demandeur expiré ne vole pas la libération suivante", async () => {
    const m = new Mutex();
    await m.acquire();

    await expect(m.acquire(20)).rejects.toBeInstanceOf(MutexTimeoutError);

    // Le demandeur expiré a bien été retiré de la file : la libération rend le
    // verrou DISPONIBLE (sinon il resterait `locked` à jamais).
    m.release();
    await expect(m.run(() => "ok")).resolves.toBe("ok");
  });

  it("run(fn, ms) propage le timeout au lieu de pendre", async () => {
    const m = new Mutex();
    await m.acquire();

    await expect(m.run(() => "jamais exécuté", 20)).rejects.toBeInstanceOf(MutexTimeoutError);

    m.release();
  });
});
