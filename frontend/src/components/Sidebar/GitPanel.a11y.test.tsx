// @vitest-environment jsdom
/**
 * F18 — accessibilité : la section Git n'était pas atteignable au clavier.
 * L'en-tête repliable était un `<div role="button">` SANS `tabIndex` ni
 * `onKeyDown`. Il doit être un VRAI `<button>` (focusable nativement, activable
 * par Entrée/Espace) exposant son état via `aria-expanded`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { GitPanel } from "./GitPanel";
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
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  sessionStorage.clear();
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === "/api/projects/p1/git/status") {
        return jsonResponse({
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: [],
          modified: [],
          deleted: [],
          created: [],
          conflict: [],
          files: [],
          isClean: true,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function renderPanel() {
  const on = vi.fn(() => () => {});
  return render(
    <I18nProvider>
      <GitPanel project={makeProject("p1", "MainProj")} linkedProjects={[]} onRefresh={vi.fn()} on={on as any} />
    </I18nProvider>,
  );
}

describe("GitPanel — en-tête de section accessible au clavier (F18)", () => {
  it("l'en-tête est un VRAI <button> (focusable nativement), pas un div role=button", async () => {
    renderPanel();
    const header = await screen.findByRole("button", { name: /MainProj/ });
    expect(header.tagName).toBe("BUTTON");
    // Un <button> est focusable sans tabIndex explicite.
    expect(header.hasAttribute("tabindex")).toBe(false);
    header.focus();
    expect(document.activeElement).toBe(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("l'activation (clic / Entrée) déplie la section et met à jour aria-expanded", async () => {
    renderPanel();
    const header = await screen.findByRole("button", { name: /MainProj/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    await waitFor(() => expect(header.getAttribute("aria-expanded")).toBe("true"));
  });
});
