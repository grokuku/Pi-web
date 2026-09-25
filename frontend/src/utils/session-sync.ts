// ── Synchronisation de l'état de session backend → frontend (P4) ───────────
// Après un crash backend, `isStreaming` pouvait rester bloqué à `true` côté
// front. Le message suivant partait alors en `pi_steer` (steer sur une session
// restaurée IDLE → branche idle de steerPrompt) au lieu de `pi_prompt`.
//
// À la reconnexion WS, on ne réinitialise JAMAIS aveuglément (BUG-68 : l'agent
// peut réellement tourner) — on re-qualifie `isStreaming` depuis la vérité
// backend (`getSessionInfo().isStreaming`), qui fait autorité. Ces helpers sont
// purs (testés dans session-sync.test.ts) car l'environnement vitest frontend
// est `node` (pas de jsdom / testing-library).

/** Patch partiel d'état session projet (compatible Partial<ProjectSessionState>). */
export interface ServerSessionPatch<T = unknown> {
  session: T;
  isStreaming?: boolean;
}

/**
 * Construit le patch d'état frontend à partir de l'info de session backend.
 * Copie `isStreaming` UNIQUEMENT si le backend l'expose (booléen) : un backend
 * plus ancien qui ne l'expose pas ne doit pas écraser le flag front.
 */
export function mergeServerSessionState<T>(info: T): ServerSessionPatch<T> {
  const patch: ServerSessionPatch<T> = { session: info };
  const streaming = (info as any)?.isStreaming;
  if (typeof streaming === "boolean") patch.isStreaming = streaming;
  return patch;
}

/**
 * Type de message à envoyer selon l'état de streaming RÉEL :
 * streaming → `pi_steer` (injection), idle → `pi_prompt` (nouveau tour).
 */
export function promptMessageType(isStreaming: boolean): "pi_prompt" | "pi_steer" {
  return isStreaming ? "pi_steer" : "pi_prompt";
}
