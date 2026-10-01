// @vitest-environment jsdom
/**
 * Tests du sélecteur de THÈME (ThemePicker) :
 *   • déclencheur : pastille + NOM du thème courant (plus de pastille anonyme) ;
 *   • panneau : mode segmenté Sombre/Clair, liste des 5 thèmes (ligne active
 *     encadrée + coche, badge DÉFAUT sur Matrix), puces de la bibliothèque
 *     holaf, toggle Scanlines conservé, note de migration ;
 *   • interactions : sélection d'un thème, changement de mode, scanlines ;
 *   • SYNCHRONISATION avec le bouton ☀/☾ du header (même état partagé).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ThemePicker, type ThemePickerProps } from "./ThemePicker";
import type { PiWebThemeId } from "../../theme/pi-web-theme";

function renderPicker(overrides: Partial<ThemePickerProps> = {}) {
  const props: ThemePickerProps = {
    theme: "dark",
    themeName: "matrix",
    scanlines: true,
    onThemeChange: vi.fn(),
    onModeChange: vi.fn(),
    onScanlinesToggle: vi.fn(),
    ...overrides,
  };
  const view = render(
    <I18nProvider>
      <ThemePicker {...props} />
    </I18nProvider>
  );
  const rerenderWith = (next: Partial<ThemePickerProps>) =>
    view.rerender(
      <I18nProvider>
        <ThemePicker {...props} {...next} />
      </I18nProvider>
    );
  return { props, rerenderWith };
}

/** Ouvre le panneau (le menu est porté dans <body> via createPortal). */
function openPanel() {
  fireEvent.click(screen.getByTestId("theme-picker-trigger"));
  return screen.getByTestId("theme-picker-panel");
}

function swatchOf(button: HTMLElement): string {
  const swatch = button.querySelector("span") as HTMLElement;
  return swatch.style.backgroundColor;
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "fr"); // libellés déterministes
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("déclencheur", () => {
  it("affiche le NOM du thème courant + sa pastille (fini la pastille anonyme)", () => {
    renderPicker();
    const trigger = screen.getByTestId("theme-picker-trigger");
    expect(screen.getByTestId("theme-picker-current").textContent).toBe("Matrix");
    expect(trigger.getAttribute("aria-label")).toContain("Matrix");
    expect(swatchOf(trigger)).toMatch(/00ff41|rgb\(0, 255, 65\)/i);
  });

  it("suit la prop themeName (autre thème → autre nom et autre pastille)", () => {
    const { rerenderWith } = renderPicker();
    rerenderWith({ themeName: "violet" as PiWebThemeId });
    expect(screen.getByTestId("theme-picker-current").textContent).toBe("Violet");
    expect(swatchOf(screen.getByTestId("theme-picker-trigger"))).toMatch(/c084fc|rgb\(192, 132, 252\)/i);
  });
});

