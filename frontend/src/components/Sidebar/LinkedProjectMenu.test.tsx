// @vitest-environment jsdom
/**
 * Tests du LinkedProjectMenu — régression du bug « holaf-lib absent de la
 * liste “Lier un projet…” » : un projet déjà membre d'AUTRES groupes doit
 * rester proposable (badge « lié ×N »), seuls les doublons du groupe COURANT
 * et le projet lui-même sont exclus. Vérifie aussi le rafraîchissement des
 * projets à l'ouverture du picker et après une liaison.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { LinkedProjectMenu } from "./LinkedProjectMenu";
import type { Project } from "../../types";

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    storage: "local",
    versioning: "standalone",
    cwd: `/projects/${overrides.name}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Groupe cible : ne contient PAS holaf-lib.
const aiHelper = makeProject({ id: "a1", name: "AI-Helper" });
const comfyHelper = makeProject({ id: "a2", name: "ComfyUI-AI-Helper" });
const targetGroup = makeProject({
  id: "g-target",
  name: "LINKED AI Helper",
  storage: "linked",
  cwd: "/projects/LINKED AI Helper",
  linkedProjectIds: [aiHelper.id, comfyHelper.id],
});
// holaf-lib déjà membre de 2 AUTRES groupes.
const holafLib = makeProject({ id: "h1", name: "holaf-lib" });
const otherGroup1 = makeProject({
  id: "g-1",
  name: "Linked Homy et libs",
  storage: "linked",
  cwd: "/projects/Linked Homy et libs",
  linkedProjectIds: [makeProject({ id: "s1", name: "Homy" }).id, holafLib.id],
});
const otherGroup2 = makeProject({
  id: "g-2",
  name: "Yuki and Libs",
  storage: "linked",
  cwd: "/projects/Yuki and Libs",
  linkedProjectIds: [makeProject({ id: "s2", name: "Yuki" }).id, holafLib.id],
});
const unlinked = makeProject({ id: "u1", name: "Talky" });

const projects = [targetGroup, aiHelper, comfyHelper, holafLib, otherGroup1, otherGroup2, unlinked];

function renderMenu(props: {
  onClose?: () => void;
  onProjectsChanged?: () => void | Promise<void>;
  anchor: HTMLElement;
}) {
  return render(
    <I18nProvider>
      <LinkedProjectMenu
        project={targetGroup}
        projects={projects}
        anchor={props.anchor}
        onClose={props.onClose ?? (() => {})}
        onProjectsChanged={props.onProjectsChanged ?? (() => {})}
        showOrigins={false}
        onToggleShowOrigins={() => {}}
      />
    </I18nProvider>
  );
}

describe("LinkedProjectMenu — liste des candidats à lier", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem("pi-web-language", "en");
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("propose holaf-lib (déjà membre de 2 autres groupes) et signale la multi-appartenance", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    renderMenu({ anchor });

    // Entrée en mode pick.
    fireEvent.click(screen.getByText("Link a project\u2026"));
    expect(await screen.findByText("holaf-lib")).toBeTruthy();
    // Badge informatif : 2 autres groupes le contiennent déjà.
    expect(screen.getByText("linked \u00d72")).toBeTruthy();
    expect(screen.getByTitle(/"holaf-lib" is already grouped in 2 other linked project\(s\)/)).toBeTruthy();
    // Candidat sans autre appartenance : pas de badge.
    expect(screen.getByText("Talky")).toBeTruthy();
  });

  it("n'affiche pas les membres du groupe courant ni le projet lui-même", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    renderMenu({ anchor });

    fireEvent.click(screen.getByText("Link a project\u2026"));
    await screen.findByText("holaf-lib");

    expect(screen.queryByText("AI-Helper")).toBeNull();          // déjà membre du groupe courant
    expect(screen.queryByText("ComfyUI-AI-Helper")).toBeNull();  // déjà membre du groupe courant
    expect(screen.queryByText("LINKED AI Helper")).toBeNull();   // projet lui-même
    expect(screen.queryByText("Linked Homy et libs")).toBeNull(); // placeholder (pas d'imbrication)
    expect(screen.queryByText("Yuki and Libs")).toBeNull();       // placeholder (pas d'imbrication)
  });

  it("recharge la liste des projets à l'ouverture du picker (données fraîches)", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onProjectsChanged = vi.fn();
    renderMenu({ anchor, onProjectsChanged });

    expect(onProjectsChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Link a project\u2026"));
    expect(onProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it("lie le candidat (POST /linked) puis rafraîchit la liste et ferme le menu", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onProjectsChanged = vi.fn();
    const onClose = vi.fn();
    renderMenu({ anchor, onProjectsChanged, onClose });

    fireEvent.click(screen.getByText("Link a project\u2026"));
    fireEvent.click(await screen.findByText("holaf-lib"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onProjectsChanged).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/g-target/linked",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ subProjectId: "h1" }),
      })
    );
  });
});
