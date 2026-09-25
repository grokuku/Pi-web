/**
 * stream-silence.ts — Détecteur de SILENCE DE FLUX (liveness par événements).
 *
 * Principe (conception retenue) : la liveness d'un run n'est PAS sa durée mais
 * le fait qu'il PRODUISE encore des événements. Tant que le flux d'événements
 * est continu (deltas de texte, tool calls, message_update…), le compteur de
 * silence est réinitialisé → un run de plusieurs heures ne peut PAS être coupé.
 * Seul un SILENCE RÉEL (aucun événement pendant N minutes) arrête le run.
 *
 * Ce module est PUR (aucune I/O, aucun timer interne : l'horloge est injectable
 * et le pilote — extension harness, session backend — appelle `evaluate()` à
 * intervalle régulier). Il vit dans backend/src/pi/ (comme harness-abort) pour
 * rester scanné par vitest ET être importé par l'extension harness-orchestrator
 * via jiti (chemin relatif résolu au chargement).
 *
 * ⚠️ Attente légitime sans flux : un sous-agent en file derrière le limiteur
 * LLM n'émet AUCUN événement. `pause()`/`resume()` neutralisent le détecteur
 * pendant cette attente — sinon il serait tué à tort.
 */

// ── Délai de silence (aucun événement) ────────────────────────────────

/** Délai par défaut sans AUCUN événement avant arrêt propre : 15 min. */
export const DEFAULT_STREAM_SILENCE_TIMEOUT_MS = 15 * 60_000;

/** Bornes de normalisation. 0 est une valeur SPÉCIALE = « illimité ». */
export const MIN_STREAM_SILENCE_TIMEOUT_MS = 30_000;      // 30 s
export const MAX_STREAM_SILENCE_TIMEOUT_MS = 24 * 60 * 60_000; // 24 h
/** Valeur sentinelle « aucun arrêt sur silence ». */
export const STREAM_SILENCE_DISABLED = 0;

// ── Garde-fou de dernier recours (durée totale, OPTIONNEL) ────────────
// Désactivé par défaut (0 = désactivé) : incompatible avec des générations de
// plusieurs heures. S'il est activé explicitement, il reste un plafond de
// dernier recours (borne dure), pas un timeout de travail normal.
export const DEFAULT_AGENT_HARD_TIMEOUT_MS = 0;
export const MAX_AGENT_HARD_TIMEOUT_MS = 24 * 60 * 60_000; // 24 h

/** Ramène un délai de silence arbitraire à une valeur valide, sinon le défaut.
 *  `0` est conservé tel quel (= illimité). */
export function sanitizeStreamSilenceTimeoutMs(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value === STREAM_SILENCE_DISABLED) return STREAM_SILENCE_DISABLED;
    if (value >= MIN_STREAM_SILENCE_TIMEOUT_MS && value <= MAX_STREAM_SILENCE_TIMEOUT_MS) return value;
  }
  return DEFAULT_STREAM_SILENCE_TIMEOUT_MS;
}

/** Ramène un garde-fou de dernier recours à une valeur valide, sinon 0 (off). */
export function sanitizeAgentHardTimeoutMs(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_AGENT_HARD_TIMEOUT_MS) {
    return value;
  }
  return DEFAULT_AGENT_HARD_TIMEOUT_MS;
}

// ── Détecteur ─────────────────────────────────────────────────────────

export type StreamSilenceStatus = "alive" | "warning" | "silence" | "hard-timeout";

export interface StreamSilenceVerdict {
  status: StreamSilenceStatus;
  /** Millisecondes écoulées depuis le dernier événement (0 pendant une pause). */
  silentMs: number;
  /** Millisecondes écoulées depuis le démarrage, hors attentes légitimes. */
  elapsedMs: number;
}

export interface StreamSilenceOptions {
  /** Délai sans événement avant arrêt (0 = illimité, jamais de silence fatal). */
  silenceTimeoutMs: number;
  /** Plafond de dernier recours (0/absent = désactivé). */
  hardTimeoutMs?: number;
  /** Fraction du délai de silence déclenchant l'alerte progressive (défaut 1/3). */
  warnRatio?: number;
  /** Horloge injectable (tests à timers simulés). */
  now?: () => number;
}

/**
 * Machine à états PURE du silence de flux. Aucun timer : l'appelant appelle
 * `touch()` à chaque événement et `evaluate()` périodiquement.
 */
export class StreamSilenceDetector {
  private readonly now: () => number;
  private readonly silenceTimeoutMs: number;
  private readonly hardTimeoutMs: number;
  private readonly warnRatio: number;
  private readonly startAt: number;
  private lastActivityAt: number;
  private pausedAt: number | null = null;
  private pausedMs = 0;

