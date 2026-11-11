// @vitest-environment jsdom
/**
 * Sélecteur « Vision Model » (Settings → Analysis Models).
 *
 * BUG corrigé : le `<select>` filtrait sur le champ BRUT `model.vision` et
 * ignorait donc :
 *   - l'override manuel `visionOverride: "yes"` (contournement documenté côté UI) ;
 *   - la détection AUTORITAIRE du provider (`capabilities.vision` de Switchy),
 *     car l'heuristique de nom (`inferVision`) rate les noms opaques.
 * Résultat mesuré sur l'instance réelle : 2 modèles proposés sur 6 capables.
 *
 * Le sélecteur doit utiliser la capacité RÉSOLUE (`resolveModelCapability`),
 * comme le fait déjà le backend pour l'envoi d'images (session.ts, attachments.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { SettingsModal } from "./SettingsModal";
import { toast } from "../../utils/holaf-toast";

vi.mock("../../utils/holaf-toast", () => ({ toast: vi.fn() }));
vi.mock("../common/ModalDialog", () => ({
  ModalDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ModelLibraryModal", () => ({ ProvidersTab: () => null, ModelsTab: () => null }));
vi.mock("./MemorySettingsTab", () => ({ MemorySettingsTab: () => null }));
vi.mock("./settings/LibrySection", () => ({ default: () => null }));
vi.mock("./settings/ShortcutsTab", () => ({ default: () => null }));
vi.mock("./settings/SecurityTab", () => ({ default: () => null }));
vi.mock("./settings/LayoutTab", () => ({ default: () => null }));
vi.mock("./settings/ApiKeysTab", () => ({ default: () => null }));

function model(over: Record<string, unknown>) {
  return {
    providerId: "provider_switchy",
    isDefault: false,
    reasoning: false,
    audio: false,
    contextWindow: 1048576,
    maxTokens: 8192,
    visionOverride: "auto",
    audioOverride: "auto",
    reasoningOverride: "auto",
    ...over,
  };
}

// Reproduit la bibliothèque réelle de l'utilisateur (Switchy = 7 services) + un
// modèle local. Les noms « Clef », « Beam », « Deepseek-* » ne sont reconnus par
// AUCUNE branche de `inferVision`.
const library = {
  models: [
    // Nom reconnu par l'heuristique (gemma4…) ET vision déclarée par le provider.
    model({ id: "m1", modelId: "gemma4-prioritaire", name: "gemma4-prioritaire", vision: true }),
    // Vision CONFIRMÉE par le provider (capabilities.vision), nom raté par l'heuristique.
    model({ id: "m2", modelId: "Clef", name: "Clef", vision: true }),
    // Détection ratée, mais l'utilisateur a mis « Vision : Oui » à la main.
    model({ id: "m3", modelId: "Deepseek-Fast", name: "Deepseek-Fast", vision: false, visionOverride: "yes" }),
    // Le provider déclare explicitement l'absence de vision → ne doit PAS apparaître.
    model({ id: "m4", modelId: "Beam", name: "Beam", vision: false }),
    // L'utilisateur a explicitement refusé la vision → ne doit PAS apparaître.
    model({ id: "m5", modelId: "Kimi-3.1-pro-high", name: "Kimi-3.1-pro-high", vision: true, visionOverride: "no" }),
  ],
  defaultModelId: "m1",
  commitModelId: null,
  visionModelId: null,
  audioModelId: null,
  librarianModelId: null,
  projectModes: {},
  concurrency: { providerMaxLLMSlots: {} },
};

const initialData: Record<string, unknown> = {
  "/api/model-library": library,
  "/api/providers": [],
  "/api/settings/webclaw": { url: "", hasApiKey: false },
  "/api/settings/tavily": { hasApiKey: false },
  "/api/settings/concurrency": { config: {}, stats: null },
  "/api/pi/packages": [],
  "/api/pi/available": { extensions: [], skills: [], prompts: [], themes: [] },
  "/api/pi": { skills: [] },
};

function response(data: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => data } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  vi.mocked(toast).mockReset();
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    return response(initialData[url] ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Options (libellés) du seul sélecteur « Vision Model ». */
async function visionOptions(): Promise<string[]> {
  render(
    <I18nProvider>
      <SettingsModal onClose={vi.fn()} session={{}} />
    </I18nProvider>,
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/model-library"));
  fireEvent.click(screen.getByText("Analysis Models"));
  const select = await screen.findByRole("combobox", { name: "Vision model" });
  return Array.from(select.querySelectorAll("option")).map((o) => o.textContent || "");
}

describe("SettingsModal — sélecteur « Vision Model »", () => {
  it("propose les modèles à vision CONFIRMÉE par le provider, même si le nom n'est pas reconnu par l'heuristique", async () => {
    const options = await visionOptions();
    expect(options).toContain("Clef");
    expect(options).toContain("gemma4-prioritaire");
  });

  it("propose aussi un modèle coché « Vision : Oui » à la main (contournement)", async () => {
    const options = await visionOptions();
    expect(options).toContain("Deepseek-Fast");
  });

  it("n'expose PAS un modèle sans vision (provider « false ») ni un modèle refusé par l'override « Non »", async () => {
    const options = await visionOptions();
    expect(options).not.toContain("Beam");
    expect(options).not.toContain("Kimi-3.1-pro-high");
    // « — None (use main model) — » reste toujours disponible.
    expect(options.some((o) => o.includes("None (use main model)"))).toBe(true);
  });

  it("affiche le compteur de modèles capables (capacité résolue)", async () => {
    await visionOptions();
    expect(await screen.findByText("3 vision model(s) available")).toBeTruthy();
  });
});
