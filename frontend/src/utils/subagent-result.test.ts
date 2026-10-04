// ── Helpers purs du message de résultat de sous-agent (`subagent_result`) ────
// Ces helpers alimentent l'en-tête replié du message : extraction des
// métadonnées structurées de `details.results` (live ET relecture), décision
// d'auto-dépli (échec), libellé i18n du statut, repli sur l'en-tête texte.
import { describe, expect, it } from "vitest";
import {
  countContentLines,
  extractSubagentResults,
  firstResultHeading,
  isSubagentResultFailed,
  subagentStatusLabelKey,
} from "./subagent-result";

const VALID = {
  delegateRunId: "run-1",
  delegateFunction: "execute",
  label: "Exécution",
  status: "success",
  cause: null,
  errorMessage: null,
  response: "réponse complète",
  durationMs: 4_200,
  actionCount: 3,
};

describe("extractSubagentResults", () => {
  it("extrait les champs sûrs de details.results (customType subagent_result)", () => {
    expect(extractSubagentResults("subagent_result", { results: [VALID] })).toEqual([
      {
        delegateRunId: "run-1",
        delegateFunction: "execute",
        label: "Exécution",
        status: "success",
        durationMs: 4_200,
        actionCount: 3,
      },
    ]);
  });

  it("ignore les autres customType et les détails sans results", () => {
    expect(extractSubagentResults("screenshot", { results: [VALID] })).toBeUndefined();
    expect(extractSubagentResults("subagent_result", undefined)).toBeUndefined();
    expect(extractSubagentResults("subagent_result", { results: "nope" })).toBeUndefined();
    expect(extractSubagentResults("subagent_result", { results: [] })).toBeUndefined();
  });

  it("filtre les entrées sans delegateRunId et normalise les valeurs douteuses", () => {
    const extracted = extractSubagentResults("subagent_result", {
      results: [
        { label: "orpheline" },
        {
          delegateRunId: "run-2",
          status: "",
          cause: "",
          durationMs: -5,
          actionCount: Number.NaN,
        },
      ],
    });
    expect(extracted).toEqual([
      { delegateRunId: "run-2", delegateFunction: undefined, label: undefined, status: "success", cause: undefined, errorMessage: undefined, durationMs: 0, actionCount: undefined },
    ]);
  });

  it("conserve cause/errorMessage non vides", () => {
    const extracted = extractSubagentResults("subagent_result", {
      results: [{ delegateRunId: "run-3", status: "error", cause: "crash", errorMessage: "boom" }],
    });
    expect(extracted?.[0]).toMatchObject({ status: "error", cause: "crash", errorMessage: "boom" });
  });
});

describe("isSubagentResultFailed", () => {
  it("pas d'auto-dépli sans métadonnées ni en cas de succès", () => {
    expect(isSubagentResultFailed(undefined)).toBe(false);
    expect(isSubagentResultFailed([])).toBe(false);
    expect(isSubagentResultFailed([{ delegateRunId: "r", status: "success" }])).toBe(false);
  });

  it("auto-dépli si AU MOINS UN résultat n'est pas un succès (aligné sur runFromActivity)", () => {
    expect(isSubagentResultFailed([
      { delegateRunId: "a", status: "success" },
      { delegateRunId: "b", status: "timeout-inactivity" },
    ])).toBe(true);
    expect(isSubagentResultFailed([{ delegateRunId: "c", status: "cancelled" }])).toBe(true);
  });
});

describe("subagentStatusLabelKey", () => {
  it("mappe les statuts connus vers leurs clés i18n", () => {
    expect(subagentStatusLabelKey("success")).toBe("chat.subAgentStatusSuccess");
    expect(subagentStatusLabelKey("error")).toBe("chat.subAgentStatusError");
    expect(subagentStatusLabelKey("timeout-inactivity")).toBe("chat.subAgentStatusTimeoutInactivity");
    expect(subagentStatusLabelKey("timeout-global")).toBe("chat.subAgentStatusTimeoutGlobal");
    expect(subagentStatusLabelKey("aborted")).toBe("chat.subAgentStatusAborted");
    expect(subagentStatusLabelKey("cancelled")).toBe("chat.subAgentStatusCancelled");
  });

  it("renvoie null pour un statut inconnu (affiché brut par l'UI)", () => {
    expect(subagentStatusLabelKey("weird")).toBeNull();
  });
});

describe("firstResultHeading", () => {
  it("extrait la première ligne « ### … » (en-tête backend)", () => {
    const content = "🧩 Résultat du sous-agent\n\n### Exécution (execute) — succès\n\ncorps";
    expect(firstResultHeading(content)).toBe("Exécution (execute) — succès");
  });

  it("renvoie null sans ligne d'en-tête", () => {
    expect(firstResultHeading("juste du texte")).toBeNull();
    expect(firstResultHeading("")).toBeNull();
  });
});

describe("countContentLines", () => {
  it("compte les lignes (0 si vide)", () => {
    expect(countContentLines("a\nb\nc")).toBe(3);
    expect(countContentLines("")).toBe(0);
  });
});
