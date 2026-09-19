/**
 * Concurrency Manager for Pi-Web
 *
 * Two independent pools:
 * - LLM slots : limite les appels provider simultanés (RPM/TPM),
 *   PAR PROVIDER — chaque provider a ses propres slots et sa propre
 *   file d'attente, avec une limite effective = override par provider
 *   (providerMaxLLMSlots[providerId]) ?? maxLLMSlots (défaut global).
 * - Agent slots : limite les sessions Pi SDK simultanées (RAM),
 *   reste GLOBAL (non segmenté par provider).
 *
 * Chaque agent consomme un agent slot au démarrage, et un LLM slot
 * seulement pendant les appels provider. Les files d'attente sont
 * gérées par promesse — la tâche suivante est débloquée quand un
 * slot se libère, dans la file du MÊME provider uniquement.
 *
 * BUG-59 : la réentrance était basée sur projectId, ce qui causait
 * un bug : les agents harness partageaient le slot de la session
 * principale, et le release tuait le slot de la session principale.
 * Désormais, chaque appel utilise un slotKey unique (ex: "projectId::architect").
 */

// ── Types ─────────────────────────────────────────────────────

export interface ConcurrencyConfig {
  maxLLMSlots: number;    // limite LLM par DÉFAUT (globale, utilisée pour tout provider sans override)
  maxAgentSlots: number;  // sessions Pi SDK simultanées max (global, non segmenté par provider)
  providerMaxLLMSlots?: Record<string, number>;  // limite LLM par provider (override du défaut global)
}

export const DEFAULT_CONFIG: ConcurrencyConfig = {
  maxLLMSlots: 3,
  maxAgentSlots: 5,
};

// Provider sentinelle : providerId de repli quand l'appelant ne connaît pas
// le provider (modèle inconnu, anciens appels, tests). Un provider absent de
// la map — y compris la sentinelle — retombe toujours sur le défaut global :
// on ne rejette jamais un appel pour cause de provider inconnu.
export const DEFAULT_LLM_PROVIDER = "__default__";

// Temps max d'attente dans la file avant rejet (60s)
const QUEUE_TIMEOUT_MS = 60_000;

interface QueuedTask {
  slotKey: string;
  label: string;
  providerId: string;  // provider propriétaire de la tâche (file isolée par provider)
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timestamp: number;
  aborted: boolean; // true si la tâche a timeouté dans la file
}

interface SlotInfo {
  slotKey: string;
  label: string;
  providerId: string; // mémorisé pour retrouver le provider au release
  acquiredAt: number;
}

/** Filtre les entrées invalides d'une map de limites par provider. */
function sanitizeProviderLimits(map: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(map || {})) {
    // Clés réservées JS : jamais acceptées (protection pollution de prototype).
    if (typeof key !== "string" || !key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) continue;
    out[key] = value;
  }
  return out;
}

// ── Manager ───────────────────────────────────────────────────

class ConcurrencyManager {
  private config: ConcurrencyConfig = { ...DEFAULT_CONFIG };

  // Limites LLM par provider (providerId → slots max). Champ séparé de
  // `config` pour que getConfig() n'expose la map que si elle est non vide
  // (rétro-compatibilité : un config sans override garde sa forme historique).
  private providerLimits: Record<string, number> = {};

  // Map key = slotKey (unique par appel) ; SlotInfo porte le providerId.
  private llmSlots: Map<string, SlotInfo> = new Map();
  private agentSlots: Map<string, SlotInfo> = new Map();

  // Files d'attente LLM PAR PROVIDER : libérer un slot d'un provider ne
  // réveille que la file de CE provider (isolation des limites RPM/TPM).
  private llmQueues: Map<string, QueuedTask[]> = new Map();
  private agentQueue: QueuedTask[] = [];

