// @vitest-environment jsdom
// ── Rendu : ligne d'état du composer (git + indicateur d'activité) ──────────
// Vérifie que « ça travaille » est VISIBLE et honnête pendant une délégation
// (aucun événement de texte de la session principale), que l'indicateur
// s'éteint au repos, que la pastille « stalled » est explicite et supprimée
// pendant une délégation active, et que `git:<branche>` reste affiché.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ChatStatusLine } from "./ChatStatusLine";
import { SubAgentControlsProvider } from "../../stores/subagentRuns";

function renderLine(props: Partial<ComponentProps<typeof ChatStatusLine>> = {}) {
  return render(
    <I18nProvider>
      <ChatStatusLine isStreaming={false} {...props} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
});

afterEach(() => {
  cleanup();
});

describe("ChatStatusLine — indicateur d'activité", () => {
  it("affiche « Delegation in progress… » sans événement texte (cas délégation)", () => {
    renderLine({ gitBranch: "main", subAgentActive: true, isStreaming: false, activity: null });
    expect(screen.getByText("Delegation in progress…")).toBeTruthy();
    // La branche git reste visible à côté de l'indicateur.
    expect(screen.getByText("git:main")).toBeTruthy();
  });

  it("affiche le libellé FR « Délégation en cours… » (parité fr/en)", () => {
    localStorage.setItem("pi-web-language", "fr");
    renderLine({ gitBranch: "main", subAgentActive: true });
    expect(screen.getByText("Délégation en cours…")).toBeTruthy();
  });

  it("session au repos : AUCUN indicateur (mais git:main conservé)", () => {
    renderLine({ gitBranch: "main", isStreaming: false, subAgentActive: false, activity: null });
    expect(screen.getByText("git:main")).toBeTruthy();
    expect(screen.queryByText("Delegation in progress…")).toBeNull();
    expect(screen.queryByText("In progress…")).toBeNull();
    expect(screen.queryByText("no activity for 60s")).toBeNull();
  });

  it("run principal en streaming : libellé de phase (réflexion)", () => {
    renderLine({ isStreaming: true, activity: { type: "thinking" } });
    expect(screen.getByText("Thinking…")).toBeTruthy();
    // Plus de libellé trompeur « Loading... ».
    expect(screen.queryByText("Loading...")).toBeNull();
  });

  it("délégation active : la pastille « stalled » ne s'affiche pas", () => {
    renderLine({ isStreaming: true, streamingStalled: true, subAgentActive: true });
    expect(screen.getByText("Delegation in progress…")).toBeTruthy();
    expect(screen.queryByText("no activity for 60s")).toBeNull();
  });

  it("run principal silencieux sans délégation : « no activity for 60s » (explicite)", () => {
    renderLine({ isStreaming: true, streamingStalled: true });
    expect(screen.getByText("no activity for 60s")).toBeTruthy();
  });

  it("subAgentActive → bouton « Stop all » qui arrête TOUS les runs via le contexte (LOT 1)", () => {
    const stop = vi.fn();
    render(
      <I18nProvider>
        <SubAgentControlsProvider value={{ stop }}>
          <ChatStatusLine isStreaming={false} subAgentActive />
        </SubAgentControlsProvider>
      </I18nProvider>,
    );
    screen.getByRole("button", { name: /Stop all/i }).click();
    // Aucun runId → arrêt GLOBAL du projet.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith();
  });

  it("aucune délégation active → AUCUN bouton « Stop all »", () => {
    renderLine({ isStreaming: false, subAgentActive: false });
    expect(screen.queryByRole("button", { name: /Stop all/i })).toBeNull();
  });
});
