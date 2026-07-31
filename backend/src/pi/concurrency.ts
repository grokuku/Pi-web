/**
 * Concurrency Manager for Pi-Web
 *
 * Two independent pools:
 * - LLM slots : limite les appels provider simultanés (RPM/TPM)
 * - Agent slots : limite les sessions Pi SDK simultanées (RAM)
 *
 * Chaque agent consomme un agent slot au démarrage, et un LLM slot
 * seulement pendant les appels provider. Les files d'attente sont
 * gérées par promesse — la tâche suivante est débloquée quand un
 * slot se libère.
 *
 * BUG-59 : la réentrance était basée sur projectId, ce qui causait
 * un bug : les agents harness partageaient le slot de la session
 * principale, et le release tuait le slot de la session principale.
 * Désormais, chaque appel utilise un slotKey unique (ex: "projectId::architect").
 */

// ── Types ─────────────────────────────────────────────────────

export interface ConcurrencyConfig {
  maxLLMSlots: number;    // appels provider simultanés max
  maxAgentSlots: number;  // sessions Pi SDK simultanées max
}

export const DEFAULT_CONFIG: ConcurrencyConfig = {
  maxLLMSlots: 3,
  maxAgentSlots: 5,
};

// Temps max d'attente dans la file avant rejet (60s)
const QUEUE_TIMEOUT_MS = 60_000;

interface QueuedTask {
  slotKey: string;
  label: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timestamp: number;
  aborted: boolean; // true si la tâche a timeouté dans la file
}

interface SlotInfo {
  slotKey: string;
  label: string;
  acquiredAt: number;
}

// ── Manager ───────────────────────────────────────────────────

class ConcurrencyManager {
  private config: ConcurrencyConfig = { ...DEFAULT_CONFIG };

  // Map key = slotKey (unique par appel)
  private llmSlots: Map<string, SlotInfo> = new Map();
  private agentSlots: Map<string, SlotInfo> = new Map();

  private llmQueue: QueuedTask[] = [];
  private agentQueue: QueuedTask[] = [];

  /** Met à jour la configuration (thread-safe car synchrone) */
  setConfig(config: Partial<ConcurrencyConfig>): void {
    if (config.maxLLMSlots !== undefined && config.maxLLMSlots > 0) {
      this.config.maxLLMSlots = config.maxLLMSlots;
    }
    if (config.maxAgentSlots !== undefined && config.maxAgentSlots > 0) {
      this.config.maxAgentSlots = config.maxAgentSlots;
    }
    // Tenter de débloquer des tâches en attente si les limites ont augmenté
    this.drainQueues();
  }

  getConfig(): ConcurrencyConfig {
    return { ...this.config };
  }

  /** Stats en temps réel */
  getStats() {
    return {
      llmSlots: { used: this.llmSlots.size, max: this.config.maxLLMSlots, queue: this.llmQueue.length },
      agentSlots: { used: this.agentSlots.size, max: this.config.maxAgentSlots, queue: this.agentQueue.length },
      active: [...this.llmSlots.values()],
      agents: [...this.agentSlots.values()],
    };
  }

  // ── LLM Slots ──

  /**
   * Acquiert un slot LLM. Si tous les slots sont pris, la promesse
   * reste en attente jusqu'à ce qu'un slot se libère ou que le
   * timeout de file (60s) expire.
   *
   * @param slotKey Identifiant unique par appel (ex: "projectId::architect")
   * @param label   Libellé pour affichage/stats
   */
  async acquireLLMSlot(slotKey: string, label: string): Promise<void> {
    // Réentrance safety : si ce slotKey a déjà un slot, ne rien faire
    if (this.llmSlots.has(slotKey)) return;

    if (this.llmSlots.size < this.config.maxLLMSlots) {
      this.llmSlots.set(slotKey, { slotKey, label, acquiredAt: Date.now() });
      return;
    }

    // File d'attente avec timeout
    return new Promise<void>((resolve, reject) => {
      const task: QueuedTask = {
        slotKey,
        label,
        resolve,
        reject,
        timestamp: Date.now(),
        aborted: false,
        timer: undefined as any,
      };
      task.timer = setTimeout(() => {
        task.aborted = true;
        const idx = this.llmQueue.indexOf(task);
        if (idx >= 0) this.llmQueue.splice(idx, 1);
        reject(new Error(
          `[concurrency] LLM slot acquisition timed out after ${QUEUE_TIMEOUT_MS / 1000}s ` +
          `(slotKey=${slotKey}, ${this.llmSlots.size}/${this.config.maxLLMSlots} slots used, ` +
          `${this.llmQueue.length} en attente)`
        ));
      }, QUEUE_TIMEOUT_MS);
      this.llmQueue.push(task);
    });
  }

  /** Libère un slot LLM (appelé dans le finally après l'appel provider) */
  releaseLLMSlot(slotKey: string): void {
    this.llmSlots.delete(slotKey);
    this.drainLLMQueue();
  }

  // ── Agent Slots ──

  /**
   * Acquiert un slot agent (session Pi SDK). Bloque si tous les
   * slots sont pris, avec timeout de file (60s).
   *
   * @param slotKey Identifiant unique par appel (ex: "projectId::auto-review")
   * @param label   Libellé pour affichage/stats
   */
  async acquireAgentSlot(slotKey: string, label: string): Promise<void> {
    if (this.agentSlots.has(slotKey)) return;

    if (this.agentSlots.size < this.config.maxAgentSlots) {
      this.agentSlots.set(slotKey, { slotKey, label, acquiredAt: Date.now() });
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const task: QueuedTask = {
        slotKey,
        label,
        resolve,
        reject,
        timestamp: Date.now(),
        aborted: false,
        timer: undefined as any,
      };
      task.timer = setTimeout(() => {
        task.aborted = true;
        const idx = this.agentQueue.indexOf(task);
        if (idx >= 0) this.agentQueue.splice(idx, 1);
        reject(new Error(
          `[concurrency] Agent slot acquisition timed out after ${QUEUE_TIMEOUT_MS / 1000}s ` +
          `(slotKey=${slotKey}, ${this.agentSlots.size}/${this.config.maxAgentSlots} slots used, ` +
          `${this.agentQueue.length} en attente)`
        ));
      }, QUEUE_TIMEOUT_MS);
      this.agentQueue.push(task);
    });
  }

  /** Libère un slot agent (session terminée) */
  releaseAgentSlot(slotKey: string): void {
    this.agentSlots.delete(slotKey);
    this.drainAgentQueue();
  }

  // ── Helpers ──

  private drainLLMQueue(): void {
    while (this.llmQueue.length > 0 && this.llmSlots.size < this.config.maxLLMSlots) {
      const next = this.llmQueue.shift()!;
      // Ignorer les tâches qui ont déjà timeouté dans la file
      if (next.aborted) continue;
      clearTimeout(next.timer);
      this.llmSlots.set(next.slotKey, { slotKey: next.slotKey, label: next.label, acquiredAt: Date.now() });
      next.resolve();
    }
  }

  private drainAgentQueue(): void {
    while (this.agentQueue.length > 0 && this.agentSlots.size < this.config.maxAgentSlots) {
      const next = this.agentQueue.shift()!;
      if (next.aborted) continue;
      clearTimeout(next.timer);
      this.agentSlots.set(next.slotKey, { slotKey: next.slotKey, label: next.label, acquiredAt: Date.now() });
      next.resolve();
    }
  }

  private drainQueues(): void {
    this.drainLLMQueue();
    this.drainAgentQueue();
  }
}

// ── Singleton ─────────────────────────────────────────────────

export const concurrencyManager = new ConcurrencyManager();