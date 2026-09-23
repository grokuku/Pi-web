/**
 * Tests de sharedMemoryAuth — correctif SEC-02.
 *
 * Vérifie que le bypass localhost de la mémoire partagée repose sur la socket
 * réelle (non forgeable via X-Forwarded-For) et que le tag caller "localhost"
 * est bien posé pour une requête réellement locale.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { sharedMemoryAuth } from "./shared-memory.js";

type SharedReq = Request & { memoryCaller?: any };
type Res = Response & { statusCode: number };

function makeReq(options: { remoteAddress?: string; ip?: string; headers?: Record<string, string> } = {}): SharedReq {
  const { remoteAddress = "192.168.1.50", ip = remoteAddress, headers = {} } = options;
  return { method: "GET", path: "/memories", query: {}, headers, socket: { remoteAddress }, ip } as unknown as SharedReq;
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

afterEach(() => vi.restoreAllMocks());

describe("sharedMemoryAuth — SEC-02", () => {
  it("X-Forwarded-For: 127.0.0.1 avec socket distante → 401 (pas de caller localhost)", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "127.0.0.1" }, ip: "127.0.0.1" });
    const res = makeRes();
    const next = vi.fn();

    sharedMemoryAuth(req, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(req.memoryCaller).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("socket réellement locale → bypass avec caller localhost", () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const req = makeReq({ remoteAddress: addr });
      const next = vi.fn();
      sharedMemoryAuth(req, makeRes(), next as unknown as NextFunction);
      expect(next, addr).toHaveBeenCalledTimes(1);
      expect(req.memoryCaller, addr).toEqual({ source: "localhost" });
    }
  });
});
