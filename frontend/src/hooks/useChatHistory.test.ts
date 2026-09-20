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

// ── Tests : timeline chronologique (LOT 3) ──────────────────────────────────
// Les résultats d'outils orphelins, exécutions bash et compactions doivent
// être rendus À LEUR DATE comme blocs autonomes (kind), sans perdre de données
// (output bash complet, exitCode, tokensBefore des compactions).
describe("convertHistoryToDisplayMessages — timeline LOT 3", () => {
  beforeEach(() => {
    resetSubagentRuns();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("rend une exécution bash à sa date (commande, sortie, exitCode, cancelled)", () => {
    const history = [
      { id: "b1", role: "bashExecution", command: "ls -la", output: "a\nb", exitCode: 0, timestamp: 10 },
      { id: "b2", role: "bashExecution", command: "sleep 99", output: "", cancelled: true, timestamp: 11 },
    ];
    const display = convertHistoryToDisplayMessages(history as any);
    expect(display).toHaveLength(2);
    expect(display[0]).toMatchObject({
      kind: "bashExecution",
      bashExecution: { command: "ls -la", output: "a\nb", exitCode: 0 },
    });
    expect(display[1].bashExecution).toMatchObject({ command: "sleep 99", cancelled: true });
    // Plus de bulle utilisateur pour bash (l'ancien rendu était role "user").
    expect(display.every((m) => m.role === "assistant")).toBe(true);
  });

  it("rend une compaction à sa date avec tokensBefore et le résumé", () => {
    const history = [
      { id: "e2", role: "compactionSummary", summary: "résumé de la conversation", tokensBefore: 900, timestamp: 20 },
    ];
    const display = convertHistoryToDisplayMessages(history as any);
    expect(display).toHaveLength(1);
    expect(display[0]).toMatchObject({
      kind: "compaction",
      compaction: { summary: "résumé de la conversation", tokensBefore: 900 },
    });
    // Résumé plus fourré dans thinking ; contenu plus « *Conversation compacted* ».
    expect(display[0].thinking).toBe("");
    expect(display[0].content).toBe("");
  });

  it("fold un résultat rattaché à un toolCall, mais rend un résultat ORPHELIN à sa date", () => {
    const history = [
      { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }], timestamp: 1 },
      { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "contenu" }], timestamp: 2 },
      // Orphelin : aucun toolCall "tc9" n'est déclaré.
      { id: "tr9", role: "toolResult", toolCallId: "tc9", toolName: "bash", content: [{ type: "text", text: "boom" }], details: { isError: true }, timestamp: 3 },
    ];
    const display = convertHistoryToDisplayMessages(history as any);
    // a1 (avec tc1 foldé) + tr9 orphan autonome.
    expect(display).toHaveLength(2);
    expect(display[0].toolCalls?.[0]).toMatchObject({ id: "tc1", output: "contenu" });
    expect(display[1]).toMatchObject({ kind: "toolResult", toolResult: { id: "tc9", name: "bash", isError: true } });
  });

  it("conserve l'ordre chronologique inter-types", () => {
    const history = [
      { id: "u1", role: "user", content: "salut", timestamp: 1 },
      { id: "b1", role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, timestamp: 2 },
      { id: "e2", role: "compactionSummary", summary: "s", tokensBefore: 100, timestamp: 3 },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 4 },
    ];
    const display = convertHistoryToDisplayMessages(history as any);
    expect(display.map((m) => m.kind ?? m.role)).toEqual(["user", "bashExecution", "compaction", "assistant"]);
  });
});

// ── Tests : ordre chronologique DANS un message assistant (fil chronologique) ─
// Le content[] du SDK est ordonné (texte → outil → texte) : la conversion doit
// exposer ce même ordre via `blocks` (le rendu le suit), au lieu de regrouper
// par type (ce qui affichait un appel d'outil AVANT le texte qui l'introduisait).
describe("convertHistoryToDisplayMessages — ordre des blocs", () => {
  beforeEach(() => {
    resetSubagentRuns();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("préserve l'ordre texte → outil → texte dans blocks", () => {
    const history = [
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "Je délègue :" },
          { type: "toolCall", id: "tc1", name: "delegate", arguments: { function: "execute" } },
          { type: "text", text: "C'est fait." },
        ],
        timestamp: 1,
      },
      { role: "toolResult", toolCallId: "tc1", toolName: "delegate", content: [{ type: "text", text: "ok" }], timestamp: 2 },
    ];
    const display = convertHistoryToDisplayMessages(history as any);
    expect(display[0].blocks).toEqual([
      { kind: "text", text: "Je délègue :" },
      { kind: "toolCall", toolCallId: "tc1" },
      { kind: "text", text: "C'est fait." },
    ]);
    // Agrégats inchangés (rétro-compatibilité).
    expect(display[0].content).toBe("Je délègue :\nC'est fait.");
    expect(display[0].toolCalls?.[0]).toMatchObject({ id: "tc1", output: "ok" });
  });

  it("préserve aussi l'ordre réflexion → texte", () => {
    const history = [
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "je réfléchis" },
          { type: "text", text: "réponse" },
        ],
        timestamp: 1,
      },
    ];
    const display = convertHistoryToDisplayMessages(history as any);
    expect(display[0].blocks).toEqual([
      { kind: "thinking", text: "je réfléchis" },
      { kind: "text", text: "réponse" },
    ]);
  });
});
