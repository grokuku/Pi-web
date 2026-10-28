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

// ─────────────────────────────────────────────────────────────────────────────
// Classifieur de triage : TYPE (« chat » ou « system-one ») + modèle dédié.
// Exigence : configurable DANS L'INTERFACE, en français, pleine largeur, avec
// un libellé clair — et les deux classifieurs doivent avoir leur PROPRE modèle.
// ─────────────────────────────────────────────────────────────────────────────

/** Select du TYPE de classifieur (aria-label dédié). */
function classifierTypeSelect(): HTMLSelectElement {
  return screen.getByLabelText("Type de classifieur de triage") as HTMLSelectElement;
}

function renderModalWithSave(models: RegisteredModel[], config: RoutingConfig | null = null) {
  const onSave = vi.fn(async (_routing: RoutingConfig) => {});
  render(
    <I18nProvider>
      <RoutingConfigModal
        onClose={vi.fn()}
        onSave={onSave}
        models={models}
        providers={[]}
        config={config}
      />
    </I18nProvider>,
  );
  return { onSave };
}

describe("RoutingConfigModal — classifieur System One", () => {
  it("le type de classifieur est exposé dans l'interface (français, 2 options)", () => {
    renderModal([makeModel()]);
    const select = classifierTypeSelect();
    expect(select).toBeTruthy();
    const options = within(select).getAllByRole("option");
    expect(options.map(o => o.getAttribute("value"))).toEqual(["chat", "system-one"]);
    expect(options[0].textContent).toContain("Chat");
    expect(options[1].textContent).toContain("System One");
    // Par défaut : chat → le modèle du classifieur chat reste affiché.
    expect(select.value).toBe("chat");
    expect(screen.getByLabelText(/Modèle du classifieur chat/)).toBeTruthy();
  });

  it("choisir « system-one » fait apparaître le champ de modèle DÉDIÉ (distinct du chat)", () => {
    renderModal([makeModel()]);
    expect(screen.queryByLabelText(/Modèle de décision \(System One\)/)).toBeNull();

    fireEvent.change(classifierTypeSelect(), { target: { value: "system-one" } });

    expect(screen.getByLabelText(/Modèle de décision \(System One\)/)).toBeTruthy();
    // Le champ du classifieur chat disparaît : aucun mélange des deux modèles.
    expect(screen.queryByLabelText(/Modèle du classifieur chat/)).toBeNull();
  });

  it("enregistrer conserve le type ET les deux modèles séparément", async () => {
    const clef = makeModel({ id: "p2__clef", providerId: "p2", modelId: "clef", name: "clef" });
    const cheap = makeModel({ id: "m1", name: "DeepSeek V4.1 Flash" });
    const { onSave } = renderModalWithSave([clef, cheap], {
      enabled: true,
      trivial: { modelId: null },
      standard: { modelId: null },
      complex: { modelId: null },
      review: { modelId: null },
      reviewRiskThreshold: 0.5,
      confidenceThreshold: 0.5,
      classifierModelId: "m1",
      classifierType: "system-one",
      systemOneModelId: "p2__clef",
    } as RoutingConfig);

    fireEvent.click(screen.getByRole("button", { name: /Enregistrer/ }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved.classifierType).toBe("system-one");
    expect(saved.systemOneModelId).toBe("p2__clef");
    expect(saved.classifierModelId).toBe("m1"); // le classifieur chat est intact
  });

  it("config historique (sans les nouveaux champs) → chat / aucun modèle System One", async () => {
    const { onSave } = renderModalWithSave([makeModel()], {
      enabled: true,
      trivial: { modelId: null },
      standard: { modelId: null },
      complex: { modelId: null },
      review: { modelId: null },
      reviewRiskThreshold: 0.5,
      confidenceThreshold: 0.5,
      classifierModelId: null,
    } as RoutingConfig);

    expect(classifierTypeSelect().value).toBe("chat");
    fireEvent.click(screen.getByRole("button", { name: /Enregistrer/ }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved.classifierType).toBe("chat");
    expect(saved.systemOneModelId).toBeNull();
  });
});
