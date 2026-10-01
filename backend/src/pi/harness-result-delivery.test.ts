/**
 * harness-result-delivery.test.ts — LOT 2 (orchestrateur interactif) : logique
 * PURE de livraison/lotissement des résultats de sous-agents réinjectés par le
 * backend.
 *
 * - resultDeliveryOptions : idle → tour normal ; streaming → followUp.
 * - buildResultMessageContent : texte du message conversationnel (1 ou N résultats).
 * - createResultBatcher : fenêtre FIXE (≈3 s) → UN SEUL flush pour des fins
 *   rapprochées (critère d'acceptation : pas de N tours LLM).
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildResultMessageContent,
  createResultBatcher,
  RESULT_BATCH_WINDOW_MS,
  RESULT_TEXT_MAX,
  resultDeliveryOptions,
  resultStatusLabel,
  type SubagentResultPayload,
} from "./harness-result-delivery.js";

function result(over: Partial<SubagentResultPayload> = {}): SubagentResultPayload {
  return {
    delegateRunId: "d-1",
    delegateFunction: "execute",
    label: "Exécution",
    status: "success",
    response: "travail terminé",
    durationMs: 1234,
    actionCount: 3,
    ...over,
  };
}

describe("resultDeliveryOptions", () => {
  it("orchestrateur idle ⇒ tour normal (triggerTurn vrai, pas de deliverAs)", () => {
    expect(resultDeliveryOptions(false)).toEqual({ triggerTurn: true });
  });

  it("orchestrateur en streaming ⇒ followUp (attend la fin du tour)", () => {
    expect(resultDeliveryOptions(true)).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });
});

describe("resultStatusLabel", () => {
  it("libellés connus + fallback", () => {
    expect(resultStatusLabel("success")).toBe("succès");
    expect(resultStatusLabel("cancelled")).toBe("annulé par l'utilisateur");
    expect(resultStatusLabel("weird")).toBe("weird");
  });
});

describe("buildResultMessageContent", () => {
  it("un seul résultat : en-tête singulier + corps", () => {
    const text = buildResultMessageContent([result()]);
    expect(text).toContain("Résultat du sous-agent");
    expect(text).toContain("### Exécution (execute) — succès");
    expect(text).toContain("travail terminé");
    expect(text).toContain("3 action(s)");
  });

  it("plusieurs résultats : en-tête pluriel + séparateur", () => {
    const text = buildResultMessageContent([
      result({ delegateRunId: "d-1" }),
      result({ delegateRunId: "d-2", status: "cancelled", response: "partiel" }),
    ]);
    expect(text).toContain("Résultat de 2 sous-agents");
    expect(text).toContain("---");
    expect(text).toContain("annulé par l'utilisateur");
  });

  it("sans réponse : utilise le message d'erreur, sinon 'aucune sortie'", () => {
    expect(buildResultMessageContent([result({ response: "", errorMessage: "boom" })]))
      .toContain("boom");
    expect(buildResultMessageContent([result({ response: "   " })])).toContain("(aucune sortie)");
  });

  it("tronque une réponse démesurée (RESULT_TEXT_MAX)", () => {
    const text = buildResultMessageContent([result({ response: "x".repeat(RESULT_TEXT_MAX + 500) })]);
    expect(text).toContain("(tronqué)");
  });

  it("liste vide ⇒ chaîne vide", () => {
    expect(buildResultMessageContent([])).toBe("");
  });
});

describe("createResultBatcher (fenêtre fixe)", () => {
  it("regroupe les résultats rapprochés en UN SEUL flush", () => {
    const onFlush = vi.fn();
    const scheduled: { fn: () => void; ms: number }[] = [];
    const batcher = createResultBatcher({
      onFlush,
      windowMs: RESULT_BATCH_WINDOW_MS,
      setTimeoutFn: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length;
      },
      clearTimeoutFn: () => {},
    });

    batcher.add(result({ delegateRunId: "d-1" }));
    batcher.add(result({ delegateRunId: "d-2" }));
    batcher.add(result({ delegateRunId: "d-3" }));
    // Fenêtre armée UNE fois (premier arrivé), non repoussée.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(RESULT_BATCH_WINDOW_MS);
    expect(batcher.pendingCount()).toBe(3);
    expect(onFlush).not.toHaveBeenCalled();

    // Déclenche la fenêtre → UN flush avec les 3 items.
    scheduled[0].fn();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].map((r: SubagentResultPayload) => r.delegateRunId)).toEqual([
      "d-1",
      "d-2",
      "d-3",
    ]);
    expect(batcher.pendingCount()).toBe(0);
  });

  it("un nouvel ajout APRÈS flush ré-arme une fenêtre", () => {
    const onFlush = vi.fn();
    const scheduled: { fn: () => void }[] = [];
    const batcher = createResultBatcher({
      onFlush,
      setTimeoutFn: (fn) => {
        scheduled.push({ fn });
        return scheduled.length;
      },
      clearTimeoutFn: () => {},
    });
    batcher.add(result({ delegateRunId: "d-1" }));
    scheduled[0].fn();
    expect(onFlush).toHaveBeenCalledTimes(1);
    batcher.add(result({ delegateRunId: "d-2" }));
    expect(scheduled).toHaveLength(2);
    scheduled[1].fn();
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("flushNow vide immédiatement le lot", () => {
    const onFlush = vi.fn();
    const batcher = createResultBatcher({
      onFlush,
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    batcher.add(result({ delegateRunId: "d-1" }));
    batcher.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
    // Un flush sur lot vide ne rappelle pas onFlush.
    batcher.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("un onFlush qui jette ne remonte pas", () => {
    const batcher = createResultBatcher({
      onFlush: () => {
        throw new Error("boom");
      },
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    batcher.add(result());
    expect(() => batcher.flushNow()).not.toThrow();
  });
});
