// @vitest-environment jsdom
// ── Réglage « déplier le détail par défaut » et sous-agents (régression) ────
// BUG : le mur en colonnes (ParallelSubAgents) ne contient QUE des runs actifs
// (selectConcurrentRuns). Passer `isRunning` vrai à TOUTES les colonnes annule
// la précédence de resolveExpanded (isRunning > réglage global) : le réglage
// pi-web-display-detail était ignoré pour les sous-agents. Seul le run le PLUS
// RÉCENT du groupe s'auto-déplie désormais (sortie live) ; les colonnes plus
// anciennes suivent le réglage / l'override utilisateur.
// Côté bloc inline (SubAgentBlock), un run terminal OU resté `running` mais
// bloqué (`stuck`) ne s'auto-déplie pas non plus ; un run actif si.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { CollapseProvider } from "./CollapsibleBlock";
import { ParallelSubAgents } from "./ParallelSubAgents";
import { SubAgentBlock } from "./SubAgentBlock";
import type { SubagentEnvelope } from "../../stores/subagentRuns";
import {
  flushSubagentNotifications,
  registerArchivedRuns,
  resetSubagentRuns,
  routeSubagentEnvelope,
  runFromActivity,
  STUCK_RUN_TIMEOUT_MS,
} from "../../stores/subagentRuns";
import type { ToolCallInfo } from "../../types";

const PROJECT = "projet-test";

function env(event: any, over: Partial<SubagentEnvelope> = {}): SubagentEnvelope {
  return {
    type: "subagent",
    source: "subagent",
    delegateRunId: "run-defaut",
    attempt: 1,
    delegateFunction: "execute",
    delegateLabel: "Exécution",
    event,
    ...over,
  };
}

/** Démarre un run ACTIF du projet de test, avec un message visible en corps. */
function startRun(runId: string, startedAt: number, text: string): void {
  const over = { delegateRunId: runId, projectId: PROJECT };
  routeSubagentEnvelope(env({ type: "subagent_start" }, over), [], startedAt, PROJECT);
  routeSubagentEnvelope(
    env(
      {
        type: "message_end",
        message: { role: "assistant", id: `${runId}-m1`, content: [{ type: "text", text }] },
      },
      over,
    ),
    [],
    startedAt + 1,
    PROJECT,
  );
}

/** ToolCall `delegate` pointant (via details) vers le run donné. */
function delegateCall(runId: string): ToolCallInfo {
  return {
    id: `tc-${runId}`,
    name: "delegate",
    args: { function: "execute" },
    output: "",
    isError: false,
    isStreaming: false,
    details: { delegateRunId: runId },
  };
}

/** Rend un contenu sous CollapseProvider réglé « replié par défaut ». */
function renderCollapsed(children: ReactNode) {
  return render(
    <I18nProvider>
      <CollapseProvider defaultDetailExpanded={false}>{children}</CollapseProvider>
    </I18nProvider>,
  );
}

/**
 * Boutons de DÉPLIAGE uniquement (les en-têtes de bloc) : depuis le LOT 1, un
 * run actif porte AUSSI un bouton « Stop » → on filtre sur `aria-expanded`
 * (absent du bouton Stop) pour cibler le toggle de repli.
 */
function collapseToggles(): HTMLElement[] {
  return screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"));
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  resetSubagentRuns();
});

afterEach(() => {
  flushSubagentNotifications();
  cleanup();
  resetSubagentRuns();
});

describe("ParallelSubAgents — le réglage « replié par défaut » s'applique aux colonnes", () => {
  it("2 runs actifs, réglage replié : la colonne ancienne est REPLIÉE, seule la plus récente reste dépliée", () => {
    const now = Date.now();
    startRun("run-old", now - 1_000, "sortie-old");
    startRun("run-new", now, "sortie-new");

    renderCollapsed(<ParallelSubAgents projectId={PROJECT} />);

    const headers = collapseToggles();
    expect(headers).toHaveLength(2);
    // Ordre chronologique des colonnes (ancien puis récent) : avant le fix,
    // `isRunning` était vrai pour TOUTES → aria-expanded valait "true" partout.
    expect(headers[0].getAttribute("aria-expanded")).toBe("false");
    expect(headers[1].getAttribute("aria-expanded")).toBe("true");

    // Corps : l'ancien est masqué (réglage), le plus récent reste visible (live).
    expect(screen.queryByText("sortie-old")).toBeNull();
    expect(screen.getByText("sortie-new")).toBeTruthy();
  });

  it("réglage déplié : toutes les colonnes restent dépliées (pas de régression)", () => {
    const now = Date.now();
    startRun("run-old", now - 1_000, "sortie-old");
    startRun("run-new", now, "sortie-new");

    render(
      <I18nProvider>
        <CollapseProvider defaultDetailExpanded>
          <ParallelSubAgents projectId={PROJECT} />
        </CollapseProvider>
      </I18nProvider>,
    );

    for (const header of collapseToggles()) {
      expect(header.getAttribute("aria-expanded")).toBe("true");
    }
    expect(screen.getByText("sortie-old")).toBeTruthy();
    expect(screen.getByText("sortie-new")).toBeTruthy();
  });
});

describe("SubAgentBlock — seul un run réellement ACTIF s'auto-déplie", () => {
  it("run TERMINÉ (archivé) + réglage replié → corps masqué", () => {
    const archived = runFromActivity(
      {
        delegateRunId: "run-done",
        function: "execute",
        status: "success",
        durationMs: 1_200,
        responsePreview: "résumé-final",
      },
      Date.now(),
    )!;
    registerArchivedRuns([archived], [], PROJECT);

    renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-done")} blockId="m1:delegate:tc-run-done" />,
    );

    expect(screen.getByRole("button", { expanded: false }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("résumé-final")).toBeNull();
  });

  it("run BLOQUÉ (running sans fin) + réglage replié → pas d'auto-dépli, en-tête marqué", () => {
    const startedAt = Date.now() - STUCK_RUN_TIMEOUT_MS - 60_000;
    routeSubagentEnvelope(
      env({ type: "subagent_start" }, { delegateRunId: "run-stuck", projectId: PROJECT }),
      [],
      startedAt,
      PROJECT,
    );

    renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-stuck")} blockId="m1:delegate:tc-run-stuck" />,
    );

    expect(screen.getByRole("button", { expanded: false }).getAttribute("aria-expanded")).toBe("false");
    // L'en-tête signale quand même le blocage (i18n EN).
    expect(screen.getByText(/no end \(stalled\)/)).toBeTruthy();
  });

  it("run ACTIF + réglage replié → auto-déplié pour la sortie live (pas de régression)", () => {
    const now = Date.now();
    startRun("run-live", now, "sortie-live");

    renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-live")} blockId="m1:delegate:tc-run-live" />,
    );

    expect(screen.getByRole("button", { expanded: true }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("sortie-live")).toBeTruthy();
  });
});
