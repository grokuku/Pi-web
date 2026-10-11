// @vitest-environment jsdom
/**
 * Tests — LibrySection (réglages du service Libry + interrupteur du libraire).
 *
 * Contrat verrouillé, identique aux blocs WebClaw/Tavily de SettingsModal :
 *  - la clé API n'est JAMAIS préremplie (champ vide au chargement) et n'est PAS
 *    envoyée au POST quand le champ est vide (keep-if-absent) ;
 *  - l'interrupteur envoie librarianBackend "libry" | "local" et le backend
 *    ACTIF affiché vient de la valeur effective renvoyée par le serveur (pas
 *    d'état optimiste) ;
 *  - une valeur pilotée par l'environnement est signalée à l'utilisateur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../../i18n";
import LibrySection from "./LibrySection";

vi.mock("../../../utils/holaf-toast", () => ({ toast: vi.fn() }));

const PUBLIC_CONFIG = {
  url: "http://libry:3007",
  hasApiKey: true,
  apiKeyPreview: "••••abcd",
  librarianBackend: "local",
  urlFromEnv: false,
  apiKeyFromEnv: false,
  backendFromEnv: false,
};

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as unknown as Response;
}

/** GET → `get`, POST → `post` (idempotent : insensible aux rendus multiples). */
function stubFetch(get: unknown, post: unknown) {
  const mock = vi.fn(async (_url: string, init?: RequestInit) =>
    jsonResponse(init?.method === "POST" ? post : get),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function postBodies(mock: ReturnType<typeof vi.fn>): any[] {
  return mock.mock.calls
    .filter((c: any[]) => c[1]?.method === "POST")
    .map((c: any[]) => JSON.parse(c[1].body));
}

function renderSection() {
  return render(
    <I18nProvider>
      <LibrySection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en"); // libellés déterministes
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LibrySection", () => {
  it("charge la config : URL effective, clé jamais préremplie (aperçu masqué), backend actif affiché", async () => {
    const mock = stubFetch(PUBLIC_CONFIG, PUBLIC_CONFIG);
    renderSection();

    await screen.findByDisplayValue("http://libry:3007");
    const key = screen.getByTestId("libry-api-key") as HTMLInputElement;
    expect(key.value).toBe(""); // jamais préremplie
    expect(key.placeholder).toBe("••••abcd"); // aperçu masqué seul
    expect(screen.getByTestId("libry-active-backend").textContent).toContain("Pi-Web (local)");
    expect(mock.mock.calls[0][0]).toBe("/api/settings/libry");
  });

  it("bascule sur Libry puis enregistre : POST sans apiKey (champ vide = clé conservée)", async () => {
    const mock = stubFetch(PUBLIC_CONFIG, { ...PUBLIC_CONFIG, librarianBackend: "libry" });
    renderSection();
    await screen.findByDisplayValue("http://libry:3007");

    fireEvent.click(screen.getByTestId("libry-backend-libry"));
    fireEvent.click(screen.getByText("SAVE"));

    await waitFor(() => expect(postBodies(mock).length).toBe(1));
    expect(postBodies(mock)[0]).toEqual({ url: "http://libry:3007", librarianBackend: "libry" });
    // Le backend actif reflète la valeur effective renvoyée par le serveur.
    await waitFor(() =>
      expect(screen.getByTestId("libry-active-backend").textContent).toContain("Libry service"),
    );
  });

  it("une clé saisie est envoyée au POST, puis le champ est vidé (jamais réaffichée)", async () => {
    const mock = stubFetch(PUBLIC_CONFIG, { ...PUBLIC_CONFIG, apiKeyPreview: "••••wxyz" });
    renderSection();
    await screen.findByDisplayValue("http://libry:3007");

    fireEvent.change(screen.getByTestId("libry-api-key"), { target: { value: "secret_key_wxyz" } });
    fireEvent.click(screen.getByText("SAVE"));

    await waitFor(() => expect(postBodies(mock).length).toBe(1));
    expect(postBodies(mock)[0]).toEqual({
      url: "http://libry:3007",
      librarianBackend: "local",
      apiKey: "secret_key_wxyz",
    });
    const key = screen.getByTestId("libry-api-key") as HTMLInputElement;
    await waitFor(() => expect(key.value).toBe(""));
    expect(key.placeholder).toBe("••••wxyz");
  });

  it("signale les valeurs gérées par l'environnement (URL et clé)", async () => {
    stubFetch(
      { ...PUBLIC_CONFIG, url: "http://env-libry:3007", urlFromEnv: true, apiKeyFromEnv: true },
      PUBLIC_CONFIG,
    );
    renderSection();

    await screen.findByDisplayValue("http://env-libry:3007");
    expect(screen.getAllByText("Managed by environment").length).toBe(2);
  });
});
