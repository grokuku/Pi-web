// @vitest-environment jsdom
/**
 * Tests du GitAuthModal :
 *  - le message d'erreur RÉEL qui a déclenché l'ouverture est affiché
 *    (`initialError`) — il n'est plus perdu derrière le formulaire ;
 *  - un origin SSH est annoncé AVANT la saisie, avec la commande de conversion ;
 *  - le texte « stored in memory only » (FAUX : les identifiants sont persistés
 *    chiffrés) a été remplacé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { GitAuthModal } from "./GitAuthModal";
import type { Project } from "../../types";

function makeProject(remote: string): Project {
  return {
    id: "p1",
    name: "Yuki",
    storage: "local",
    versioning: "git",
    cwd: "/projects/Yuki",
    git: { remote, branch: "main", provider: "github", lastSync: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Project;
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderModal(project: Project, initialError?: string) {
  return render(
    <I18nProvider>
      <GitAuthModal project={project} onClose={vi.fn()} onConfigured={vi.fn()} initialError={initialError} />
    </I18nProvider>
  );
}

describe("GitAuthModal", () => {
  it("affiche la cause réelle de l'échec passée par le parent", () => {
    renderModal(makeProject("https://github.com/grokuku/Yuki.git"), "Git push authentication failed: 403 Bad credentials");
    expect(screen.getByText("Git push authentication failed: 403 Bad credentials")).toBeTruthy();
  });

  it("origin SSH → avertissement explicite + commande `git remote set-url`", () => {
    renderModal(makeProject("git@github.com:grokuku/Yuki.git"));
    expect(screen.getByText(/uses an/)).toBeTruthy();
    expect(screen.getByText("git remote set-url origin https://github.com/grokuku/Yuki.git")).toBeTruthy();
  });

  it("origin HTTPS → aucun avertissement SSH", () => {
    renderModal(makeProject("https://github.com/grokuku/Yuki.git"));
    expect(screen.queryByText(/git remote set-url/)).toBeNull();
  });

  it("ne prétend plus que les identifiants restent en mémoire seule", () => {
    renderModal(makeProject("https://github.com/grokuku/Yuki.git"));
    expect(screen.queryByText(/stored in memory only/i)).toBeNull();
    expect(screen.getByText(/saved encrypted/i)).toBeTruthy();
  });
});
