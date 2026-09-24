// ── Tests unitaires : store isolé des runs de sous-agents (LOT 2b) ──────────
// Cœur du lot : `applySubagentEvent` est PUR (run + enveloppe → nouveau run),
// testable sans React ni timer. On couvre aussi le rattachement FIFO + fonction
// (routeSubagentEnvelope) et la reconstruction d'un run archivé (historique).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DisplayMessage, SubAgentRun } from "../types";
import {
  applySubagentEvent,
  concurrentWallAnchor,
  delegateAnchorTimestamp,
  extractDelegateCalls,
  flushSubagentNotifications,
  getAllRuns,
  getDatedDetachedRuns,
  getOrphanRuns,
  getRun,
  insertDatedRuns,
  isRunActive,
  isRunConcurrent,
  isRunStuck,
  registerArchivedRuns,
  resetSubagentRuns,
  routeSubagentEnvelope,
  runAnchorTimestamp,
  runFromActivity,
  runTimeInterval,
  selectConcurrentRuns,
  STUCK_RUN_TIMEOUT_MS,
  subscribeRun,
  toEpochMs,
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

  it("extractDelegateCalls remonte details.delegateRunId (retour du tool)", () => {
    const messages: DisplayMessage[] = [{
      id: "a", role: "assistant", content: "", thinking: "", timestamp: 0,
      toolCalls: [{ id: "y", name: "delegate", args: { function: "review" }, output: "", isError: false, isStreaming: false, details: { delegateRunId: "d-1" } }],
    }];
    expect(extractDelegateCalls(messages)).toEqual([{ id: "y", fn: "review", runId: "d-1" }]);
  });

  it("runs archivés non rattachables → orphelins (fin de fil)", () => {
    const run = runFromActivity({ delegateRunId: "d-orphan", function: "execute", status: "success" }, 0)!;
    // Aucun tool call `delegate` fourni → pas de rattachement.
    registerArchivedRuns([run], []);
    expect(getOrphanRuns().some((r) => r.id === "d-orphan")).toBe(true);
  });

  describe("rattachement EXACT par details.delegateRunId (LOT 2a)", () => {
    // Tool call `delegate` portant le retour du tool (details.delegateRunId).
    function msgWithRun(id: string, fn: string, runId: string): DisplayMessage {
      return {
        id, role: "assistant", content: "", thinking: "", timestamp: 0,
        toolCalls: [{
          id: `${id}-tc`, name: "delegate", args: { function: fn },
          output: "", isError: false, isStreaming: false,
          details: { delegateRunId: runId },
        }],
      };
    }

    it("routeSubagentEnvelope rattache via details même si l'ordre FIFO diffère", () => {
      // Tool calls dans l'ordre b (r2) puis a (r1) : le FIFO attacherait r1 au
      // premier libre (b) ; details impose le rattachement exact.
      const messages = [msgWithRun("b", "execute", "r2"), msgWithRun("a", "execute", "r1")];
      routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r1" }), messages);
      routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r2" }), messages);
      expect(getRun("r1")?.toolCallId).toBe("a-tc");
      expect(getRun("r2")?.toolCallId).toBe("b-tc");
    });

    it("runs archivés rattachés exactement par details (avant le FIFO)", () => {
      const run = runFromActivity({ delegateRunId: "r2", function: "execute", status: "success" }, 0)!;
      const messages = [msgWithRun("b", "execute", "r2"), msgWithRun("a", "execute", "r1")];
      registerArchivedRuns([run], messages);
      expect(getRun("r2")?.toolCallId).toBe("b-tc");
      expect(getOrphanRuns().some((r) => r.id === "r2")).toBe(false);
    });
  });
});

