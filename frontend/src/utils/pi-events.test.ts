// ── Tests unitaires : applyPiEvent (cycle complet du streaming) ─────
// Vérifie le comportement du processor pur extrait de ChatView : création
// du message _streaming, concaténation des deltas, timing de la réflexion,
// tool calls, finalisation, timeout et dédup par id.
import { describe, it, expect, vi } from "vitest";
import { applyPiEvent, appendMessageDedup, findPendingUserMessages, prependHistoryBatch } from "./pi-events";
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
