// ── Micro-benchmarks : applyPiEvent ─────────────────────────────────
// Mesure le coût du processor de streaming sur deux scénarios réalistes :
// 1) un long flux de text_delta (10 000 chunks) ;
// 2) un message avec 100 tool calls + leurs updates.
// Format de sortie lisible (temps moyen par batch).
//
// NB : en Vitest 5, `bench` n'est plus un export top-level de `vitest` :
// c'est une fixture du contexte de test (`test('…', async ({ bench }) => …)`).
import { describe, test } from "vitest";
import { applyPiEvent as applyPiEventFn } from "./pi-events";
import type { DisplayMessage, PiEvent } from "../types";

// Destructure l'export en const locale : évite le warning Vitest sur les
// « module export getters » accédés trop souvent pendant le benchmark.
const applyPiEvent = applyPiEventFn;

// ── Scénario 1 : 10 000 text_delta ───────────────────────────────────
function buildTextDeltaStream(n: number): PiEvent[] {
  const events: PiEvent[] = [{ type: "message_start", message: { role: "assistant", id: "asst-bench" } }];
  for (let i = 0; i < n; i++) {
    events.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
  }
  return events;
}

// ── Scénario 2 : 100 tool calls + updates ────────────────────────────
function buildToolCallStream(n: number): PiEvent[] {
  const events: PiEvent[] = [{ type: "message_start", message: { role: "assistant", id: "asst-bench" } }];
  for (let i = 0; i < n; i++) {
    const id = `tc-${i}`;
    events.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolCallId: id, toolName: "read_file", args: { path: `/tmp/${i}` } } });
    events.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", toolCallId: id, argsDelta: { offset: i } } });
    events.push({ type: "tool_execution_update", toolCallId: id, partialResult: { content: [{ text: `output ${i}` }] } });
    events.push({ type: "tool_execution_end", toolCallId: id, result: { content: [{ text: `done ${i}` }] }, isError: false });
  }
  return events;
}

// Applique une séquence complète d'événements (un « batch »).
function runBatch(events: PiEvent[]): DisplayMessage[] {
  let msgs: DisplayMessage[] = [];
  let asstId: string | null = null;
  for (const evt of events) {
    const r = applyPiEvent(msgs, evt, asstId);
    msgs = r.messages;
    asstId = r.assistantId;
  }
  return msgs;
}

describe("applyPiEvent — benchmarks", () => {
  const textStream = buildTextDeltaStream(10_000);
  const toolStream = buildToolCallStream(100);

  test("flux de 10 000 text_delta", async ({ bench }) => {
    await bench("10 000 text_delta (temps moyen par batch)", () => {
      runBatch(textStream);
    }).run();
  });

  test("message de 100 tool calls + updates", async ({ bench }) => {
    await bench("100 tool calls + updates (temps moyen par batch)", () => {
      runBatch(toolStream);
    }).run();
  });
});
