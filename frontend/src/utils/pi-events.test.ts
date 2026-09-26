// ── Tests unitaires : applyPiEvent (cycle complet du streaming) ─────
// Vérifie le comportement du processor pur extrait de ChatView : création
// du message _streaming, concaténation des deltas, timing de la réflexion,
// tool calls, finalisation, timeout et dédup par id.
import { describe, it, expect, vi } from "vitest";
import { applyPiEvent, appendMessageDedup, findPendingUserMessages, getToolCallFallbackCount, prependHistoryBatch, normalizeUserContentForMatch, resetToolCallFallbackCount } from "./pi-events";
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

describe("applyPiEvent — ordre chronologique des blocs (fil chronologique)", () => {
  it("préserve l'ordre réel texte → outil → texte dans `blocks`", () => {
    const { msgs } = run([
      messageStart("asst-1"),
      textDelta("Parfait, je fais le nettoyage. "),
      toolcallStart("tc-1", "delegate", { function: "execute" }),
      toolcallEnd("tc-1", { name: "delegate", arguments: { function: "execute" } }),
      textDelta("Terminé."),
    ]);
    // Le bloc du sous-agent est APRÈS le texte qui l'a introduit (et avant le
    // texte suivant) : c'est exactement ce que regroupait à tort l'ancien rendu
    // par type (outils toujours au-dessus du texte).
    expect(msgs[0].blocks).toEqual([
      { kind: "text", text: "Parfait, je fais le nettoyage. " },
      { kind: "toolCall", toolCallId: "tc-1" },
      { kind: "text", text: "Terminé." },
    ]);
    // Les agrégats restent inchangés (rétro-compatibilité).
    expect(msgs[0].content).toBe("Parfait, je fais le nettoyage. Terminé.");
    expect(msgs[0].toolCalls).toHaveLength(1);
  });

  it("un toolcall_start ne duplique pas un bloc déjà présent pour le même id", () => {
    const { msgs } = run([
      messageStart("asst-1"),
      toolcallStart("tc-1", "delegate", {}),
      toolcallStart("tc-1", "delegate", {}),
    ]);
    expect(msgs[0].blocks?.filter((b) => b.kind === "toolCall")).toHaveLength(1);
  });
});

