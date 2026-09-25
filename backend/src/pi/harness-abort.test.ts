/**
 * harness-abort.test.ts — P2 (abort utilisateur vs interne) + P3 (rejets de
 * promesses perdantes de course). Ces helpers sont la logique partagée avec
 * l'extension harness-orchestrator (importée via jiti) — les tester ici garantit
 * qu'un abort interne ne peut plus être étiqueté « abort-utilisateur » et
 * qu'aucun rejet attendu n'atteint le handler unhandledRejection du backend.
 */
import { describe, expect, it } from "vitest";
import {
  ABORT_MESSAGE_MARKER,
  ABORT_SESSION_MESSAGE,
  ABORT_USER_MESSAGE,
  abortMessageFor,
  createRaceGuard,
  isAbortInterruption,
  resolveAbortCause,
  swallowRejection,
} from "./harness-abort.js";

describe("resolveAbortCause (P2)", () => {
  it("abandon utilisateur prouvé ⇒ abort-utilisateur", () => {
    expect(resolveAbortCause(true)).toBe("abort-utilisateur");
  });

  it("tout autre motif ⇒ abort-session (jamais abort-utilisateur)", () => {
    expect(resolveAbortCause(false)).toBe("abort-session");
  });

  it("les messages d'abandon portent le marqueur commun", () => {
    expect(isAbortInterruption(ABORT_USER_MESSAGE)).toBe(true);
    expect(isAbortInterruption(ABORT_SESSION_MESSAGE)).toBe(true);
    expect(isAbortInterruption(`${ABORT_SESSION_MESSAGE} (récupéré : 10 chars)`)).toBe(true);
    expect(isAbortInterruption("Fonction execute inactive depuis 300s")).toBe(false);
    expect(isAbortInterruption("")).toBe(false);
  });

  it("abortMessageFor distingue les deux libellés", () => {
    expect(abortMessageFor("abort-utilisateur")).toBe(ABORT_USER_MESSAGE);
    expect(abortMessageFor("abort-session")).toBe(ABORT_SESSION_MESSAGE);
    expect(ABORT_USER_MESSAGE).toContain(ABORT_MESSAGE_MARKER);
    expect(ABORT_SESSION_MESSAGE).toContain(ABORT_MESSAGE_MARKER);
  });
});

describe("swallowRejection + raceGuard (P3)", () => {
  it("une promesse perdante rejetée ne produit pas d'unhandledRejection", async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const losing = Promise.reject(new Error("course perdue"));
      swallowRejection(losing);
      // Laisser tourner un tour de boucle pour d'éventuels diagnostics.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toBe(0);
  });

  it("un callback de timer ne rejette plus après finish()", () => {
    const guard = createRaceGuard();
    const calls: string[] = [];
    guard.guard(() => calls.push("avant"));
    guard.finish();
    guard.guard(() => calls.push("après"));
    expect(guard.finished).toBe(true);
    expect(calls).toEqual(["avant"]);
  });
});
