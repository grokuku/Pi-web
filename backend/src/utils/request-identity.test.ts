/**
 * Tests de request-identity.ts — correctif SEC-02.
 *
 * Vérifie que la détection locale repose EXCLUSIVEMENT sur l'adresse réelle de
 * la socket TCP (non forgeable), et jamais sur `req.ip` (dérivé de
 * X-Forwarded-For sous trust proxy, donc contrôlable par le client).
 */
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { isLoopbackAddress, isTrustedLocalRequest } from "./request-identity.js";

function reqWith(remoteAddress: string | undefined, ip = "8.8.8.8"): Request {
  return {
    socket: remoteAddress === undefined ? {} : { remoteAddress },
    ip,
  } as unknown as Request;
}

describe("isLoopbackAddress", () => {
  it("reconnaît les formes de boucle locale IPv4/IPv6", () => {
    for (const addr of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1", "::ffff:127.0.0.2"]) {
      expect(isLoopbackAddress(addr), addr).toBe(true);
    }
  });

  it("normalise la casse et le suffixe de zone IPv6", () => {
    expect(isLoopbackAddress("::1%lo0")).toBe(true);
    expect(isLoopbackAddress("::FFFF:127.0.0.1")).toBe(true);
  });

  it("rejette les adresses distantes et les valeurs invalides", () => {
    for (const addr of [
      "192.168.1.50",
      "10.0.0.1",
      "::ffff:192.168.1.50",
      "128.0.0.1",
      "::2",
      "",
      undefined,
      null,
    ]) {
      expect(isLoopbackAddress(addr as string), String(addr)).toBe(false);
    }
  });
});

describe("isTrustedLocalRequest (SEC-02)", () => {
  it("accepte une socket réellement en boucle locale", () => {
    expect(isTrustedLocalRequest(reqWith("127.0.0.1"))).toBe(true);
    expect(isTrustedLocalRequest(reqWith("::1"))).toBe(true);
    expect(isTrustedLocalRequest(reqWith("::ffff:127.0.0.1"))).toBe(true);
  });

  it("rejette une socket distante même si req.ip est falsifié en 127.0.0.1", () => {
    // Scénario d'attaque : X-Forwarded-For: 127.0.0.1 → req.ip = 127.0.0.1,
    // mais la connexion réelle vient d'ailleurs.
    expect(isTrustedLocalRequest(reqWith("192.168.1.50", "127.0.0.1"))).toBe(false);
    expect(isTrustedLocalRequest(reqWith("::ffff:192.168.1.50", "127.0.0.1"))).toBe(false);
  });

  it("rejette une requête sans adresse de socket", () => {
    expect(isTrustedLocalRequest(reqWith(undefined))).toBe(false);
  });
});