// ── Tests : rattachement de SECOURS d'un toolCall `delegate` (fix ordre chat) ──
// Quand le `toolcall_start` est manqué (coupure WS), le bloc de secours ne doit
// pas atterrir aveuglément sur le DERNIER message assistant (qui peut être la
// réponse finale) : il réintègre le message HÔTE de la délégation.
describe("applyPiEvent — rattachement de secours d'un delegate (fix ordre)", () => {
  function delegateHost(): DisplayMessage {
    return {
      id: "A", role: "assistant", content: "", thinking: "", timestamp: 1,
      toolCalls: [{ id: "tc-old", name: "delegate", args: { function: "execute" }, output: "", isError: false, isStreaming: false }],
      blocks: [{ kind: "toolCall", toolCallId: "tc-old" }],
    };
  }
  function finalAnswer(): DisplayMessage {
    return {
      id: "B", role: "assistant", content: "réponse finale", thinking: "", timestamp: 2,
      toolCalls: [], blocks: [{ kind: "text", text: "réponse finale" }],
    };
  }

  it("réintègre le message hôte du delegate, PAS la réponse finale", () => {
    resetToolCallFallbackCount();
    const { msgs } = run(
      [{ type: "tool_execution_start", toolCallId: "tc-new", toolName: "delegate", args: { function: "execute" } }],
      [delegateHost(), finalAnswer()],
    );
    // Le nouveau delegate est posé sur A (l'hôte de la délégation)…
    expect(msgs[0].toolCalls.map((tc) => tc.id)).toContain("tc-new");
    expect(msgs[0].blocks).toEqual([
      { kind: "toolCall", toolCallId: "tc-old" },
      { kind: "toolCall", toolCallId: "tc-new" },
    ]);
    // …et B (la réponse finale) reste intacte, sans bloc sous-agent après elle.
    expect(msgs[1].toolCalls).toHaveLength(0);
    expect(msgs[1].blocks).toEqual([{ kind: "text", text: "réponse finale" }]);
    expect(getToolCallFallbackCount()).toBe(1);
  });

  it("sans message hôte delegate, repli sur le dernier message assistant (comportement actuel)", () => {
    resetToolCallFallbackCount();
    const { msgs } = run(
      [{ type: "tool_execution_start", toolCallId: "tc-x", toolName: "read", args: { path: "/a" } }],
      [finalAnswer()],
    );
    expect(msgs[0].toolCalls.map((tc) => tc.id)).toContain("tc-x");
    expect(getToolCallFallbackCount()).toBe(1);
  });

  it("un delegate réintègre l'hôte même quand un message non-delegate suit", () => {
    resetToolCallFallbackCount();
    const middle: DisplayMessage = {
      id: "M", role: "assistant", content: "", thinking: "", timestamp: 3,
      toolCalls: [{ id: "tc-read", name: "read", args: {}, output: "ok", isError: false, isStreaming: false }],
      blocks: [{ kind: "toolCall", toolCallId: "tc-read" }],
    };
    const { msgs } = run(
      [{ type: "tool_execution_start", toolCallId: "tc-new2", toolName: "delegate", args: { function: "execute" } }],
      [delegateHost(), middle, finalAnswer()],
    );
    expect(msgs[0].toolCalls.map((tc) => tc.id)).toContain("tc-new2");
    expect(msgs[2].toolCalls).toHaveLength(0);
    expect(getToolCallFallbackCount()).toBe(1);
  });

  it("un delegate déjà résolu (output présent) n'est pas considéré hôte → repli dernier message", () => {
    resetToolCallFallbackCount();
    const resolved: DisplayMessage = {
      id: "R", role: "assistant", content: "", thinking: "", timestamp: 1,
      toolCalls: [{ id: "tc-done", name: "delegate", args: { function: "execute" }, output: "terminé", isError: false, isStreaming: false }],
      blocks: [{ kind: "toolCall", toolCallId: "tc-done" }],
    };
    const { msgs } = run(
      [{ type: "tool_execution_start", toolCallId: "tc-new3", toolName: "delegate", args: { function: "review" } }],
      [resolved, finalAnswer()],
    );
    // L'hôte « résolu » n'est pas retenu → repli sur le dernier message (B).
    expect(msgs[1].toolCalls.map((tc) => tc.id)).toContain("tc-new3");
    expect(getToolCallFallbackCount()).toBe(1);
  });
});

describe("applyPiEvent — tool_execution après message_end (correctif silence sous-agent)", () => {
  // Le SDK clôture le message assistant (message_end) AVANT d'exécuter ses
  // outils : `assistantId` devient null quand tool_execution_start arrive.
  // L'ancien updateLast (gardé par `id === assistantId`) jetait alors TOUS les
  // events d'exécution → sortie live, flag isStreaming et durées perdus (seul
  // la relecture pi_history les faisait apparaître).
  it("applique tool_execution_start/update au message porteur, même après message_end", () => {
    const { msgs, asstId } = run([
      messageStart("asst-1"),
      toolcallStart("tc-1", "delegate", { function: "execute" }),
      toolcallEnd("tc-1", { name: "delegate", arguments: { function: "execute" } }),
      messageEnd("asst-1"),
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "delegate", args: { function: "execute" } },
      toolExecUpdate("tc-1", "sous-agent Exécution lancé..."),
    ]);
    expect(asstId).toBeNull();
    const tc = msgs[0].toolCalls[0];
    expect(tc.output).toBe("sous-agent Exécution lancé...");
    expect(tc.isStreaming).toBe(true);
  });

  it("finalise l'outil après message_end (output + isError + endedAt)", () => {
    const { msgs } = run([
      messageStart("asst-1"),
      toolcallStart("tc-1", "bash", { command: "false" }),
      messageEnd("asst-1"),
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "false" } },
      toolExecEnd("tc-1", "boom", true),
    ]);
    const tc = msgs[0].toolCalls[0];
    expect(tc.output).toBe("boom");
    expect(tc.isError).toBe(true);
    expect(tc.isStreaming).toBe(false);
    expect(tc.endedAt).toBeDefined();
  });

  it("message_end reconstruit contenu et ordre depuis content[] si aucun delta (provider non streamé)", () => {
    const { msgs } = run([
      messageStart("asst-1"),
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: "asst-1",
          content: [
            { type: "text", text: "avant" },
            { type: "toolCall", id: "tc-9", name: "delegate", arguments: { function: "execute" } },
            { type: "text", text: "après" },
          ],
        },
      },
    ]);
    expect(msgs[0].content).toBe("avant\naprès");
    expect(msgs[0].toolCalls[0]).toMatchObject({ id: "tc-9", name: "delegate" });
    expect(msgs[0].blocks).toEqual([
      { kind: "text", text: "avant" },
      { kind: "toolCall", toolCallId: "tc-9" },
      { kind: "text", text: "après" },
    ]);
    expect(msgs[0]._streaming).toBe(false);
  });
});

