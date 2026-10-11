/**
 * Tests du client Libry (backend/src/libry/client.ts).
 *
 * - `fs` mocké en mémoire : AUCUN fichier réel (`.data/libry-config.json`) n'est
 *   touché sur le disque.
 * - `fetch` mocké : AUCUN test ne dépend du réseau.
 *
 * Objectifs : résolution `env ?? fichier ?? défaut` ; la clé n'est jamais
 * réaffichée en clair ; 401 et « injoignable » produisent des messages typés et
 * actionnables ; l'interrupteur `librarianBackend` est lu à chaud, défaut "local".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fsState } = vi.hoisted(() => ({
  fsState: { files: {} as Record<string, string> },
}));

vi.mock("fs", () => ({
  existsSync: vi.fn((p: string) => Object.prototype.hasOwnProperty.call(fsState.files, p)),
  mkdirSync: vi.fn(() => {}),
  readFileSync: vi.fn((p: string) => fsState.files[p]),
  writeFileSync: vi.fn((p: string, data: string) => {
    fsState.files[p] = data;
  }),
}));

import {
  DEFAULT_LIBRY_URL,
  LibryError,
  getLibryConfig,
  getLibrarianBackend,
  libryArchive,
  librySearch,
  libryStatus,
  setLibryConfig,
  toPublicLibryConfig,
} from "./client.js";

const ENV_KEYS = ["LIBRY_URL", "LIBRY_API_KEY", "LIBRARIAN_BACKEND"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  fsState.files = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Résolution de la config ──

describe("getLibryConfig — priorité env ?? fichier ?? défaut", () => {
  it("sans env ni fichier : défauts (url libry:3007, clé vide, backend local)", () => {
    expect(getLibryConfig()).toEqual({
      url: DEFAULT_LIBRY_URL,
      apiKey: "",
      librarianBackend: "local",
    });
  });

  it("le fichier prime le défaut", () => {
    setLibryConfig({ url: "http://libry.local:9999", apiKey: "libry_file_key" });
    const config = getLibryConfig();
    expect(config.url).toBe("http://libry.local:9999");
    expect(config.apiKey).toBe("libry_file_key");
  });

  it("l'env prime le fichier", () => {
    setLibryConfig({ url: "http://file-url:3007", apiKey: "libry_file_key" });
    process.env.LIBRY_URL = "http://env-url:3007";
    process.env.LIBRY_API_KEY = "libry_env_key";
    const config = getLibryConfig();
    expect(config.url).toBe("http://env-url:3007");
    expect(config.apiKey).toBe("libry_env_key");
  });

  it("une variable d'env VIDE est traitée comme absente (retombe sur le fichier)", () => {
    setLibryConfig({ url: "http://file-url:3007" });
    process.env.LIBRY_URL = "";
    expect(getLibryConfig().url).toBe("http://file-url:3007");
  });
});

describe("setLibryConfig — keep-if-absent", () => {
  it("un champ absent/vide conserve la valeur courante", () => {
    setLibryConfig({ url: "http://libry:3007", apiKey: "libry_keepme" });
    // Mise à jour de l'URL seule : la clé est conservée.
    setLibryConfig({ url: "http://libry2:3007" });
    expect(getLibryConfig()).toEqual({
      url: "http://libry2:3007",
      apiKey: "libry_keepme",
      librarianBackend: "local",
    });
    // Clé vide : conservée également.
    setLibryConfig({ apiKey: "" });
    expect(getLibryConfig().apiKey).toBe("libry_keepme");
  });
});

// ── Interrupteur (lu à chaud) ──

describe("getLibrarianBackend — interrupteur à chaud", () => {
  it("défaut \"local\"", () => {
    expect(getLibrarianBackend()).toBe("local");
  });

  it("valeur fichier \"libry\"", () => {
    setLibryConfig({ librarianBackend: "libry" });
    expect(getLibrarianBackend()).toBe("libry");
  });

  it("l'env prime le fichier et une valeur inconnue retombe sur \"local\"", () => {
    setLibryConfig({ librarianBackend: "local" });
    process.env.LIBRARIAN_BACKEND = "libry";
    expect(getLibrarianBackend()).toBe("libry");
    process.env.LIBRARIAN_BACKEND = "nimportequoi";
    expect(getLibrarianBackend()).toBe("local");
  });

  it("est relu à chaud (aucun cache)", () => {
    expect(getLibrarianBackend()).toBe("local");
    setLibryConfig({ librarianBackend: "libry" });
    expect(getLibrarianBackend()).toBe("libry");
  });
});

// ── Vue publique : la clé n'est jamais renvoyée en clair ──

describe("toPublicLibryConfig", () => {
  it("n'expose que hasApiKey + un aperçu, jamais la clé", () => {
    const view = toPublicLibryConfig({ url: "http://libry:3007", apiKey: "libry_secret_abcd", librarianBackend: "local" });
    expect(view).toEqual({
      url: "http://libry:3007",
      hasApiKey: true,
      apiKeyPreview: "••••abcd",
      librarianBackend: "local",
      urlFromEnv: false,
      apiKeyFromEnv: false,
      backendFromEnv: false,
    });
    expect(JSON.stringify(view)).not.toContain("libry_secret_abcd");
  });

  it("clé vide : hasApiKey false, aperçu vide, et le backend effectif est exposé", () => {
    expect(toPublicLibryConfig({ url: "http://libry:3007", apiKey: "", librarianBackend: "libry" })).toEqual({
      url: "http://libry:3007",
      hasApiKey: false,
      apiKeyPreview: "",
      librarianBackend: "libry",
      urlFromEnv: false,
      apiKeyFromEnv: false,
      backendFromEnv: false,
    });
  });

  it("signale les valeurs pilotées par l'environnement (env NON VIDE uniquement)", () => {
    process.env.LIBRY_URL = "http://env-url:3007";
    process.env.LIBRY_API_KEY = "libry_env_key";
    process.env.LIBRARIAN_BACKEND = "libry";
    const view = toPublicLibryConfig(getLibryConfig());
    expect(view.urlFromEnv).toBe(true);
    expect(view.apiKeyFromEnv).toBe(true);
    expect(view.backendFromEnv).toBe(true);
    // La clé d'env n'est jamais exposée pour autant : aperçu masqué seulement.
    expect(JSON.stringify(view)).not.toContain("libry_env_key");

    // Env vide (ou valeur de backend invalide) = absente → pas « géré par l'environnement ».
    process.env.LIBRY_URL = "";
    process.env.LIBRY_API_KEY = "";
    process.env.LIBRARIAN_BACKEND = "nimportequoi";
    const view2 = toPublicLibryConfig(getLibryConfig());
    expect(view2.urlFromEnv).toBe(false);
    expect(view2.apiKeyFromEnv).toBe(false);
    expect(view2.backendFromEnv).toBe(false);
  });
});

// ── Appels REST (fetch simulé, aucun réseau) ──

describe("appels REST (fetch simulé)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("librySearch : POST /search avec Bearer et renvoie les résultats", async () => {
    process.env.LIBRY_URL = "http://libry:3007/";
    process.env.LIBRY_API_KEY = "libry_k1";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ title: "t", url: "http://x", snippet: "s" }], archived: true }),
    });

    const out = await librySearch("express routing");
    expect(out.results).toHaveLength(1);
    expect(out.archived).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://libry:3007/api/librarian/search");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer libry_k1");
    expect(JSON.parse(init.body)).toEqual({ query: "express routing" });
  });

  it("libryStatus : route publique, aucune clé requise (Authorization omise si clé vide)", async () => {
    process.env.LIBRY_URL = "http://libry:3007";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ totalDocs: 3, lastUpdated: "", lastScan: "" }),
    });

    const status = await libryStatus();
    expect(status.totalDocs).toBe(3);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("libryArchive : transmet le content déjà extrait", async () => {
    process.env.LIBRY_API_KEY = "libry_k2";
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ success: true }) });

    await libryArchive({
      name: "express",
      version: "latest",
      type: "documentation",
      sourceUrl: "http://x",
      content: { summary: "s", keyPoints: ["a"], rawContent: "raw" },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/librarian/archive");
    const body = JSON.parse(init.body);
    expect(body.name).toBe("express");
    expect(body.content).toEqual({ summary: "s", keyPoints: ["a"], rawContent: "raw" });
  });

  it("401 : message explicite, la clé n'est jamais dans le message", async () => {
    process.env.LIBRY_API_KEY = "libry_secret_zzz";
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) });

    await expect(librySearch("x")).rejects.toMatchObject({
      name: "LibryError",
      code: "unauthorized",
      status: 401,
    });
    await expect(librySearch("x")).rejects.toThrow(/refusé la clé/);
    try {
      await librySearch("x");
    } catch (e: any) {
      expect((e as Error).message).not.toContain("libry_secret_zzz");
    }
  });

  it("clé absente : message explicite, aucun appel réseau", async () => {
    process.env.LIBRY_URL = "http://libry:3007";
    await expect(librySearch("x")).rejects.toMatchObject({ code: "key_missing" });
    await expect(librySearch("x")).rejects.toThrow(/clé API absente/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injoignable : message explicite (LibryError unreachable)", async () => {
    process.env.LIBRY_URL = "http://libry:3007";
    process.env.LIBRY_API_KEY = "libry_k3";
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(librySearch("x")).rejects.toBeInstanceOf(LibryError);
    await expect(librySearch("x")).rejects.toMatchObject({ code: "unreachable" });
    await expect(librySearch("x")).rejects.toThrow(/injoignable/);
  });

  it("timeout : message explicite (AbortError → code timeout)", async () => {
    process.env.LIBRY_API_KEY = "libry_k4";
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(librySearch("x")).rejects.toMatchObject({ code: "timeout" });
  });
});
