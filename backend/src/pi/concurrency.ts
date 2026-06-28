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

interface QueuedTask {
  resolve: () => void;
  projectId: string;
  label: string;
  timestamp: number;
}

interface SlotInfo {
  projectId: string;
  label: string;
  acquiredAt: number;
}

// ── Manager ───────────────────────────────────────────────────

class ConcurrencyManager {
  private config: ConcurrencyConfig = { ...DEFAULT_CONFIG };

  private llmSlots: Map<string, SlotInfo> = new Map();
  private agentSlots: Map<string, SlotInfo> = new Map();

  private llmQueue: QueuedTask[] = [];
  private agentQueue: QueuedTask[] = [];

  private slotCounter = 0;

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
   * reste en attente jusqu'à ce qu'un slot se libère.
   */
  async acquireLLMSlot(projectId: string, label: string): Promise<void> {
    const slot = this.tryAcquireLLM(projectId, label);
    if (slot) return;

    // File d'attente
    return new Promise<void>((resolve) => {
      this.llmQueue.push({ resolve, projectId, label, timestamp: Date.now() });
    });
  }

  /** Libère un slot LLM (appelé dans le finally après l'appel provider) */
  releaseLLMSlot(projectId: string): void {
    // Trouver et supprimer le slot correspondant
    for (const [id, info] of this.llmSlots) {
      if (info.projectId === projectId) {
        this.llmSlots.delete(id);
        break;
      }
    }
    // Débloquer la prochaine tâche en attente
    this.drainLLMQueue();
  }

  // ── Agent Slots ──

  /**
   * Acquiert un slot agent (session Pi SDK). Bloque si tous les
   * slots sont pris.
   */
  async acquireAgentSlot(projectId: string, label: string): Promise<void> {
    const slot = this.tryAcquireAgent(projectId, label);
    if (slot) return;

    return new Promise<void>((resolve) => {
      this.agentQueue.push({ resolve, projectId, label, timestamp: Date.now() });
    });
  }

  /** Libère un slot agent (session terminée) */
  releaseAgentSlot(projectId: string): void {
    for (const [id, info] of this.agentSlots) {
      if (info.projectId === projectId) {
        this.agentSlots.delete(id);
        break;
      }
    }
    this.drainAgentQueue();
  }

  // ── Helpers ──

  private tryAcquireLLM(projectId: string, label: string): string | null {
    // Vérifier si ce project a déjà un slot (réentrance)
    for (const [id, info] of this.llmSlots) {
      if (info.projectId === projectId) return id;
    }

    if (this.llmSlots.size < this.config.maxLLMSlots) {
      const id = `llm-${++this.slotCounter}`;
      this.llmSlots.set(id, { projectId, label, acquiredAt: Date.now() });
      return id;
    }
    return null;
  }

  private tryAcquireAgent(projectId: string, label: string): string | null {
    for (const [id, info] of this.agentSlots) {
      if (info.projectId === projectId) return id;
    }

    if (this.agentSlots.size < this.config.maxAgentSlots) {
      const id = `agent-${++this.slotCounter}`;
      this.agentSlots.set(id, { projectId, label, acquiredAt: Date.now() });
      return id;
    }
    return null;
  }

  private drainLLMQueue(): void {
    while (this.llmQueue.length > 0 && this.llmSlots.size < this.config.maxLLMSlots) {
      const next = this.llmQueue.shift()!;
      const slot = this.tryAcquireLLM(next.projectId, next.label);
      if (slot) next.resolve();
    }
  }

  private drainAgentQueue(): void {
    while (this.agentQueue.length > 0 && this.agentSlots.size < this.config.maxAgentSlots) {
      const next = this.agentQueue.shift()!;
      const slot = this.tryAcquireAgent(next.projectId, next.label);
      if (slot) next.resolve();
    }
  }

  private drainQueues(): void {
    this.drainLLMQueue();
    this.drainAgentQueue();
  }
}

// ── Singleton ─────────────────────────────────────────────────

export const concurrencyManager = new ConcurrencyManager();