  constructor(options: StreamSilenceOptions) {
    this.now = options.now ?? Date.now;
    this.silenceTimeoutMs = sanitizeStreamSilenceTimeoutMs(options.silenceTimeoutMs);
    this.hardTimeoutMs = sanitizeAgentHardTimeoutMs(options.hardTimeoutMs ?? 0);
    this.warnRatio = typeof options.warnRatio === "number" && options.warnRatio > 0 ? options.warnRatio : 1 / 3;
    const now = this.now();
    this.startAt = now;
    this.lastActivityAt = now;
  }

  /** Un événement vient d'être streamé → le silence repart de zéro. */
  touch(): void {
    this.lastActivityAt = this.now();
  }

  /** Entrée dans une attente LÉGITIME sans flux (file du limiteur LLM). */
  pause(): void {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }

  /** Sortie d'attente : l'attente ne compte ni comme silence ni comme durée. */
  resume(): void {
    if (this.pausedAt === null) return;
    const now = this.now();
    this.pausedMs += now - this.pausedAt;
    this.pausedAt = null;
    this.lastActivityAt = now;
  }

  /** Le détecteur est-il neutralisé (attente légitime en cours) ? */
  get waiting(): boolean {
    return this.pausedAt !== null;
  }

  /** Millisecondes depuis le dernier événement (0 tant qu'une pause est active). */
  get silentMs(): number {
    if (this.pausedAt !== null) return 0;
    return Math.max(0, this.now() - this.lastActivityAt);
  }

  /** Durée effective du run, attentes légitimes exclues. */
  get elapsedMs(): number {
    const now = this.now();
    const pendingPause = this.pausedAt !== null ? now - this.pausedAt : 0;
    return Math.max(0, now - this.startAt - this.pausedMs - pendingPause);
  }

  /** Seuil d'alerte progressive (ms) dans le délai courant. */
  get warnAtMs(): number {
    if (this.silenceTimeoutMs === STREAM_SILENCE_DISABLED) return Number.POSITIVE_INFINITY;
    return Math.max(1_000, Math.floor(this.silenceTimeoutMs * this.warnRatio));
  }

  /**
   * Verdict courant. Priorité au garde-fou dur (s'il est activé) puis au
   * silence. Une pause active renvoie toujours `alive`.
   */
  evaluate(): StreamSilenceVerdict {
    const elapsedMs = this.elapsedMs;
    const silentMs = this.silentMs;
    if (this.pausedAt !== null) return { status: "alive", silentMs: 0, elapsedMs };
    if (this.hardTimeoutMs > 0 && elapsedMs >= this.hardTimeoutMs) {
      return { status: "hard-timeout", silentMs, elapsedMs };
    }
    if (this.silenceTimeoutMs !== STREAM_SILENCE_DISABLED && silentMs >= this.silenceTimeoutMs) {
      return { status: "silence", silentMs, elapsedMs };
    }
    if (silentMs >= this.warnAtMs) return { status: "warning", silentMs, elapsedMs };
    return { status: "alive", silentMs, elapsedMs };
  }
}

// ── Messages honnêtes (motif explicite côté UI/archive) ───────────────

/** Durée lisible : « 42s », « 7 min », « 1 h 05 min ». */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours} h ${String(remMinutes).padStart(2, "0")} min`;
}

/** Marqueur STABLE reconnaissable d'un arrêt sur silence de flux. */
export const SILENCE_TIMEOUT_MARKER = "flux silencieux";

/** Motif d'arrêt : « Fonction X silencieuse depuis 15 min — flux silencieux… ». */
export function streamSilenceMessage(label: string, silentMs: number): string {
  return (
    `Fonction ${label} silencieuse depuis ${formatDurationMs(silentMs)} — ` +
    `${SILENCE_TIMEOUT_MARKER} (aucun événement streamé)`
  );
}

/** Motif d'un arrêt par le garde-fou de dernier recours (optionnel). */
export function hardTimeoutMessage(label: string, elapsedMs: number): string {
  return `Fonction ${label} a dépassé le garde-fou de dernier recours (timeout global de ${formatDurationMs(elapsedMs)})`;
}

/** Le message décrit-il un arrêt sur silence de flux (→ retry possible) ? */
export function isSilenceTimeoutMessage(message: string): boolean {
  const msg = String(message || "");
  return (
    msg.includes(SILENCE_TIMEOUT_MARKER) ||
    msg.includes("silencieux") ||
    msg.includes("inactivité") ||
    msg.includes("inactivity") ||
    msg.includes("Inactivity")
  );
}

/** Le message décrit-il l'arrêt par le garde-fou de dernier recours ? */
export function isHardTimeoutMessage(message: string): boolean {
  return String(message || "").includes("timeout global");
}
