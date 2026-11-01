/**
 * Levée quand l'attente d'un verrou dépasse le délai maximal autorisé.
 *
 * Contexte : une opération bloquée (git qui attend un mot de passe, I/O figée)
 * retenait le verrou SANS limite — toutes les opérations suivantes du même
 * dépôt attendaient alors indéfiniment, sans le moindre message. Avec un délai
 * maximal, on échoue explicitement au lieu de bloquer en silence.
 */
export class MutexTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(
      `Timed out after ${Math.round(waitedMs / 1000)}s waiting for a lock held by another operation ` +
      `(that operation is probably stuck — the previous action never finished)`
    );
    this.name = "MutexTimeoutError";
  }
}

export interface MutexOptions {
  /**
   * Délai maximal d'attente de `acquire()` en ms (0 = illimité, défaut).
   * Un verrou sans limite ne doit être utilisé que pour des sections critiques
   * courtes dont on sait qu'elles ne peuvent pas se bloquer.
   */
  acquireTimeoutMs?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Simple async mutex for serializing file read/write operations.
 */
export class Mutex {
  private locked = false;
  private queue: Waiter[] = [];
  private readonly acquireTimeoutMs: number;

  constructor(options: MutexOptions = {}) {
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 0;
  }

  /**
   * Acquiert le verrou.
   *
   * @param timeoutMs délai maximal d'attente (ms) ; prioritaire sur celui du
   *   constructeur. 0 / non fourni = attente illimitée (compatibilité).
   * @throws MutexTimeoutError si le verrou n'est pas obtenu à temps — le
   *   demandeur est alors retiré de la file (il ne consommera pas la libération
   *   suivante, qui reviendrait à personne et bloquerait le mutex à jamais).
   */
  async acquire(timeoutMs?: number): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    const waitMs = timeoutMs ?? this.acquireTimeoutMs;
    const bounded = Number.isFinite(waitMs) && waitMs > 0;

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const waiter: Waiter = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };

      if (bounded) {
        timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new MutexTimeoutError(waitMs));
        }, waitMs);
      }

      this.queue.push(waiter);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Passation directe : le verrou reste `locked` pour le suivant.
      next.resolve();
    } else {
      this.locked = false;
    }
  }

  /** Run a function while holding the lock. */
  async run<T>(fn: () => T | Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
