// @vitest-environment jsdom
// ── Séparateur de journée dans le fil (rendu RÉEL via GroupedMessages) ──────
// Même point de rendu que le fil live ET le lecteur de conversation passée
// (PastConversationViewer réutilise GroupedMessages) : ces tests verrouillent
// donc les deux d'un coup :
//  - un SEUL repère entre des messages du même jour, placé AVANT le premier ;
//  - un NOUVEAU repère au changement de jour, avant le premier message du jour ;
//  - libellés : TOUJOURS la date complète (fr « Vendredi 2 Février 2024 »,
//    en « Friday 2 February 2024 »), même pour un message du jour ;
//    jamais « Aujourd'hui »/« Hier » ;
//  - message sans horodatage → aucun repère ;
//  - lot antérieur chargé → les repères des jours anciens apparaissent
//    (réconciliation sur la liste rendue, sans doublon) ;
//  - structure centrée : deux segments de ligne jumeaux encadrent la date ;
//  - non-régression du regroupement : deux messages assistant consécutifs
//    restent UN groupe (un seul en-tête) sous un seul repère.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { I18nProvider } from "../../i18n";
import { GroupedMessages } from "./ChatView";
import type { DisplayMessage } from "../../types";
import { resetSubagentRuns } from "../../stores/subagentRuns";

/** Timestamp LOCAL → indifférent au fuseau de la machine de test. */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

function userMessage(id: string, content: string, timestamp: number): DisplayMessage {
  return { id, role: "user", content, thinking: "", toolCalls: [], timestamp };
}

function assistantMessage(id: string, content: string, timestamp: number): DisplayMessage {
  return { id, role: "assistant", content, thinking: "", toolCalls: [], timestamp };
}

/** Fil RÉEL : GroupedMessages monte le CollapseProvider comme en prod. */
function Thread({ messages }: { messages: DisplayMessage[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <GroupedMessages
      messages={messages}
      displayDetailExpanded={false}
      onFileClick={() => {}}
      scrollContainerRef={ref}
      projectId="projet-test"
    />
  );
}

function renderThread(messages: DisplayMessage[]) {
  return render(
    <I18nProvider>
      <Thread messages={messages} />
    </I18nProvider>,
  );
}

const separators = () => screen.queryAllByTestId("day-separator");
const labels = () => separators().map((el) => el.getAttribute("aria-label"));
/** `a` précède-t-il `b` dans le document ? (ordre réel du DOM) */
const precedes = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  localStorage.setItem("pi-web-language", "fr");
  resetSubagentRuns();
});

afterEach(() => {
  cleanup();
  resetSubagentRuns();
});

