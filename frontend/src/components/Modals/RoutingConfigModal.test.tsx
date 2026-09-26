// @vitest-environment jsdom
/**
 * Tests de RoutingConfigModal — le sélecteur de niveau de réflexion d'une
 * catégorie doit suivre le modèle choisi pour cette catégorie :
 *  - modèle déclarant des niveaux (reasoningLevels) → SEULS ces niveaux + « défaut » ;
 *  - catégorie sur « défaut » / modèle introuvable → TOUS les niveaux (repli) ;
 *  - thinkingLevel enregistré devenu indisponible → ramené au « défaut » (clamp).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { RoutingConfigModal } from "./RoutingConfigModal";
import type { RegisteredModel, RoutingConfig } from "../../types";

function makeModel(overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    id: "m1",
    providerId: "p1",
    modelId: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    isDefault: true,
    reasoning: true,
    vision: false,
    contextWindow: 128000,
    maxTokens: 16384,
    reasoningLevels: ["off", "low", "high", "max"],
    reasoningDefault: "high",
    ...overrides,
  };
}

function renderModal(models: RegisteredModel[], config: RoutingConfig | null = null) {
  return render(
    <I18nProvider>
      <RoutingConfigModal
        onClose={vi.fn()}
        onSave={vi.fn(async () => {})}
        models={models}
        providers={[]}
        config={config}
      />
    </I18nProvider>,
  );
}

/** Sélecteur de réflexion de la catégorie « Trivial » (aria-label i18n). */
function trivialThinkingSelect(): HTMLSelectElement {
  return screen.getByLabelText(/Thinking level.*Trivial/) as HTMLSelectElement;
}

/** Sélecteur de MODÈLE de la catégorie « Trivial » (1er combobox de la modale). */
function trivialModelSelect(): HTMLSelectElement {
  return screen.getAllByRole("combobox")[0] as HTMLSelectElement;
}

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  // ModalDialog utilise useMediaQuery → jsdom ne fournit pas matchMedia.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("RoutingConfigModal — niveaux calculés par modèle", () => {
  it("sans modèle choisi → repli sur TOUS les niveaux (default + 7)", () => {
    renderModal([makeModel()]);
    const options = within(trivialThinkingSelect()).getAllByRole("option");
    expect(options).toHaveLength(1 + 7);
    expect(options[0].textContent).toContain("Default");
  });

  it("modèle déclarant ['off','low','high','max'] → 4 niveaux + défaut, sans medium/xhigh", () => {
    renderModal([makeModel()], {
      enabled: true,
      trivial: { modelId: "m1" },
      standard: { modelId: null },
      complex: { modelId: null },
      review: { modelId: null },
      reviewRiskThreshold: 0.5,
      confidenceThreshold: 0.5,
    } as RoutingConfig);

    const select = trivialThinkingSelect();
    expect(within(select).getAllByRole("option")).toHaveLength(1 + 4);
    expect(within(select).queryByRole("option", { name: "medium" })).toBeNull();
    expect(within(select).queryByRole("option", { name: "very high" })).toBeNull();
    expect(within(select).getByRole("option", { name: "low" })).toBeTruthy();
  });

  it("changer le modèle de la catégorie met à jour les niveaux proposés", () => {
    renderModal([makeModel()]);
    // Au départ : tous les niveaux (catégorie sur défaut).
    expect(within(trivialThinkingSelect()).getAllByRole("option")).toHaveLength(1 + 7);

    fireEvent.change(trivialModelSelect(), { target: { value: "m1" } });

    const select = trivialThinkingSelect();
    expect(within(select).getAllByRole("option")).toHaveLength(1 + 4);
    expect(within(select).queryByRole("option", { name: "medium" })).toBeNull();
  });

  it("thinkingLevel enregistré devenu indisponible → ramené au « défaut » (clamp)", () => {
    renderModal([makeModel()], {
      enabled: true,
      // « medium » n'est PAS déclaré par le modèle → doit être clampé.
      trivial: { modelId: "m1", thinkingLevel: "medium" },
      standard: { modelId: null },
      complex: { modelId: null },
      review: { modelId: null },
      reviewRiskThreshold: 0.5,
      confidenceThreshold: 0.5,
    } as RoutingConfig);

    expect(trivialThinkingSelect().value).toBe("");
  });
});