describe("panneau", () => {
  it("présente titre, pack appliqué, mode, thèmes, bibliothèque, scanlines et note de migration", () => {
    renderPicker();
    expect(screen.queryByTestId("theme-picker-panel")).toBeNull();
    const panel = openPanel();
    expect(document.body.contains(panel)).toBe(true); // portail dans <body>
    expect(screen.getByText("THÈME")).toBeTruthy();
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("pi-web-green-dark");
    expect(screen.getByTestId("theme-mode-dark")).toBeTruthy();
    expect(screen.getByTestId("theme-mode-light")).toBeTruthy();
    for (const id of ["matrix", "violet", "orange", "cyan", "rose", "indigo", "emerald", "midnight", "slate", "amber"]) {
      expect(screen.getByTestId(`theme-option-${id}`), id).toBeTruthy();
    }
    expect(screen.getByText("BIBLIOTHÈQUE HOLAF")).toBeTruthy();
    expect(screen.getByTestId("theme-scanlines-toggle")).toBeTruthy();
    expect(screen.getByText(/Migration/)).toBeTruthy();
  });

  it("met la ligne Matrix en évidence : encadrée, cochée, badge DÉFAUT", () => {
    renderPicker();
    openPanel();
    const matrix = screen.getByTestId("theme-option-matrix");
    expect(matrix.getAttribute("aria-pressed")).toBe("true");
    expect(matrix.className).toContain("border-hacker-accent");
    expect(matrix.textContent).toContain("✓");
    expect(matrix.textContent).toContain("DÉFAUT");
    expect(matrix.textContent).toContain("pi-web-green-*");
    // Les autres lignes ne sont pas marquées.
    const violet = screen.getByTestId("theme-option-violet");
    expect(violet.getAttribute("aria-pressed")).toBe("false");
    expect(violet.textContent).not.toContain("DÉFAUT");
    expect(violet.textContent).not.toContain("✓");
  });

  it("remonte le thème choisi et déplace la sélection", () => {
    const { props, rerenderWith } = renderPicker();
    openPanel();
    fireEvent.click(screen.getByTestId("theme-option-violet"));
    expect(props.onThemeChange).toHaveBeenCalledWith("violet");
    rerenderWith({ themeName: "violet" as PiWebThemeId });
    expect(screen.getByTestId("theme-option-violet").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-option-matrix").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("pi-web-purple-dark");
  });

  it("sélectionne aussi un thème de la bibliothèque holaf", () => {
    const { props, rerenderWith } = renderPicker();
    openPanel();
    fireEvent.click(screen.getByTestId("theme-option-indigo"));
    expect(props.onThemeChange).toHaveBeenCalledWith("indigo");
    rerenderWith({ themeName: "indigo" as PiWebThemeId });
    expect(screen.getByTestId("theme-option-indigo").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("pi-web-lib-indigo-dark");
  });

  it("ferme au clic extérieur", () => {
    renderPicker();
    openPanel();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("theme-picker-panel")).toBeNull();
  });
});

describe("mode sombre / clair", () => {
  it("reflète le mode courant et remonte le changement", () => {
    const { props, rerenderWith } = renderPicker({ theme: "dark" });
    openPanel();
    expect(screen.getByTestId("theme-mode-dark").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-mode-light").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("theme-mode-light"));
    expect(props.onModeChange).toHaveBeenCalledWith("light");
    rerenderWith({ theme: "light" });
    expect(screen.getByTestId("theme-mode-light").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-mode-dark").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("pi-web-green-light");
  });
});

describe("scanlines (conservé)", () => {
  it("reflète l'état et notifie le toggle", () => {
    const { props, rerenderWith } = renderPicker({ scanlines: true });
    openPanel();
    const toggle = screen.getByTestId("theme-scanlines-toggle");
    expect(toggle.textContent).toContain("✓");
    fireEvent.click(toggle);
    expect(props.onScanlinesToggle).toHaveBeenCalledTimes(1);
    rerenderWith({ scanlines: false });
    expect(screen.getByTestId("theme-scanlines-toggle").textContent).not.toContain("✓");
  });
});

describe("synchronisation avec le bouton ☀/☾ du header", () => {
  /** Même état partagé que App.tsx : toggle ☀/☾ + ThemePicker. */
  function Harness() {
    const [mode, setMode] = useState<"dark" | "light">("dark");
    const [name, setName] = useState<PiWebThemeId>("matrix");
    const [scanlines, setScanlines] = useState(false);
    return (
      <I18nProvider>
        <button data-testid="mode-toggle" onClick={() => setMode((m) => (m === "dark" ? "light" : "dark"))}>
          {mode === "dark" ? "☀" : "☾"}
        </button>
        <ThemePicker
          theme={mode}
          themeName={name}
          scanlines={scanlines}
          onThemeChange={setName}
          onModeChange={setMode}
          onScanlinesToggle={() => setScanlines((s) => !s)}
        />
      </I18nProvider>
    );
  }

  it("passer en Clair dans le panneau bascule aussi le bouton ☀/☾", () => {
    render(<Harness />);
    expect(screen.getByTestId("mode-toggle").textContent).toBe("☀");
    fireEvent.click(screen.getByTestId("theme-picker-trigger"));
    fireEvent.click(screen.getByTestId("theme-mode-light"));
    expect(screen.getByTestId("mode-toggle").textContent).toBe("☾");
    expect(screen.getByTestId("theme-mode-light").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("pi-web-green-light");
  });

  it("le bouton ☀/☾ met à jour le mode affiché dans le panneau", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("theme-picker-trigger"));
    fireEvent.click(screen.getByTestId("mode-toggle"));
    expect(screen.getByTestId("mode-toggle").textContent).toBe("☾");
    expect(screen.getByTestId("theme-mode-light").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-mode-dark").getAttribute("aria-pressed")).toBe("false");
  });
});
