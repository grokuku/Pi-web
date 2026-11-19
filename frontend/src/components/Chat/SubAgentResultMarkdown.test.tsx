// @vitest-environment jsdom
// ── Corps markdown d'un `subagent_result` rendu par le composant PARTAGÉ ─────
// BUG (capture utilisateur) : la réponse d'un sous-agent (réinjectée par le
// backend dans un custom message `subagent_result`, cf.
// backend/src/pi/harness-result-delivery.ts#buildResultMessageContent) était
// rendue dans un simple `div` `whitespace-pre-wrap` → TEXTE BRUT. Le markdown
// produit par l'agent s'affichait donc VERBATIM dans le fil : puces non
// rendues, italique `*…*` brute, citations `>` brutes, tableau GFM affiché
// comme du texte (entêtes + rangées de séparateurs = « colonnes vides »).
//
// Correctif : le corps passe par `MarkdownContent` (react-markdown +
// remark-gfm, la SEULE bibliothèque de rendu du projet) et par la classe
// `prose-hacker`, comme les messages assistant et l'explorateur de fichiers.
//
// Ces tests verrouillent le rendu AU POINT DE RENDU RÉEL (GroupedMessages →
// UserBubble, le chemin du fil live ET de la relecture d'historique).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { I18nProvider } from "../../i18n";
import { GroupedMessages } from "./ChatView";
import type { DisplayMessage } from "../../types";
import { resetSubagentRuns } from "../../stores/subagentRuns";

/** Corps réaliste d'une réponse de sous-agent (markdown de bout en bout). */
const BODY = [
  "**Ce qu'il faudrait**",
  "",
  "- ⚠️ *Il lit la dernière position connue de `origin/main` …*",
  "- ⚠️ « À jour » = « rien à récupérer selon une photo périmée ».",
  "",
  "> « À jour » ne veut pas dire « synchronisé ».",
  "",
  "| Option | Coût | Risque |",
  "| --- | --- | --- |",
  "| fetch à l'ouverture | faible | réseau |",
  "| poll périodique | moyen | bruit |",
  "",
  "Voir `origin/main` pour le détail.",
].join("\n");

/** Contenu backend : en-tête « ### … » (porté par le bloc) + corps. */
const CONTENT = ["### Exécution (execute) — succès", "", BODY].join("\n");

function resultMessage(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "c-res-md",
    role: "user",
    content: CONTENT,
    thinking: "",
    toolCalls: [],
    timestamp: Date.now(),
    customType: "subagent_result",
    display: true,
    subagentResults: [
      {
        delegateRunId: "run-md",
        delegateFunction: "execute",
        label: "Exécution",
        status: "success",
        durationMs: 3_000,
        actionCount: 2,
      },
    ],
    ...over,
  };
}

/** Rend le fil RÉEL, corps DÉPLIÉ (réglage « détail déplié » actif). */
function renderResult(message: DisplayMessage) {
  const Thread = () => {
    const ref = useRef<HTMLDivElement | null>(null);
    return (
      <GroupedMessages
        messages={[message]}
        displayDetailExpanded
        onFileClick={() => {}}
        scrollContainerRef={ref}
        projectId="projet-test"
      />
    );
  };
  return render(
    <I18nProvider>
      <Thread />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  resetSubagentRuns();
});

afterEach(() => {
  cleanup();
  resetSubagentRuns();
});

describe("SubAgentResultMessage — le corps est du MARKDOWN RENDU", () => {
  it("rend les listes, l'italique, la citation, le tableau GFM, le code inline et le gras", () => {
    const { container } = renderResult(resultMessage());

    // Liste à puces : deux items, la ligne « - » consommée par le parseur.
    const ul = container.querySelector("ul");
    expect(ul).not.toBeNull();
    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(2);

    // Italique (le `*…*` du modèle devient <em>).
    expect(container.querySelectorAll("em").length).toBeGreaterThanOrEqual(1);

    // Citation `>`.
    expect(container.querySelector("blockquote")).not.toBeNull();

    // Tableau GFM 3 colonnes : entêtes ET cellules REMPLIES (jamais vides).
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    const ths = Array.from(table!.querySelectorAll("th"));
    expect(ths.map((th) => th.textContent)).toEqual(["Option", "Coût", "Risque"]);
    const rows = Array.from(table!.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      expect(cells).toHaveLength(3);
      for (const cell of cells) expect((cell.textContent || "").trim()).not.toBe("");
    }
    expect(table!.textContent).toContain("fetch à l'ouverture");

    // Code inline + gras.
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain("origin/main");
    expect(container.querySelector("strong")!.textContent).toContain("Ce qu'il faudrait");
  });

  it("ne laisse AUCUN markdown brut dans le corps rendu", () => {
    const { container } = renderResult(resultMessage());
    const text = container.textContent || "";
    // Marqueur de puce littéral, délimiteurs d'italique, citation et tuyaux de
    // tableau : tous consommés par le rendu.
    expect(text).not.toMatch(/(^|\n)\s*-\s⚠️/);
    expect(text).not.toContain("*Il lit");
    expect(text).not.toMatch(/(^|\n)> /);
    expect(text).not.toContain("| --- |");
  });

  it("n'affiche PAS deux fois la ligne d'en-tête « ### … » (déjà dans l'en-tête du bloc)", () => {
    const { container } = renderResult(resultMessage());
    // L'en-tête du bloc porte le libellé/statut…
    const headers = Array.from(container.querySelectorAll("[aria-expanded]"));
    expect(headers).toHaveLength(1);
    expect(headers[0].textContent).toContain("Exécution (execute)");
    // …et le corps ne le répète pas en `### …` brut.
    expect(container.textContent).not.toContain("###");
  });
});

describe("SubAgentResultMessage — aucun emoji injecté à la place d'une puce", () => {
  it("le ⚠️ du modèle reste DANS l'item, jamais substitué au marqueur", () => {
    const { container } = renderResult(resultMessage());

    // Le nombre d'emoji affichés est EXACTEMENT celui du contenu : aucun code
    // n'en ajoute (anti-régression du symptôme « ⚠️ à la place de la puce »).
    const sourceCount = (CONTENT.match(/⚠️/g) || []).length;
    const renderedCount = (container.textContent!.match(/⚠️/g) || []).length;
    expect(renderedCount).toBe(sourceCount);

    // Et chaque item commence par l'emoji du modèle : le marqueur de liste est
    // rendu par le CSS (`list-style-type`), pas remplacé par un emoji.
    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(2);
    for (const li of items) {
      expect((li.textContent || "").trimStart().startsWith("⚠️")).toBe(true);
    }
  });
});
