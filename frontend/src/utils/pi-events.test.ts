// ── Tests unitaires : applyPiEvent (cycle complet du streaming) ─────
// Vérifie le comportement du processor pur extrait de ChatView : création
// du message _streaming, concaténation des deltas, timing de la réflexion,
// tool calls, finalisation, timeout et dédup par id.
import { describe, it, expect, vi } from "vitest";
import { applyPiEvent, appendMessageDedup } from "./pi-events";
import type { DisplayMessage, PiEvent } from "../types";

// ── Helpers de construction d'événements ─────────────────────────────
function messageStart(id = "asst-1"): PiEvent {
  return { type: "message_start", message: { role: "assistant", id } };
}
function textDelta(delta: string): PiEvent {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}
function thinkingDelta(delta: string): PiEvent {
  return { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } };
}
function toolcallStart(toolCallId: string, toolName: string, args: any = {}): PiEvent {
  return { type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolCallId, toolName, args } };
}
function toolcallDelta(toolCallId: string, argsDelta: any): PiEvent {
  return { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", toolCallId, argsDelta } };
}
function toolcallEnd(toolCallId: string, toolCall: any): PiEvent {
  return { type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCallId, toolCall } };
}
function toolExecUpdate(toolCallId: string, text: string): PiEvent {
  return { type: "tool_execution_update", toolCallId, partialResult: { content: [{ text }] } };
}
function toolExecEnd(toolCallId: string, text: string, isError = false): PiEvent {
  return { type: "tool_execution_end", toolCallId, result: { content: [{ text }] }, isError };
}
function messageEnd(id = "asst-1", usage?: any): PiEvent {
  return { type: "message_end", message: { role: "assistant", id, usage } };
}
function agentEndTimeout(): PiEvent {
  return { type: "agent_end", reason: "timeout" };
}

// Applique une séquence d'événements et renvoie l'état final.
function run(events: PiEvent[], initial: DisplayMessage[] = [], assistantId: string | null = null, t?: (key: string, ...args: any[]) => string) {
  let msgs = initial;
  let asstId = assistantId;
  for (const evt of events) {
    const r = applyPiEvent(msgs, evt, asstId, t);
    msgs = r.messages;
    asstId = r.assistantId;
  }
  return { msgs, asstId };
}

describe("applyPiEvent — cycle complet du streaming", () => {
  it("message_start crée un message assistant _streaming", () => {
    const { msgs, asstId } = run([messageStart("asst-1")]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      id: "asst-1",
      role: "assistant",
      content: "",
      thinking: "",
      toolCalls: [],
      _streaming: true,
    });
    expect(asstId).toBe("asst-1");
  });

  it("text_delta concatène le contenu", () => {
    const { msgs } = run([messageStart("asst-1"), textDelta("Bonjour "), textDelta("monde")]);
    expect(msgs[0].content).toBe("Bonjour monde");
  });

  it("thinking_delta horodate thinkingStartedAt puis text_delta fige thinkingDurationMs", () => {
    // On fige Date.now pour un test déterministe.
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { msgs } = run([
        messageStart("asst-1"),
        thinkingDelta("réfléchis…"),
        textDelta("réponse"),
      ]);
      expect(msgs[0].thinking).toBe("réfléchis…");
      expect(msgs[0].thinkingStartedAt).toBe(now);
      // thinkingDurationMs figé au premier text_delta = now - thinkingStartedAt = 0
      expect(msgs[0].thinkingDurationMs).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("thinkingDurationMs reste figé aux text_delta suivants", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { msgs } = run([
        messageStart("asst-1"),
        thinkingDelta("a"),
        textDelta("x"),
        textDelta("y"),
      ]);
      expect(msgs[0].thinkingDurationMs).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("toolcall_start / delta / end gère le cycle complet d'un tool call", () => {
    const { msgs } = run([
      messageStart("asst-1"),
      toolcallStart("tc-1", "read_file", { path: "/tmp/a" }),
      toolcallDelta("tc-1", { offset: 10 }),
      toolcallEnd("tc-1", { name: "read_file", arguments: { path: "/tmp/a", offset: 10 } }),
    ]);
    const tc = msgs[0].toolCalls[0];
    expect(tc).toMatchObject({
      id: "tc-1",
      name: "read_file",
      args: { path: "/tmp/a", offset: 10 },
      isStreaming: false,
    });
    expect(tc.startedAt).toBeDefined();
  });

  it("toolcall_start déduplique par id (pas de doublon)", () => {
    const { msgs } = run([
      messageStart("asst-1"),
      toolcallStart("tc-1", "read_file"),
      toolcallStart("tc-1", "read_file"),
    ]);
    expect(msgs[0].toolCalls).toHaveLength(1);
  });

  it("tool_execution_update fusionne l'output (remplace par le résultat partiel)", () => {
    const { msgs } = run([
      messageStart("asst-1"),
      toolcallStart("tc-1", "read_file"),
      toolExecUpdate("tc-1", "ligne 1"),
      toolExecUpdate("tc-1", "ligne 2"),
    ]);
    // L'update remplace l'output par le résultat partiel courant.
    expect(msgs[0].toolCalls[0].output).toBe("ligne 2");
    expect(msgs[0].toolCalls[0].isStreaming).toBe(true);
  });

  it("tool_execution_end finalise l'output et l'état d'erreur", () => {
    const { msgs } = run([
      messageStart("asst-1"),
      toolcallStart("tc-1", "read_file"),
      toolExecEnd("tc-1", "résultat", true),
    ]);
    expect(msgs[0].toolCalls[0].output).toBe("résultat");
    expect(msgs[0].toolCalls[0].isError).toBe(true);
    expect(msgs[0].toolCalls[0].isStreaming).toBe(false);
  });

  it("message_end finalise (_streaming false) et préserve usage/stopReason", () => {
    const { msgs, asstId } = run([
      messageStart("asst-1"),
      textDelta("réponse"),
      messageEnd("asst-1", { input: 5, output: 3, cost: { total: 0.01 } }),
    ]);
    expect(msgs[0]._streaming).toBe(false);
    expect(msgs[0].usage).toEqual({ input: 5, output: 3, cost: { total: 0.01 } });
    expect(asstId).toBeNull();
  });

  it("agent_end reason:timeout → stopReason error + errorMessage localisé", () => {
    const t = vi.fn((key: string) => (key === "chat.timeoutError" ? "Temps dépassé" : key));
    const { msgs, asstId } = run(
      [messageStart("asst-1"), textDelta("partiel"), agentEndTimeout()],
      [],
      null,
      t,
    );
    expect(msgs[0]._streaming).toBe(false);
    expect(msgs[0].stopReason).toBe("error");
    expect(msgs[0].errorMessage).toBe("Temps dépassé");
    expect(asstId).toBeNull();
  });

  it("dédup par id sur les appends custom (injected)", () => {
    const custom: DisplayMessage = {
      id: "custom-1",
      role: "assistant",
      content: "note",
      thinking: "",
      toolCalls: [],
      timestamp: 1,
      customType: "git_notification",
      injected: true,
    };
    // Deux appends du même id → un seul message.
    const once = appendMessageDedup([], custom);
    const twice = appendMessageDedup(once, custom);
    expect(twice).toHaveLength(1);
    // Un id différent est bien ajouté.
    const other = appendMessageDedup(twice, { ...custom, id: "custom-2" });
    expect(other).toHaveLength(2);
  });
});