  /** Met à jour la configuration (thread-safe car synchrone) */
  setConfig(config: Partial<ConcurrencyConfig>): void {
    if (config.maxLLMSlots !== undefined && config.maxLLMSlots > 0) {
      this.config.maxLLMSlots = config.maxLLMSlots;
    }
    if (config.maxAgentSlots !== undefined && config.maxAgentSlots > 0) {
      this.config.maxAgentSlots = config.maxAgentSlots;
    }
    // Map de limites par provider : remplacée ENTIÈREMENT quand elle est
    // fournie (permet de supprimer un override en envoyant une map réduite
    // ou vide) ; laissée inchangée si absente (setConfig partiel compatible).
    if (config.providerMaxLLMSlots !== undefined && typeof config.providerMaxLLMSlots === "object") {
      this.providerLimits = sanitizeProviderLimits(config.providerMaxLLMSlots);
    }
    // Tenter de débloquer des tâches en attente si les limites ont augmenté
    this.drainQueues();
  }

  getConfig(): ConcurrencyConfig {
    const cfg: ConcurrencyConfig = { ...this.config };
    if (Object.keys(this.providerLimits).length > 0) {
      cfg.providerMaxLLMSlots = { ...this.providerLimits };
    }
    return cfg;
  }

  /**
   * Limite LLM effective d'un provider : override par provider si présent,
   * sinon le défaut global maxLLMSlots. Provider inconnu → défaut global.
   */
  getEffectiveLLMLimit(providerId: string): number {
    return this.providerLimits[providerId] ?? this.config.maxLLMSlots;
  }

  /** Stats en temps réel */
  getStats() {
    // Agrégats globaux préservés (consommés par l'UI : SettingsModal).
    let llmQueued = 0;
    for (const queue of this.llmQueues.values()) llmQueued += queue.length;
    // Détail par provider : tout provider ayant des slots, une file ou un override.
    const llmByProvider: Record<string, { used: number; max: number; queue: number }> = {};
    for (const slot of this.llmSlots.values()) {
      const entry = (llmByProvider[slot.providerId] ??= {
        used: 0,
        max: this.getEffectiveLLMLimit(slot.providerId),
        queue: 0,
      });
      entry.used++;
    }
    for (const [providerId, queue] of this.llmQueues) {
      const entry = (llmByProvider[providerId] ??= {
        used: 0,
        max: this.getEffectiveLLMLimit(providerId),
        queue: 0,
      });
      entry.queue = queue.length;
    }
    for (const providerId of Object.keys(this.providerLimits)) {
      llmByProvider[providerId] ??= {
        used: 0,
        max: this.getEffectiveLLMLimit(providerId),
        queue: 0,
      };
    }
    return {
      llmSlots: { used: this.llmSlots.size, max: this.config.maxLLMSlots, queue: llmQueued },
      agentSlots: { used: this.agentSlots.size, max: this.config.maxAgentSlots, queue: this.agentQueue.length },
      llmByProvider,
      active: [...this.llmSlots.values()],
      agents: [...this.agentSlots.values()],
    };
  }

  // ── LLM Slots (pool par provider) ──

  /** Nombre de slots LLM actuellement détenus par un provider. */
  private usedLLMSlotsByProvider(providerId: string): number {
    let n = 0;
    for (const slot of this.llmSlots.values()) {
      if (slot.providerId === providerId) n++;
    }
    return n;
  }

