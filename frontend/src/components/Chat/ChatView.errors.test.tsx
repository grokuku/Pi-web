// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ChatView } from "./ChatView";

const handlers = new Map<string, (msg: any) => void>();
const on = vi.fn((type: string, cb: (msg: any) => void) => {
  handlers.set(type, cb);
  return () => { handlers.delete(type); };
});

function renderChat() {
  return render(
    <I18nProvider>
      <ChatView
        send={vi.fn(() => true)}
        on={on}
        activeProject={{
          id: "p1",
          name: "Project",
          cwd: "/projects/p1",
          storage: "local",
          versioning: "git",
          git: { remote: "", branch: "main", provider: "github", lastSync: null },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }}
        isStreaming={false}
        session={{}}
        projectId="p1"
        connected={true}
        pendingMessages={0}
      />
    </I18nProvider>,
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
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  handlers.clear();
  on.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ChatView — erreurs et persistance honnêtes", () => {
  it("une erreur WS reste dans le bandeau seul, sans faux message utilisateur dans le fil", async () => {
    renderChat();

    await act(async () => {
      handlers.get("error")?.({ projectId: "p1", error: "backend exploded" });
    });

    expect(screen.getByText("backend exploded")).toBeTruthy();
    expect(screen.queryByText("❌ backend exploded")).toBeNull();
    expect(screen.getAllByText(/backend exploded/)).toHaveLength(1);
  });

  it("QuotaExceededError affiche une seule bannière et désactive les écritures suivantes", async () => {
    const originalSetItem = Storage.prototype.setItem;
    const writes: string[] = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === "pi-web-chat-p1") {
        writes.push(key);
        throw new DOMException("quota full", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    });
    renderChat();

    expect(await screen.findByText(/Local chat cache is disabled/, {}, { timeout: 1500 })).toBeTruthy();
    expect(screen.getAllByText(/Local chat cache is disabled/)).toHaveLength(1);
    expect(writes).toHaveLength(1);

    // Une nouvelle erreur provoque un rendu : aucune nouvelle tentative de cache.
    await act(async () => {
      handlers.get("error")?.({ projectId: "p1", error: "still visible" });
    });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(writes).toHaveLength(1);
    expect(screen.getAllByText(/Local chat cache is disabled/)).toHaveLength(1);
  }, 3000);
});