// ── Insertion À LEUR DATE des runs détachés (fix chronologie chat) ─────────
// Helper PUR d'insertion : l'ordre existant des groupes n'est jamais modifié,
// les runs sont posés avant le premier groupe dont la date les dépasse, avec un
// tri stable (tie-break par id).
describe("insertDatedRuns — insertion chronologique STABLE des runs détachés", () => {
  // Étiquette lisible d'une entrée de fil (groupe / run / mur) pour les asserts.
  const labelEntry = (e: { kind: string; group?: number; run?: { id: string }; id?: string }): string =>
    e.kind === "group" ? `g${e.group}` : e.kind === "run" ? e.run!.id : `w-${e.id}`;
  it("insère un run avant le premier groupe dont la date le dépasse", () => {
    const entries = insertDatedRuns([100, 300], [makeRun("r", { startedAt: 200 })], (g) => g);
    expect(entries.map(labelEntry)).toEqual([
      "g100",
      "r",
      "g300",
    ]);
  });

  it("deux runs de MÊME date → tie-break par id (déterministe)", () => {
    const entries = insertDatedRuns(
      [100, 300],
      [makeRun("b", { startedAt: 200 }), makeRun("a", { startedAt: 200 })],
      (g) => g,
    );
    expect(entries.map((e) => labelEntry(e))).toEqual([
      "g100",
      "a",
      "b",
      "g300",
    ]);
  });

  it("un run plus récent que tous les groupes est placé en fin", () => {
    const entries = insertDatedRuns([100, 300], [makeRun("late", { startedAt: 500 })], (g) => g);
    expect(entries.map((e) => labelEntry(e))).toEqual([
      "g100",
      "g300",
      "late",
    ]);
  });

  it("un run plus ancien que tous les groupes est placé en tête", () => {
    const entries = insertDatedRuns([100, 300], [makeRun("old", { startedAt: 50 })], (g) => g);
    expect(entries.map((e) => labelEntry(e))).toEqual([
      "old",
      "g100",
      "g300",
    ]);
  });

  it("à date égale, le run passe AVANT le groupe (jamais après la réponse)", () => {
    const entries = insertDatedRuns([200], [makeRun("r", { startedAt: 200 })], (g) => g);
    expect(entries.map((e) => e.kind)).toEqual(["run", "group"]);
  });

  it("sans run, renvoie les groupes dans leur ordre d'origine", () => {
    const entries = insertDatedRuns([300, 100], [], (g) => g);
    expect(entries.map((e) => (e.kind === "group" ? e.group : -1))).toEqual([300, 100]);
  });

  it("runAnchorTimestamp : début prioritaire, sinon fin, sinon 0", () => {
    expect(runAnchorTimestamp(makeRun("a", { startedAt: 10, endedAt: 20 }))).toBe(10);
    expect(runAnchorTimestamp(makeRun("a", { endedAt: 20 }))).toBe(20);
    expect(runAnchorTimestamp(makeRun("a"))).toBe(0);
  });
});

// ── Runs BLOQUÉS : sortie du mur de colonnes après seuil ─────────────────────
describe("isRunStuck / selectConcurrentRuns — run bloqué sorti du mur", () => {
  it("isRunStuck : vrai seulement si running au-delà du seuil", () => {
    const live = makeRun("a", { startedAt: 0 });
    expect(isRunStuck(live, STUCK_RUN_TIMEOUT_MS)).toBe(false); // borne inclusive
    expect(isRunStuck(live, STUCK_RUN_TIMEOUT_MS + 1)).toBe(true);
    // Un run terminé n'est jamais bloqué.
    expect(isRunStuck(makeRun("a", { status: "done", startedAt: 0, endedAt: 10 }), 10_000_000)).toBe(false);
    // Sans startedAt, impossible de dater → jamais bloqué.
    expect(isRunStuck(makeRun("a"), 10_000_000)).toBe(false);
  });

  it("deux runs actifs au-delà du seuil → plus de groupe de colonnes", () => {
    const a = makeRun("a", { startedAt: 0 });
    const b = makeRun("b", { startedAt: 10 });
    expect(selectConcurrentRuns([a, b], 1000)).toHaveLength(1); // récents → colonnes
    expect(selectConcurrentRuns([a, b], STUCK_RUN_TIMEOUT_MS + 1000)).toEqual([]); // bloqués
  });

  it("un seul run récent + un run bloqué → pas de colonne (il ne reste qu'un actif)", () => {
    const recent = makeRun("recent", { startedAt: STUCK_RUN_TIMEOUT_MS + 500 });
    const stuck = makeRun("stuck", { startedAt: 0 });
    expect(selectConcurrentRuns([recent, stuck], STUCK_RUN_TIMEOUT_MS + 1000)).toEqual([]);
  });
});