  /**
   * Acquiert un slot LLM pour un provider. Si la limite effective de CE
   * provider est atteinte (providerMaxLLMSlots[providerId] ?? maxLLMSlots),
   * la promesse reste en attente dans la file du provider jusqu'à ce qu'un
   * slot se libère ou que le timeout de file (60s) expire.
   *
   * @param slotKey    Identifiant unique par appel (ex: "provider::projectId::architect")
   * @param label      Libellé pour affichage/stats
   * @param providerId Provider du modèle appelé ; défaut "__default__"
   *                   (rétro-compatible : les appels sans provider partagent
   *                   le pool de la sentinelle, limite = défaut global).
   */
  async acquireLLMSlot(slotKey: string, label: string, providerId: string = DEFAULT_LLM_PROVIDER): Promise<void> {
    // Réentrance safety : si ce slotKey a déjà un slot, ne rien faire
    if (this.llmSlots.has(slotKey)) return;

    const limit = this.getEffectiveLLMLimit(providerId);
    if (this.usedLLMSlotsByProvider(providerId) < limit) {
      this.llmSlots.set(slotKey, { slotKey, label, providerId, acquiredAt: Date.now() });
      return;
    }

    // File d'attente propre au provider, avec timeout
    return new Promise<void>((resolve, reject) => {
      const task: QueuedTask = {
        slotKey,
        label,
        providerId,
        resolve,
        reject,
        timestamp: Date.now(),
        aborted: false,
        timer: undefined as any,
      };
      task.timer = setTimeout(() => {
        task.aborted = true;
        const queue = this.llmQueues.get(providerId);
        const idx = queue ? queue.indexOf(task) : -1;
        if (queue && idx >= 0) queue.splice(idx, 1);
        const remaining = queue ? queue.length : 0;
        reject(new Error(
          `[concurrency] LLM slot acquisition timed out after ${QUEUE_TIMEOUT_MS / 1000}s ` +
          `(slotKey=${slotKey}, provider=${providerId}, ${this.usedLLMSlotsByProvider(providerId)}/${limit} slots used, ` +
          `${remaining} en attente)`
        ));
      }, QUEUE_TIMEOUT_MS);
      let queue = this.llmQueues.get(providerId);
      if (!queue) {
        queue = [];
        this.llmQueues.set(providerId, queue);
      }
      queue.push(task);
    });
  }

  /** Libère un slot LLM (appelé dans le finally après l'appel provider). */
  releaseLLMSlot(slotKey: string): void {
    // Le provider est retrouvé depuis le SlotInfo (mémorisé à l'acquisition) :
    // l'appelant n'a pas besoin de re-préciser le provider, et une clé
    // inconnue reste un no-op silencieux.
    const slot = this.llmSlots.get(slotKey);
    if (!slot) return;
    this.llmSlots.delete(slotKey);
    // Seule la file de CE provider peut être réveillée.
    this.drainLLMQueue(slot.providerId);
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
      this.agentSlots.set(slotKey, { slotKey, label, providerId: DEFAULT_LLM_PROVIDER, acquiredAt: Date.now() });
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const task: QueuedTask = {
        slotKey,
        label,
        providerId: DEFAULT_LLM_PROVIDER,
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

  /** Drain FIFO de la file d'un provider : servi tant que SA limite effective n'est pas atteinte. */
  private drainLLMQueue(providerId: string): void {
    const queue = this.llmQueues.get(providerId);
    if (!queue || queue.length === 0) return;
    while (queue.length > 0 && this.usedLLMSlotsByProvider(providerId) < this.getEffectiveLLMLimit(providerId)) {
      const next = queue.shift()!;
      // Ignorer les tâches qui ont déjà timeouté dans la file
      if (next.aborted) continue;
      clearTimeout(next.timer);
      this.llmSlots.set(next.slotKey, {
        slotKey: next.slotKey,
        label: next.label,
        providerId,
        acquiredAt: Date.now(),
      });
      next.resolve();
    }
    if (queue.length === 0) this.llmQueues.delete(providerId);
  }

  private drainAgentQueue(): void {
    while (this.agentQueue.length > 0 && this.agentSlots.size < this.config.maxAgentSlots) {
      const next = this.agentQueue.shift()!;
      if (next.aborted) continue;
      clearTimeout(next.timer);
      this.agentSlots.set(next.slotKey, { slotKey: next.slotKey, label: next.label, providerId: DEFAULT_LLM_PROVIDER, acquiredAt: Date.now() });
      next.resolve();
    }
  }

  private drainQueues(): void {
    // Drain LLM : chaque provider ne débloque que sa propre file.
    for (const providerId of [...this.llmQueues.keys()]) {
      this.drainLLMQueue(providerId);
    }
    this.drainAgentQueue();
  }
}

// ── Singleton ─────────────────────────────────────────────────

export const concurrencyManager = new ConcurrencyManager();