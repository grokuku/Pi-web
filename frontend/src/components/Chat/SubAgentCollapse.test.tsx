// @vitest-environment jsdom
// ── Réglage « déplier le détail par défaut » et sous-agents (régression) ────
// BUG (historique) : le mur en colonnes (ParallelSubAgents) ne contient QUE des
// runs actifs (selectConcurrentRuns) ; passer `isRunning` vrai annulait la
// précédence de resolveExpanded (isRunning > réglage global) → le réglage
// pi-web-display-detail était ignoré pour les sous-agents.
// DÉCISION PRODUIT (correctif « journal ») : le journal d'un sous-agent
// (actions numérotées) et ses réflexions/textes suivent le réglage MÊME
// PENDANT le run — l'en-tête (toujours visible) reste le suivi live : statut,
// chrono, nombre d'actions, dernière action résumée. Repliés par défaut avec
// le réglage INACTIF, dépliables au clic ; l'auto-dépli d'erreur est conservé.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** Émet un tool call TERMINÉ du sous-agent (visible dans le journal d'actions). */
function emitEndedAction(runId: string, at: number): void {
  const over = { delegateRunId: runId, projectId: PROJECT };
  routeSubagentEnvelope(
    env(
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: 'cd /projects/Yuki && grep -n "fu" .' },
      },
      over,
    ),
    [],
    at,
    PROJECT,
  );
  routeSubagentEnvelope(
    env(
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        outputTruncated: true,
        result: {
          content: [{ type: "text", text: Array.from({ length: 59 }, (_, i) => `ligne ${i}`).join("\n") }],
        },
      },
      over,
    ),
    [],
    at + 1,
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

/** Actions du journal, telles que la capture utilisateur : « 11. bash … · 59 lignes · 0s · tronqué ». */
const JOURNAL_ACTIONS = [
  {
    seq: 11,
    toolName: "bash",
    argSummary: 'bash cd /projects/Yuki && grep -n "fu" .',
    summary: "59 lignes",
    durationMs: 0,
    truncated: true,
  },
  {
    seq: 12,
    toolName: "read",
    argSummary: "read /projects/Yuki/public/ui/config.ts",
    summary: "154 lignes",
    durationMs: 0,
    truncated: true,
  },
];

/** Run ARCHIVÉ terminé (relu depuis l'historique) portant un journal d'actions. */
function registerArchivedWithJournal(runId: string, status = "success") {
  const archived = runFromActivity(
    {
      delegateRunId: runId,
      function: "execute",
      status,
      durationMs: 1_200,
      responsePreview: "résumé-final",
      actions: JOURNAL_ACTIONS,
    },
    Date.now(),
  )!;
  registerArchivedRuns([archived], [], PROJECT);
  return archived;
}

/** Rend un contenu sous CollapseProvider réglé « replié par défaut ». */
function renderCollapsed(children: ReactNode) {
  return render(
    <I18nProvider>
      <CollapseProvider defaultDetailExpanded={false}>{children}</CollapseProvider>
    </I18nProvider>,
  );
}

/** Rend un contenu sous CollapseProvider réglé « déplié par défaut ». */
function renderExpanded(children: ReactNode) {
  return render(
    <I18nProvider>
      <CollapseProvider defaultDetailExpanded>{children}</CollapseProvider>
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
  it("2 runs actifs, réglage replié : TOUTES les colonnes sont REPLIÉES (journal masqué)", () => {
    const now = Date.now();
    startRun("run-old", now - 1_000, "sortie-old");
    startRun("run-new", now, "sortie-new");

    renderCollapsed(<ParallelSubAgents projectId={PROJECT} />);

    const headers = collapseToggles();
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header.getAttribute("aria-expanded")).toBe("false");
    }
    // Aucun corps visible : le suivi live est porté par les en-têtes seuls.
    expect(screen.queryByText("sortie-old")).toBeNull();
    expect(screen.queryByText("sortie-new")).toBeNull();
  });

  it("réglage déplié : toutes les colonnes restent dépliées (pas de régression)", () => {
    const now = Date.now();
    startRun("run-old", now - 1_000, "sortie-old");
    startRun("run-new", now, "sortie-new");

    renderExpanded(<ParallelSubAgents projectId={PROJECT} />);

    for (const header of collapseToggles()) {
      expect(header.getAttribute("aria-expanded")).toBe("true");
    }
    expect(screen.getByText("sortie-old")).toBeTruthy();
    expect(screen.getByText("sortie-new")).toBeTruthy();
  });
});