// ── Tests : filet de sécurité « réflexion seule ⇒ réponse » ────────────────
// Un provider peut renvoyer tout le texte dans `reasoning` (content vide) : le
// tour doit être PROMU en réponse, sans duplication, et jamais quand il porte un
// outil ou une erreur.
describe("applyPiEvent — filet de sécurité: réflexion seule promue en réponse", () => {
  function endWith(content: any[], stopReason?: string): PiEvent {
    return { type: "message_end", message: { role: "assistant", id: "asst-1", content, stopReason } };
  }

  it("thinking seul (content vide) → promu en réponse, réflexion vidée", () => {
    const { msgs } = run([messageStart("asst-1"), endWith([{ type: "thinking", thinking: "abc", thinkingSignature: "reasoning" }], "stop")]);
    expect(msgs[0].content).toBe("abc");
    expect(msgs[0].thinking).toBe("");
    expect(msgs[0].blocks).toEqual([{ kind: "text", text: "abc" }]);
    // Pas de duplication : le texte n'existe pas à la fois en réflexion et réponse.
    expect(msgs[0].toolCalls).toHaveLength(0);
  });

  it("non-régression: [thinking, text] inchangé", () => {
    const { msgs } = run([messageStart("asst-1"), endWith([
      { type: "thinking", thinking: "r" },
      { type: "text", text: "t" },
    ], "stop")]);
    expect(msgs[0].content).toBe("t");
    expect(msgs[0].thinking).toBe("r");
    expect(msgs[0].blocks).toEqual([
      { kind: "thinking", text: "r" },
      { kind: "text", text: "t" },
    ]);
  });

  it("non-régression: [thinking, toolCall] → AUCUNE promotion", () => {
    const { msgs } = run([messageStart("asst-1"), endWith([
      { type: "thinking", thinking: "abc" },
      { type: "toolCall", id: "tc-1", name: "read" },
    ], "toolUse")]);
    expect(msgs[0].content).toBe("");
    expect(msgs[0].thinking).toBe("abc");
    expect(msgs[0].toolCalls).toHaveLength(1);
  });

  it("non-régression: stopReason error + thinking seul → PAS de promotion", () => {
    const { msgs } = run([messageStart("asst-1"), endWith([{ type: "thinking", thinking: "abc" }], "error")]);
    expect(msgs[0].content).toBe("");
    expect(msgs[0].thinking).toBe("abc");
    expect(msgs[0].stopReason).toBe("error");
  });

  it("réflexion vide → PAS de promotion", () => {
    const { msgs } = run([messageStart("asst-1"), endWith([{ type: "thinking", thinking: "   " }], "stop")]);
    expect(msgs[0].content).toBe("");
  });
});

