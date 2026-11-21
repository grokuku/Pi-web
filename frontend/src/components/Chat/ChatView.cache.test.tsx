// @vitest-environment jsdom
// ── Tests d'intégration : cache local du fil branché dans ChatView ─────────
// Vérifie le comportement OBSERVABLE par l'utilisateur, sans réseau :
//  - le fil est peint depuis le cache local quand il est frais (bandeau
//    « affichage depuis un cache local ») ;
//  - un cache de plus de 24 h n'est JAMAIS présenté comme l'état courant ;
//  - le cache n'écrase JAMAIS l'historique backend déjà reçu ;
//  - sans IndexedDB (jsdom) tout fonctionne : repli localStorage.
// (Aucun réglage d'interface : le cache est toujours actif, avec des valeurs
// fixées dans utils/chat-local-cache.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import { ChatView } from "./ChatView";
import { createLocalStorageChatCacheStore } from "../../utils/chat-cache-store";
import { CHAT_CACHE_MAX_AGE_MS } from "../../utils/chat-cache";
import { resetChatCacheStore, saveChatCache } from "../../utils/chat-local-cache";
import type { DisplayMessage } from "../../types";

const handlers = new Map<string, (msg: any) => void>();
const on = vi.fn((type: string, cb: (msg: any) => void) => {
  handlers.set(type, cb);
  return () => { handlers.delete(type); };
});

const project = {
  id: "p1",
  name: "Project",
  cwd: "/projects/p1",
  storage: "local" as const,
  versioning: "git" as const,
  git: { remote: "", branch: "main", provider: "github" as const, lastSync: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderChat() {
  return render(
    <I18nProvider>
      <ChatView
        send={vi.fn(() => true)}
        on={on}
        activeProject={project}
        isStreaming={false}
        session={{}}
        projectId="p1"
        connected={true}
        pendingMessages={0}
      />
    </I18nProvider>,
  );
}

function cachedMessage(ts: number, content: string, id = "cache-1"): DisplayMessage {
  return { id, role: "user", content, thinking: "", toolCalls: [], timestamp: ts };
}

/** Écrit un snapshot de cache comme le ferait une session précédente. */
async function seedCache(messages: DisplayMessage[], savedAt = Date.now()) {
  const store = createLocalStorageChatCacheStore(localStorage);
  await saveChatCache("p1", messages, { store, storage: localStorage, now: savedAt });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("pi-web-language", "en");
  resetChatCacheStore();
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
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  handlers.clear();
  on.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ChatView — cache local du fil", () => {
  it("repeint le fil depuis le cache frais (IndexedDB absent → repli localStorage) avec un bandeau honnête", async () => {
    await seedCache([cachedMessage(Date.now() - 1000, "bonjour du cache")]);
    renderChat();

    expect(await screen.findByText("bonjour du cache")).toBeTruthy();
    // Bandeau : le contenu vient du CACHE, pas (encore) du backend.
    expect(screen.getByText(/Displaying from local cache/)).toBeTruthy();
  });

  it("un cache de plus de 24 h n'est jamais présenté comme l'état courant", async () => {
    const old = Date.now() - CHAT_CACHE_MAX_AGE_MS - 60_000;
    await seedCache([cachedMessage(old, "conversation périmée")], old);
    renderChat();

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("conversation périmée")).toBeNull();
    expect(screen.queryByText(/Displaying from local cache/)).toBeNull();
  });

  it("l'historique BACKEND prime : un pi_history reçu avant la lecture du cache n'est pas écrasé", async () => {
    await seedCache([cachedMessage(Date.now() - 1000, "contenu du cache")]);
    renderChat();

    await act(async () => {
      handlers.get("pi_history")?.({ projectId: "p1", messages: [{ role: "user", content: "vérité serveur", timestamp: Date.now() }] });
    });

    expect(await screen.findByText("vérité serveur")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("contenu du cache")).toBeNull());
  });

  it("cache activé → le fil est écrit et relu après rechargement", async () => {
    renderChat();

    await act(async () => {
      handlers.get("pi_history")?.({ projectId: "p1", messages: [{ role: "user", content: "à retenir", timestamp: Date.now() }] });
    });
    await waitFor(() => expect(localStorage.getItem("pi-web-chat-p1")).not.toBeNull(), { timeout: 2000 });

    // « Rechargement » : nouvel arbre, le fil revient du cache.
    cleanup();
    handlers.clear();
    renderChat();
    expect(await screen.findByText("à retenir")).toBeTruthy();
  }, 5000);
});
