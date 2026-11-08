// @vitest-environment jsdom
/**
 * F11 (reste) — le formulaire de commit poussait encore des chaînes EN codées
 * en dur (`SUBJECT`, `BODY (optional)`, placeholders, « This will stage all
 * changes… ») et les compteurs du résumé (`staged` / `modified` / `new` /
 * `deleted`) restaient anglais en interface FR.
 * Ce test rend la modale en FRANÇAIS : aucune de ces chaînes EN ne doit
 * subsister, et les libellés FR doivent venir des clés i18n.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { CommitPushModal } from "./CommitPushModal";
import type { Project } from "../../types";

const project = {
  id: "p1",
  name: "MainProj",
  storage: "local",
  versioning: "git",
  cwd: "/projects/MainProj",
  git: { remote: "https://github.com/example/MainProj.git", branch: "main", provider: "github", lastSync: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Project;

const PREVIEW = {
  status: {
    staged: ["src/b.ts"],
    modified: ["src/a.ts"],
    deleted: ["src/c.ts"],
    created: ["src/d.ts"],
    files: [{ path: "src/a.ts", status: "M" }],
    isClean: false,
    ahead: 0,
    behind: 0,
  },
  proposedMessage: { subject: "Update src: a.ts", body: "" },
};

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "fr");
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
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/git/commit-push/preview")) return jsonResponse(PREVIEW);
    throw new Error(`unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderModal() {
  return render(
    <I18nProvider>
      <CommitPushModal project={project} onClose={vi.fn()} onDone={vi.fn()} />
    </I18nProvider>
  );
}

describe("CommitPushModal — libellés i18n (F11)", () => {
  it("affiche le formulaire en français, sans chaîne EN codée en dur", async () => {
    renderModal();

    // Libellés / placeholders issus des clés i18n.
    expect(await screen.findByText("SUJET")).toBeTruthy();
    expect(screen.getByText("CORPS (optionnel)")).toBeTruthy();
    expect(screen.getByPlaceholderText("Mise à jour : modifications")).toBeTruthy();
    expect(screen.getByPlaceholderText("Description détaillée des modifications…")).toBeTruthy();
    expect(screen.getByText(/Toutes les modifications seront indexées/)).toBeTruthy();

    // Aucune trace des anciennes chaînes anglaises.
    expect(screen.queryByText("SUBJECT")).toBeNull();
    expect(screen.queryByText("BODY (optional)")).toBeNull();
    expect(screen.queryByText(/This will stage all changes/)).toBeNull();
  });

  it("compteurs du résumé traduits (staged/modified/new/deleted)", async () => {
    renderModal();

    expect(await screen.findByText(/1 indexé/)).toBeTruthy();
    expect(screen.getByText(/1 modifié/)).toBeTruthy();
    expect(screen.getByText(/1 nouveau/)).toBeTruthy();
    expect(screen.getByText(/1 supprimé/)).toBeTruthy();

    expect(screen.queryByText(/\bstaged\b/)).toBeNull();
    expect(screen.queryByText(/\bmodified\b/)).toBeNull();
    expect(screen.queryByText(/\bdeleted\b/)).toBeNull();
  });
});
