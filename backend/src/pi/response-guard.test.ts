/**
 * Tests du garde-fou « réponse vide par épuisement du budget par la réflexion ».
 *
 * Cas de référence : Ollama (`deepseek-v4.1-flash`) sans `reasoning_effort` +
 * budget court → `content` vide, `stopReason: "length"`, message ne contenant
 * qu'un bloc thinking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectThinkingOnlyTruncatedTurn, warnIfThinkingOnlyTruncatedTurn } from "./response-guard.js";

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [],
    stopReason: "stop",
    ...overrides,
  };
}

describe("detectThinkingOnlyTruncatedTurn", () => {
  it("réflexion seule + troncature (length) + réponse vide → diagnostic", () => {
    const diag = detectThinkingOnlyTruncatedTurn(
      assistant({
        content: [{ type: "thinking", thinking: "  je réfléchis longuement…  " }],
        stopReason: "length",
        model: "deepseek-v4.1-flash",
        provider: "provider_ollama",
        providerThinkingLevel: "high",
      }),
    );
    expect(diag).not.toBeNull();
    expect(diag!.thinkingChars).toBeGreaterThan(0);
    expect(diag!.textChars).toBe(0);
    expect(diag!.stopReason).toBe("length");
    expect(diag!.model).toBe("deepseek-v4.1-flash");
    expect(diag!.providerThinkingLevel).toBe("high");
  });

  it("reconnaît la raison brute max_tokens", () => {
    const diag = detectThinkingOnlyTruncatedTurn(
      assistant({ content: [{ type: "thinking", thinking: "x" }], stopReason: "length", rawStopReason: "max_tokens" }),
    );
    expect(diag).not.toBeNull();
  });

  it("réflexion seule mais tour TERMINÉ normalement (stop) → pas de diagnostic", () => {
    expect(
      detectThinkingOnlyTruncatedTurn(assistant({ content: [{ type: "thinking", thinking: "…" }], stopReason: "stop" })),
    ).toBeNull();
  });

  it("un tour normal avec texte n'est PAS affecté", () => {
    expect(
      detectThinkingOnlyTruncatedTurn(
        assistant({ content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Réponse" }], stopReason: "length" }),
      ),
    ).toBeNull();
  });

  it("un tour avec appel d'outil n'est PAS affecté", () => {
    expect(
      detectThinkingOnlyTruncatedTurn(
        assistant({ content: [{ type: "thinking", thinking: "…" }, { type: "toolCall", name: "bash" }], stopReason: "length" }),
      ),
    ).toBeNull();
  });

  it("troncature SANS réflexion (texte vide, pas de thinking) → pas de diagnostic", () => {
    expect(detectThinkingOnlyTruncatedTurn(assistant({ content: [], stopReason: "length" }))).toBeNull();
    expect(
      detectThinkingOnlyTruncatedTurn(assistant({ content: [{ type: "thinking", thinking: "   " }], stopReason: "length" })),
    ).toBeNull();
  });

  it("entrées non pertinentes → null", () => {
    expect(detectThinkingOnlyTruncatedTurn(undefined)).toBeNull();
    expect(detectThinkingOnlyTruncatedTurn({ role: "user", content: [] })).toBeNull();
  });
});

describe("warnIfThinkingOnlyTruncatedTurn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("journalise un avertissement pour un message_end réflexion-seule tronqué", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diag = warnIfThinkingOnlyTruncatedTurn(
      {
        type: "message_end",
        message: assistant({ role: "assistant", content: [{ type: "thinking", thinking: "…" }], stopReason: "length", model: "m" }),
      },
      "proj-1",
    );
    expect(diag).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("proj-1");
  });

  it("n'émet AUCUN log pour un tour normal ni pour un autre type d'événement", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfThinkingOnlyTruncatedTurn({ type: "message_end", message: assistant({ content: [{ type: "text", text: "ok" }], stopReason: "stop" }) }, "p");
    warnIfThinkingOnlyTruncatedTurn({ type: "message_update" }, "p");
    expect(warn).not.toHaveBeenCalled();
  });
});
