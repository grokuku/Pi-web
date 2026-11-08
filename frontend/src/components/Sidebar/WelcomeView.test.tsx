// @vitest-environment jsdom
/**
 * F08 — RÈGLE PROJET « l'interface doit utiliser TOUTE la largeur disponible ».
 * L'écran d'accueil était une colonne étroite centrée (`items-center
 * justify-center` + `w-full max-w-2xl`, ~672 px) : sur un 1920 px, deux tiers
 * de la zone de travail étaient vides. Le conteneur racine doit désormais être
 * PLEINE LARGEUR (grille), le texte restant borné À L'INTÉRIEUR des cartes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { WelcomeView } from "./WelcomeView";
import type { Project } from "../../types";

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    storage: "local",
    versioning: "git",
    cwd: `/projects/${name}`,
    git: { remote: `https://github.com/example/${name}.git`, branch: "main", provider: "github", lastSync: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url === "/api/status") {
        return jsonResponse({
          piWebVersion: "1.0.0",
          piSdkVersion: "0.1.0",
          extensions: [],
          activeSessions: 0,
          uptimeSeconds: 10,
          projectsCount: 1,
          nodeVersion: "22",
        });
      }
      if (url === "/api/status/update") {
        return jsonResponse({ currentVersion: "1.0.0", latestVersion: "1.0.0", updateAvailable: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("WelcomeView — pleine largeur (F08)", () => {
  it("le conteneur racine n'est plus une colonne étroite centrée : aucun max-w-2xl, une grille pleine largeur", () => {
    const { container } = render(
      <I18nProvider>
        <WelcomeView projects={[makeProject("p1", "Alpha")]} onSelectProject={vi.fn()} onAddProject={vi.fn()} />
      </I18nProvider>,
    );

    const root = container.firstElementChild as HTMLElement;
    const inner = root.firstElementChild as HTMLElement;

    // Le racine ne doit ni borner sa largeur, ni centrer son contenu.
    expect(root.className).not.toMatch(/max-w-2xl/);
    expect(root.className).not.toMatch(/items-center/);
    expect(root.className).not.toMatch(/justify-center/);
    // Les DEUX niveaux (racine + conteneur de contenu) sont exempts de max-w-2xl.
    expect(inner.className).not.toMatch(/max-w-2xl/);

    // Contenu réparti en grille pleine largeur.
    expect(inner.className).toMatch(/\bgrid\b/);
    expect(inner.className).toMatch(/max-w-none/);
    expect(inner.className).toMatch(/grid-cols-1/);
  });

  it("le titre et la grille de projets restent rendus (lisibilité préservée)", async () => {
    render(
      <I18nProvider>
        <WelcomeView projects={[makeProject("p1", "Alpha")]} onSelectProject={vi.fn()} onAddProject={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByRole("heading", { name: "PI-WEB" })).toBeTruthy();
    expect(await screen.findByText("Alpha")).toBeTruthy();
  });
});
