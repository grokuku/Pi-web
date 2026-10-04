// ── Tests : classification des erreurs provider + regroupement des tentatives ─
// Cas de référence : incident 500 Ollama Cloud (4 tentatives automatiques du
// SDK pour un même tour = 4 messages assistant vides avec stopReason "error").
import { describe, expect, it } from "vitest";
import type { DisplayMessage } from "../types";
import {
  LLM_ERROR_DETAIL_MAX,
  buildProviderErrorRun,
  classifyLlmError,
  groupProviderFailures,
  isEmptyFailedAttempt,
  isFailedAssistantMessage,
  llmErrorDisplay,
  llmErrorMessageKey,
  llmErrorTitleKey,
  prettyProviderName,
} from "./llm-errors";

function failedAttempt(id: string, errorMessage: string, over: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "",
    thinking: "",
    toolCalls: [],
    timestamp: 1000 + Number(id.replace(/\D/g, "") || 0),
    stopReason: "error",
    errorMessage,
    ...over,
  };
}

function success(id: string, content = "Bonjour !"): DisplayMessage {
  return {
    id,
    role: "assistant",
    content,
    thinking: "",
    toolCalls: [],
    timestamp: 2000,
    stopReason: "stop",
    blocks: [{ kind: "text", text: content }],
  };
}

function user(id: string, content = "salut"): DisplayMessage {
  return { id, role: "user", content, thinking: "", toolCalls: [], timestamp: 1 };
}

describe("classifyLlmError", () => {
  it("500 JSON (incident) → server + statut + ref + détail lisible", () => {
    const info = classifyLlmError(
      '500: {"message":"Internal Server Error (ref: 97780de6-d6ab-4582-91e8-e7a8a9543966)","type":"api_error","param":null,"code":null}',
    );
    expect(info.kind).toBe("server");
    expect(info.httpStatus).toBe(500);
    expect(info.ref).toBe("97780de6-d6ab-4582-91e8-e7a8a9543966");
    expect(info.detail).toContain("Internal Server Error");
  });

  it("503 overloaded / 429 / timeout / auth / quota / bad_request / network / aborted", () => {
    expect(classifyLlmError('503 "Server overloaded, please retry shortly (ref: c67c5a79-86e9-4e1b-bd77-bf02663b7df6)"').kind).toBe("overloaded");
    expect(classifyLlmError('429: {"message":"Rate limit exceeded"}').kind).toBe("rate_limit");
    expect(classifyLlmError("429 Provider returned error\n...").kind).toBe("rate_limit");
    expect(classifyLlmError("524 status code (no body)").kind).toBe("timeout");
    expect(classifyLlmError("Request timed out.").kind).toBe("timeout");
    expect(classifyLlmError('403 "this model requires a subscription"').kind).toBe("auth");
    expect(classifyLlmError('402: {"error":"insufficient credits"}').kind).toBe("quota");
    expect(classifyLlmError("400 Failed to deserialize the JSON body").kind).toBe("bad_request");
    expect(classifyLlmError("Connection error.").kind).toBe("network");
    expect(classifyLlmError("Request was aborted").kind).toBe("aborted");
  });

  it("vide / inconnu → unknown sans détail", () => {
    expect(classifyLlmError(undefined)).toEqual({ kind: "unknown", detail: "" });
    expect(classifyLlmError("Provider returned error").kind).toBe("unknown");
  });

  it("masque les secrets et borne le détail", () => {
    const info = classifyLlmError(`500: {"error":"Authorization: Bearer sk-abc123DEF456ghi"}`);
    expect(info.detail).not.toContain("abc123DEF456ghi");
    const long = classifyLlmError(`500 ${"x".repeat(5000)}`);
    expect(long.detail.length).toBeLessThanOrEqual(LLM_ERROR_DETAIL_MAX);
  });

  it("mappe les clés i18n par type", () => {
    expect(llmErrorMessageKey("server")).toBe("chat.providerErrorMessageServer");
    expect(llmErrorMessageKey("rate_limit")).toBe("chat.providerErrorMessageRateLimit");
    expect(llmErrorMessageKey("aborted")).toBe("chat.providerErrorMessageAborted");
    expect(llmErrorTitleKey("aborted")).toBe("chat.providerErrorTitleAborted");
    expect(llmErrorTitleKey("unknown")).toBe("chat.providerErrorTitleUnknown");
    expect(llmErrorTitleKey("server")).toBe("chat.providerErrorTitle");
  });

  it("llmErrorDisplay prépare titre + message + args (modèle, provider lisible, ref)", () => {
    const d = llmErrorDisplay({
      errorMessage: '500: {"message":"Internal Server Error (ref: 97780de6-d6ab-4582-91e8-e7a8a9543966)"}',
      provider: "ollama-cloud",
      model: "deepseek-v4.1-flash",
    });
    expect(d.titleKey).toBe("chat.providerErrorTitle");
    expect(d.messageKey).toBe("chat.providerErrorMessageServer");
    expect(d.args[0]).toBe("deepseek-v4.1-flash");
    expect(d.args[1]).toBe("Ollama Cloud");
    expect(d.args[2]).toBe("97780de6-d6ab-4582-91e8-e7a8a9543966");
  });

  it("prettyProviderName : ids → libellés lisibles, vide si inconnu", () => {
    expect(prettyProviderName("ollama-cloud")).toBe("Ollama Cloud");
    expect(prettyProviderName("openrouter")).toBe("Openrouter");
    expect(prettyProviderName("")).toBe("");
    expect(prettyProviderName(undefined)).toBe("");
  });
});