// ── Tests unitaires : findPendingUserMessages (filet de secours 6210d1c) ──
// Un pi_history construit AVANT le commit du message de l'utilisateur ne doit
// pas faire disparaître le message tout juste tapé de l'affichage.
// Correctif « question disparue » (incident Yuki) : la préservation ne dépend
// plus de l'âge (la fenêtre de 15 s expirait pendant les gros rattrapages)
// mais de la PRÉSENCE du contenu dans l'historique reçu — avec une borne
// « hors fenêtre serveur » quand l'historique est une tranche (windowFrom>0).
describe("findPendingUserMessages — messages user en vol", () => {
  const NOW = 1_000_000;

  function userMsg(id: string, content: string, timestamp: number): DisplayMessage {
    return { id, role: "user", content, thinking: "", toolCalls: [], timestamp };
  }

  it("ré-attache le message user optimiste récent absent de l'historique", () => {
    const pending = userMsg("opti-1", "salut", NOW - 100);
    const missing = findPendingUserMessages([pending], [userMsg("h1", "vieux", NOW - 9000)], NOW);
    expect(missing).toHaveLength(1);
    expect(missing[0].id).toBe("opti-1");
  });

  it("ne ré-attache PAS si le backend a déjà commité le même contenu (pas de doublon)", () => {
    const pending = userMsg("opti-1", "ma question", NOW - 100);
    // L'historique contient déjà le message commité (id backend ≠ id optimiste,
    // contenu identique) EN DERNIER user : c'est le flux normal, pas de perte.
    const history = [userMsg("h0", "vieux", NOW - 9000), userMsg("h2", "ma question", NOW - 50)];
    expect(findPendingUserMessages([pending], history, NOW)).toHaveLength(0);
  });

  it("préserve un message user ANCIEN absent d'un historique COMPLET (plus de fenêtre d'âge — incident Yuki)", () => {
    // Le rattrapage (1,96 Mo) peut prendre > 15 s à arriver : l'ancienne
    // fenêtre d'âge faisait disparaître la question. Absent de l'historique
    // complet = non confirmé → préservé quel que soit l'âge.
    const old = userMsg("opti-old", "ma question", NOW - 16_000);
    const missing = findPendingUserMessages([old], [userMsg("h1", "vieux", NOW - 60_000)], NOW);
    expect(missing).toHaveLength(1);
    expect(missing[0].id).toBe("opti-old");
  });

  it("préserve aussi un message ancien quand l'historique reçu est VIDE", () => {
    const old = userMsg("opti-old", "ancien", NOW - 16_000);
    expect(findPendingUserMessages([old], [], NOW)).toHaveLength(1);
  });

  it("ne préserve PAS un message antérieur à la fenêtre serveur (pi_history tronqué, windowFrom > 0)", () => {
    // Message issu d'un lot antérieur déjà chargé (pi_history_page) : la
    // resync fenêtrée ne le contient pas et c'est NORMAL (il vit dans les
    // lots serveur) → le ré-attacher dupliquerait les vieux lots à chaque
    // resync. Marge de skew PENDING_WINDOW_SKEW_MS dépassée.
    const old = userMsg("page-old", "vieux lot", NOW - 600_000);
    const history = [userMsg("h1", "récent", NOW - 5_000), userMsg("h2", "récent2", NOW - 1_000)];
    const missing = findPendingUserMessages([old], history, NOW, undefined, { windowFrom: 40 });
    expect(missing).toHaveLength(0);
  });

  it("préserve un candidat RÉCENT absent d'un historique FENÊTRÉ (plus récent que la fenêtre)", () => {
    // Le scénario incident : rattrapage fenêtré construit AVANT le commit de
    // la question — la question est plus récente que tout ce que la fenêtre
    // contient, donc non confirmable → préservée.
    const pending = userMsg("opti-1", "ma question", NOW - 20_000); // > 15 s
    const history = [userMsg("h1", "vieux", NOW - 900_000), userMsg("h2", "récent", NOW - 100)];
    const missing = findPendingUserMessages([pending], history, NOW, undefined, { windowFrom: 40 });
    expect(missing).toHaveLength(1);
  });

  it("ne ressuscite PAS un message ANCIEN dont le contenu existe déjà dans l'historique (doublon ancien)", () => {
    // Un vieux message user déjà commité (présent dans l'historique reçu, pas
    // en dernier) ne doit pas être ré-attaché en queue à chaque resync.
    const old = userMsg("old-1", "ma question", NOW - 600_000);
    const history = [
      userMsg("h1", "ma question", NOW - 500_000),
      userMsg("h2", "réponse", NOW - 400_000),
      userMsg("h3", "autre", NOW - 100),
    ];
    expect(findPendingUserMessages([old], history, NOW)).toHaveLength(0);
  });

  it("ignore les messages _streaming et les assistants", () => {
    const streaming = { ...userMsg("s1", "x", NOW - 100), _streaming: true };
    const assistant: DisplayMessage = { id: "a1", role: "assistant", content: "y", thinking: "", toolCalls: [], timestamp: NOW - 100 };
    expect(findPendingUserMessages([streaming, assistant], [], NOW)).toHaveLength(0);
  });

  it("un doublon plus ancien à contenu identique ne masque pas le message récent", () => {
    // Le message « ma question » existe aussi plus loin dans l'historique, mais
    // PAS en dernier user (un message commité serait chronologiquement le
    // dernier) → le récent est conservé (sinon il disparaîtrait de l'affichage).
    const pending = userMsg("opti-1", "ma question", NOW - 100);
    const history = [
      userMsg("h1", "ma question", NOW - 8000), // doublon ancien
      userMsg("h2", "réponse", NOW - 7000),
      userMsg("h3", "autre", NOW - 6000),
    ];
    const missing = findPendingUserMessages([pending], history, NOW);
    expect(missing).toHaveLength(1);
  });

  it("un message user sans contenu identifiable (image seule) est conservé", () => {
    const imgOnly = userMsg("opti-img", "", NOW - 100);
    expect(findPendingUserMessages([imgOnly], [userMsg("h1", "vieux", NOW - 9000)], NOW)).toHaveLength(1);
  });

  it("aucun candidat → tableau vide (l'appelant ne modifie rien)", () => {
    expect(findPendingUserMessages([], [], NOW)).toHaveLength(0);
  });
});

