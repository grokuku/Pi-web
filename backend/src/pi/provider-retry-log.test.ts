/**
 * Tests de l'observabilité « échecs provider + reprises automatiques » (C3).
 *
 * Les formats d'errorMessage sont ceux RÉELLEMENT observés dans les transcripts
 * de session (`500: {"message":"Internal Server Error (ref: <uuid>)"}`,
 * `503 "Server overloaded…"`, `429 …`, `Request was aborted`, …).
 */
import { describe, expect, it } from "vitest";
import {
  PROVIDER_ERROR_SUMMARY_MAX,
  buildProviderFailureLog,
  buildRetryLog,
  detectProviderFailureEvent,
  detectRetryEvent,
  oneLineSummary,
  parseProviderError,
  redactSecrets,
} from "./provider-retry-log.js";

describe("parseProviderError — statut + ref + classification", () => {
  it("500 JSON (incident Ollama Cloud) → server + http 500 + ref", () => {
    const info = parseProviderError(
      '500: {"message":"Internal Server Error (ref: 97780de6-d6ab-4582-91e8-e7a8a9543966)","type":"api_error","param":null,"code":null}',
    );
    expect(info.kind).toBe("server");
    expect(info.httpStatus).toBe(500);
    expect(info.ref).toBe("97780de6-d6ab-4582-91e8-e7a8a9543966");
    expect(info.summary).toContain("Internal Server Error");
  });

  it('503 "Server overloaded" → overloaded + ref', () => {
    const info = parseProviderError(
      '503 "Server overloaded, please retry shortly (ref: 2ac5ac63-d010-4a8f-b1bc-9b667936ffaf)"',
    );
    expect(info.kind).toBe("overloaded");
    expect(info.httpStatus).toBe(503);
    expect(info.ref).toBe("2ac5ac63-d010-4a8f-b1bc-9b667936ffaf");
  });

  it("503 sans « overloaded » → server (pas overloaded)", () => {
    expect(parseProviderError('503 "Service Unavailable"').kind).toBe("server");
  });

  it("429 avec JSON → rate_limit", () => {
    const info = parseProviderError(
      '429: {"message":"Rate limit exceeded: free-models-per-day-stealth. ","code":429}',
    );
    expect(info.kind).toBe("rate_limit");
    expect(info.httpStatus).toBe(429);
  });

  it("429 sans deux-points (Ollama Cloud) → rate_limit", () => {
    expect(parseProviderError("429 Limite de requêtes atteinte chez le fournisseur upstream. (id=136343789f)").kind)
      .toBe("rate_limit");
  });

  it("402 → quota ; 401/403 → auth ; 400 → bad_request", () => {
    expect(parseProviderError('402: {"error":"insufficient credits"}').kind).toBe("quota");
    expect(parseProviderError('401 Unauthorized').kind).toBe("auth");
    expect(parseProviderError('403 "this model requires a subscription"').kind).toBe("auth");
    expect(
      parseProviderError(
        "400 Failed to deserialize the JSON body into the target type: messages[0].role: unknown variant `developer`",
      ).kind,
    ).toBe("bad_request");
  });

  it("524 / timeout transport → timeout", () => {
    expect(parseProviderError("524 status code (no body)").kind).toBe("timeout");
    expect(parseProviderError("Request timed out.").kind).toBe("timeout");
    expect(parseProviderError("Upstream idle timeout exceeded").kind).toBe("timeout");
  });

  it("abort local → aborted (jamais classé provider)", () => {
    expect(parseProviderError("Request was aborted").kind).toBe("aborted");
    expect(parseProviderError("This operation was aborted").kind).toBe("aborted");
  });

  it("connexion coupée → network", () => {
    expect(parseProviderError("Connection error.").kind).toBe("network");
    expect(parseProviderError("terminated").kind).toBe("network");
  });

  it("texte vide ou inconnu → unknown, sans lever", () => {
    expect(parseProviderError(undefined)).toEqual({ kind: "unknown", summary: "(aucun message d'erreur)" });
    expect(parseProviderError(42 as unknown).kind).toBe("unknown");
    expect(parseProviderError("Provider returned error").kind).toBe("unknown");
  });
});

describe("parseProviderError — sécurité et bornage", () => {
  it("masque Bearer / sk-… / api_key: … (aucun secret dans les logs)", () => {
    expect(redactSecrets("Authorization: Bearer sk-abc123DEF456ghi")).not.toContain("abc123DEF456ghi");
    expect(redactSecrets('{"api_key":"super-secret-value"}')).not.toContain("super-secret-value");
    expect(redactSecrets("apikey = XYZ987654321")).not.toContain("XYZ987654321");
  });

  it("résumé sur une seule ligne et tronqué", () => {
    const info = parseProviderError(`500: {"message":"${"x".repeat(2000)}"}`);
    expect(info.summary).not.toContain("\n");
    expect(info.summary.length).toBeLessThanOrEqual(PROVIDER_ERROR_SUMMARY_MAX);
    expect(info.summary.endsWith("…")).toBe(true);
    expect(oneLineSummary("a\n\nb   c")).toBe("a b c");
  });
});

