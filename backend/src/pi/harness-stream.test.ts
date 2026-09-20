/**
 * harness-stream.test.ts — tests des helpers PURS du streaming sous-agent
 * (LOT 2a, refonte du chat).
 *
 * - Enveloppe {type:"subagent", …} + makeDelegateRunId (format, unicité).
 * - emitSubagentEvent : pont globalThis (enregistré/restauré proprement),
 *   no-op si non résolvable, try/catch permanent (un callback qui jette ne
 *   doit JAMAIS remonter à l'appelant — un échec de streaming ne fait pas
 *   échouer une délégation).
 * - Quota de sécurité (createSubagentEventGate) : ≤20 événements/s, fusion
 *   des tool_execution_update consécutifs d'un même toolCallId, droppedEvents.
 * - Troncatures + résumés d'outils (alignés sur la spec : read → N lignes,
 *   write → N lignes écrites, edit → +A/−B via details.diff, bash → exit N +
 *   N lignes, grep/find/ls → N résultats/fichiers/entrées, erreur → 1re ligne).
 *
 * Aucun effet de bord : le pont d'émission est sauvegardé/restauré autour de
 * chaque test qui le manipule (isolation vis-à-vis des autres fichiers).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSubagentEnvelope,
  countLines,
  createSubagentEventGate,
  emitSubagentEvent,
  filterSubagentActivityFromContext,
  firstLine,
  isSubagentActivityMessage,
  makeDelegateRunId,
  resolveSubagentEmitter,
  registerSubagentEmitter,
  summarizeToolAction,
  summarizeToolArgs,
  truncateChars,
  type RawSubagentEmitter,
  type SubagentEventBase,
} from "./harness-stream.js";

const BRIDGE_KEY = "__piWebHarnessRawEmit__";

// Isolation du pont global : sauvegarde/restauration autour de chaque test.
let savedBridge: unknown;

beforeEach(() => {
  savedBridge = (globalThis as any)[BRIDGE_KEY];
});

afterEach(() => {
  if (savedBridge === undefined) {
    delete (globalThis as any)[BRIDGE_KEY];
  } else {
    (globalThis as any)[BRIDGE_KEY] = savedBridge;
  }
});

const base: SubagentEventBase = {
  delegateRunId: "d-123-abcdef",
  attempt: 1,
  delegateFunction: "execute",
  delegateLabel: "Exécution",
  model: "anthropic/claude-test",
  taskExcerpt: "Corrige le bug X",
};

describe("makeDelegateRunId", () => {
  it("respecte le format d-<epochMs>-<4 aléa>", () => {
    const id = makeDelegateRunId(1736400000000);
    expect(id).toMatch(/^d-\d{13}-[0-9a-f]{4}$/);
    expect(id.startsWith("d-1736400000000-")).toBe(true);
  });

  it("génère des identifiants distincts pour des instants distincts", () => {
    // L'unicité repose sur (epochMs, 4 aléa) : à instants distincts, les ids
    // sont distincts de façon déterministe.
    const ids = new Set(Array.from({ length: 100 }, (_, i) => makeDelegateRunId(1736400000000 + i)));
    expect(ids.size).toBe(100);
  });

  it("tire des suffixes aléatoires distincts pour un même instant (échantillon réduit)", () => {
    // 4 chars hexa = 65536 combinaisons : un grand échantillon au même instant
    // rendrait ce test intrinsèquement floppé (paradoxe des anniversaires) —
    // on borne l'échantillon (collision résiduelle < 0.5%).
    const ids = new Set(Array.from({ length: 20 }, () => makeDelegateRunId(1736400000000)));
    expect(ids.size).toBe(20);
  });
});

describe("buildSubagentEnvelope", () => {
  it("enveloppe l'event avec les champs de la spec", () => {
    const envelope = buildSubagentEnvelope(base, { type: "subagent_start" });
    expect(envelope).toEqual({
      type: "subagent",
      source: "subagent",
      delegateRunId: "d-123-abcdef",
      attempt: 1,
      delegateFunction: "execute",
      delegateLabel: "Exécution",
      model: "anthropic/claude-test",
      taskExcerpt: "Corrige le bug X",
      event: { type: "subagent_start" },
    });
  });

  it("tronque taskExcerpt à 80 chars", () => {
    const envelope = buildSubagentEnvelope({ ...base, taskExcerpt: "x".repeat(300) }, {});
    expect(envelope.taskExcerpt.length).toBe(80);
  });

  it("tolère une base incomplète (valeurs par défaut)", () => {
    const envelope = buildSubagentEnvelope({} as any, { type: "tool_execution_start" });
    expect(envelope.delegateRunId).toBe("");
    expect(envelope.attempt).toBe(1);
    expect(envelope.delegateFunction).toBe("unknown");
    expect(envelope.model).toBe("?");
  });
});

describe("emitSubagentEvent (pont globalThis)", () => {
  it("émet l'enveloppe + projectId via l'émetteur enregistré", () => {
    const received: { event: any; projectId: string }[] = [];
    registerSubagentEmitter(((event: any, projectId: string) => {
      received.push({ event, projectId });
    }) as RawSubagentEmitter);

    emitSubagentEvent("p-1", base, { type: "tool_execution_start", toolName: "read" });

    expect(received).toHaveLength(1);
    expect(received[0].projectId).toBe("p-1");
    expect(received[0].event.type).toBe("subagent");
    expect(received[0].event.source).toBe("subagent");
    expect(received[0].event.event.type).toBe("tool_execution_start");
  });

  it("est un no-op si le pont n'est pas résolvable", () => {
    delete (globalThis as any)[BRIDGE_KEY];
    expect(resolveSubagentEmitter()).toBeNull();
    // Ne doit JAMAIS jeter.
    expect(() => emitSubagentEvent("p-1", base, { type: "subagent_start" })).not.toThrow();
  });

  it("est un no-op si projectId est vide", () => {
    const received: unknown[] = [];
    registerSubagentEmitter(((event: unknown) => {
      received.push(event);
    }) as RawSubagentEmitter);
    emitSubagentEvent("", base, { type: "subagent_start" });
    expect(received).toHaveLength(0);
  });

  it("avale les exceptions de l'émetteur (try/catch permanent)", () => {
    registerSubagentEmitter((() => {
      throw new Error("callback abonné en feu");
    }) as unknown as RawSubagentEmitter);
    // Un échec de streaming ne doit JAMAIS faire échouer une délégation.
    expect(() => emitSubagentEvent("p-1", base, { type: "subagent_start" })).not.toThrow();
  });
});

describe("isSubagentActivityMessage / filterSubagentActivityFromContext", () => {
  it("reconnaît les entrées custom subagent_activity", () => {
    expect(isSubagentActivityMessage({ role: "custom", customType: "subagent_activity" })).toBe(true);
    expect(isSubagentActivityMessage({ role: "custom", customType: "screenshot" })).toBe(false);
    expect(isSubagentActivityMessage({ role: "assistant" })).toBe(false);
    expect(isSubagentActivityMessage(null)).toBe(false);
  });

  it("filtre uniquement les entrées subagent_activity du contexte LLM", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "custom", customType: "subagent_activity", content: "résumé" },
      { role: "assistant", content: "hi" },
      { role: "custom", customType: "git_notification", content: "push ok" },
    ];
    const filtered = filterSubagentActivityFromContext(messages) as any[];
    expect(filtered).toHaveLength(3);
    expect(filtered.some((m) => m.customType === "subagent_activity")).toBe(false);
    // L'original n'est pas muté.
    expect(messages).toHaveLength(4);
  });
});

describe("createSubagentEventGate (quota 20/s)", () => {
  it("admite au plus maxPerSecond événements par fenêtre glissante", () => {
    let now = 1000;
    const gate = createSubagentEventGate({ maxPerSecond: 3, now: () => now });
    expect(gate.admit({ type: "a" }).admitted).toBe(true);
    expect(gate.admit({ type: "b" }).admitted).toBe(true);
    expect(gate.admit({ type: "c" }).admitted).toBe(true);
    const over = gate.admit({ type: "d" });
    expect(over.admitted).toBe(false);
    expect(over.merged).toBe(false);
    expect(gate.droppedEvents).toBe(1);
  });

  it("laisse passer à nouveau après glissement de la fenêtre (1 s)", () => {
    let now = 1000;
    const gate = createSubagentEventGate({ maxPerSecond: 2, now: () => now });
    gate.admit({ type: "a" });
    gate.admit({ type: "b" });
    expect(gate.admit({ type: "c" }).admitted).toBe(false);
    now = 1000 + 999;
    expect(gate.admit({ type: "d" }).admitted).toBe(false); // fenêtre pas encore glissée
    now = 1000 + 1000;
    expect(gate.admit({ type: "e" }).admitted).toBe(true);
  });

  it("FOND les tool_execution_update consécutifs d'un même toolCallId (pas de drop dur)", () => {
    let now = 1000;
    const gate = createSubagentEventGate({ maxPerSecond: 2, now: () => now });
    expect(gate.admit({ type: "tool_execution_start", toolCallId: "t1" }).admitted).toBe(true);
    expect(gate.admit({ type: "tool_execution_update", toolCallId: "t1" }).admitted).toBe(true);
    // Quota plein : un update du MÊME toolCallId → fusion (pas un drop anonyme).
    const fused = gate.admit({ type: "tool_execution_update", toolCallId: "t1" });
    expect(fused.admitted).toBe(false);
    expect(fused.merged).toBe(true);
    expect(gate.droppedEvents).toBe(1);
    // Un update d'un AUTRE toolCallId → drop simple.
    const dropped = gate.admit({ type: "tool_execution_update", toolCallId: "t2" });
    expect(dropped.admitted).toBe(false);
    expect(dropped.merged).toBe(false);
    expect(gate.droppedEvents).toBe(2);
  });

  it("la fusion exige un update consécutif (autre type admis entre-deux → drop)", () => {
    let now = 1000;
    const gate = createSubagentEventGate({ maxPerSecond: 2, now: () => now });
    gate.admit({ type: "tool_execution_update", toolCallId: "t1" });
    gate.admit({ type: "tool_execution_start", toolCallId: "t1" });
    const over = gate.admit({ type: "tool_execution_update", toolCallId: "t1" });
    expect(over.admitted).toBe(false);
    expect(over.merged).toBe(false); // le dernier admis n'était pas un update
  });
});

describe("troncatures", () => {
  it("truncateChars borne la longueur et gère les non-strings", () => {
    expect(truncateChars("abcdef", 3)).toBe("abc");
    expect(truncateChars("abc", 10)).toBe("abc");
    expect(truncateChars(undefined, 5)).toBe("");
    expect(truncateChars(42, 5)).toBe("42");
  });

  it("firstLine renvoie la première ligne non vide tronquée", () => {
    expect(firstLine("\n\n  bonjour le monde  \n(suite)", 7)).toBe("bonjour");
    expect(firstLine("", 10)).toBe("");
  });

  it("countLines compte les lignes non vides", () => {
    expect(countLines("a\nb\n\nc")).toBe(3);
    expect(countLines("")).toBe(0);
    expect(countLines("   \n\t")).toBe(0);
  });
});

describe("summarizeToolArgs", () => {
  it("extrait la cible (path/command/pattern) et borne à 120 chars", () => {
    expect(summarizeToolArgs("read", { path: "/a/b.ts" })).toBe("read /a/b.ts");
    expect(summarizeToolArgs("bash", { command: "ls -la" })).toBe("bash ls -la");
    expect(summarizeToolArgs("grep", { pattern: "foo" })).toBe("grep foo");
    expect(summarizeToolArgs("ls", {})).toBe("ls");
    expect(summarizeToolArgs("read", { path: "x".repeat(200) }).length).toBe(120);
  });
});

describe("summarizeToolAction (aligné sur la spec LOT 2a)", () => {
  it("read → N lignes", () => {
    expect(summarizeToolAction({ toolName: "read", output: "l1\nl2\nl3" })).toBe("3 lignes");
  });

  it("write → N lignes écrites (depuis args.content)", () => {
    expect(summarizeToolAction({ toolName: "write", args: { content: "a\nb\nc" } })).toBe(
      "3 lignes écrites",
    );
  });

  it("edit → +A/−B via details.diff (en-têtes +++/--- ignorés)", () => {
    const diff = ["--- a/f", "+++ b/f", "contexte", "+ajout1", "+ajout2", "-supp"].join("\n");
    expect(summarizeToolAction({ toolName: "edit", details: { diff } })).toBe("+2/−1");
  });

  it("edit sans diff → fallback générique", () => {
    expect(summarizeToolAction({ toolName: "edit" })).toBe("fichier modifié");
  });

  it("bash → exit N + N lignes (code extrait de l'output SDK)", () => {
    const output = "out1\nout2\n\nCommand exited with code 3";
    expect(summarizeToolAction({ toolName: "bash", output })).toBe("exit 3 · 3 lignes");
    expect(summarizeToolAction({ toolName: "bash", output: "ok\nok2" })).toBe("2 lignes");
  });

  it("grep/find/ls → N résultats/fichiers/entrées", () => {
    expect(summarizeToolAction({ toolName: "grep", output: "a\nb" })).toBe("2 résultats");
    expect(summarizeToolAction({ toolName: "find", output: "a\nb\nc" })).toBe("3 fichiers");
    expect(summarizeToolAction({ toolName: "ls", output: "a" })).toBe("1 entrées");
  });

  it("erreur → 1re ligne de l'output, bornée à 120 chars", () => {
    const long = "x".repeat(300);
    const summary = summarizeToolAction({ toolName: "read", output: `${long}\nligne2`, isError: true });
    expect(summary.startsWith("erreur — ")).toBe(true);
    expect(summary.length).toBe(120);
  });

  it("outil inconnu → 1re ligne (ou nom du tool si sortie vide)", () => {
    expect(summarizeToolAction({ toolName: "cbm_search", output: "résultat utile" })).toBe(
      "résultat utile",
    );
    expect(summarizeToolAction({ toolName: "cbm_search" })).toBe("cbm_search");
  });
});