// ── Tests unitaires : messages user à PIÈCE JOINTE (bug « message en bas de fil ») ──
// Séquences extraites de la session persistée réelle
// dd5e824c-bc11-41fa-9b81-c2914774a954 : l'entrée 47e095b2 (user, text+image,
// index 1414) est suivie de 11 entrées assistant/toolResult. Le backend committe
// le contenu AVEC le bloc de refs d'attachement en tête (« 🖼️ **image.png**
// (id: …, 7.7 KB)\n\n<texte> ») alors que le message OPTIMISTE affiché ne porte
// que le texte saisi : la comparaison de contenu brute échouait → le message
// déjà commité était ré-appendé EN FIN de fil au rechargement.
describe("findPendingUserMessages — messages à pièce jointe (fix chronologie)", () => {
  const NOW = 2_000_000;
  const IMG_ID = "a8a4a584-8004-46f7-b48b-f84f5e96adf6";
  // Contenu COMMITÉ réel (entrée 47e095b2) : refs préfixées + texte saisi.
  const COMMITTED_TEXT =
    `🖼️ **image.png** (id: ${IMG_ID}, 7.7 KB)\n\n` +
    "concernant INFRA-02, j'ai l'impression que le mode harness n'a pas été correctement restauré apres le redémarrage.";
  // Contenu OPTIMISTE affiché : le texte saisi, SANS le bloc de refs.
  const TYPED_TEXT =
    "concernant INFRA-02, j'ai l'impression que le mode harness n'a pas été correctement restauré apres le redémarrage.";

  function assistantMsg(id: string, content: string, timestamp: number): DisplayMessage {
    return { id, role: "assistant", content, thinking: "", toolCalls: [], timestamp };
  }
  function plainUser(id: string, content: string, timestamp: number): DisplayMessage {
    return { id, role: "user", content, thinking: "", toolCalls: [], timestamp };
  }
  function attachmentUser(id: string, content: string, timestamp: number): DisplayMessage {
    return {
      id, role: "user", content, thinking: "", toolCalls: [], timestamp,
      images: [{ attachmentId: IMG_ID, name: "image.png", mimeType: "image/png" }],
      attachmentRefs: [{ id: IMG_ID, name: "image.png", category: "image", size: 7885 }],
    };
  }

  it("(a) un message user avec pièce jointe suivi de 2 réponses reste à sa place (pas de ré-append en fin de fil)", () => {
    const committed = plainUser("h-attach", COMMITTED_TEXT, NOW - 90);
    const display = [
      committed,
      assistantMsg("a1", "réponse 1", NOW - 80),
      assistantMsg("a2", "réponse 2", NOW - 70),
    ];
    const optimistic = attachmentUser("opti", TYPED_TEXT, NOW - 100);
    const pending = findPendingUserMessages([optimistic], display, NOW);
    expect(pending).toHaveLength(0);
    const merged = pending.length > 0 ? [...display, ...pending] : display;
    expect(merged.map(m => m.id)).toEqual(["h-attach", "a1", "a2"]);
  });

  it("(a-bis) pièce jointe SANS texte (contenu optimiste « 📎 nom ») n'est pas ré-appendée", () => {
    const committed = plainUser("h", `🖼️ **image.png** (id: ${IMG_ID}, 7.7 KB)`, NOW - 90);
    const optimistic = attachmentUser("opti", "📎 image.png", NOW - 100);
    expect(findPendingUserMessages([optimistic], [committed], NOW)).toHaveLength(0);
  });

  it("(b) un message user simple suivi d'outils/compaction reste à sa place", () => {
    const display: DisplayMessage[] = [
      plainUser("h-user", "ma question", NOW - 90),
      assistantMsg("a1", "", NOW - 80),
      { id: "c1", role: "assistant", content: "", thinking: "", toolCalls: [], timestamp: NOW - 70, kind: "compaction", compaction: { summary: "résumé", tokensBefore: 1000 } },
    ];
    const pending = findPendingUserMessages([plainUser("opti", "ma question", NOW - 100)], display, NOW);
    expect(pending).toHaveLength(0);
  });

  it("(c) cohérence live vs rechargement : l'ordre reconstruit = l'ordre réel (user avant sa réponse)", () => {
    // Live : message optimiste (pièce jointe) puis réponse assistant.
    const live = [attachmentUser("opti", TYPED_TEXT, NOW - 100), assistantMsg("a1", "ok", NOW - 90)];
    // Rechargement : version COMMITÉE (refs préfixées) + même réponse.
    const display = [plainUser("h-attach", COMMITTED_TEXT, NOW - 99), assistantMsg("a1", "ok", NOW - 90)];
    const pending = findPendingUserMessages(live, display, NOW);
    expect(pending).toHaveLength(0);
    const merged = pending.length > 0 ? [...display, ...pending] : display;
    expect(merged.map(m => m.id)).toEqual(["h-attach", "a1"]);
  });

  it("normalise le préfixe de refs d'attachement (helper pur)", () => {
    expect(normalizeUserContentForMatch(COMMITTED_TEXT)).toBe(TYPED_TEXT);
    expect(normalizeUserContentForMatch(TYPED_TEXT)).toBe(TYPED_TEXT);
    expect(
      normalizeUserContentForMatch(
        `🖼️ **a.png** (id: ${IMG_ID}, 1 KB)\n📄 **b.pdf** (id: ffff-2222, 2 KB)\n\ntexte utile`,
      ),
    ).toBe("texte utile");
  });
});

