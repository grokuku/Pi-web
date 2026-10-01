/**
 * session-subagent-result.test.ts — LOT 2 (orchestrateur interactif) :
 * réinjection du RÉSULTAT d'un sous-agent détaché dans la conversation de
 * l'orchestrateur (seam `deliverSubagentResultsToSession`, session mockée).
 *
 * Vérifie la décision idle vs streaming (tour normal vs followUp) et la forme
 * du message conversationnel `subagent_result` (display:true, triggerTurn:true,
 * AUCUN marqueur non conversationnel → vu par le LLM).
 */
import { describe, expect, it, vi } from "vitest";
import { deliverSubagentResultsToSession } from "./session.js";
import type { SubagentResultPayload } from "./harness-result-delivery.js";

function result(over: Partial<SubagentResultPayload> = {}): SubagentResultPayload {
  return {
    delegateRunId: "d-1",
    delegateFunction: "execute",
    label: "Exécution",
    status: "success",
    response: "travail terminé",
    durationMs: 1000,
    actionCount: 2,
    ...over,
  };
}

function mockSession() {
  return { sendCustomMessage: vi.fn(async () => {}) };
}

describe("deliverSubagentResultsToSession (LOT 2)", () => {
  it("orchestrateur IDLE → tour normal (triggerTurn:true, pas de deliverAs)", async () => {
    const session = mockSession();
    await deliverSubagentResultsToSession(session as any, [result()], false);

    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    const [message, options] = session.sendCustomMessage.mock.calls[0] as any[];
    expect(message.customType).toBe("subagent_result");
    expect(message.display).toBe(true);
    expect(message.content).toContain("travail terminé");
    expect(message.details.results).toHaveLength(1);
    expect(options).toEqual({ triggerTurn: true });
    // JAMAIS marqué non conversationnel (le LLM DOIT voir ce message).
    expect(message.details.__nonConversational).toBeUndefined();
  });

  it("orchestrateur en STREAMING → followUp (attend la fin du tour courant)", async () => {
    const session = mockSession();
    await deliverSubagentResultsToSession(session as any, [result()], true);
    const [, options] = session.sendCustomMessage.mock.calls[0] as any[];
    expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("plusieurs résultats → UN SEUL message (lotissement)", async () => {
    const session = mockSession();
    await deliverSubagentResultsToSession(
      session as any,
      [result({ delegateRunId: "d-1" }), result({ delegateRunId: "d-2", status: "cancelled", response: "partiel" })],
      false,
    );
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    const [message] = session.sendCustomMessage.mock.calls[0] as any[];
    expect(message.content).toContain("Résultat de 2 sous-agents");
    expect(message.details.results.map((r: SubagentResultPayload) => r.delegateRunId)).toEqual(["d-1", "d-2"]);
  });

  it("liste vide → aucun envoi", async () => {
    const session = mockSession();
    await deliverSubagentResultsToSession(session as any, [], false);
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });
});
