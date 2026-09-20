// ── Tests : relecture historique d'une entrée `subagent_activity` (LOT 2b) ───
// La conversion pi_history doit : ignorer le custom (display:false) dans le
// fil, reconstruire un SubAgentRun archivé et le rattacher au toolCall
// `delegate` correspondant (FIFO + fonction) pour relecture après rechargement.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { convertHistoryToDisplayMessages } from "./useChatHistory";
import { getRun, resetSubagentRuns } from "../stores/subagentRuns";

const raw = [
  {
    id: "a1",
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "delegate", arguments: { function: "execute", task: "fais X" } }],
    timestamp: 1,
  },
  { role: "toolResult", toolCallId: "tc1", toolName: "delegate", content: [{ type: "text", text: "preview" }], timestamp: 2 },
  {
    id: "c1",
    role: "custom",
    customType: "subagent_activity",
    display: false,
    content: "🤖 Sous-agent Exécution (execute) — success · 1 action(s)",
    details: {
      delegateRunId: "d-hist-1",
      function: "execute",
      label: "Exécution",
      model: "prov/m",
      status: "success",
      attempts: 1,
      durationMs: 4200,
      actionCount: 1,
      eventCount: 5,
      thinkingChars: 0,
      actions: [{ seq: 1, toolName: "read", argSummary: "read a.ts", summary: "2 lignes", durationMs: 5, isError: false, outputChars: 10, truncated: false }],
      responsePreview: "ok",
    },
    timestamp: 3,
  },
];

describe("convertHistoryToDisplayMessages — subagent_activity (LOT 2b)", () => {
  beforeEach(() => {
    resetSubagentRuns();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("ignore l'entrée custom dans le fil et enregistre un run archivé rattaché", () => {
    const display = convertHistoryToDisplayMessages(raw as any);
    // 1 seul message affiché (l'assistant avec le toolCall delegate) — le
    // custom subagent_activity (display:false) n'apparaît PAS comme message.
    expect(display).toHaveLength(1);
    expect(display[0].role).toBe("assistant");
    expect(display[0].toolCalls?.[0].id).toBe("tc1");

    const run = getRun("d-hist-1");
    expect(run).toMatchObject({ archived: true, status: "done", label: "Exécution", modelId: "prov/m" });
    expect(run?.toolCallId).toBe("tc1");
    expect(run?.actions[0]).toMatchObject({ toolName: "read", summary: "2 lignes" });
    expect(run?.end).toMatchObject({ status: "success", durationMs: 4200, actionCount: 1 });
  });

  it("relecture idempotente (re-conversion) : pas de doublon, rattachement stable", () => {
    convertHistoryToDisplayMessages(raw as any);
    const display = convertHistoryToDisplayMessages(raw as any);
    expect(display).toHaveLength(1);
    expect(getRun("d-hist-1")?.toolCallId).toBe("tc1");
  });
});
