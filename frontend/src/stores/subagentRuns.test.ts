// ── Tests unitaires : store isolé des runs de sous-agents (LOT 2b) ──────────
// Cœur du lot : `applySubagentEvent` est PUR (run + enveloppe → nouveau run),
// testable sans React ni timer. On couvre aussi le rattachement FIFO + fonction
// (routeSubagentEnvelope) et la reconstruction d'un run archivé (historique).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DisplayMessage } from "../types";
import {
  applySubagentEvent,
  extractDelegateCalls,
  flushSubagentNotifications,
  getOrphanRuns,
  getRun,
  registerArchivedRuns,
  resetSubagentRuns,
  routeSubagentEnvelope,
  runFromActivity,
  subscribeRun,
  type SubagentEnvelope,
} from "./subagentRuns";

// Aide : enveloppe {type:"subagent", …} minimale.
function env(event: any, over: Partial<SubagentEnvelope> = {}): SubagentEnvelope {
  return {
    type: "subagent",
    source: "subagent",
    delegateRunId: "d-1000-abcd",
    attempt: 1,
    delegateFunction: "execute",
    delegateLabel: "Exécution",
    model: "prov/model-x",
    taskExcerpt: "fais X",
    event,
    ...over,
  };
}

function msg(id: string, delegateFns: (string | undefined)[]): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "",
    thinking: "",
    timestamp: 0,
    toolCalls: delegateFns.map((fn, i) => ({
      id: `${id}-tc${i}`,
      name: "delegate",
      args: fn === undefined ? {} : { function: fn },
      output: "",
      isError: false,
      isStreaming: false,
    })),
  };
}

beforeEach(() => {
  resetSubagentRuns();
});
afterEach(() => {
  flushSubagentNotifications();
  vi.useRealTimers();
});

describe("applySubagentEvent — fonction PURE d'application d'événement", () => {
  it("subagent_start initialise un run avec les métadonnées de l'enveloppe", () => {
    const run = applySubagentEvent(undefined, env({ type: "subagent_start" }), 500);
    expect(run).toMatchObject({
      id: "d-1000-abcd",
      function: "execute",
      label: "Exécution",
      modelId: "prov/model-x",
      task: "fais X",
      status: "running",
      isError: false,
      attempt: 1,
      startedAt: 500,
    });
    expect(run.actions).toEqual([]);
    expect(run.messages).toEqual([]);
  });

  it("tool_execution_start → action avec résumé d'arguments ; update → output ; end → résumé + durée + erreur", () => {
    let run = applySubagentEvent(undefined, env({ type: "subagent_start" }), 0);
    run = applySubagentEvent(run, env({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/a/b.ts" } }), 10);
    expect(run.actions).toHaveLength(1);
    expect(run.actions[0]).toMatchObject({ seq: 1, toolCallId: "t1", toolName: "read", argSummary: "read /a/b.ts", isError: false, startedAt: 10 });

    run = applySubagentEvent(run, env({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "partiel" }] } }), 20);
    expect(run.currentOutput).toBe("partiel");
    expect(run.actions[0].output).toBe("partiel");

    run = applySubagentEvent(run, env({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "l1\nl2\nl3" }] }, outputChars: 8, outputTruncated: false }), 60);
    expect(run.actions[0]).toMatchObject({ summary: "read /a/b.ts · 3 lignes", outputChars: 8, isError: false, endedAt: 60, durationMs: 50 });
    expect(run.status).toBe("running");
  });

  it("tool_execution_end d'erreur → action en erreur + résumé ⚠", () => {
    let run = applySubagentEvent(undefined, env({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "false" } }), 0);
    run = applySubagentEvent(run, env({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "boom" }] }, outputTruncated: true }), 30);
    expect(run.actions[0].isError).toBe(true);
    expect(run.actions[0].summary.startsWith("⚠")).toBe(true);
    expect(run.actions[0].truncated).toBe(true);
  });

  it("tool_execution_start rejoué (même toolCallId) → pas de doublon d'action", () => {
    let run = applySubagentEvent(undefined, env({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} }), 0);
    run = applySubagentEvent(run, env({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} }), 5);
    expect(run.actions).toHaveLength(1);
  });

  it("message_end → message tronqué (texte/thinking + flags), vide ignoré", () => {
    let run = applySubagentEvent(undefined, env({ type: "subagent_start" }), 0);
    run = applySubagentEvent(run, env({
      type: "message_end",
      message: { role: "assistant", id: "m1", content: [{ type: "text", text: "réponse" }, { type: "thinking", thinking: "réflexion" }] },
      textTruncated: false,
      thinkingTruncated: true,
    }), 100);
    expect(run.messages).toHaveLength(1);
    expect(run.messages[0]).toMatchObject({ id: "m1", text: "réponse", thinking: "réflexion", textTruncated: false, thinkingTruncated: true, timestamp: 100 });

    const same = applySubagentEvent(run, env({ type: "message_end", message: { role: "assistant", content: [] } }), 200);
    expect(same.messages).toHaveLength(1); // vide → ignoré
  });

  it("subagent_end (success) → done ; (error) → failed + end complet", () => {
    const ok = applySubagentEvent(undefined, env({
      type: "subagent_end",
      status: "success",
      attemptsMade: 1,
      durationMs: 1234,
      actionCount: 3,
      eventCount: 9,
      thinkingChars: 42,
      model: "prov/final",
      cause: null,
      errorMessage: null,
      responsePreview: "ok",
      droppedEvents: 2,
    }), 999);
    expect(ok.status).toBe("done");
    expect(ok.isError).toBe(false);
    expect(ok.endedAt).toBe(999);
    expect(ok.modelId).toBe("prov/final");
    expect(ok.end).toMatchObject({ status: "success", durationMs: 1234, actionCount: 3, eventCount: 9, droppedEvents: 2 });

    const ko = applySubagentEvent(undefined, env({ type: "subagent_end", status: "timeout-inactivity", attemptsMade: 2, errorMessage: "timeout" }), 5);
    expect(ko.status).toBe("failed");
    expect(ko.isError).toBe(true);
    expect(ko.attempt).toBe(2);
    expect(ko.end?.cause).toBe(null);
  });

  it("pure : le run précédent n'est jamais muté", () => {
    const base = applySubagentEvent(undefined, env({ type: "subagent_start" }), 0);
    const frozenActions = base.actions;
    const next = applySubagentEvent(base, env({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} }), 1);
    expect(base.actions).toBe(frozenActions);
    expect(base.actions).toHaveLength(0);
    expect(next.actions).toHaveLength(1);
    expect(next).not.toBe(base);
  });
});

