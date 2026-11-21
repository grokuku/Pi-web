// ── Garde d'ancienneté du snapshot chat (cache local du fil) ────────────────
// Le cache local (IndexedDB `pi-web-chat-cache`, repli localStorage
// `pi-web-chat-<projectId>`) peut contenir un
// snapshot TRÈS ancien (limite des 200 messages persistés, écrits au dernier
// rendu de la dernière session ouverte) : l'afficher tel quel ferait croire à
// l'utilisateur qu'il regarde l'état courant de la conversation, alors que le
// backend a pu tourner des heures entre-temps. Ce module juge la fraîcheur du
// snapshot : au-delà de CHAT_CACHE_MAX_AGE_MS, il ne doit JAMAIS servir
// d'affichage initial — on montre un chat vide et on attend la resync backend
// (pi_history), seule source de vérité.
import type { DisplayMessage } from "../types";

export const CHAT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h

export interface ChatCacheSnapshot {
  messages: DisplayMessage[];
  /** false → snapshot trop ancien (ou sans horodatage fiable) : ne PAS l'afficher. */
  fresh: boolean;
  /** Âge du snapshot en ms (Infinity si aucun horodatage exploitable). */
  ageMs: number;
}

/**
 * Juge la fraîcheur d'un snapshot DÉJÀ désérialisé (sans re-parser de JSON).
 *
 * La fraîcheur est celle du message LE PLUS RÉCENT du snapshot (le dernier
 * rendu) : un snapshot plus vieux que `maxAgeMs` n'est pas « fresh ».
 * Un snapshot sans aucun horodatage exploitable est réputé périmé (défaut
 * sûr : on ne présente pas du contenu non daté comme état courant).
 * Snapshot vide ou non-tableau → null (pas de fallback à afficher).
 */
export function judgeChatCacheSnapshot(
  messages: DisplayMessage[] | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = CHAT_CACHE_MAX_AGE_MS
): ChatCacheSnapshot | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const timestamps = messages
    .map((m) => m?.timestamp)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (timestamps.length === 0) return { messages, fresh: false, ageMs: Infinity };
  const ageMs = now - Math.max(...timestamps);
  return { messages, fresh: ageMs <= maxAgeMs, ageMs };
}

/**
 * Parse un snapshot (chaîne JSON) et juge sa fraîcheur.
 * Snapshot absent, vide ou corrompu → null (pas de fallback à afficher).
 */
export function parseChatCacheSnapshot(
  raw: string | null,
  now: number = Date.now(),
  maxAgeMs: number = CHAT_CACHE_MAX_AGE_MS
): ChatCacheSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return judgeChatCacheSnapshot(parsed as DisplayMessage[], now, maxAgeMs);
  } catch {
    return null;
  }
}