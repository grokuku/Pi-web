/**
 * Tests des middlewares librarianAuth / librarianAdminOnly — correctif SEC-02.
 *
 * Vérifie que le bypass localhost repose sur la socket réelle (non forgeable)
 * et que le chemin navigateur (isBrowserRequest) de librarianAdminOnly reste
 * fonctionnel.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { librarianAuth, librarianAdminOnly } from "./librarian-auth.js";

type Res = Response & { statusCode: number };

function makeReq(
  options: { remoteAddress?: string; ip?: string; headers?: Record<string, string> } = {}
): Request {
  const { remoteAddress = "192.168.1.50", ip = remoteAddress, headers = {} } = options;
  return { method: "GET", path: "/keys", query: {}, headers, socket: { remoteAddress }, ip } as unknown as Request;
}

function makeRes(): Res {
  const res: any = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn(() => res);
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

describe("librarianAuth — SEC-02", () => {
  it("X-Forwarded-For: 127.0.0.1 avec socket distante → 401", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "127.0.0.1" }, ip: "127.0.0.1" });
    const res = makeRes();
    const next = vi.fn();
    librarianAuth(req, res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("socket réellement locale → bypass", () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const next = vi.fn();
      librarianAuth(makeReq({ remoteAddress: addr }), makeRes(), next as unknown as NextFunction);
      expect(next, addr).toHaveBeenCalledTimes(1);
    }
  });
});

describe("librarianAdminOnly — SEC-02", () => {
  it("X-Forwarded-For: 127.0.0.1 avec socket distante et sans origine navigateur → 403", () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    process.env.WS_ALLOWED_ORIGINS = "";
    const req = makeReq({ headers: { "x-forwarded-for": "127.0.0.1" }, ip: "127.0.0.1" });
    const res = makeRes();
    const next = vi.fn();
    librarianAdminOnly(req, res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("socket réellement locale → bypass", () => {
    const next = vi.fn();
    librarianAdminOnly(makeReq({ remoteAddress: "127.0.0.1" }), makeRes(), next as unknown as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("navigateur (mode allow-all `*`) → autorisé (UI Settings → API Keys)", () => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.WS_ALLOWED_ORIGINS;
    delete process.env.PUBLIC_BASE_URL;
    const req = makeReq({ headers: { origin: "https://pi.example.com", "sec-fetch-site": "same-origin" } });
    const next = vi.fn();
    librarianAdminOnly(req, makeRes(), next as unknown as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
