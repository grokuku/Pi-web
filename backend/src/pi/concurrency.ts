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

import { logger } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────

export interface ConcurrencyConfig {
  maxLLMSlots: number;    // limite LLM par DÉFAUT (globale, utilisée pour tout provider sans override)
  maxAgentSlots: number;  // sessions Pi SDK simultanées max (global, non segmenté par provider)
  providerMaxLLMSlots?: Record<string, number>;  // limite LLM par provider (override du défaut global)
  queueTimeoutMs?: number;  // délai max d'attente en file avant rejet (ms)
}

// ── Timeout de file ──
// Défaut généreux (10 min) : un sous-agent HARNESS peut être mis en file
// derrière un provider saturé et attendre plusieurs minutes sans être perdu.
// L'ancien 60 s fixe était un plafond arbitraire qui tuait ces attentes.
// Bornes exposées pour la validation route (5 s..1 h) et la normalisation.
export const DEFAULT_QUEUE_TIMEOUT_MS = 600_000;
export const MIN_QUEUE_TIMEOUT_MS = 5_000;
export const MAX_QUEUE_TIMEOUT_MS = 3_600_000;

// ── Watchdog anti-blocage ──
// Un slot LLM ne devrait jamais rester détenu beaucoup plus longtemps qu'un
// appel provider normal. Au-delà du seuil (30 min, toujours > queueTimeoutMs),
// on le libère de FORCE pour éviter de figer définitivement la limite d'un
// provider (chemin de libération oublié, crash d'une branche, abort non
// propagé). Le seuil effectif = max(30 min, 3 × queueTimeoutMs).
export const LLM_SLOT_WATCHDOG_MIN_MS = 30 * 60_000;
const LLM_SLOT_WATCHDOG_INTERVAL_MS = 60_000;

export const DEFAULT_CONFIG: ConcurrencyConfig = {
  maxLLMSlots: 3,
  maxAgentSlots: 5,
  queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
};

/** Ramène un délai de file arbitraire à un entier valide, sinon le défaut. */
function sanitizeQueueTimeoutMs(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_QUEUE_TIMEOUT_MS &&
    value <= MAX_QUEUE_TIMEOUT_MS
  ) {
    return value;
  }
  return DEFAULT_QUEUE_TIMEOUT_MS;
}