// ── Runs détachés rendus À LEUR DATE ────────────────────────────────────────
describe("getDatedDetachedRuns — runs sans toolCall à insérer dans le fil", () => {
  it("inclut un orphelin archivé et exclut un run rattaché", () => {
    const orphan = runFromActivity({ delegateRunId: "d-orph", function: "execute", status: "success" }, 0)!;
    registerArchivedRuns([orphan], []);
    expect(getDatedDetachedRuns(undefined, 0).some((r) => r.id === "d-orph")).toBe(true);

    // Le toolCall `delegate` devient disponible → le run se rattache et quitte
    // la liste des runs datés.
    const attached = runFromActivity({ delegateRunId: "d-att", function: "execute", status: "success" }, 0)!;
    registerArchivedRuns([attached], [msg("a", ["execute"])]);
    expect(getRun("d-att")?.toolCallId).toBe("a-tc0");
    expect(getDatedDetachedRuns(undefined, 0).some((r) => r.id === "d-att")).toBe(false);
  });

  it("inclut un run BLOQUÉ (running sans subagent_end) dès que le seuil est dépassé", () => {
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "d-stuck" }), [], 0);
    // Avant le seuil : run actif, pas encore détaché (il vit dans le mur/fil).
    expect(getDatedDetachedRuns(undefined, 1000).some((r) => r.id === "d-stuck")).toBe(false);
    // Après le seuil : détaché → inséré à sa date.
    expect(getDatedDetachedRuns(undefined, STUCK_RUN_TIMEOUT_MS + 1).some((r) => r.id === "d-stuck")).toBe(true);
  });
});

/**
 * (fix orphelins) Le rattachement d'un orphelin est RETENTÉ à chaque nouvelle
 * liste de messages : un run resté orphelin redevient inline dès que la
 * pagination d'historique apporte enfin son toolCall `delegate`.
 */
