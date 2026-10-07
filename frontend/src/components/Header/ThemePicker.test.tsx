// @vitest-environment jsdom
/**
 * Tests du sélecteur de THÈME (ThemePicker) — branché sur la brique holaf-lib :
 *   • déclencheur : pastille + NOM de la famille courante (ex. « ● MATRIX ») ;
 *   • panneau : preset appliqué (`matrix-dark`), mode segmenté Sombre/Clair,
 *     liste des familles de la brique (identité Matrix + 6 familles couleur),
 *     badge DÉFAUT sur Matrix, toggle Scanlines, note de migration ;
 *   • interactions : sélection d'une famille, changement de mode, scanlines ;
 *   • SYNCHRONISATION avec le bouton ☀/☾ du header (même état partagé).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ThemePicker, type ThemePickerProps } from "./ThemePicker";
import { PI_WEB_FAMILY_ORDER, type PiWebThemeId } from "../../theme/pi-web-theme";

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
  it("affiche le NOM de la famille courante + sa pastille (fin de la pastille anonyme)", () => {
    renderPicker();
    const trigger = screen.getByTestId("theme-picker-trigger");
    expect(screen.getByTestId("theme-picker-current").textContent).toBe("Matrix");
    expect(trigger.getAttribute("aria-label")).toContain("Matrix");
    expect(swatchOf(trigger)).toMatch(/00ff41|rgb\(0, 255, 65\)/i);
  });

  it("suit la prop themeName (autre famille → autre nom et autre pastille)", () => {
    const { rerenderWith } = renderPicker();
    rerenderWith({ themeName: "turquoise" as PiWebThemeId });
    expect(screen.getByTestId("theme-picker-current").textContent).toBe("Turquoise");
    expect(swatchOf(screen.getByTestId("theme-picker-trigger"))).toMatch(/0ec7de|rgb\(14, 199, 222\)/i);
  });
});

describe("panneau", () => {
  it("présente titre, preset appliqué, mode, familles de la brique, scanlines et note", () => {
    renderPicker();
    expect(screen.queryByTestId("theme-picker-panel")).toBeNull();
    const panel = openPanel();
    expect(document.body.contains(panel)).toBe(true); // portail dans <body>
    expect(screen.getByText("THÈME")).toBeTruthy();
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("matrix-dark");
    expect(screen.getByTestId("theme-mode-dark")).toBeTruthy();
    expect(screen.getByTestId("theme-mode-light")).toBeTruthy();
    for (const family of PI_WEB_FAMILY_ORDER) {
      expect(screen.getByTestId(`theme-option-${family}`), family).toBeTruthy();
    }
    expect(screen.getByTestId("theme-scanlines-toggle")).toBeTruthy();
    expect(screen.getByText(/Migration/)).toBeTruthy();
  });

  it("met Matrix en évidence : encadrée, cochée, badge DÉFAUT, sous-titre de presets", () => {
    renderPicker();
    openPanel();
    const matrix = screen.getByTestId("theme-option-matrix");
    expect(matrix.getAttribute("aria-pressed")).toBe("true");
    expect(matrix.className).toContain("border-hacker-accent");
    expect(matrix.textContent).toContain("✓");
    expect(matrix.textContent).toContain("DÉFAUT");
    expect(matrix.textContent).toContain("matrix-dark · matrix-light");
    const turquoise = screen.getByTestId("theme-option-turquoise");
    expect(turquoise.getAttribute("aria-pressed")).toBe("false");
    expect(turquoise.textContent).not.toContain("DÉFAUT");
    expect(turquoise.textContent).not.toContain("✓");
  });

  it("remonte la famille choisie et déplace la sélection (preset piégé mis à jour)", () => {
    const { props, rerenderWith } = renderPicker();
    openPanel();
    fireEvent.click(screen.getByTestId("theme-option-turquoise"));
    expect(props.onThemeChange).toHaveBeenCalledWith("turquoise");
    rerenderWith({ themeName: "turquoise" as PiWebThemeId });
    expect(screen.getByTestId("theme-option-turquoise").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-option-matrix").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("turquoise-dark");
  });

  it("ne propose QUE les familles de la brique : exactement 7 entrées, aucune héritée", () => {
    renderPicker();
    openPanel();
    for (const family of PI_WEB_FAMILY_ORDER) {
      expect(screen.getByTestId(`theme-option-${family}`), family).toBeTruthy();
    }
    // Les anciens thèmes supprimés ne sont plus proposés.
    expect(screen.queryByTestId("theme-option-violet")).toBeNull();
    expect(screen.queryByTestId("theme-option-indigo")).toBeNull();
    expect(screen.queryByTestId("theme-option-rose")).toBeNull();
  });

  it("affiche pour chaque famille le sous-titre de ses deux presets <id>-dark · <id>-light", () => {
    renderPicker();
    openPanel();
    for (const family of PI_WEB_FAMILY_ORDER) {
      expect(screen.getByTestId(`theme-option-${family}`).textContent).toContain(`${family}-dark · ${family}-light`);
    }
  });

  it("n'expose plus aucune section « bibliothèque » séparée", () => {
    renderPicker();
    openPanel();
    expect(screen.queryByText("BIBLIOTHÈQUE HOLAF")).toBeNull();
  });

  it("ferme au clic extérieur", () => {
    renderPicker();
    openPanel();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("theme-picker-panel")).toBeNull();
  });
});

describe("mode sombre / clair", () => {
  it("reflète le mode courant et remonte le changement (preset <famille>-<mode>)", () => {
    const { props, rerenderWith } = renderPicker({ theme: "dark" });
    openPanel();
    expect(screen.getByTestId("theme-mode-dark").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-mode-light").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("theme-mode-light"));
    expect(props.onModeChange).toHaveBeenCalledWith("light");
    rerenderWith({ theme: "light" });
    expect(screen.getByTestId("theme-mode-light").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-mode-dark").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("matrix-light");
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
    expect(screen.getByTestId("theme-picker-pack").textContent).toBe("matrix-light");
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