describe("groupProviderFailures", () => {
  const ERR1 = '500: {"message":"Internal Server Error (ref: aaaa)"}';
  const ERR2 = '500: {"message":"Internal Server Error (ref: bbbb)"}';

  it("N tentatives ratées vides consécutives → UN SEUL bloc regroupé", () => {
    const items = groupProviderFailures([
      user("u1"),
      failedAttempt("a1", ERR1),
      failedAttempt("a2", ERR1),
      failedAttempt("a3", ERR1),
      failedAttempt("a4", ERR2),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "failures"]);
    const run = items[1];
    if (run.kind !== "failures") throw new Error("attendu un bloc de tentatives");
    expect(run.run.attempts).toHaveLength(4);
    // L'ancre est la PREMIÈRE tentative (blockId stable).
    expect(run.run.anchorId).toBe("a1");
    // La dernière erreur est celle mise en avant (dernier élément).
    expect(run.run.attempts[3].errorMessage).toBe(ERR2);
    expect(run.run.attempts[0].timestamp).toBe(1001);
    expect(run.run.attempts[3].timestamp).toBe(1004);
  });

  it("reprise RÉUSSIE : les tentatives ratées sont rattachées AU MESSAGE RÉUSSI (note repliable)", () => {
    const items = groupProviderFailures([
      user("u1"),
      failedAttempt("a1", ERR1),
      failedAttempt("a2", ERR2),
      success("a3", "Voici la réponse."),
    ]);
    expect(items).toHaveLength(2);
    const msg = items[1];
    if (msg.kind !== "message") throw new Error("attendu le message réussi");
    expect(msg.message.id).toBe("a3");
    expect(msg.failedAttemptsBefore?.attempts.map((a) => a.id)).toEqual(["a1", "a2"]);
    // AUCUN item "failures" : le tour n'est pas présenté comme un échec.
    expect(items.some((i) => i.kind === "failures")).toBe(false);
  });

  it("échec AVEC contenu : le message reste rendu (jamais masqué), sans regroupement", () => {
    const partial = failedAttempt("a1", ERR1, { content: "Début de réponse…" });
    const items = groupProviderFailures([user("u1"), partial]);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "message", message: { id: "a1" } });
    expect(items[1].kind === "message" && items[1].failedAttemptsBefore).toBeFalsy();
  });

  it("run sans suite réussie reste un bloc autonome, même en fin de liste", () => {
    const items = groupProviderFailures([failedAttempt("a1", ERR1)]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("failures");
  });

  it("run suivi d'un message NON-assistant → bloc autonome (pas de rattachement)", () => {
    const items = groupProviderFailures([failedAttempt("a1", ERR1), user("u2")]);
    expect(items.map((i) => i.kind)).toEqual(["failures", "message"]);
  });

  it("messages normaux sans erreur → inchangés, dans l'ordre", () => {
    const items = groupProviderFailures([user("u1"), success("a1"), success("a2")]);
    expect(items.map((i) => (i.kind === "message" ? i.message.id : i.kind))).toEqual(["u1", "a1", "a2"]);
  });

  it("préserve l'ordre : run, message réussi, run (sans rattachement croisé)", () => {
    const items = groupProviderFailures([
      failedAttempt("a1", ERR1),
      success("a2"),
      failedAttempt("a3", ERR2),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "failures"]);
    expect(items[0].kind === "message" && items[0].message.id).toBe("a2");
    expect(items[1].kind === "failures" && items[1].run.anchorId).toBe("a3");
  });
});

describe("isFailedAssistantMessage / isEmptyFailedAttempt", () => {
  it("distingue échec vide, échec avec contenu, message normal", () => {
    expect(isFailedAssistantMessage(failedAttempt("a1", "boom"))).toBe(true);
    expect(isFailedAssistantMessage(success("a2"))).toBe(false);
    expect(isEmptyFailedAttempt(failedAttempt("a1", "boom"))).toBe(true);
    expect(isEmptyFailedAttempt(failedAttempt("a1", "boom", { content: "x" }))).toBe(false);
    expect(isEmptyFailedAttempt(failedAttempt("a1", "boom", { thinking: "réflexion" }))).toBe(false);
    expect(isEmptyFailedAttempt(failedAttempt("a1", "boom", {
      toolCalls: [{ id: "t", name: "read", args: {}, output: "", isError: false, isStreaming: false }],
    }))).toBe(false);
    expect(isEmptyFailedAttempt(success("a2"))).toBe(false);
  });

  it("buildProviderErrorRun exige au moins une tentative et fige l'ancre", () => {
    expect(() => buildProviderErrorRun([])).toThrow();
    const run = buildProviderErrorRun([failedAttempt("a1", "e1"), failedAttempt("a2", "e2")]);
    expect(run.anchorId).toBe("a1");
    expect(run.attempts).toHaveLength(2);
  });
});