describe("runFromActivity — relecture d'une entrée persistée subagent_activity", () => {
  it("reconstruit un run archivé avec les actions résumées", () => {
    const run = runFromActivity({
      delegateRunId: "d-42-ffff",
      function: "review",
      label: "Relecture",
      model: "prov/m",
      status: "error",
      attempts: 2,
      durationMs: 5000,
      actionCount: 1,
      eventCount: 7,
      thinkingChars: 10,
      cause: "timeout",
      errorMessage: "boum",
      responsePreview: "partiel",
      actions: [{ seq: 1, toolName: "grep", argSummary: "grep TODO", durationMs: 12, isError: false, summary: "3 résultats", outputChars: 30, truncated: false }],
    }, 10_000);
    expect(run).not.toBeNull();
    expect(run).toMatchObject({
      id: "d-42-ffff",
      function: "review",
      label: "Relecture",
      modelId: "prov/m",
      status: "failed",
      isError: true,
      attempt: 2,
      archived: true,
      startedAt: 5000,
      endedAt: 10_000,
    });
    expect(run!.actions[0]).toMatchObject({ toolName: "grep", summary: "3 résultats", durationMs: 12 });
    expect(run!.end).toMatchObject({ status: "error", cause: "timeout", errorMessage: "boum" });
  });

  it("refuse un payload sans delegateRunId", () => {
    expect(runFromActivity({ function: "execute" })).toBeNull();
    expect(runFromActivity(null)).toBeNull();
  });
});

describe("routeSubagentEnvelope — rattachement FIFO + args.function", () => {
  it("rattache par fonction (deux runs execute → deux tool calls dans l'ordre)", () => {
    const messages: DisplayMessage[] = [msg("a", ["execute", "execute"]), msg("b", ["planning"])];

    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r1" }), messages);
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r2" }), messages);

    expect(getRun("r1")?.toolCallId).toBe("a-tc0");
    expect(getRun("r2")?.toolCallId).toBe("a-tc1");
  });

  it("fonction re-classée (aucun match) → repli sur le premier tool call libre", () => {
    const messages: DisplayMessage[] = [msg("a", ["planning"])];
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r1", delegateFunction: "integrate" }), messages);
    expect(getRun("r1")?.toolCallId).toBe("a-tc0");
  });

  it("retente le rattachement quand le toolCall arrive après le premier event", () => {
    const empty: DisplayMessage[] = [];
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r1" }), empty);
    expect(getRun("r1")?.toolCallId).toBeUndefined();
    // Le toolCall est commité un render plus tard.
    routeSubagentEnvelope(env({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} }, { delegateRunId: "r1" }), [msg("a", ["execute"])]);
    expect(getRun("r1")?.toolCallId).toBe("a-tc0");
  });

  it("ne touche JAMAIS le tableau de messages (mêmes références)", () => {
    const messages: DisplayMessage[] = [msg("a", ["execute"])];
    const before = JSON.stringify(messages);
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r1" }), messages);
    routeSubagentEnvelope(env({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "x" }] } }, { delegateRunId: "r1" }), messages);
    expect(JSON.stringify(messages)).toBe(before);
    expect(messages[0].toolCalls![0].output).toBe("");
  });

  it("extractDelegateCalls ne retient que les tool calls delegate", () => {
    const messages: DisplayMessage[] = [{
      id: "a", role: "assistant", content: "", thinking: "", timestamp: 0,
      toolCalls: [
        { id: "x", name: "read", args: {}, output: "", isError: false, isStreaming: false },
        { id: "y", name: "delegate", args: { function: "review" }, output: "", isError: false, isStreaming: false },
      ],
    }];
    expect(extractDelegateCalls(messages)).toEqual([{ id: "y", fn: "review" }]);
  });

  it("runs archivés non rattachables → orphelins (fin de fil)", () => {
    const run = runFromActivity({ delegateRunId: "d-orphan", function: "execute", status: "success" }, 0)!;
    // Aucun tool call `delegate` fourni → pas de rattachement.
    registerArchivedRuns([run], []);
    expect(getOrphanRuns().some((r) => r.id === "d-orphan")).toBe(true);
  });
});

describe("coalescing ~100 ms par run", () => {
  it("plusieurs events rapprochés → une seule notification après le délai", () => {
    flushSubagentNotifications();
    vi.useFakeTimers();
    const cb = vi.fn();
    const unsub = subscribeRun("r1", cb);
    const messages: DisplayMessage[] = [msg("a", ["execute"])];
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r1" }), messages);
    routeSubagentEnvelope(env({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} }, { delegateRunId: "r1" }), messages);
    expect(cb).not.toHaveBeenCalled(); // coalescé
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    // L'état exposé est bien le plus récent (action présente).
    expect(getRun("r1")?.actions).toHaveLength(1);
    unsub();
  });
});