describe("registerArchivedRuns — rattachement RETENTÉ d'un orphelin", () => {
  it("re-tente le rattachement quand le delegate arrive plus tard", () => {
    const run = runFromActivity({ delegateRunId: "d-retry", function: "execute", status: "success" }, 0)!;
    registerArchivedRuns([run], []);
    expect(getOrphanRuns().some((r) => r.id === "d-retry")).toBe(true);

    // Pagination : le toolCall `delegate` arrive enfin.
    registerArchivedRuns([run], [msg("a", ["execute"])]);
    expect(getRun("d-retry")?.toolCallId).toBe("a-tc0");
    expect(getOrphanRuns().some((r) => r.id === "d-retry")).toBe(false);
    expect(getDatedDetachedRuns(undefined, 0).some((r) => r.id === "d-retry")).toBe(false);
  });

  it("idempotent : un run déjà enregistré n'est jamais dupliqué", () => {
    const run = runFromActivity({ delegateRunId: "d-dup", function: "execute", status: "success" }, 0)!;
    registerArchivedRuns([run], []);
    registerArchivedRuns([run], []);
    expect(getAllRuns().filter((r) => r.id === "d-dup")).toHaveLength(1);
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

// ── LOT 4 : détection de concurrence (vue en colonnes) ──────────────────────
// `selectConcurrentRuns` est PURE (runs + now → groupes) : on la teste sans
// React ni store. Aide : construit un run minimal actif/terminé.
function makeRun(
  id: string,
  over: Partial<SubAgentRun> = {},
): SubAgentRun {
  return {
    id,
    function: "execute",
    label: "Exécution",
    task: "",
    status: "running",
    isError: false,
    attempt: 1,
    actions: [],
    messages: [],
    ...over,
  };
}

describe("selectConcurrentRuns — groupes de sous-agents simultanés ACTIFS", () => {
  it("deux runs ACTIFS qui se chevauchent → un groupe de deux", () => {
    const a = makeRun("a", { startedAt: 0 });
    const b = makeRun("b", { startedAt: 500 });
    const groups = selectConcurrentRuns([a, b], 1000);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id)).toEqual(["a", "b"]); // chronologique
  });

  it("un seul run actif → aucun groupe (fil normal)", () => {
    expect(selectConcurrentRuns([makeRun("a", { startedAt: 0 })], 1000)).toEqual([]);
    expect(selectConcurrentRuns([], 1000)).toEqual([]);
  });

  it("deux runs TERMINÉS non contemporains → aucun groupe", () => {
    const a = makeRun("a", { status: "done", startedAt: 0, endedAt: 100 });
    const b = makeRun("b", { status: "done", startedAt: 300, endedAt: 400 });
    expect(selectConcurrentRuns([a, b], 1000)).toEqual([]);
  });

  it("un run TERMINÉ + un run ACTIF → aucun groupe (il ne reste qu'un actif)", () => {
    const done = makeRun("done", { status: "done", startedAt: 0, endedAt: 900 });
    const live = makeRun("live", { startedAt: 500 });
    expect(selectConcurrentRuns([done, live], 1000)).toEqual([]);
  });

  it("un run terminé contemporain + deux actifs → le groupe ne contient que les actifs", () => {
    const done = makeRun("done", { status: "done", startedAt: 0, endedAt: 800 });
    const a = makeRun("a", { startedAt: 100 });
    const b = makeRun("b", { startedAt: 200 });
    const groups = selectConcurrentRuns([done, a, b], 1000);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("trois actifs → un seul groupe de trois, trié chronologiquement", () => {
    const a = makeRun("a", { startedAt: 0 });
    const b = makeRun("b", { startedAt: 10 });
    const c = makeRun("c", { startedAt: 5 });
    const groups = selectConcurrentRuns([a, b, c], 1000);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("les runs ARCHIVÉS (historique) sont ignorés", () => {
    const a = makeRun("a", { startedAt: 0 });
    const b = makeRun("b", { startedAt: 10, archived: true });
    expect(selectConcurrentRuns([a, b], 1000)).toEqual([]);
  });

  it("runTimeInterval : ouvert jusqu'à now si actif, figé si terminé", () => {
    expect(runTimeInterval(makeRun("a", { startedAt: 100 }), 500)).toEqual({ start: 100, end: 500 });
    expect(runTimeInterval(makeRun("a", { status: "done", startedAt: 100, endedAt: 300 }), 500)).toEqual({ start: 100, end: 300 });
    // Terminé sans endedAt → réduit à un point.
    expect(runTimeInterval(makeRun("a", { status: "done", startedAt: 100 }), 500)).toEqual({ start: 100, end: 100 });
    expect(isRunActive(makeRun("a"))).toBe(true);
    expect(isRunActive(makeRun("a", { status: "failed" }))).toBe(false);
  });

  it("isRunConcurrent : appartenance à un groupe", () => {
    const a = makeRun("a", { startedAt: 0 });
    const b = makeRun("b", { startedAt: 10 });
    const groups = selectConcurrentRuns([a, b], 1000);
    expect(isRunConcurrent("a", groups)).toBe(true);
    expect(isRunConcurrent("z", groups)).toBe(false);
    expect(isRunConcurrent(undefined, groups)).toBe(false);
  });
});

describe("getAllRuns / useConcurrentRuns — vue live du store", () => {
  it("getAllRuns expose les runs vivants et les groupes se déduisent", () => {
    const messages: DisplayMessage[] = [msg("a", ["execute", "execute"])];
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r1" }), messages, 100);
    expect(selectConcurrentRuns(getAllRuns(), 200)).toEqual([]); // 1 seul actif
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r2" }), messages, 150);
    const groups = selectConcurrentRuns(getAllRuns(), 200);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("un run terminé ne bloque pas : dès qu'il ne reste qu'un actif, plus de groupe", () => {
    const messages: DisplayMessage[] = [msg("a", ["execute", "execute"])];
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r1" }), messages, 100);
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "r2" }), messages, 150);
    expect(selectConcurrentRuns(getAllRuns(), 200)).toHaveLength(1);
    routeSubagentEnvelope(env({ type: "subagent_end", status: "success" }, { delegateRunId: "r2" }), messages, 300);
    expect(selectConcurrentRuns(getAllRuns(), 400)).toEqual([]);
  });
});

// ── ÉTANCHÉITÉ inter-projets (BUG : sous-agents d'un projet affichés dans la
// conversation d'un AUTRE projet — deux projets déléguant en parallèle) ──────
// Le store est désormais SCOPÉ par projectId : chaque run porte le projet de
// son enveloppe (ou de la frame WS qui l'a livré), les sélecteurs filtrent par
// projet, le rattachement FIFO ne franchit jamais les frontières et le reset
// au changement de projet ne purge que le projet quitté.
describe("étanchéité inter-projets du store (BUG sous-agents cross-project)", () => {
  const PA = "uuid-projet-a";
  const PB = "uuid-projet-b";
  const messagesA = [msg("a", ["execute", "execute"])]; // 2 toolCalls dans Pi-A
  const messagesB = [msg("b", ["execute"])];

  it("deux projets émettant en parallèle : getAllRuns(pid) ne voit que SON projet", () => {
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "ra1", projectId: PA }), messagesA, 100, PA);
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "ra2", projectId: PA }), messagesA, 110, PA);
    // Pi-B émet EN MÊME TEMPS (sous-agent Yuki pendant que Pi-Web délègue).
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "rb1", projectId: PB }), messagesB, 120, PB);

    const runsA = getAllRuns(PA);
    expect(runsA.map((r) => r.id).sort()).toEqual(["ra1", "ra2"]);
    expect(getAllRuns(PB).map((r) => r.id)).toEqual(["rb1"]);
    // Compat : sans filtre, tout est visible (aucune perte de données).
    expect(getAllRuns()).toHaveLength(3);
  });

  it("le mur des colonnes (selectConcurrentRuns) compte les runs concurrents d'UN SEUL projet", () => {
    // Deux runs actifs dans Pi-A + un run actif dans Pi-B, tous simultanés :
    // la vue de Pi-A doit montrer UN groupe de 2 (jamais 3 avec le run étranger).
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "ra1", projectId: PA }), messagesA, 100, PA);
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "ra2", projectId: PA }), messagesA, 110, PA);
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "rb1", projectId: PB }), messagesB, 120, PB);

    const groupsA = selectConcurrentRuns(getAllRuns(PA), 200);
    expect(groupsA).toHaveLength(1);
    expect(groupsA[0].map((r) => r.id).sort()).toEqual(["ra1", "ra2"]);
    // Vue de Pi-B : son propre run seul → pas de groupe (comportement fil).
    expect(selectConcurrentRuns(getAllRuns(PB), 200)).toEqual([]);
  });

  it("le FIFO de secours ne rattachera JAMAIS un run étranger aux toolCalls locaux", () => {
    // Le run de Pi-B arrive pendant que le fil affiché est celui de Pi-A
    // (frame multi-projets) : les messages fournis sont ceux de Pi-A.
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "rb1", projectId: PB }), messagesA, 100, PA);
    // Aucun toolCall de Pi-A consommé par le run étranger…
    expect(getRun("rb1")?.toolCallId).toBeUndefined();
    // …et le 1er toolCall de Pi-A reste LIBRE pour un run de Pi-A.
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "ra1", projectId: PA }), messagesA, 120, PA);
    expect(getRun("ra1")?.toolCallId).toBe("a-tc0");
  });

  it("incohérence enveloppe ↔ frame (env.projectId ≠ frame pid) → event ignoré", () => {
    // Défense en profondeur : l'enveloppe porte SON projet (backend) ; si la
    // frame qui la transporte annonce un autre projet, on refuse.
    const out = routeSubagentEnvelope(
      env({ type: "subagent_start" }, { delegateRunId: "rx", projectId: PB }),
      messagesA, 100, PA,
    );
    expect(out).toBeUndefined();
    expect(getRun("rx")).toBeUndefined();
    expect(getAllRuns()).toHaveLength(0);
  });

  it("frame sans projectId dans l'enveloppe (backend antérieur) : le run adopte le pid de la frame", () => {
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "rl1" }), messagesA, 100, PA);
    expect(getRun("rl1")?.projectId).toBe(PA);
    // Il est bien rattaché aux toolCalls de SON projet (rattachement FIFO normal).
    expect(getRun("rl1")?.toolCallId).toBe("a-tc0");
  });

  it("enveloppe avec projectId mais sans frame pid : run marqué, rattachement autorisé", () => {
    // L'enveloppe est la source d'autorité ; sans frame pid, le run garde son
    // projet et peut se rattacher (le FIFO refuse seulement les MISMATCH).
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "rl2", projectId: PA }), messagesA, 100);
    expect(getRun("rl2")?.projectId).toBe(PA);
    expect(getRun("rl2")?.toolCallId).toBe("a-tc0");
  });

  it("orphelins archivés : getOrphanRuns(pid) ne montre que les orphelins du projet", () => {
    registerArchivedRuns([
      { ...runFromActivity({ delegateRunId: "oa", function: "execute", status: "success" }, 0)!, projectId: PA },
      { ...runFromActivity({ delegateRunId: "ob", function: "execute", status: "success" }, 0)!, projectId: PB },
    ], [], undefined);
    // NB : sans 3e argument ici, les runs portent DÉJÀ leur projectId (fourni
    // dans la liste — même comportement qu'un run marqué en amont).
    expect(getOrphanRuns(PA).map((r) => r.id)).toEqual(["oa"]);
    expect(getOrphanRuns(PB).map((r) => r.id)).toEqual(["ob"]);
    expect(getOrphanRuns()).toHaveLength(2);
  });

  it("registerArchivedRuns marque le projectId de la conversation relecture", () => {
    const run = runFromActivity({ delegateRunId: "oc", function: "execute", status: "success" }, 0)!;
    expect(run.projectId).toBeUndefined(); // l'activité persistée ne porte pas le projet
    registerArchivedRuns([run], messagesA, PA);
    expect(getRun("oc")?.projectId).toBe(PA);
    // Rattaché aux toolCalls du MÊME projet.
    expect(getRun("oc")?.toolCallId).toBe("a-tc0");
  });

  it("resetSubagentRuns(pid) purge le projet quitté SAUF ses runs actifs ; les autres projets intacts", () => {
    // Pi-A : un run actif + un run terminé. Pi-B : un run actif.
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "ra1", projectId: PA }), messagesA, 100, PA);
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "ra2", projectId: PA }), messagesA, 105, PA);
    routeSubagentEnvelope(env({ type: "subagent_end", status: "success" }, { delegateRunId: "ra2", projectId: PA }), messagesA, 130, PA);
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "rb1", projectId: PB }), messagesB, 110, PB);
    expect(getRun("rb1")?.toolCallId).toBe("b-tc0"); // rattaché à Pi-B

    // L'utilisateur quitte Pi-A (changement de projet dans ChatView).
    resetSubagentRuns(PA);
    // Le run TERMINÉ de Pi-A est purgé (nettoyage — la relecture passera par
    // l'activité archivée persistée dans SA session)…
    expect(getRun("ra2")).toBeUndefined();
    // …mais son run ENCORE ACTIF survit : le projet continue de déléguer en
    // arrière-plan, et à son retour l'utilisateur retrouve son run en cours.
    expect(getRun("ra1")?.toolCallId).toBe("a-tc0");
    // Le run de Pi-B (autre projet, encore actif) survit AVEC son rattachement
    // — il s'affichera dans SA conversation, jamais ailleurs.
    expect(getRun("rb1")?.toolCallId).toBe("b-tc0");
    // Sans argument : purge totale (comportement historique).
    resetSubagentRuns();
    expect(getRun("ra1")).toBeUndefined();
    expect(getRun("rb1")).toBeUndefined();
  });

  it("rattachement EXACT par details.delegateRunId reste correct entre projets (aucun cross-attach)", () => {
    // ToolCalls de Pi-A portant le retour du tool (details.delegateRunId).
    const exactA: DisplayMessage[] = [{
      id: "a", role: "assistant", content: "", thinking: "", timestamp: 0,
      toolCalls: [{ id: "a-tc", name: "delegate", args: { function: "execute" }, output: "", isError: false, isStreaming: false, details: { delegateRunId: "ra1" } }],
    }];
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "ra1", projectId: PA }), exactA, 100, PA);
    expect(getRun("ra1")?.toolCallId).toBe("a-tc");
    // Un run de Pi-B avec le même motif ne peut pas voler le toolCall de Pi-A :
    // même si details portait (par erreur) ce runId, le mismatch projet bloque.
    routeSubagentEnvelope(env({ type: "subagent_start" }, { delegateRunId: "rb1", projectId: PB }), exactA, 110, PB);
    expect(getRun("rb1")?.toolCallId).toBeUndefined();
  });
});

