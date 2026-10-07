// @vitest-environment jsdom
/**
 * Tests du LayoutRenderer — focus sur l'ajout du 4e panneau SKILLS.
 *
 * Les presets 2/3 slots ne couvrent que 1 à 3 panneaux : avec 4 panneaux, le
 * renderer doit retomber sur une disposition plate à parts égales, tout en
 * continuant d'afficher les 4 slots (aucun panneau perdu, y compris quand le
 * preset mémorisé est une disposition composée type « 2 haut / 1 bas »).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LayoutRenderer } from "./LayoutRenderer";
import type { LayoutType, PanelId } from "../../types";

function renderLayout(orderedPanels: PanelId[], layoutType: LayoutType) {
  const panelContent = Object.fromEntries(
    (["pi", "terminal", "files", "skills"] as PanelId[]).map((id) => [
      id,
      <div data-testid={`content-${id}`}>{id}</div>,
    ]),
  ) as Record<PanelId, React.ReactNode>;
  return render(
    <LayoutRenderer
      orderedPanels={orderedPanels}
      layoutType={layoutType}
      sizes={{}}
      panelContent={panelContent}
      onSwap={vi.fn()}
      onDetach={vi.fn()}
      onNewWindow={vi.fn()}
      onSizesChange={vi.fn()}
    />,
  );
}

function dividerCount(): number {
  return document.querySelectorAll("div.cursor-col-resize, div.cursor-row-resize").length;
}

afterEach(() => cleanup());

describe("LayoutRenderer — 4 panneaux (dont SKILLS)", () => {
  it("affiche les 4 panneaux et un sélecteur par slot (3 séparateurs)", () => {
    renderLayout(["pi", "terminal", "files", "skills"], "horizontal-3");
    for (const id of ["pi", "terminal", "files", "skills"]) {
      expect(screen.getByTestId(`content-${id}`), id).toBeTruthy();
    }
    expect(screen.getAllByRole("combobox")).toHaveLength(4);
    expect(dividerCount()).toBe(3);
  });

  it("retombe sur une disposition plate quand le preset mémorisé est composé (3 slots)", () => {
    // top-2-bottom-1 ne connaît que 3 slots : avec 4 panneaux, les 4 doivent
    // rester rendus (repli plat vertical).
    renderLayout(["pi", "terminal", "files", "skills"], "top-2-bottom-1");
    for (const id of ["pi", "terminal", "files", "skills"]) {
      expect(screen.getByTestId(`content-${id}`), id).toBeTruthy();
    }
    expect(screen.getAllByRole("combobox")).toHaveLength(4);
    expect(dividerCount()).toBe(3);
    expect(document.querySelectorAll("div.cursor-row-resize")).toHaveLength(3);
  });

  it("conserve les dispositions composées pour 3 panneaux (non-régression)", () => {
    renderLayout(["pi", "terminal", "files"], "top-2-bottom-1");
    for (const id of ["pi", "terminal", "files"]) {
      expect(screen.getByTestId(`content-${id}`), id).toBeTruthy();
    }
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
  });

  it("panneau unique : pas d'en-tête de slot, contenu affiché", () => {
    renderLayout(["skills"], "horizontal-2");
    expect(screen.getByTestId("content-skills")).toBeTruthy();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(dividerCount()).toBe(0);
  });
});
