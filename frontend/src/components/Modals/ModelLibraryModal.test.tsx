// @vitest-environment jsdom
/**
 * Tests de régression — ProvidersTab (ModelLibraryModal).
 *
 * Défaut corrigé : le panneau d'édition partageait son état entre providers
 * (pas de `key`, pas de resynchronisation) → passer de ✎A à ✎B conservait les
 * valeurs de A et le PUT sur l'id de B envoyait le payload de A. De plus,
 * « Ajouter » testé en premier restait actif → POST (doublon) au lieu de PUT.
 *
 * On rend `ProvidersTab` seul (pas de fetch au montage) avec un `fetch` simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ProvidersTab } from "./ModelLibraryModal";
import type { ProviderConfig } from "../../types";

// ── Providers de test (type ollama → pas de champ apiKey dans le panneau) ──
const providerA: ProviderConfig = {
  id: "pa",
  name: "Alpha",
  type: "ollama",
  baseUrl: "http://a.local/v1",
  maxConcurrentCalls: 2,
  discoveredModels: [],
  connectionStatus: "untested",
};
const providerB: ProviderConfig = {
  id: "pb",
  name: "Beta",
  type: "ollama",
  baseUrl: "http://b.local/v1",
  maxConcurrentCalls: 7,
  discoveredModels: [],
  connectionStatus: "untested",
};

/** Récupère le bouton ✎ de la carte portant `name` (ordre : TEST, ✎, 🗑). */
function editButtonFor(name: string): HTMLButtonElement {
  const row = screen.getByText(name).closest("div.flex");
  if (!row) throw new Error(`carte introuvable pour ${name}`);
  const buttons = row.querySelectorAll("button");
  return buttons[1] as HTMLButtonElement;
}

function fetchCalls(): Array<{ url: string; method: string; body: any }> {
  return (globalThis.fetch as any).mock.calls.map((c: any[]) => ({
    url: c[0],
    method: c[1]?.method ?? "GET",
    body: c[1]?.body ? JSON.parse(c[1].body) : undefined,
  }));
}

function renderTab(providers: ProviderConfig[] = [providerA, providerB]) {
  return render(
    <I18nProvider>
      <ProvidersTab providers={providers} setProviders={vi.fn()} setError={vi.fn()} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? "GET";
      // Réponse de mutation : renvoie un provider cohérent avec l'id visé.
      const id = String(url).split("/").pop();
      const base = id === providerB.id ? providerB : providerA;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...base,
          ...(init?.body ? JSON.parse(init.body) : {}),
          hasApiKey: false,
        }),
      };
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProvidersTab — pas de mélange d'état entre providers", () => {
  it("ouvrir ✎ sur A puis ✎ sur B affiche bien la fiche de B", () => {
    const { container } = renderTab();

    fireEvent.click(editButtonFor("Alpha"));
    expect((screen.getByPlaceholderText("My Provider") as HTMLInputElement).value).toBe("Alpha");

    // Bascule vers B SANS fermer le panneau : le composant doit être remonté.
    fireEvent.click(editButtonFor("Beta"));
    expect((screen.getByPlaceholderText("My Provider") as HTMLInputElement).value).toBe("Beta");
    expect((screen.getByDisplayValue(providerB.baseUrl) as HTMLInputElement).value).toBe(providerB.baseUrl);
    expect((container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe("7");
  });

  it("enregistrer après ✎A→✎B fait un PUT sur l'id de B avec le payload de B", () => {
    renderTab();

    fireEvent.click(editButtonFor("Alpha"));
    fireEvent.click(editButtonFor("Beta"));
    fireEvent.click(screen.getByText("SAVE"));

    const mutation = fetchCalls().find((c) => c.method !== "GET")!;
    expect(mutation.method).toBe("PUT");
    expect(mutation.url).toBe("/api/providers/pb");
    expect(mutation.body).toMatchObject({
      name: "Beta",
      type: "ollama",
      baseUrl: "http://b.local/v1",
      maxConcurrentCalls: 7,
    });
    // Le payload de A ne doit JAMAIS fuiter.
    expect(JSON.stringify(mutation.body)).not.toContain("Alpha");
    expect(JSON.stringify(mutation.body)).not.toContain("a.local");
  });
});

describe("ProvidersTab — « Ajouter » et « Modifier » mutuellement exclusifs", () => {
  it("ajout puis ✎ effectue un PUT (pas de POST / doublon)", () => {
    renderTab();

    fireEvent.click(screen.getByText("ADD PROVIDER").closest("button")!); // ouvre le panneau d'ajout
    fireEvent.click(editButtonFor("Beta")); // bascule vers l'édition de B
    fireEvent.click(screen.getByText("SAVE"));

    const mutations = fetchCalls().filter((c) => c.method !== "GET");
    expect(mutations).toHaveLength(1);
    expect(mutations[0].method).toBe("PUT");
    expect(mutations[0].url).toBe("/api/providers/pb");
    expect(mutations.some((m) => m.method === "POST")).toBe(false);
  });

  it("les panneaux « Ajouter » et « Modifier » ne peuvent pas coexister", () => {
    renderTab();

    fireEvent.click(screen.getByText("ADD PROVIDER").closest("button")!);
    expect(screen.getByText("ADD PROVIDER")).toBeTruthy(); // en-tête du panneau d'ajout

    fireEvent.click(editButtonFor("Alpha"));
    expect(screen.getByText("EDIT PROVIDER")).toBeTruthy();
    // Le panneau d'ajout a été refermé (son en-tête/bouton n'existe plus).
    expect(screen.queryByText("ADD PROVIDER")).toBeNull();
  });

  it("annuler puis réouvrir repart de la bonne source", () => {
    const { container } = renderTab();

    fireEvent.click(editButtonFor("Alpha"));
    fireEvent.click(screen.getByText("CANCEL"));
    fireEvent.click(editButtonFor("Beta"));

    expect((screen.getByPlaceholderText("My Provider") as HTMLInputElement).value).toBe("Beta");
    expect((container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe("7");
  });
});