describe("séparateur de journée — placement", () => {
  it("messages du même jour → UN SEUL repère, placé AVANT le premier message", () => {
    renderThread([
      userMessage("u1", "premier message", at(2024, 2, 2, 9)),
      userMessage("u2", "deuxième message", at(2024, 2, 2, 14)),
      userMessage("u3", "troisième message", at(2024, 2, 2, 23, 59)),
    ]);

    const seps = separators();
    expect(seps).toHaveLength(1);
    expect(precedes(seps[0], screen.getByText("premier message"))).toBe(true);
    expect(precedes(seps[0], screen.getByText("deuxième message"))).toBe(true);
    expect(precedes(seps[0], screen.getByText("troisième message"))).toBe(true);
  });

  it("changement de jour → nouveau repère AVANT le premier message du jour suivant", () => {
    renderThread([
      userMessage("u1", "hier soir", at(2024, 2, 2, 23, 50)),
      userMessage("u2", "ce matin", at(2024, 2, 3, 0, 5)),
      userMessage("u3", "ce midi", at(2024, 2, 3, 12, 0)),
    ]);

    const seps = separators();
    expect(seps).toHaveLength(2);
    expect(labels()).toEqual(["Vendredi 2 Février 2024", "Samedi 3 Février 2024"]);
    // Ordre : repère jour 1 → « hier soir » → repère jour 2 → messages du jour 2.
    expect(precedes(seps[0], screen.getByText("hier soir"))).toBe(true);
    expect(precedes(screen.getByText("hier soir"), seps[1])).toBe(true);
    expect(precedes(seps[1], screen.getByText("ce matin"))).toBe(true);
    expect(precedes(seps[1], screen.getByText("ce midi"))).toBe(true);
  });

  it("message sans horodatage → AUCUN repère pour lui (les messages datés restent repérés)", () => {
    renderThread([
      userMessage("u1", "sans date", 0),
      userMessage("u2", "avec date", at(2024, 2, 2, 10)),
      userMessage("u3", "même jour", at(2024, 2, 2, 18)),
    ]);

    const seps = separators();
    expect(seps).toHaveLength(1);
    expect(precedes(screen.getByText("sans date"), seps[0])).toBe(true);
    expect(precedes(seps[0], screen.getByText("avec date"))).toBe(true);
    expect(precedes(seps[0], screen.getByText("même jour"))).toBe(true);
  });

  it("aucun horodatage exploitable → fil inchangé, aucun repère", () => {
    renderThread([
      userMessage("u1", "sans date 1", 0),
      { ...userMessage("u2", "sans date 2", 0), timestamp: undefined as unknown as number },
    ]);

    expect(separators()).toHaveLength(0);
    expect(screen.getByText("sans date 1")).toBeTruthy();
    expect(screen.getByText("sans date 2")).toBeTruthy();
  });
});

describe("séparateur de journée — libellés", () => {
  const yesterdayAtNoon = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  };

  it("fr : date complète jour de semaine + jour + mois + année, y compris pour aujourd'hui et hier", () => {
    renderThread([
      userMessage("u1", "vieux message", at(2024, 2, 2)),
      userMessage("u2", "message d'hier", yesterdayAtNoon()),
      userMessage("u3", "message d'aujourd'hui", Date.now()),
    ]);

    const shown = labels();
    expect(shown[0]).toBe("Vendredi 2 Février 2024");
    // La veille et le jour même affichent AUSSI la date complète — jamais « Hier »/« Aujourd'hui ».
    for (const label of shown) {
      expect(label).not.toBe("Hier");
      expect(label).not.toBe("Aujourd'hui");
      expect(label).toMatch(/^\p{Lu}\p{Ll}+ \d{1,2} \p{Lu}\p{Ll}+ \d{4}$/u);
    }
    expect(shown).toHaveLength(3);
  });

  it("en : même structure, « Friday 2 February 2024 » (pas de « Today »/« Yesterday »)", () => {
    localStorage.setItem("pi-web-language", "en");
    renderThread([
      userMessage("u1", "old message", at(2024, 2, 2)),
      userMessage("u2", "yesterday message", yesterdayAtNoon()),
      userMessage("u3", "today message", Date.now()),
    ]);

    const shown = labels();
    expect(shown[0]).toBe("Friday 2 February 2024");
    for (const label of shown) {
      expect(label).not.toBe("Yesterday");
      expect(label).not.toBe("Today");
      expect(label).toMatch(/^\p{Lu}\p{Ll}+ \d{1,2} \p{Lu}\p{Ll}+ \d{4}$/u);
    }
  });
});

