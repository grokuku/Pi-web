// @vitest-environment jsdom
/**
 * Tests du composant d'adaptation HolafIcon.
 *  - rend un unique `<svg>` racine pour un nom connu (compatibilité lucide) ;
 *  - respecte EXACTEMENT les tailles fines 9/10/12/14/16/20/32 (+ défaut) ;
 *  - transmet `className` jusqu'au SVG (animate-spin, couleurs, marges) ;
 *  - nom inconnu → ne rend rien et journalise une erreur claire ;
 *  - `title` → role="img" + aria-label (sinon décoratif/aria-hidden).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HolafIcon } from "./HolafIcon";

afterEach(cleanup);

describe("HolafIcon", () => {
  it("rend un <svg> unique pour un nom connu (style de la brique)", () => {
    const { container } = render(<HolafIcon name="gear" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(container.querySelectorAll("svg").length).toBe(1);
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    expect(svg!.getAttribute("stroke-width")).toBe("2");
    expect(svg!.getAttribute("fill")).toBe("none");
    expect(
      svg!.querySelector("circle, path, rect, line, polyline, polygon")
    ).not.toBeNull();
  });

  it("applique size exactement (9/10/12/14/16/20/32)", () => {
    for (const s of [9, 10, 12, 14, 16, 20, 32]) {
      const { container } = render(<HolafIcon name="check" size={s} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe(String(s));
      expect(svg.getAttribute("height")).toBe(String(s));
      cleanup();
    }
  });

  it("applique la taille par défaut (12) sans prop size", () => {
    const { container } = render(<HolafIcon name="x" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("12");
    expect(svg.getAttribute("height")).toBe("12");
  });

  it("transmet className jusqu'au SVG (animate-spin, couleurs)", () => {
    const { container } = render(
      <HolafIcon name="refresh" className="animate-spin text-hacker-accent" />
    );
    const svg = container.querySelector("svg")!;
    expect(svg.classList.contains("animate-spin")).toBe(true);
    expect(svg.classList.contains("text-hacker-accent")).toBe(true);
  });

  it("nom inconnu → ne rend rien et journalise une erreur", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<HolafIcon name="not-an-icon" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("title → role img + aria-label (sinon décoratif)", () => {
    const { container } = render(<HolafIcon name="x" title="Fermer" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Fermer");
    expect(svg.getAttribute("aria-hidden")).toBeNull();

    cleanup();
    const { container: c2 } = render(<HolafIcon name="x" />);
    expect(c2.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});
