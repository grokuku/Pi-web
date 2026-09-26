// @vitest-environment jsdom
/**
 * Tests du ProjectSwitcher (sélecteur GÉNÉRAL de projets de la sidebar) —
 * case « Masquer les projets déjà liés à un groupe » : cochée par défaut sous
 * le champ de recherche, elle retire les projets membres d'un groupe lié ;
 * les projets liés eux-mêmes et le projet actif restent TOUJOURS listés.
 * Vérifie aussi la recherche (cumulée à la case), le reset de la case à
 * chaque ouverture et la navigation vers le projet choisi.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ProjectSwitcher } from "./ProjectSwitcher";
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

// Scénario aligné sur la liste réelle (capture user) : projets de base, trois
// groupes liés — holaf-lib est membre de DEUX groupes — et un projet libre.
const aiHelper = makeProject({ id: "a1", name: "AI-Helper" });
const comfyHelper = makeProject({ id: "a2", name: "ComfyUI-AI-Helper" });
const holafLib = makeProject({ id: "h1", name: "holaf-lib" });
const homy = makeProject({ id: "m1", name: "Homy" });
const yuki = makeProject({ id: "y1", name: "Yuki" });
const aiHelperGroup = makeProject({
  id: "g-target",
  name: "LINKED AI Helper",
  storage: "linked",
  cwd: "/projects/LINKED AI Helper",
  linkedProjectIds: [aiHelper.id, comfyHelper.id],
});
const homyGroup = makeProject({
  id: "g-1",
  name: "Linked Homy et libs",
  storage: "linked",
  cwd: "/projects/Linked Homy et libs",
  linkedProjectIds: [homy.id, holafLib.id],
});
const yukiGroup = makeProject({
  id: "g-2",
  name: "Yuki and Libs",
  storage: "linked",
  cwd: "/projects/Yuki and Libs",
  linkedProjectIds: [yuki.id, holafLib.id],
});
const talky = makeProject({ id: "u1", name: "Talky" });

const projects = [
  aiHelperGroup,
  homyGroup,
  yukiGroup,
  aiHelper,
  comfyHelper,
  holafLib,
  homy,
  yuki,
  talky,
];

function renderSwitcher(opts?: {
  active?: Project | null;
  onSelectProject?: (p: Project) => void;
}) {
  return render(
    <I18nProvider>
      <ProjectSwitcher
        projects={projects}
        activeProject={opts?.active === undefined ? talky : opts.active}
        onSelectProject={opts?.onSelectProject ?? (() => {})}
        onDeleteProject={() => {}}
      />
    </I18nProvider>
  );
}

/** Ouvre le dropdown (bouton ancre « Switch project »). */
function openSwitcher() {
  fireEvent.click(screen.getByTitle("Switch project"));
}

