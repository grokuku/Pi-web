/**
 * Tests du durcissement SEC-03 : les routes CBM hors /api (/cbm-ui, /assets,
 * /rpc) passent désormais par `apiAuth`.
 *
 * 1. Comportemental : un mini-app Express monte `apiAuth` devant les handlers
 *    CBM exactement comme index.ts, avec des origines EXPLICITES (allow-all
 *    désactivé) → origine non autorisée = 401, origine autorisée = passe.
 * 2. Structurel : on vérifie dans le source d'index.ts que les trois montages
 *    incluent bien `apiAuth` et que `/api` reste inchangé (bootstrap non
 *    importable car il démarre le serveur).
 *
 * NB : ce durcissement est INOPÉRANT en mode allow-all (`*`) — cf. le
 * commentaire d'index.ts et middleware/api-auth.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import express from "express";
import { apiAuth } from "./api-auth.js";

vi.mock("../routes/agent-keys.js", () => ({
  validateToken: vi.fn(() => null),
  isAgentEnabled: vi.fn(() => true),
}));

// Neutralise le bypass localhost : le test émet ses requêtes depuis 127.0.0.1
// et doit pouvoir éprouver le chemin « requête navigateur ».
vi.mock("../utils/request-identity.js", () => ({
  isTrustedLocalRequest: vi.fn(() => false),
}));

const ORIGIN_ENV_KEYS = ["ALLOWED_ORIGINS", "WS_ALLOWED_ORIGINS", "PUBLIC_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ORIGIN_ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ORIGIN_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  // Même composition qu'index.ts : apiAuth AVANT le proxy CBM.
  app.use("/rpc", apiAuth, (_req, res) => res.json({ ok: true, route: "rpc" }));
  app.use("/cbm-ui", apiAuth, (_req, res) => res.json({ ok: true, route: "cbm-ui" }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("SEC-03 — /rpc et /cbm-ui passent par apiAuth", () => {
  it("origine NON autorisée : /rpc est refusé (401)", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    process.env.WS_ALLOWED_ORIGINS = "";
    delete process.env.PUBLIC_BASE_URL;
    await withServer(async (base) => {
      const res = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).not.toMatchObject({ ok: true });
    });
  });

  it("origine autorisée : /rpc passe le middleware", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    process.env.WS_ALLOWED_ORIGINS = "";
    delete process.env.PUBLIC_BASE_URL;
    await withServer(async (base) => {
      const res = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: { origin: "https://app.example.com", "sec-fetch-site": "same-site" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, route: "rpc" });
    });
  });

  it("GET /cbm-ui same-origin (UI iframe) : passe sans jeton", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    process.env.WS_ALLOWED_ORIGINS = "";
    delete process.env.PUBLIC_BASE_URL;
    await withServer(async (base) => {
      const res = await fetch(`${base}/cbm-ui`, {
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, route: "cbm-ui" });
    });
  });

  it("GET /cbm-ui avec origine non autorisée : refusé (401)", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    process.env.WS_ALLOWED_ORIGINS = "";
    delete process.env.PUBLIC_BASE_URL;
    await withServer(async (base) => {
      const res = await fetch(`${base}/cbm-ui`, {
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      });
      expect(res.status).toBe(401);
    });
  });
});

describe("SEC-03 — câblage dans index.ts", () => {
  const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

  it("/cbm-ui, /assets et /rpc sont montés avec apiAuth", () => {
    expect(indexSrc).toMatch(/app\.use\(\s*"\/cbm-ui",\s*apiAuth,\s*cbmProxy\s*\)/);
    expect(indexSrc).toMatch(/app\.use\(\s*"\/assets",\s*apiAuth,\s*cbmProxy\s*\)/);
    expect(indexSrc).toMatch(/app\.use\(\s*"\/rpc",\s*apiAuth,\s*cbmProxy\s*\)/);
  });

  it("/api reste monté sur apiAuth (inchangé)", () => {
    expect(indexSrc).toMatch(/app\.use\("\/api",\s*apiAuth\)/);
  });
});