// ── Ancrage À L'APPEL `delegate` (fix « sous-agent après la réponse finale ») ─
// Cause racine : `buildFullUiHistory` sérialise les timestamps d'entrées en ISO
// 8601 → `now - durationMs` donnait NaN et les dates de groupes valaient 0 ; le
// tri poussait alors TOUT run détaché en fin de fil (après la réponse finale).
// On vérifie : normalisation des dates, rattachement au `toolResult` `delegate`
// orphelin, et placement AVANT la réponse finale même si l'activité du
// sous-agent est enregistrée après.
describe("ancrage par appel `delegate` (jamais après la réponse finale)", () => {
  it("toEpochMs normalise ISO 8601 en epoch ms (et préserve le numérique)", () => {
    expect(toEpochMs("2026-09-20T12:54:41.841Z")).toBe(1789908881841);
    expect(toEpochMs(1234)).toBe(1234);
    expect(toEpochMs(undefined, 42)).toBe(42);
    expect(toEpochMs("pas une date", 42)).toBe(42);
  });

  it("runFromActivity accepte un timestamp ISO : startedAt/endedAt finis (jamais NaN)", () => {
    const run = runFromActivity(
      { delegateRunId: "d-iso", function: "execute", status: "success", durationMs: 362103 },
      "2026-09-20T12:54:41.841Z",
    )!;
    expect(Number.isFinite(run.startedAt as number)).toBe(true);
    expect(run.startedAt).toBe(1789908881841 - 362103);
    expect(run.endedAt).toBe(1789908881841);
    // Même sans durée, l'ancrage reste numérique.
    const noDur = runFromActivity({ delegateRunId: "d-nodur", function: "execute", status: "success" }, "2026-09-20T12:54:41.841Z")!;
    expect(noDur.startedAt).toBe(1789908881841);
    expect(runAnchorTimestamp(noDur)).toBe(1789908881841);
  });

  it("runAnchorTimestamp refuse les valeurs non finies (jamais NaN)", () => {
    expect(runAnchorTimestamp(makeRun("a", { startedAt: NaN, endedAt: 10 }))).toBe(10);
    expect(runAnchorTimestamp(makeRun("a", { startedAt: Infinity }))).toBe(0);
  });

  it("extractDelegateCalls accepte un toolResult `delegate` ORPHELIN (toolCall hors fenêtre)", () => {
    const messages: DisplayMessage[] = [
      {
        id: "tr1", role: "assistant", content: "", thinking: "", timestamp: 5,
        toolCalls: [],
        kind: "toolResult",
        toolResult: {
          id: "call_orphan", name: "delegate", args: {}, output: "…", isError: false, isStreaming: false,
          details: { delegateRunId: "d-orph", delegateFunction: "execute" },
        },
      },
    ];
    expect(extractDelegateCalls(messages)).toEqual([{ id: "call_orphan", fn: "execute", runId: "d-orph" }]);
  });

  it("un run archivé se rattache à son toolResult `delegate` orphelin (plus détaché)", () => {
    const run = runFromActivity({ delegateRunId: "d-orph", function: "execute", status: "success", durationMs: 1000 }, 5000)!;
    const messages: DisplayMessage[] = [
      {
        id: "tr1", role: "assistant", content: "", thinking: "", timestamp: 5,
        toolCalls: [],
        kind: "toolResult",
        toolResult: {
          id: "call_orphan", name: "delegate", args: {}, output: "", isError: false, isStreaming: false,
          details: { delegateRunId: "d-orph", delegateFunction: "execute" },
        },
      },
    ];
    registerArchivedRuns([run], messages);
    expect(getRun("d-orph")?.toolCallId).toBe("call_orphan");
    expect(getDatedDetachedRuns(undefined, 0).some((r) => r.id === "d-orph")).toBe(false);
  });

  it("activité enregistrée APRÈS la réponse finale → le run est placé AVANT elle", () => {
    // Fil : groupe assistant (delegate + réponse finale) à ts 1000, puis rien.
    // L'activité du sous-agent est écrite à 5000, sa durée 4000 → début 1000.
    const run = runFromActivity(
      { delegateRunId: "d-late", function: "execute", status: "success", durationMs: 4000 },
      5000,
    )!;
    expect(runAnchorTimestamp(run)).toBe(1000);
    // La réponse finale est dans un groupe daté 1000 : le run (début 1000) est
    // inséré AVANT ce groupe (début ≤ date du groupe), jamais après.
    const entries = insertDatedRuns([1000], [run], (g) => g);
    expect(entries.map((e) => e.kind)).toEqual(["run", "group"]);
  });

  it("delegateAnchorTimestamp privilégie la position du toolCall dans le fil", () => {
    const groups: DisplayMessage[][] = [
      [{ id: "a", role: "assistant", content: "", thinking: "", timestamp: 111, toolCalls: [{ id: "t1", name: "delegate", args: {}, output: "", isError: false, isStreaming: false }] }],
    ];
    const run = makeRun("d-x", { startedAt: 999, toolCallId: "t1" });
    expect(delegateAnchorTimestamp(run, groups)).toBe(111);
    // ToolCall absent → repli sur la date du run.
    expect(delegateAnchorTimestamp(makeRun("d-y", { startedAt: 999, toolCallId: "absent" }), groups)).toBe(999);
  });

  it("le mur des colonnes se place À LA DATE du premier `delegate` du lot", () => {
    const entries = insertDatedRuns(
      [100, 300],
      [],
      (g) => g,
      [{ ts: 200, id: "parallel" }],
    );
    expect(entries.map((e) => (e.kind === "group" ? `g${e.group}` : e.kind === "run" ? e.run.id : `w-${e.id}`))).toEqual([
      "g100",
      "w-parallel",
      "g300",
    ]);
    // À date égale, le run passe AVANT le mur (tie-break clé stable).
    const tied = insertDatedRuns([300], [makeRun("r", { startedAt: 200 })], (g) => g, [{ ts: 200 }]);
    expect(tied.map((e) => e.kind)).toEqual(["run", "wall", "group"]);
  });

  it("concurrentWallAnchor : date du premier delegate du groupe, sinon null", () => {
    const a = makeRun("a", { startedAt: 100 });
    const b = makeRun("b", { startedAt: 150 });
    expect(concurrentWallAnchor([a, b], 200)).toBe(100);
    expect(concurrentWallAnchor([a], 200)).toBeNull(); // 1 seul actif → pas de mur
    expect(concurrentWallAnchor([], 200)).toBeNull();
    // Deux runs actifs sans date exploitable → null (l'appelant retombe en fin de fil).
    expect(concurrentWallAnchor([makeRun("a"), makeRun("b")], 200)).toBeNull();
  });
});
