/**
 * B10 (performance) — `GET /api/cbm/status` ne doit JAMAIS geler la boucle
 * d'événements.
 *
 * Avant : `getCbmVersion()` faisait `execSync(... --version, { timeout: 10_000 })`
 * et `isServerRunning()` un `execSync("curl …", { timeout: 3000 })`. Appelés
 * depuis le handler HTTP, ils bloquaient le processus jusqu'à 13 s : le
 * streaming WebSocket des sessions LLM en cours s'arrêtait net.
 *
 * Après : `execFile` promisifié + `fetch` (timeouts identiques), handler async.
 *
 * Aucun réseau : `child_process` est entièrement simulé et `fetch` n'est
 * intercepté que pour 127.0.0.1:9749 (le reste passe par le vrai fetch, utilisé
 * ici pour joindre le serveur Express de test sur un port éphémère).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";

const { execFileMock, execSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execSyncMock: vi.fn(() => {
    throw new Error("execSync interdit dans un handler HTTP (B10)");
  }),
}));

// `promisify(execFile)` retombe sur la convention callback : la simulation
// résout APRÈS un délai, ce qui laisse la boucle d'événements respirer.
vi.mock("child_process", () => ({
  execFile: execFileMock,
  execSync: execSyncMock,
}));

const realFetch = globalThis.fetch;
let fakeBin: string;
let server: import("http").Server;
let base: string;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cbm-status-"));
  fakeBin = path.join(dir, "codebase-memory-mcp");
  writeFileSync(fakeBin, "#!/bin/sh\n");
  process.env.CBM_BIN_PATH = fakeBin;

  execFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (e: unknown, out: unknown) => void) => {
      setTimeout(() => cb(null, { stdout: "codebase-memory-mcp 0.11.0", stderr: "" }), 30);
    },
  );

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    if (url.startsWith("http://127.0.0.1:9749")) {
      // Serveur CBM « vivant mais sans route racine » (cas réel).
      return new Response(null, { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const { default: cbmRouter } = await import("./cbm.js");
  const app = express();
  app.use(express.json());
  app.use("/api/cbm", cbmRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  execSyncMock.mockClear();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  delete process.env.CBM_BIN_PATH;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    rmSync(path.dirname(fakeBin), { recursive: true, force: true });
  } catch {}
});

describe("B10 — /api/cbm/status ne bloque pas la boucle d'événements", () => {
  it("la source n'appelle plus execSync (aucun gel synchrone possible)", () => {
    const src = readFileSync(fileURLToPath(new URL("./cbm.ts", import.meta.url)), "utf-8");
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/?\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/execSync/);
    expect(code).toMatch(/execFile/);
  });

  it("répond installed/version/running ET laisse la boucle d'événements tourner", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 2);
    let body: any;
    try {
      const res = await realFetch(`${base}/api/cbm/status`);
      body = await res.json();
    } finally {
      clearInterval(timer);
    }
    // Si le handler bloquait (execSync), aucun tick n'aurait pu s'exécuter
    // pendant l'interrogation du binaire (simulée à 30 ms).
    expect(ticks).toBeGreaterThan(0);
    expect(execSyncMock).not.toHaveBeenCalled();
    expect(body.installed).toBe(true);
    expect(body.version).toBe("0.11.0");
    expect(body.running).toBe(true);
  });
});
