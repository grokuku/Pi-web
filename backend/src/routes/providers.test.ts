/**
 * Tests des mutations de providers (routes/providers.ts).
 *
 * - `fs` mocké en mémoire : providers.json n'est jamais touché sur le disque.
 * - `logger` mocké : on vérifie la TRAÇABILITÉ sans écrire de vraie ligne.
 * - `model-library`/`concurrency` mockés : `syncConcurrencyProviderLimits`
 *   n'effectue aucun I/O réel.
 *
 * Objectif : un PUT partiel ne doit PAS écraser les autres champs ; un id
 * inconnu renvoie 404 ; un changement de `type` est refusé (400) ; la clé API
 * n'est jamais journalisée.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fsState, loggerMock } = vi.hoisted(() => ({
  fsState: { files: {} as Record<string, string> },
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("fs", () => ({
  existsSync: vi.fn((p: string) => Object.prototype.hasOwnProperty.call(fsState.files, p)),
  mkdirSync: vi.fn(() => {}),
  readFileSync: vi.fn((p: string) => fsState.files[p]),
  writeFileSync: vi.fn((p: string, data: string) => {
    fsState.files[p] = data;
  }),
}));

vi.mock("../utils/logger.js", () => ({ logger: loggerMock }));

vi.mock("../pi/model-library.js", () => ({
  loadModelLibrary: vi.fn(() => ({ concurrency: { providerMaxLLMSlots: {} }, models: [] })),
  saveModelLibrary: vi.fn(),
}));

vi.mock("../pi/concurrency.js", () => ({
  concurrencyManager: { setConfig: vi.fn() },
}));

import router from "./providers.js";
import { saveProviders, type ProviderConfig } from "../pi/providers.js";

// ── Harnais : invocation directe du Router Express (pas de serveur HTTP) ──
function request(method: string, url: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req: any = { method, url, body, headers: {}, query: {} };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    // Express expose le Router comme une fonction middleware `(req, res, next)`.
    (router as any)(req, res, () => resolve({ status: 404, body: { error: "no matching route" } }));
  });
}

function seed(providers: ProviderConfig[]): void {
  saveProviders(providers);
}

const seedProvider: ProviderConfig = {
  id: "p1",
  name: "Original",
  type: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-secret-xyz",
  maxConcurrentCalls: 3,
  discoveredModels: [],
  connectionStatus: "untested",
};

beforeEach(() => {
  fsState.files = {};
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
});

describe("PUT /api/providers/:id — mise à jour partielle", () => {
  it("body { maxConcurrentCalls } seul : name/baseUrl/apiKey inchangés", async () => {
    seed([seedProvider]);

    const res = await request("PUT", "/p1", { maxConcurrentCalls: 5 });

    expect(res.status).toBe(200);
    expect(res.body.maxConcurrentCalls).toBe(5);
    // Les autres champs ne sont PAS écrasés par un payload partiel.
    expect(res.body.name).toBe("Original");
    expect(res.body.baseUrl).toBe("https://api.example.com/v1");
    expect(res.body.hasApiKey).toBe(true);

    // Vérifié aussi côté persistance (loadProviders relit le "disque" simulé).
    const { loadProviders } = await import("../pi/providers.js");
    const stored = loadProviders().find((p) => p.id === "p1")!;
    expect(stored).toMatchObject({
      name: "Original",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret-xyz",
      maxConcurrentCalls: 5,
    });
  });

  it("id inconnu → 404", async () => {
    seed([seedProvider]);
    const res = await request("PUT", "/inconnu", { maxConcurrentCalls: 5 });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Provider not found" });
  });

  it("changement de type refusé (400) et signalé au logger", async () => {
    seed([seedProvider]);
    const res = await request("PUT", "/p1", { type: "anthropic" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "type cannot be changed" });
    expect(loggerMock.warn).toHaveBeenCalledWith("providers", expect.stringContaining("type refusé"), expect.anything());
  });

  it("un PUT normal journalise id + champs modifiés SANS la valeur de la clé API", async () => {
    seed([seedProvider]);

    await request("PUT", "/p1", { maxConcurrentCalls: 9, apiKey: "sk-new-TOP-SECRET" });

    const [category, message, details] = loggerMock.info.mock.calls.at(-1)!;
    expect(category).toBe("providers");
    expect(String(message)).toContain("p1");
    expect(details).toMatchObject({ id: "p1", fields: expect.arrayContaining(["apiKey", "maxConcurrentCalls"]), apiKeyChanged: true });
    // La VALEUR de la clé n'apparaît nulle part dans les logs.
    expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain("sk-new-TOP-SECRET");
    expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain("sk-secret-xyz");
  });
});