// ── Tests unitaires : prependHistoryBatch (chargement par lots) ──────
// Les lots antérieurs (pi_history_page) sont préfixés à la liste locale,
// avec dédup par id (le lot et la liste partagent l'espace d'ids backend).
describe("prependHistoryBatch — préfixage d'un lot antérieur", () => {
  function msg(id: string, content: string): DisplayMessage {
    return { id, role: "user", content, thinking: "", toolCalls: [], timestamp: 0 };
  }

  it("préfixe le lot avant les messages existants (ordre chronologique)", () => {
    const result = prependHistoryBatch(
      [msg("e5", "récent"), msg("e6", "plus récent")],
      [msg("e2", "ancien"), msg("e3", "moins ancien")],
    );
    expect(result.map((m) => m.id)).toEqual(["e2", "e3", "e5", "e6"]);
  });

  it("dédup : les ids déjà présents localement sont écartés (rejeu/race)", () => {
    const result = prependHistoryBatch(
      [msg("e5", "récent")],
      [msg("e2", "ancien"), msg("e3", "déjà connu"), msg("e5", "doublon du récent")],
    );
    expect(result.map((m) => m.id)).toEqual(["e2", "e3", "e5"]);
  });

  it("lot entièrement connu → liste inchangée (même référence)", () => {
    const prev = [msg("e5", "récent")];
    expect(prependHistoryBatch(prev, [msg("e5", "doublon")])).toBe(prev);
    expect(prependHistoryBatch(prev, [])).toBe(prev);
  });

  it("doublons DANS le lot écartés ; messages sans id conservés", () => {
    const noId = { role: "user", content: "sans id", thinking: "", toolCalls: [] } as unknown as DisplayMessage;
    const result = prependHistoryBatch(
      [msg("e5", "existant")],
      [msg("e1", "a"), msg("e1", "dup intra-lot"), noId],
    );
    // e1-dup écarté (doublon intra-lot), noId conservé, préfixé avant e5.
    expect(result.map((m) => m.id ?? m.content)).toEqual(["e1", "sans id", "e5"]);
  });

  it("pagination successive : aucun trou ni doublon sur 3 lots", () => {
    let list: DisplayMessage[] = [msg("e9", "9"), msg("e10", "10")];
    list = prependHistoryBatch(list, [msg("e6", "6"), msg("e7", "7"), msg("e8", "8")]);
    list = prependHistoryBatch(list, [msg("e3", "3"), msg("e4", "4"), msg("e5", "5")]);
    list = prependHistoryBatch(list, [msg("e1", "1"), msg("e2", "2")]);
    expect(list.map((m) => m.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"]);
  });
});