describe("SubAgentBlock — journal replié par défaut (réglage INACTIF), dépliable au clic", () => {
  it("run TERMINÉ + réglage replié → journal masqué, en-tête repliable avec le nombre d'actions", () => {
    registerArchivedWithJournal("run-done");

    renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-done")} blockId="m1:delegate:tc-run-done" />,
    );

    // En-tête repliable présent + informatif (2 actions, aperçu de la dernière).
    const header = screen.getByRole("button", { expanded: false });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("2 actions")).toBeTruthy();
    // Journal masqué : ni numéro d'action, ni corps de ligne.
    expect(screen.queryByText("11.")).toBeNull();
    expect(screen.queryByText(/59 lignes/)).toBeNull();
  });

  it("clic sur l'en-tête → déplie le journal (lignes + durées + tronqué), re-clic → replie", () => {
    registerArchivedWithJournal("run-click");

    renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-click")} blockId="m1:delegate:tc-run-click" />,
    );
    const header = screen.getByRole("button", { expanded: false });

    fireEvent.click(header);
    expect(screen.getByText("11.")).toBeTruthy();
    expect(screen.getByText(/59 lignes/)).toBeTruthy();
    expect(screen.getAllByText("· tronqué")).toHaveLength(2);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);
    expect(screen.queryByText("11.")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("réglage ACTIF → journal visible sans clic", () => {
    registerArchivedWithJournal("run-open");

    renderExpanded(
      <SubAgentBlock toolCall={delegateCall("run-open")} blockId="m1:delegate:tc-run-open" />,
    );

    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
    expect(screen.getByText("11.")).toBeTruthy();
    expect(screen.getByText("12.")).toBeTruthy();
  });

  it("changement du réglage → s'applique IMMÉDIATEMENT au bloc déjà monté", () => {
    registerArchivedWithJournal("run-live-toggle");

    const view = renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-live-toggle")} blockId="m1:delegate:tc-run-live-toggle" />,
    );
    expect(screen.queryByText("11.")).toBeNull();

    view.rerender(
      <I18nProvider>
        <CollapseProvider defaultDetailExpanded>
          <SubAgentBlock toolCall={delegateCall("run-live-toggle")} blockId="m1:delegate:tc-run-live-toggle" />
        </CollapseProvider>
      </I18nProvider>,
    );
    expect(screen.getByText("11.")).toBeTruthy();

    view.rerender(
      <I18nProvider>
        <CollapseProvider defaultDetailExpanded={false}>
          <SubAgentBlock toolCall={delegateCall("run-live-toggle")} blockId="m1:delegate:tc-run-live-toggle" />
        </CollapseProvider>
      </I18nProvider>,
    );
    expect(screen.queryByText("11.")).toBeNull();
  });

  it("run ACTIF + réglage replié → journal REPLIÉ (décision produit), suivi live dans l'en-tête", () => {
    const now = Date.now();
    startRun("run-live", now, "sortie-live");
    emitEndedAction("run-live", now + 2);

    renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-live")} blockId="m1:delegate:tc-run-live" />,
    );

    // Replié malgré le run en cours ; l'en-tête montre le nombre d'actions et
    // le résumé de la dernière action (suivi d'un coup d'œil).
    const header = screen.getByRole("button", { expanded: false });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("1 action")).toBeTruthy();
    expect(screen.queryByText("sortie-live")).toBeNull();
    expect(screen.queryByText("1.")).toBeNull();

    // Un clic déplie le mini-fil (réflexion/texte) et le journal.
    fireEvent.click(header);
    expect(screen.getByText("sortie-live")).toBeTruthy();
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("· exit 0 · 59 lignes")).toBeTruthy();
  });

  it("journal LIVE : la cible n'est PAS dupliquée (tête du résumé retirée)", () => {
    const now = Date.now();
    startRun("run-dedupe", now, "");
    emitEndedAction("run-dedupe", now + 2);

    renderExpanded(
      <SubAgentBlock toolCall={delegateCall("run-dedupe")} blockId="m1:delegate:tc-run-dedupe" />,
    );

    const line = screen.getByText("1.").parentElement!;
    // La commande n'apparaît qu'UNE fois (toolName + cible), pas de doublon
    // « bash <cmd> · bash <cmd> · exit 0 … ».
    expect(line.textContent!.split("/projects/Yuki").length - 1).toBe(1);
    expect(line.textContent).toContain("· exit 0 · 59 lignes");
  });

  it("run TERMINÉ (archivé) + réglage replié → corps masqué (non-régression)", () => {
    registerArchivedWithJournal("run-done-2");

    renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-done-2")} blockId="m1:delegate:tc-run-done-2" />,
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

  it("run en ÉCHEC + réglage replié → auto-déplié (l'erreur reste visible)", () => {
    registerArchivedWithJournal("run-failed", "error");

    renderCollapsed(
      <SubAgentBlock toolCall={delegateCall("run-failed")} blockId="m1:delegate:tc-run-failed" />,
    );

    expect(screen.getByRole("button", { expanded: true }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("11.")).toBeTruthy();
  });
});