describe("ProjectSwitcher — case « masquer les projets déjà liés »", () => {
  beforeEach(() => {
    localStorage.setItem("pi-web-language", "en");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("affiche la case SOUS le champ de recherche, cochée par défaut avec le compteur de masqués", async () => {
    renderSwitcher();
    openSwitcher();

    const searchInput = await screen.findByLabelText("Search a project\u2026");
    const checkbox = screen.getByTestId("switcher-hide-already-linked") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    // Ordre du DOM : la case vient APRÈS le champ de recherche.
    expect(searchInput.compareDocumentPosition(checkbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 5 projets de base sont membres d'un groupe lié (holaf-lib compté 1 fois).
    expect(screen.getByText(/5 hidden/)).toBeTruthy();

    // Case cochée : les membres sont masqués…
    expect(screen.queryByText("holaf-lib")).toBeNull();
    expect(screen.queryByText("AI-Helper")).toBeNull();
    expect(screen.queryByText("ComfyUI-AI-Helper")).toBeNull();
    expect(screen.queryByText("Homy")).toBeNull();
    expect(screen.queryByText("Yuki")).toBeNull();
    // …mais les projets liés (entrées de premier niveau) et les projets libres restent.
    expect(screen.getByText("LINKED AI Helper")).toBeTruthy();
    expect(screen.getByText("Linked Homy et libs")).toBeTruthy();
    expect(screen.getByText("Yuki and Libs")).toBeTruthy();
    // « Talky » apparaît aussi dans le bouton ancre (projet actif) : on cible
    // la ligne du dropdown par son rôle.
    expect(screen.getByRole("option", { name: "Talky" })).toBeTruthy();
  });

  it("décocher fait réapparaître les membres, recocher les retire", () => {
    renderSwitcher();
    openSwitcher();

    const checkbox = screen.getByTestId("switcher-hide-already-linked") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText("holaf-lib")).toBeTruthy();
    expect(screen.getByText("AI-Helper")).toBeTruthy();
    expect(screen.getByText("Homy")).toBeTruthy();
    expect(screen.queryByText(/hidden/)).toBeNull();

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(screen.queryByText("holaf-lib")).toBeNull();
    expect(screen.getByText(/5 hidden/)).toBeTruthy();
  });

  it("le projet ACTIF membre d'un groupe reste visible et marqué, case cochée", () => {
    renderSwitcher({ active: holafLib });
    openSwitcher();

    const checkbox = screen.getByTestId("switcher-hide-already-linked") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    // Ligne active présente (✓) malgré son appartenance à 2 groupes.
    const activeOption = screen.getByRole("option", { name: /holaf-lib/ });
    expect(activeOption.getAttribute("aria-selected")).toBe("true");
    // Le projet actif n'est pas compté comme masqué : 4 autres membres le sont.
    expect(screen.getByText(/4 hidden/)).toBeTruthy();
  });

  it("la recherche fonctionne dans les deux états et se cumule avec la case", async () => {
    renderSwitcher();
    openSwitcher();

    const searchInput = await screen.findByLabelText("Search a project\u2026");
    const checkbox = screen.getByTestId("switcher-hide-already-linked") as HTMLInputElement;

    // Case cochée : holaf-lib masqué même si la recherche porte sur son nom.
    fireEvent.change(searchInput, { target: { value: "holaf" } });
    expect(screen.queryByText("holaf-lib")).toBeNull();
    expect(screen.getByText("No match")).toBeTruthy();

    // Décochée : la recherche le retrouve.
    fireEvent.click(checkbox);
    expect(screen.getByText("holaf-lib")).toBeTruthy();
    expect(screen.queryByText("No match")).toBeNull();

    // Recocher + recherche sur un membre : le membre reste masqué, son groupe
    // lié (qui contient le terme dans son nom) reste listé.
    fireEvent.click(checkbox);
    fireEvent.change(searchInput, { target: { value: "Homy" } });
    expect(screen.queryByText("Homy")).toBeNull();
    expect(screen.getByText("Linked Homy et libs")).toBeTruthy();

    // Décochée, la recherche le fait réapparaître ; elle filtre toujours.
    fireEvent.click(checkbox);
    expect(screen.getByText("Homy")).toBeTruthy();
    fireEvent.change(searchInput, { target: { value: "zzz" } });
    expect(screen.queryByText("Homy")).toBeNull();
    expect(screen.getByText("No match")).toBeTruthy();
  });

  it("recrée la case cochée (et vide la recherche) à chaque ouverture", async () => {
    renderSwitcher();
    openSwitcher();

    const checkbox = screen.getByTestId("switcher-hide-already-linked") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Search a project\u2026"), { target: { value: "Talky" } });

    // Fermeture puis réouverture : l'état par défaut (cochée, recherche vide)
    // est recréé — le dropdown n'est pas démonté, ce reset est donc explicite.
    openSwitcher();
    openSwitcher();
    const reopened = (await screen.findByTestId("switcher-hide-already-linked")) as HTMLInputElement;
    expect(reopened.checked).toBe(true);
    expect((screen.getByLabelText("Search a project\u2026") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("holaf-lib")).toBeNull();
  });

  it("sélectionner un projet navigue puis ferme le dropdown (non-régression)", () => {
    const onSelectProject = vi.fn();
    renderSwitcher({ active: null, onSelectProject });
    openSwitcher();

    fireEvent.click(screen.getByText("Talky"));
    expect(onSelectProject).toHaveBeenCalledTimes(1);
    expect(onSelectProject.mock.calls[0][0].id).toBe(talky.id);
    expect(screen.queryByLabelText("Search a project\u2026")).toBeNull();
  });

  /** Noms affichés, dans l'ordre du DOM (options du dropdown). */
  function optionNames(): string[] {
    return screen.getAllByRole("option").map((el) => el.textContent ?? "");
  }

  it("affiche les projets par ordre alphabétique insensible à la casse (après filtres)", () => {
    renderSwitcher();
    openSwitcher();

    // Case cochée : groupes liés + projet actif/libre, triés alphabétiquement.
    // « LINKED AI Helper » avant « Linked Homy et libs » (casse ignorée),
    // et « Talky » avant « Yuki and Libs ».
    expect(optionNames()).toEqual([
      "LINKED AI Helper",
      "Linked Homy et libs",
      "Talky",
      "Yuki and Libs",
    ]);

    // Case décochée : tous les projets, toujours triés (holaf-lib entre
    // ComfyUI-AI-Helper et Homy).
    fireEvent.click(screen.getByTestId("switcher-hide-already-linked"));
    expect(optionNames()).toEqual([
      "AI-Helper",
      "ComfyUI-AI-Helper",
      "holaf-lib",
      "Homy",
      "LINKED AI Helper",
      "Linked Homy et libs",
      "Talky",
      "Yuki",
      "Yuki and Libs",
    ]);
  });

  it("applique le tri APRÈS la recherche (résultat filtré et ordonné)", async () => {
    renderSwitcher();
    openSwitcher();

    // Recherche « i » (casse ignorée) sur la liste complète (case décochée).
    fireEvent.click(screen.getByTestId("switcher-hide-already-linked"));
    fireEvent.change(await screen.findByLabelText("Search a project\u2026"), { target: { value: "i" } });
    const names = optionNames();
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" })));
    expect(names).toContain("holaf-lib");
    expect(names).not.toContain("Talky");
  });
});
