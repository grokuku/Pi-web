/**
 * session-steer-timeout.test.ts — P1 : le steer harness + agent idle ne doit
 * plus être borné par un timeout de session (ce timeout tuait l'orchestrator en
 * pleine délégation), tandis que le contrat de garde du MODE CODE reste
 * fonctionnel (withSessionTimeout).
 *
 * Le MODE CODE n'est plus coupé par une DURÉE fixe (ancien SESSION_TIMEOUT_MS
 * de 5 min) mais par un SILENCE de flux : tant que des événements arrivent, le
 * compteur se réinitialise (cf. stream-silence). Le test vérifie qu'un flux
 * réellement silencieux est arrêté proprement.
 *
 * Le backend n'expose pas de seam pour injecter une session factice dans
 * `sessionsByProject` : on vérifie donc d'une part que withSessionTimeout
 * fonctionne (contrat code), d'autre part l'invariant STRUCTUREL du code source
 * de steerPrompt (aucun withSessionTimeout, withLLMSlot sur le chemin harness).
 * Le marqueur d'abandon utilisateur (P2) est vérifié sur le pont global.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_SILENCE_CHECK_INTERVAL_MS,
  steerPrompt,
  wasSessionAbortedByUser,
  withSessionTimeout,
} from "./session.js";
import { DEFAULT_STREAM_SILENCE_TIMEOUT_MS } from "./stream-silence.js";

describe("P1 — steerPrompt harness (invariant structurel)", () => {
  const src = steerPrompt.toString();

  it("n'utilise AUCUN withSessionTimeout (délégation > 5 min légitime)", () => {
    expect(src).not.toContain("withSessionTimeout");
  });

  it("utilise withLLMSlot sur le chemin harness idle", () => {
    expect(src).toContain("steer(harness)");
    expect(src).toContain("withLLMSlot");
  });
});

describe("P1 — withSessionTimeout : garde par SILENCE du mode code", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("abort la session et rejette après un SILENCE de flux (pas une durée fixe)", async () => {
    vi.useFakeTimers();
    const abort = vi.fn(async () => {});
    const fakeSession = { model: undefined, abort } as any;
    const never = new Promise<void>(() => {});

    const pending = withSessionTimeout(never, fakeSession, "proj-timeout", "code-test");
    // Laisse l'acquisition du slot LLM + la construction du détecteur se faire.
    await vi.advanceTimersByTimeAsync(0);
    const rejection = pending.catch((e: Error) => e);
    // Aucun événement streamé → silence fatal au bout du délai configuré.
    await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_SILENCE_TIMEOUT_MS + SESSION_SILENCE_CHECK_INTERVAL_MS);

    const err = await rejection;
    expect(abort).toHaveBeenCalledTimes(1);
    expect((err as Error).message).toContain("flux silencieux");
  });
});

describe("P2 — pont global du marqueur d'abandon utilisateur", () => {
  it("est publié sur globalThis et ne jette jamais", () => {
    expect(typeof (globalThis as any).__piWebWasSessionAbortedByUser__).toBe("function");
    expect((globalThis as any).__piWebWasSessionAbortedByUser__).toBe(wasSessionAbortedByUser);
    expect(wasSessionAbortedByUser("projet-inexistant")).toBe(false);
  });
});