// Provider sentinelle : providerId de repli quand l'appelant ne connaît pas
// le provider (modèle inconnu, anciens appels, tests). Un provider absent de
// la map — y compris la sentinelle — retombe toujours sur le défaut global :
// on ne rejette jamais un appel pour cause de provider inconnu.
export const DEFAULT_LLM_PROVIDER = "__default__";

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

  constructor() {
    // Watchdog : libère les slots LLM anormalement anciens. `unref()` pour ne
    // jamais retenir le process (arrêt propre, tests vitest).
    const timer = setInterval(() => {
      try {
        this.forceReleaseStaleLLMSlots();
      } catch {
        /* le watchdog ne doit jamais faire tomber le process */
      }
    }, LLM_SLOT_WATCHDOG_INTERVAL_MS);
    (timer as any)?.unref?.();
  }

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
    // Délai de file : fourni → normalisé (valeur invalide = repli sur le défaut),
    // absent → inchangé (setConfig partiel compatible).
    if (config.queueTimeoutMs !== undefined) {
      this.config.queueTimeoutMs = sanitizeQueueTimeoutMs(config.queueTimeoutMs);
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

  /** Délai d'attente effectif dans les files (LLM et agent), en millisecondes. */
  getQueueTimeoutMs(): number {
    return this.config.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
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
   * slot se libère ou que le timeout de file configuré (queueTimeoutMs) expire.
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
      const timeoutMs = this.getQueueTimeoutMs();
      task.timer = setTimeout(() => {
        task.aborted = true;
        const queue = this.llmQueues.get(providerId);
        const idx = queue ? queue.indexOf(task) : -1;
        if (queue && idx >= 0) queue.splice(idx, 1);
        const remaining = queue ? queue.length : 0;
        reject(new Error(
          `[concurrency] LLM slot acquisition timed out after ${timeoutMs / 1000}s ` +
          `(slotKey=${slotKey}, provider=${providerId}, ${this.usedLLMSlotsByProvider(providerId)}/${limit} slots used, ` +
          `${remaining} en attente)`
        ));
      }, timeoutMs);
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

  /** Seuil effectif du watchdog (ms) : max(30 min, 3 × queueTimeoutMs). */
  getSlotWatchdogMs(): number {
    return Math.max(LLM_SLOT_WATCHDOG_MIN_MS, this.getQueueTimeoutMs() * 3);
  }

  /**
   * Libère de FORCE les slots LLM détenus au-delà du seuil du watchdog, en
   * journalisant une ERROR (slotKey, provider, âge) pour diagnostic. Retourne
   * les slotKeys libérés (utile aux tests). Le détenteur libérant plus tard
   * devient un no-op idempotent — rien ne casse.
   */
  forceReleaseStaleLLMSlots(now: number = Date.now()): string[] {
    const threshold = this.getSlotWatchdogMs();
    const stale: SlotInfo[] = [];
    for (const slot of this.llmSlots.values()) {
      if (now - slot.acquiredAt > threshold) stale.push(slot);
    }
    for (const slot of stale) {
      this.llmSlots.delete(slot.slotKey);
      logger.error("concurrency", "slot LLM libéré de FORCE par le watchdog (durée anormale)", {
        slotKey: slot.slotKey,
        label: slot.label,
        provider: slot.providerId,
        heldMs: now - slot.acquiredAt,
        thresholdMs: threshold,
      });
      this.drainLLMQueue(slot.providerId);
    }
    return stale.map((s) => s.slotKey);
  }

  // ── Agent Slots ──

  /**
   * Acquiert un slot agent (session Pi SDK). Bloque si tous les
   * slots sont pris, avec timeout de file (queueTimeoutMs).
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
      const timeoutMs = this.getQueueTimeoutMs();
      task.timer = setTimeout(() => {
        task.aborted = true;
        const idx = this.agentQueue.indexOf(task);
        if (idx >= 0) this.agentQueue.splice(idx, 1);
        reject(new Error(
          `[concurrency] Agent slot acquisition timed out after ${timeoutMs / 1000}s ` +
          `(slotKey=${slotKey}, ${this.agentSlots.size}/${this.config.maxAgentSlots} slots used, ` +
          `${this.agentQueue.length} en attente)`
        ));
      }, timeoutMs);
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

// ── Pont globalThis (extensions chargées par jiti) ─────────────────────
// Pourquoi un pont et pas un import : l'extension harness-orchestrator est
// chargée par le SDK via jiti avec `moduleCache: false`. Un module backend
// importé depuis l'extension est RÉ-ÉVALUÉ dans le registre jiti → il obtient
// une SECONDE instance de concurrency.ts (donc un autre singleton
// concurrencyManager). Les slots acquis côté extension ne seraient alors pas
// comptés par le limiteur du backend (limiteur inopérant). Preuve du besoin :
// même contrainte documentée en tête de backend/src/pi/harness-stream.ts.
// Solution : le backend publie son instance RÉELLE (ESM native) sur globalThis ;
// l'extension la consomme via ce pont (même process).
//
// ⚠️ Ne JAMAIS importer ce module depuis une extension jiti : l'import
// ré-évaluerait le module et ÉCRASERAIT le pont par une instance jiti distincte.

/** Clé du pont global exposant le manager de concurrence du backend. */
export const CONCURRENCY_BRIDGE_KEY = "__piWebConcurrency";

/** Surface MINIMALE du manager consommée par les extensions (pas d'accès interne). */
export interface LLMConcurrencyBridge {
  acquireLLMSlot(slotKey: string, label: string, providerId?: string): Promise<void>;
  releaseLLMSlot(slotKey: string): void;
  getEffectiveLLMLimit(providerId: string): number;
  getStats(): ReturnType<ConcurrencyManager["getStats"]>;
}

(globalThis as any)[CONCURRENCY_BRIDGE_KEY] = {
  acquireLLMSlot: (slotKey: string, label: string, providerId?: string) =>
    concurrencyManager.acquireLLMSlot(slotKey, label, providerId),
  releaseLLMSlot: (slotKey: string) => concurrencyManager.releaseLLMSlot(slotKey),
  getEffectiveLLMLimit: (providerId: string) => concurrencyManager.getEffectiveLLMLimit(providerId),
  getStats: () => concurrencyManager.getStats(),
} satisfies LLMConcurrencyBridge;