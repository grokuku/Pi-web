// @vitest-environment jsdom
// ── Carte d'erreur fournisseur (C1 + C2) : regroupement, repli, Réessayer ──
// Verrouille le contrat AU POINT DE RENDU RÉEL (GroupedMessages → AssistantGroup
// → ProviderErrorCard, le même chemin que le fil live et PastConversationViewer) :
//  - N tentatives ratées du même tour → UN SEUL bloc (plus de pavés rouges) ;
//  - la dernière erreur est traduite en clair (modèle + fournisseur + réf.) ;
//  - le détail brut reste accessible via le repli commun (réglage global +
//    override par bloc) — jamais supprimé ;
//  - le bouton « Réessayer » appelle le renvoi avec l'ancre du tour ;
//  - quand une reprise a RÉUSSI : plus de carte rouge, note repliable SOUS la
//    réponse, contenu de la réponse intact.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { I18nProvider } from "../../i18n";
import { GroupedMessages } from "./ChatView";
import type { DisplayMessage } from "../../types";
import { resetSubagentRuns } from "../../stores/subagentRuns";

const ERR_A = '500: {"message":"Internal Server Error (ref: aaaa1111-bbbb-2222-cccc-333344445555)","type":"api_error"}';
const ERR_B = '500: {"message":"Internal Server Error (ref: dddd1111-eeee-2222-ffff-333344445555)","type":"api_error"}';
const ERR_C = '500: {"message":"Internal Server Error (ref: cccc1111-2222-3333-4444-555566667777)","type":"api_error"}';
const ERR_A3 = '500: {"message":"Internal Server Error (ref: aaaa9999-8888-7777-6666-555544443333)","type":"api_error"}';

function user(id: string): DisplayMessage {
  return { id, role: "user", content: "Explique-moi ce bug", thinking: "", toolCalls: [], timestamp: 1 };
}

function failedAttempt(id: string, ts: number, errorMessage = ERR_A): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "",
    thinking: "",
    toolCalls: [],
    timestamp: ts,
    stopReason: "error",
    errorMessage,
    provider: "ollama-cloud",
    model: "deepseek-v4.1-flash",
  };
}

function success(id: string, ts: number): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "Voici la réponse finale.",
    thinking: "",
    toolCalls: [],
    timestamp: ts,
    stopReason: "stop",
    blocks: [{ kind: "text", text: "Voici la réponse finale." }],
  };
}

function Thread({ messages, expanded, onRetry }: { messages: DisplayMessage[]; expanded: boolean; onRetry?: (id: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <GroupedMessages
      messages={messages}
      displayDetailExpanded={expanded}
      onFileClick={() => {}}
      scrollContainerRef={ref}
      projectId="projet-test"
      onRetry={onRetry}
    />
  );
}

function renderThread(messages: DisplayMessage[], expanded: boolean, onRetry?: (id: string) => void) {
  return render(
    <I18nProvider>
      <Thread messages={messages} expanded={expanded} onRetry={onRetry} />
    </I18nProvider>,
  );
}

/** Boutons d'en-tête repliables du fil (aria-expanded). */
function collapseHeaders(): HTMLElement[] {
  return screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"));
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  resetSubagentRuns();
});

afterEach(() => {
  cleanup();
  resetSubagentRuns();
});

describe("ProviderErrorCard — regroupement des tentatives (C1)", () => {
  const fourAttempts = [
    user("u1"),
    failedAttempt("a1", 1_000),
    failedAttempt("a2", 3_000, ERR_C),
    failedAttempt("a3", 7_000, ERR_A3),
    failedAttempt("a4", 15_000, ERR_B),
  ];

  it("4 tentatives ratées → UN SEUL bloc « Provider error », une seule range horaire", () => {
    renderThread(fourAttempts, false);
    expect(screen.getAllByText("Provider error")).toHaveLength(1);
    expect(screen.getByText(/4 attempts \(from .+ to .+\)/)).toBeTruthy();
    // Message pédagogique : modèle + fournisseur + référence de la DERNIÈRE erreur.
    expect(screen.getByText(/The model deepseek-v4\.1-flash on Ollama Cloud returned an internal error/)).toBeTruthy();
    expect(screen.getByText(/ref: dddd1111-eeee-2222-ffff-333344445555/)).toBeTruthy();
    // Le JSON brut n'est PAS supprimé : il est replié.
    expect(screen.queryByText(ERR_A)).toBeNull();
    expect(screen.queryByText(ERR_B)).toBeNull();
  });

  it("réglage « détail déplié par défaut » → détail brut visible (les N tentatives)", () => {
    renderThread(fourAttempts, true);
    expect(screen.getByText(ERR_A)).toBeTruthy();
    expect(screen.getByText(ERR_B)).toBeTruthy();
    expect(screen.getByText(/Attempt 4/)).toBeTruthy();
  });

  it("réglage replié → un clic sur le détail déplie (override par bloc mémorisé)", () => {
    renderThread(fourAttempts, false);
    const details = collapseHeaders().find((h) => h.textContent?.includes("Technical details"))!;
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(screen.getByText(ERR_A)).toBeTruthy();
    expect(screen.getByText(ERR_B)).toBeTruthy();
    expect(details.getAttribute("aria-expanded")).toBe("true");
  });

  it("une tentative isolée → « 1 attempt », sans range horaire", () => {
    renderThread([user("u1"), failedAttempt("a1", 1_000)], false);
    expect(screen.getAllByText("Provider error")).toHaveLength(1);
    expect(screen.getByText("1 attempt")).toBeTruthy();
  });
});

