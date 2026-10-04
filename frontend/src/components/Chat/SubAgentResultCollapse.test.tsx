// @vitest-environment jsdom
// ── Message de RÉSULTAT de sous-agent : repli + en-tête informatif ──────────
// BUG : le message conversationnel `subagent_result` (réinjection du résultat
// d'un run détaché, backend/src/pi/session.ts) était rendu par un simple `div` —
// donc TOUJOURS visible et NON repliable, en contradiction avec le réglage
// « Déplier le détail d'affichage par défaut » (pi-web-display-detail).
//
// Correctif : rendu via CollapsibleBlock (mécanisme commun). Ces tests
// verrouillent le contrat AU POINT DE RENDU RÉEL (GroupedMessages → UserBubble,
// le même chemin que le fil live et que PastConversationViewer) :
//  - réglage INACTIF → corps masqué, en-tête toujours lisible (agent + statut
//    + taille) ;
//  - réglage ACTIF → corps visible ;
//  - clic sur l'en-tête → déplie/replie (override mémorisé par bloc) ;
//  - changement de réglage → appliqué immédiatement au bloc déjà monté ;
//  - échec → auto-déplié malgré le réglage INACTIF ;
//  - le message reste rendu (non supprimé) : il n'est que replié visuellement.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { I18nProvider } from "../../i18n";
import { GroupedMessages } from "./ChatView";
import type { DisplayMessage } from "../../types";
import { resetSubagentRuns } from "../../stores/subagentRuns";

// Contenu réaliste produit par le backend (buildResultMessageContent).
const CONTENT = [
  "🧩 Résultat du sous-agent (délégation terminée)",
  "",
  "### Exécution (execute) — succès",
  "",
  "Travail terminé : 3 fichiers modifiés.",
].join("\n");
const LINES = CONTENT.split("\n").length;
const SIZE_EN = `${LINES} lines · ${CONTENT.length} chars`;

function resultMessage(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "c-res-1",
    role: "user",
    content: CONTENT,
    thinking: "",
    toolCalls: [],
    timestamp: Date.now(),
    customType: "subagent_result",
    display: true,
    subagentResults: [
      {
        delegateRunId: "run-1",
        delegateFunction: "execute",
        label: "Exécution",
        status: "success",
        durationMs: 4_200,
        actionCount: 3,
      },
    ],
    ...over,
  };
}

/** Rend le fil RÉEL (GroupedMessages monte le CollapseProvider comme en prod). */
function Thread({ messages, expanded }: { messages: DisplayMessage[]; expanded: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <GroupedMessages
      messages={messages}
      displayDetailExpanded={expanded}
      onFileClick={() => {}}
      scrollContainerRef={ref}
      projectId="projet-test"
    />
  );
}

function renderThread(messages: DisplayMessage[], expanded: boolean) {
  return render(
    <I18nProvider>
      <Thread messages={messages} expanded={expanded} />
    </I18nProvider>,
  );
}

function rerenderThread(view: ReturnType<typeof renderThread>, messages: DisplayMessage[], expanded: boolean) {
  view.rerender(
    <I18nProvider>
      <Thread messages={messages} expanded={expanded} />
    </I18nProvider>,
  );
}

/** En-tête repliable (aria-expanded) — pas les autres boutons éventuels du fil. */
function collapseHeader(): HTMLElement {
  const headers = screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"));
  expect(headers).toHaveLength(1);
  return headers[0];
}

/** Corps du message (texte backend complet) — présent seulement déplié. */
function body(): HTMLElement | null {
  return screen.queryByText(/Travail terminé : 3 fichiers modifiés\./);
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  resetSubagentRuns();
});

afterEach(() => {
  cleanup();
  resetSubagentRuns();
});

describe("SubAgentResultMessage — réglage « replié par défaut »", () => {
  it("réglage INACTIF → corps masqué, en-tête informatif (agent, statut, taille)", () => {
    renderThread([resultMessage()], false);

    const header = collapseHeader();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // En-tête TOUJOURS visible : de quel agent il s'agit, son statut, la taille.
    expect(header.textContent).toContain("Sub-agent result");
    expect(header.textContent).toContain("Exécution (execute)");
    expect(header.textContent).toContain("success");
    expect(header.textContent).toContain(SIZE_EN);
    // Corps replié (le message n'est PAS supprimé : il n'est pas rendu).
    expect(body()).toBeNull();
  });

  it("réglage ACTIF → corps visible sans clic", () => {
    renderThread([resultMessage()], true);

    expect(collapseHeader().getAttribute("aria-expanded")).toBe("true");
    expect(body()).toBeTruthy();
    expect(screen.getByText(/🧩 Résultat du sous-agent \(délégation terminée\)/)).toBeTruthy();
  });

  it("clic sur l'en-tête → déplie ; re-clic → replie (override par bloc)", () => {
    renderThread([resultMessage()], false);
    const header = collapseHeader();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(body()).toBeTruthy();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(body()).toBeNull();
  });

  it("changement du réglage → s'applique IMMÉDIATEMENT au bloc déjà monté", () => {
    const view = renderThread([resultMessage()], false);
    expect(body()).toBeNull();

    rerenderThread(view, [resultMessage()], true);
    expect(body()).toBeTruthy();

    rerenderThread(view, [resultMessage()], false);
    expect(body()).toBeNull();
  });

  it("résultat en ÉCHEC + réglage INACTIF → auto-déplié (l'erreur reste visible)", () => {
    const message = resultMessage({
      subagentResults: [
        { delegateRunId: "run-fail", delegateFunction: "execute", label: "Exécution", status: "error" },
      ],
    });
    renderThread([message], false);

    const header = collapseHeader();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.textContent).toContain("failure");
    expect(body()).toBeTruthy();

    // L'override utilisateur garde le dernier mot : un clic peut replier.
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(body()).toBeNull();
  });

  it("lot de plusieurs résultats → en-tête liste chaque agent et son statut", () => {
    const message = resultMessage({
      subagentResults: [
        { delegateRunId: "run-1", delegateFunction: "execute", label: "Exécution", status: "success" },
        { delegateRunId: "run-2", delegateFunction: "review", label: "Relecture", status: "timeout-inactivity" },
      ],
    });
    renderThread([message], false);

    const header = collapseHeader();
    expect(header.textContent).toContain("2 sub-agents");
    expect(header.textContent).toContain("Exécution (execute)");
    expect(header.textContent).toContain("Relecture (review)");
    expect(header.textContent).toContain("success");
    expect(header.textContent).toContain("timeout (inactivity)");
  });

  it("sans métadonnées structurées → en-tête de repli issu du contenu (non-régression)", () => {
    // Payload ancien/incomplet : details.results absent. Le message doit rester
    // rendu et repliable, avec un en-tête lisible extrait du texte backend.
    renderThread([resultMessage({ subagentResults: undefined })], false);

    const header = collapseHeader();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.textContent).toContain("Sub-agent result");
    expect(header.textContent).toContain("Exécution (execute) — succès");
    expect(body()).toBeNull();
  });

  it("non-régression : le message reste rendu (non supprimé), contenu complet dépliable", () => {
    renderThread([resultMessage()], false);

    // L'en-tête existe = le message est bien dans le fil (pas filtré).
    expect(collapseHeader()).toBeTruthy();
    // Déplié, le contenu complet (conversationnel) est intact — rien n'est tronqué.
    fireEvent.click(collapseHeader());
    expect(body()!.textContent).toBe(CONTENT);
  });
});