describe("séparateur de journée — apparence et non-régression", () => {
  it("structure centrée : deux segments de ligne jumeaux (décoratifs) encadrent la date", () => {
    renderThread([userMessage("u1", "message", at(2024, 2, 2, 10))]);

    const sep = separators()[0];
    // 3 enfants : segment / date / segment — les deux segments `flex-1` sont
    // jumeaux → la date reste centrée horizontalement quelle que soit la largeur.
    expect(sep.children).toHaveLength(3);
    expect(sep.children[0].className).toContain("flex-1");
    expect(sep.children[2].className).toContain("flex-1");
    expect(sep.children[1].textContent).toBe("Vendredi 2 Février 2024");
    // Segments purement décoratifs : le lecteur d'écran n'annonce que la date.
    expect(sep.children[0].getAttribute("aria-hidden")).not.toBeNull();
    expect(sep.children[2].getAttribute("aria-hidden")).not.toBeNull();
    expect(sep.getAttribute("aria-label")).toBe("Vendredi 2 Février 2024");
  });

  it("non-régression regroupement : deux messages assistant consécutifs restent UN groupe sous un seul repère", () => {
    renderThread([
      userMessage("u1", "question", at(2024, 2, 2, 10)),
      assistantMessage("a1", "réponse 1", at(2024, 2, 2, 10, 1)),
      assistantMessage("a2", "réponse 2", at(2024, 2, 2, 10, 2)),
    ]);

    expect(separators()).toHaveLength(1);
    // Un seul en-tête « 🤖 RÉPONSE » → les deux messages forment bien un groupe.
    expect(screen.getAllByText("🤖 RÉPONSE")).toHaveLength(1);
    expect(screen.getByText("réponse 1")).toBeTruthy();
    expect(screen.getByText("réponse 2")).toBeTruthy();
  });

  it("lot antérieur : le repère du jour ancien apparaît après « Charger plus » (sans doublon)", () => {
    // 201 groupes (messages user isolés) : le plus ancien (jour 1) est masqué par
    // la fenêtre de rendu initiale (200 groupes), les 200 suivants sont du jour 2.
    const messages: DisplayMessage[] = [userMessage("g0", "jour un", at(2024, 2, 2, 8))];
    for (let i = 1; i <= 200; i++) messages.push(userMessage(`g${i}`, `message ${i}`, at(2024, 2, 3, 8)));
    renderThread(messages);

    // Fenêtre initiale : uniquement le jour 2 → un seul repère.
    expect(labels()).toEqual(["Samedi 3 Février 2024"]);
    expect(screen.queryByText("jour un")).toBeNull();

    fireEvent.click(screen.getByText(/Charger 1 message antérieur/));
    expect(screen.getByText("jour un")).toBeTruthy();

    // Le lot préfixé réconcilie les repères : jour 1 puis jour 2, une seule fois.
    expect(labels()).toEqual(["Vendredi 2 Février 2024", "Samedi 3 Février 2024"]);
    const [sepDay1, sepDay2] = separators();
    expect(precedes(sepDay1, screen.getByText("jour un"))).toBe(true);
    expect(precedes(sepDay1, screen.getByText("message 1"))).toBe(true);
    expect(precedes(screen.getByText("jour un"), sepDay2)).toBe(true);
  });
});

describe("séparateur de journée — mémoïsation des groupes inchangée", () => {
  it("re-render avec le MÊME tableau de messages → repères et groupes stables (aucun doublon)", () => {
    const messages = [
      userMessage("u1", "jour 1", at(2024, 2, 2, 9)),
      assistantMessage("a1", "réponse jour 1", at(2024, 2, 2, 9, 5)),
      userMessage("u2", "jour 2", at(2024, 2, 3, 9)),
    ];
    const view = renderThread(messages);
    expect(labels()).toEqual(["Vendredi 2 Février 2024", "Samedi 3 Février 2024"]);

    // Même référence de tableau : le cache d'identité des groupes est renvoyé
    // tel quel (perf streaming) — le rendu reste identique, pas de duplication.
    view.rerender(
      <I18nProvider>
        <Thread messages={messages} />
      </I18nProvider>,
    );
    expect(labels()).toEqual(["Vendredi 2 Février 2024", "Samedi 3 Février 2024"]);
    expect(screen.getByText("jour 1")).toBeTruthy();
    expect(screen.getByText("jour 2")).toBeTruthy();
  });
});
