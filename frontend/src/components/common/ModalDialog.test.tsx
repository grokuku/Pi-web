// @vitest-environment jsdom
/**
 * F02 — accessibilité des modales (correction CENTRALE, ModalDialog est partagé
 * par toutes les modales) :
 *  - focus initial posé sur le premier élément focusable ;
 *  - piège à Tab (dernier → premier) et Shift+Tab (premier → dernier) ;
 *  - focus rendu au déclencheur à la fermeture.
 * Et F09 — la géométrie restaurée est bornée à la fenêtre (montage + resize).
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ModalDialog } from "./ModalDialog";

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  return (
    <I18nProvider>
      <button type="button" data-testid="trigger">Open</button>
      <ModalDialog id="new-chat-confirm" onClose={onClose} ariaLabel="Test dialog">
        <button type="button">First</button>
        <button type="button">Second</button>
        <button type="button">Last</button>
      </ModalDialog>
    </I18nProvider>
  );
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
  vi.restoreAllMocks();
});

describe("ModalDialog — gestion du focus (F02)", () => {
  it("pose le focus sur le premier élément focusable à l'ouverture", () => {
    render(<Harness />);
    expect(document.activeElement?.textContent).toBe("First");
  });

  it("Tab depuis le dernier élément revient au premier (piège à Tab)", () => {
    render(<Harness />);
    const last = screen.getByText("Last");
    last.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("First");
  });

  it("Shift+Tab depuis le premier élément repart au dernier", () => {
    render(<Harness />);
    const first = screen.getByText("First");
    first.focus();

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.textContent).toBe("Last");
  });

  it("rend le focus au déclencheur à la fermeture", () => {
    function Closable() {
      const [open, setOpen] = useState(false);
      return (
        <I18nProvider>
          <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>Open</button>
          {open && (
            <ModalDialog id="new-chat-confirm" onClose={() => setOpen(false)} ariaLabel="Test dialog">
              <button type="button">First</button>
              <button type="button" onClick={() => setOpen(false)}>Close</button>
            </ModalDialog>
          )}
        </I18nProvider>
      );
    }
    render(<Closable />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.click(trigger);
    // La modale a pris le focus.
    expect(document.activeElement?.textContent).toBe("First");
    // Fermeture : le focus revient au DÉCLENCHEUR.
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("ModalDialog — géométrie bornée à la fenêtre (F09)", () => {
  it("une géométrie persistée hors écran est ramenée DANS la fenêtre au montage", () => {
    localStorage.setItem(
      "pi-web-modal-geometry",
      JSON.stringify({ "new-chat-confirm": { x: 5000, y: 4000, w: 4000, h: 3000 } }),
    );
    render(<Harness />);
    const box = screen.getByRole("dialog") as HTMLElement;
    const left = Number.parseFloat(box.style.left);
    const top = Number.parseFloat(box.style.top);
    const width = Number.parseFloat(box.style.width);
    const height = Number.parseFloat(box.style.height);

    expect(width).toBeLessThanOrEqual(window.innerWidth);
    expect(height).toBeLessThanOrEqual(window.innerHeight);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    // La modale est ENTIÈREMENT visible : x + w tient dans la fenêtre.
    expect(left + width).toBeLessThanOrEqual(window.innerWidth);
    expect(top + height).toBeLessThanOrEqual(window.innerHeight);
  });

  it("un resize plus petit rebornne la modale ouverte (jamais hors écran)", () => {
    render(<Harness />);
    const box = screen.getByRole("dialog") as HTMLElement;

    const originalW = window.innerWidth;
    const originalH = window.innerHeight;
    // Fenêtre réduite (grand écran → portable).
    Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 400, configurable: true });
    fireEvent(window, new Event("resize"));

    const left = Number.parseFloat(box.style.left);
    const width = Number.parseFloat(box.style.width);
    const top = Number.parseFloat(box.style.top);
    const height = Number.parseFloat(box.style.height);
    expect(width).toBeLessThanOrEqual(600);
    expect(height).toBeLessThanOrEqual(400);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(600);
    expect(top + height).toBeLessThanOrEqual(400);

    Object.defineProperty(window, "innerWidth", { value: originalW, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: originalH, configurable: true });
  });
});
