// @vitest-environment jsdom
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

function response(data: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => data } as Response;
}

const initialData: Record<string, unknown> = {
  "/api/model-library": { models: [], providers: [] },
  "/api/providers": [],
  "/api/settings/webclaw": { url: "", hasApiKey: false },
  "/api/settings/tavily": { hasApiKey: false },
  "/api/settings/concurrency": { config: {}, stats: null },
  "/api/pi/packages": [{ source: "pkg:demo", scope: "user", installed: true }],
  "/api/pi/available": { extensions: [], skills: [], prompts: [], themes: [] },
  "/api/pi": { skills: ["skill:demo"] },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.setItem("pi-web-language", "en");
  vi.mocked(toast).mockReset();
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" || init?.method === "DELETE") {
      return response({ error: "server says no" }, false);
    }
    return response(initialData[url] ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function renderSettings() {
  render(
    <I18nProvider>
      <SettingsModal onClose={vi.fn()} session={{}} />
    </I18nProvider>,
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/model-library"));
}

describe("SettingsModal — les refus HTTP sont visibles", () => {
  it("WebClaw : !res.ok produit un toast d'erreur", async () => {
    await renderSettings();
    fireEvent.click(screen.getByText("Analysis Models"));
    fireEvent.click((await screen.findAllByText("SAVE"))[0]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("server says no", "error"));
  });

  it("Tavily : !res.ok produit un toast d'erreur", async () => {
    await renderSettings();
    fireEvent.click(screen.getByText("Analysis Models"));
    fireEvent.click((await screen.findAllByText("SAVE"))[1]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("server says no", "error"));
  });

  it("suppression d'extension : !res.ok produit un toast d'erreur", async () => {
    await renderSettings();
    fireEvent.click(screen.getByText("Extensions & Skills"));
    fireEvent.click(await screen.findByTitle("Remove"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("server says no", "error"));
  });

  it("activation/désactivation de compétence : !res.ok produit un toast d'erreur", async () => {
    await renderSettings();
    fireEvent.click(screen.getByText("Extensions & Skills"));
    fireEvent.click(await screen.findByText("RESOURCES"));
    fireEvent.click(await screen.findByTitle("Disable"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("server says no", "error"));
  });
});