describe("detectProviderFailureEvent / buildProviderFailureLog", () => {
  function messageEnd(overrides: Record<string, unknown> = {}) {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "ollama-cloud",
        model: "deepseek-v4.1-flash",
        stopReason: "error",
        errorMessage: '500: {"message":"Internal Server Error (ref: 97780de6-d6ab-4582-91e8-e7a8a9543966)"}',
        ...overrides,
      },
    };
  }

  it("détecte un message_end assistant en échec et extrait provider/modèle", () => {
    const f = detectProviderFailureEvent(messageEnd());
    expect(f).not.toBeNull();
    expect(f!.provider).toBe("ollama-cloud");
    expect(f!.model).toBe("deepseek-v4.1-flash");
    expect(f!.stopReason).toBe("error");
  });

  it("responseModel prime sur model quand présent", () => {
    const f = detectProviderFailureEvent(messageEnd({ responseModel: "deepseek-v4.1-flash-2026" }));
    expect(f!.model).toBe("deepseek-v4.1-flash-2026");
  });

  it("ignore les tours normaux, les non-message_end et errorMessage sans stopReason error", () => {
    expect(detectProviderFailureEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }))
      .toBeNull();
    expect(detectProviderFailureEvent({ type: "message_start", message: { role: "assistant" } })).toBeNull();
    expect(detectProviderFailureEvent(null)).toBeNull();
    // errorMessage seul (stopReason absent) reste un échec à tracer.
    expect(detectProviderFailureEvent({ type: "message_end", message: { role: "assistant", errorMessage: "boom" } }))
      .not.toBeNull();
  });

  it("construit une entrée level=error avec statut, ref, durée et modèle", () => {
    const entry = buildProviderFailureLog(messageEnd(), "projet-1", 1234.7);
    expect(entry).not.toBeNull();
    expect(entry!.level).toBe("error");
    expect(entry!.category).toBe("llm-error");
    expect(entry!.message).toContain("[ollama-cloud/deepseek-v4.1-flash]");
    expect(entry!.message).toContain("type=server");
    expect(entry!.message).toContain("durée=1235ms");
    expect(entry!.details).toMatchObject({
      projectId: "projet-1",
      provider: "ollama-cloud",
      model: "deepseek-v4.1-flash",
      kind: "server",
      httpStatus: 500,
      ref: "97780de6-d6ab-4582-91e8-e7a8a9543966",
      durationMs: 1235,
    });
  });

  it("durée inconnue → ? dans le message et null dans les détails", () => {
    const entry = buildProviderFailureLog(messageEnd(), "p")!;
    expect(entry.message).toContain("durée=?");
    expect(entry.details.durationMs).toBeNull();
  });

  it("retourne null pour un événement sans échec", () => {
    expect(buildProviderFailureLog({ type: "tool_execution_end" }, "p")).toBeNull();
  });
});

describe("buildRetryLog — auto_retry_start / auto_retry_end", () => {
  it("détecte les deux phases et ignore les autres événements", () => {
    expect(detectRetryEvent({ type: "auto_retry_start", attempt: 1 })).toEqual({
      phase: "start",
      summary: { attempt: 1, maxAttempts: undefined, delayMs: undefined, success: undefined, errorMessage: undefined, finalError: undefined },
    });
    expect(detectRetryEvent({ type: "auto_retry_end", success: false, attempt: 3 })).toEqual({
      phase: "end",
      summary: { attempt: 3, maxAttempts: undefined, delayMs: undefined, success: false, errorMessage: undefined, finalError: undefined },
    });
    expect(detectRetryEvent({ type: "agent_end" })).toBeNull();
    expect(detectRetryEvent(null)).toBeNull();
  });

  it("start : reprise programmée avec délai, cause et ref", () => {
    const entry = buildRetryLog(
      {
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        errorMessage: '503 "Server overloaded, please retry shortly (ref: c67c5a79-86e9-4e1b-bd77-bf02663b7df6)"',
      },
      "projet-1",
    )!;
    expect(entry.level).toBe("warn");
    expect(entry.category).toBe("llm-retry");
    expect(entry.message).toContain("reprise 2/3 programmée dans 4000ms");
    expect(entry.message).toContain("cause=overloaded");
    expect(entry.details).toMatchObject({
      projectId: "projet-1",
      phase: "start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      kind: "overloaded",
      httpStatus: 503,
      ref: "c67c5a79-86e9-4e1b-bd77-bf02663b7df6",
    });
  });

  it("end succès : level=info, tour poursuivi", () => {
    const entry = buildRetryLog({ type: "auto_retry_end", success: true, attempt: 2 }, "p")!;
    expect(entry.level).toBe("info");
    expect(entry.message).toContain("RÉUSSIE");
    expect(entry.details).toMatchObject({ success: true, attempt: 2, projectId: "p" });
  });

  it("end échec définitif : reprises ÉPUISÉES + erreur finale", () => {
    const entry = buildRetryLog(
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "500: boom" },
      "p",
    )!;
    expect(entry.level).toBe("warn");
    expect(entry.message).toContain("ÉPUISÉES");
    expect(entry.details).toMatchObject({ success: false, attempt: 3, cancelled: false, kind: "server" });
  });

  it("end annulation : reprises ANNULÉES (abort pendant le backoff)", () => {
    const entry = buildRetryLog(
      { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
      "p",
    )!;
    expect(entry.message).toContain("ANNULÉES");
    expect(entry.details.cancelled).toBe(true);
  });

  it("ne produit rien pour un événement non-retry", () => {
    expect(buildRetryLog({ type: "message_start" }, "p")).toBeNull();
  });
});