describe("ProviderErrorCard — bouton Réessayer (C2)", () => {
  it("déclenche le renvoi avec l'ancre du tour (1re tentative)", () => {
    const onRetry = vi.fn();
    renderThread([user("u1"), failedAttempt("a1", 1_000), failedAttempt("a2", 3_000)], false, onRetry);
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith("a1");
  });

  it("historique passé (consultation) : pas de bouton Réessayer", () => {
    renderThread([user("u1"), failedAttempt("a1", 1_000)], false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("échec AVEC contenu partiel : le contenu reste affiché + carte d'erreur", () => {
    const partial = { ...failedAttempt("a1", 1_000), content: "Début de réponse…" };
    renderThread([user("u1"), partial], false, vi.fn());
    expect(screen.getByText(/Début de réponse/)).toBeTruthy();
    expect(screen.getAllByText("Provider error")).toHaveLength(1);
  });
});

describe("Reprise réussie (C1) — le tour n'est pas présenté comme un échec", () => {
  const twoFailuresThenSuccess = [
    user("u1"),
    failedAttempt("a1", 1_000),
    failedAttempt("a2", 3_000, ERR_C),
    success("a3", 20_000),
  ];

  it("pas de carte rouge ; note repliable SOUS la réponse ; contenu intact", () => {
    renderThread(twoFailuresThenSuccess, false);
    expect(screen.queryByText("Provider error")).toBeNull();
    expect(screen.getByText("Voici la réponse finale.")).toBeTruthy();
    expect(screen.getByText(/2 failed attempts before this answer — see details/)).toBeTruthy();
    // Détail replié par défaut : brut caché, mais présent dans le DOM logique.
    expect(screen.queryByText(ERR_A)).toBeNull();
  });

  it("le détail des tentatives reste consultable (réglage déplié ou clic)", () => {
    renderThread(twoFailuresThenSuccess, true);
    expect(screen.getByText(ERR_A)).toBeTruthy();
    expect(screen.getByText(ERR_C)).toBeTruthy();
  });

  it("clic sur la note pour consulter le détail (blockId stable)", () => {
    renderThread(twoFailuresThenSuccess, false);
    const note = collapseHeaders().find((h) => h.textContent?.includes("failed attempts"))!;
    fireEvent.click(note);
    expect(screen.getByText(ERR_A)).toBeTruthy();
  });
});

describe("Classification visible — messages non techniques", () => {
  it("429 → message de limite de débit, pas de jargon JSON en tête", () => {
    renderThread([user("u1"), failedAttempt("a1", 1_000, "429 Limite de requêtes atteinte chez le fournisseur upstream.")], false);
    expect(screen.getByText(/temporarily limiting requests/)).toBeTruthy();
  });

  it("abort utilisateur → titre « Generation interrupted » (pas « Provider error »)", () => {
    renderThread([user("u1"), failedAttempt("a1", 1_000, "Request was aborted")], false);
    expect(screen.getByText("Generation interrupted")).toBeTruthy();
    expect(screen.queryByText("Provider error")).toBeNull();
  });

  it("nom lisible du fournisseur (C5) : « Ollama Cloud », jamais l'id technique", () => {
    const attempt = {
      ...failedAttempt(
        "a1",
        1_000,
        '500: {"message":"Internal Server Error (ref: b8415c7e-58d6-483c-87ea-5c863445578e)"}',
      ),
      provider: "provider_1779417542317_igjvu",
      providerName: "Ollama-Cloud",
    };
    renderThread([user("u1"), attempt], false);
    expect(screen.getByText(/on Ollama Cloud returned an internal error/)).toBeTruthy();
    // La ref affichée est EXACTEMENT celle de l'erreur brute (minuscules).
    expect(screen.getByText(/ref: b8415c7e-58d6-483c-87ea-5c863445578e/)).toBeTruthy();
    expect(screen.queryByText(/provider_1779417542317_igjvu/)).toBeNull();
    expect(screen.queryByText(/Provider 1779417542317/)).toBeNull();
  });

  it("id technique sans nom résolu → message SANS nom (jamais l'id brut)", () => {
    const attempt = {
      ...failedAttempt("a1", 1_000),
      provider: "provider_1779417542317_igjvu",
      providerName: undefined,
    };
    renderThread([user("u1"), attempt], false);
    expect(screen.getByText(/The model deepseek-v4\.1-flash returned an internal error/)).toBeTruthy();
    expect(screen.queryByText(/provider_1779417542317/)).toBeNull();
  });
});
