// @vitest-environment jsdom
/**
 * Tests de régression — PreviewWindow (correctif SEC-05).
 *
 * Avant : l'iframe portait `sandbox="... allow-same-origin"`, donc un HTML servi
 * par Pi-Web s'exécutait à l'origine de Pi-Web (accès au DOM parent,
 * localStorage, fetch /api/*). Après : `allow-same-origin` est retiré — l'aperçu
 * devient une origine opaque — tout en conservant les jetons nécessaires aux
 * maquettes (scripts/forms/modals/popups).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { PreviewWindow } from "./PreviewWindow";

function renderWindow() {
  return render(
    <I18nProvider>
      <PreviewWindow
        url="/api/preview-inline/abcdef0123456789"
        title="Mockup"
        onClose={vi.fn()}
        popupActive={false}
        onTogglePopup={vi.fn()}
      />
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("PreviewWindow — sandbox (SEC-05)", () => {
  it("ne contient PAS allow-same-origin (origine opaque)", () => {
    renderWindow();
    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const sandbox = iframe!.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("conserve allow-scripts pour faire tourner les maquettes", () => {
    renderWindow();
    const sandbox = document.querySelector("iframe")!.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-forms");
    expect(sandbox).toContain("allow-modals");
    expect(sandbox).toContain("allow-popups");
  });
});
