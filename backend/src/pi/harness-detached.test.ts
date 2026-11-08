import { describe, expect, it, vi } from "vitest";
import { runDetachedDelegation } from "./harness-detached.js";

describe("runDetachedDelegation", () => {
  it("propage le message d'erreur d'un run terminé en échec", async () => {
    const postResult = vi.fn();
    runDetachedDelegation({
      run: async () => ({
        content: [{ text: "delegate exploded" }],
        details: { status: "error", cause: "tool", durationMs: 12, actionCount: 2 },
      }),
      postResult,
    });

    await vi.waitFor(() => expect(postResult).toHaveBeenCalledTimes(1));
    expect(postResult).toHaveBeenCalledWith({
      status: "error",
      cause: "tool",
      errorMessage: "delegate exploded",
      response: "delegate exploded",
      durationMs: 12,
      actionCount: 2,
    });
  });

  it("journalise une rejection inattendue et la réinjecte avec son vrai message", async () => {
    const postResult = vi.fn();
    const logger = { error: vi.fn() };
    const failure = new Error("unexpected detached failure");
    runDetachedDelegation({ run: async () => { throw failure; }, postResult, logger });

    await vi.waitFor(() => expect(postResult).toHaveBeenCalledTimes(1));
    expect(logger.error).toHaveBeenCalledWith("[harness-orchestrator] Detached delegation failed:", failure);
    expect(postResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      cause: "unexpected",
      errorMessage: "unexpected detached failure",
    }));
  });
});
