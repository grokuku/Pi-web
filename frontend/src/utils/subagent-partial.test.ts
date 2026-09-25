// Tests P5 : le « travail récupéré » ne doit apparaître qu'UNE fois.
import { describe, expect, it } from "vitest";
import type { SubAgentRun } from "../types";
import { dedupeSubAgentEndTexts } from "./subagent-partial.js";

const PARTIAL = "J'ai modifié backend/src/pi/session.ts et ajouté les tests.";

function makeRun(overrides: Partial<SubAgentRun> = {}): SubAgentRun {
  return {
    id: "d-1",
    function: "execute",
    label: "Exécution",
    task: "corriger",
    status: "failed",
    isError: true,
    attempt: 1,
    actions: [],
    messages: [],
    ...overrides,
  } as SubAgentRun;
}

function countVisibleOccurrences(run: SubAgentRun): number {
  const visibility = dedupeSubAgentEndTexts(run);
  const visible: string[] = [
    ...run.messages.map((m) => m.text || ""),
    visibility.showErrorMessage ? run.end?.errorMessage || "" : "",
    visibility.showResponsePreview ? run.end?.responsePreview || "" : "",
  ];
  return visible.filter((t) => t.includes(PARTIAL)).length;
}

describe("dedupeSubAgentEndTexts", () => {
  it("run interrompu (messages + errorMessage court + responsePreview) : le partiel n'apparaît qu'une fois", () => {
    const run = makeRun({
      messages: [{ text: PARTIAL, timestamp: 1 }],
      end: {
        status: "aborted",
        attemptsMade: 1,
        durationMs: 1000,
        actionCount: 1,
        eventCount: 2,
        thinkingChars: 0,
        model: "p/m",
        cause: "abort-session",
        errorMessage: `Délégation interrompue (abort de session) (récupéré : ${PARTIAL.length} chars)`,
        responsePreview: PARTIAL,
        droppedEvents: 0,
      },
    });
    const visibility = dedupeSubAgentEndTexts(run);
    expect(visibility.showErrorMessage).toBe(true); // motif court, non dupliqué
    expect(visibility.showResponsePreview).toBe(false); // déjà dans le mini-fil
    expect(countVisibleOccurrences(run)).toBe(1);
  });

  it("run LEGACY : errorMessage embarque le partiel ⇒ masqué s'il est aussi dans les messages", () => {
    const run = makeRun({
      messages: [{ text: PARTIAL, timestamp: 1 }],
      end: {
        status: "aborted",
        attemptsMade: 1,
        durationMs: 1000,
        actionCount: 0,
        eventCount: 1,
        thinkingChars: 0,
        model: "p/m",
        cause: "abort-utilisateur",
        errorMessage: `Travail récupéré (${PARTIAL.length} chars) :\n\n${PARTIAL}`,
        responsePreview: PARTIAL,
        droppedEvents: 0,
      },
    });
    const visibility = dedupeSubAgentEndTexts(run);
    expect(visibility.showErrorMessage).toBe(false);
    expect(visibility.showResponsePreview).toBe(false);
    expect(countVisibleOccurrences(run)).toBe(1);
  });

  it("partiel absent du mini-fil ⇒ responsePreview affiché", () => {
    const run = makeRun({
      messages: [],
      end: {
        status: "timeout-inactivity",
        attemptsMade: 2,
        durationMs: 1000,
        actionCount: 0,
        eventCount: 0,
        thinkingChars: 0,
        model: "p/m",
        cause: "timeout-inactivite",
        errorMessage: "a échoué (timeout d'inactivité) (récupéré : 40 chars)",
        responsePreview: PARTIAL,
        droppedEvents: 0,
      },
    });
    const visibility = dedupeSubAgentEndTexts(run);
    expect(visibility.showErrorMessage).toBe(true);
    expect(visibility.showResponsePreview).toBe(true);
    expect(countVisibleOccurrences(run)).toBe(1);
  });

  it("sans end : rien à afficher", () => {
    expect(dedupeSubAgentEndTexts(makeRun())).toEqual({
      showErrorMessage: false,
      showResponsePreview: false,
    });
  });
});
