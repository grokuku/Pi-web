/**
 * Validation PURE du payload PUT /api/settings/concurrency.
 *
 * Isolée de la route express pour être testable sans I/O ni serveur HTTP.
 * Règles :
 * - slots (défaut global, override par provider) : ENTIERS 1..MAX_SLOTS
 *   (plafond volontairement large : un provider peut avoir une limite très
 *   haute, ex. 2500) ; 0, floats, chaînes et clés JS réservées sont rejetés ;
 * - queueTimeoutMs : ENTIER dans [MIN_QUEUE_TIMEOUT_MS, MAX_QUEUE_TIMEOUT_MS] ;
 * - streamSilenceTimeoutMs : ENTIER dans [MIN_STREAM_SILENCE_TIMEOUT_MS,
 *   MAX_STREAM_SILENCE_TIMEOUT_MS] ou 0 (= illimité) ;
 * - agentHardTimeoutMs : ENTIER dans [0, MAX_AGENT_HARD_TIMEOUT_MS] (0 = désactivé).
 * Les champs absents sont laissés indéfinis = update partiel (le manager
 * conserve la valeur courante).
 */
import { MIN_QUEUE_TIMEOUT_MS, MAX_QUEUE_TIMEOUT_MS } from "../pi/concurrency.js";
import {
  MAX_AGENT_HARD_TIMEOUT_MS,
  MAX_STREAM_SILENCE_TIMEOUT_MS,
  MIN_STREAM_SILENCE_TIMEOUT_MS,
  STREAM_SILENCE_DISABLED,
} from "../pi/stream-silence.js";

/** Plafond haut d'une limite de slots (global ou override par provider). */
export const MAX_SLOTS = 100_000;

/** Clés réservées JS : jamais acceptées (protection pollution de prototype). */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ConcurrencyPayload {
  maxLLMSlots?: number;
  providerMaxLLMSlots?: Record<string, number>;
  queueTimeoutMs?: number;
  streamSilenceTimeoutMs?: number;
  agentHardTimeoutMs?: number;
}

/** Entier sûr dans [1, MAX_SLOTS]. */
function isValidSlotCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_SLOTS;
}

/**
 * Valide le corps de requête. Retourne `{ error }` (message machine, 400 côté
 * route) ou `{ value }` (champs validés, prêts pour setConcurrencyConfig).
 */
export function validateConcurrencyPayload(
  body: unknown
): { error: string } | { value: ConcurrencyPayload } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const { maxLLMSlots, providerMaxLLMSlots, queueTimeoutMs } = raw;
  const { streamSilenceTimeoutMs, agentHardTimeoutMs } = raw;

  if (maxLLMSlots !== undefined && !isValidSlotCount(maxLLMSlots)) {
    return { error: `maxLLMSlots must be an integer between 1 and ${MAX_SLOTS}` };
  }
  if (providerMaxLLMSlots !== undefined) {
    if (
      typeof providerMaxLLMSlots !== "object" ||
      providerMaxLLMSlots === null ||
      Array.isArray(providerMaxLLMSlots)
    ) {
      return { error: "providerMaxLLMSlots must be an object" };
    }
    for (const [key, value] of Object.entries(providerMaxLLMSlots as Record<string, unknown>)) {
      if (RESERVED_KEYS.has(key) || !key.trim()) {
        return { error: `providerMaxLLMSlots: invalid provider key "${key}"` };
      }
      if (!isValidSlotCount(value)) {
        return { error: `providerMaxLLMSlots.${key} must be an integer between 1 and ${MAX_SLOTS}` };
      }
    }
  }
  if (
    queueTimeoutMs !== undefined &&
    (!Number.isSafeInteger(queueTimeoutMs) ||
      (queueTimeoutMs as number) < MIN_QUEUE_TIMEOUT_MS ||
      (queueTimeoutMs as number) > MAX_QUEUE_TIMEOUT_MS)
  ) {
    return {
      error: `queueTimeoutMs must be an integer between ${MIN_QUEUE_TIMEOUT_MS} and ${MAX_QUEUE_TIMEOUT_MS}`,
    };
  }
  if (streamSilenceTimeoutMs !== undefined) {
    const v = streamSilenceTimeoutMs as number;
    const valid =
      Number.isSafeInteger(v) &&
      (v === STREAM_SILENCE_DISABLED || (v >= MIN_STREAM_SILENCE_TIMEOUT_MS && v <= MAX_STREAM_SILENCE_TIMEOUT_MS));
    if (!valid) {
      return {
        error:
          `streamSilenceTimeoutMs must be 0 (illimité) or an integer between ` +
          `${MIN_STREAM_SILENCE_TIMEOUT_MS} and ${MAX_STREAM_SILENCE_TIMEOUT_MS}`,
      };
    }
  }
  if (
    agentHardTimeoutMs !== undefined &&
    (!Number.isSafeInteger(agentHardTimeoutMs) ||
      (agentHardTimeoutMs as number) < 0 ||
      (agentHardTimeoutMs as number) > MAX_AGENT_HARD_TIMEOUT_MS)
  ) {
    return {
      error: `agentHardTimeoutMs must be an integer between 0 and ${MAX_AGENT_HARD_TIMEOUT_MS}`,
    };
  }

  return {
    value: {
      maxLLMSlots: maxLLMSlots as number | undefined,
      providerMaxLLMSlots: providerMaxLLMSlots as Record<string, number> | undefined,
      queueTimeoutMs: queueTimeoutMs as number | undefined,
      streamSilenceTimeoutMs: streamSilenceTimeoutMs as number | undefined,
      agentHardTimeoutMs: agentHardTimeoutMs as number | undefined,
    },
  };
}
