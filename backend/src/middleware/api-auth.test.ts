/**
 * Tests de apiAuth / isBrowserRequest — correctif SEC-02.
 *
 * Couvre : le bypass « localhost » n'est plus forgeable via X-Forwarded-For,
 * les sockets réellement locales restent acceptées, et les flux navigateur ne
 * sont pas cassés (mode allow-all `*` et liste explicite).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { apiAuth, isBrowserRequest } from "./api-auth.js";

// agent-keys est mocké : aucun accès disque, comportement déterministe
// (aucun jeton valide ; des clés existent → requête non-authentifiée = 401).
vi.mock("../routes/agent-keys.js", () => ({
  validateToken: vi.fn(() => null),
  isAgentEnabled: vi.fn(() => true),
}));

type Res = Response & { statusCode: number; body: any };

function makeReq(
  options: { remoteAddress?: string; ip?: string; headers?: Record<string, string>; path?: string; method?: string } = {}
): Request {
  const { remoteAddress = "192.168.1.50", ip = remoteAddress, headers = {}, path = "/whatever", method = "GET" } = options;
  return { method, path, query: {}, headers, socket: { remoteAddress }, ip } as unknown as Request;
}

function makeRes(): Res {
  const res: any = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res as Res;
}

const ORIGIN_ENV_KEYS = ["ALLOWED_ORIGINS", "WS_ALLOWED_ORIGINS", "PUBLIC_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ORIGIN_ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ORIGIN_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe("apiAuth — SEC-02", () => {
  it("X-Forwarded-For: 127.0.0.1 avec socket distante n'est PAS localhost → 401", () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com"; // désactive allow-all
    process.env.WS_ALLOWED_ORIGINS = "";
    const req = makeReq({ headers: { "x-forwarded-for": "127.0.0.1" }, remoteAddress: "192.168.1.50", ip: "127.0.0.1" });
    const res = makeRes();
    const next = vi.fn();

    apiAuth(req, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("socket réellement 127.0.0.1 → bypass localhost", () => {
    const req = makeReq({ remoteAddress: "127.0.0.1" });
    const res = makeRes();
    const next = vi.fn();
    apiAuth(req, res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("socket ::1 et ::ffff:127.0.0.1 restent locales", () => {
    for (const addr of ["::1", "::ffff:127.0.0.1"]) {
      const next = vi.fn();
      apiAuth(makeReq({ remoteAddress: addr }), makeRes(), next as unknown as NextFunction);
      expect(next, addr).toHaveBeenCalledTimes(1);
    }
  });

  it("flux navigateur en mode allow-all (`*`) : reste permissif", () => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.WS_ALLOWED_ORIGINS;
    delete process.env.PUBLIC_BASE_URL;
    const req = makeReq({ headers: { origin: "https://anywhere.example", "sec-fetch-site": "cross-site" } });
    expect(isBrowserRequest(req)).toBe(true);
    const next = vi.fn();
    apiAuth(req, makeRes(), next as unknown as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("origine explicite autorisée + signature navigateur : reste permissif", () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    process.env.WS_ALLOWED_ORIGINS = "";
    const req = makeReq({ headers: { origin: "https://app.example.com", "sec-fetch-site": "same-site" } });
    expect(isBrowserRequest(req)).toBe(true);
    const next = vi.fn();
    apiAuth(req, makeRes(), next as unknown as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("origine explicite NON autorisée : le flux navigateur est refusé", () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    process.env.WS_ALLOWED_ORIGINS = "";
    const req = makeReq({ headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(isBrowserRequest(req)).toBe(false);
    const res = makeRes();
    const next = vi.fn();
    apiAuth(req, res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
