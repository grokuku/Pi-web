/**
 * session-resolver.test.ts — pont global de résolution cwd → projectId
 * (renfort LOT 2a, diagnostic « silence du streaming sous-agent »).
 *
 * L'extension harness-orchestrator tourne dans le MÊME process que le backend
 * (chargée par jiti) : elle lit `globalThis.__piWebResolveProjectIdByCwd__`,
 * publié par session.ts. Sans ce pont, un cwd qui ne matche pas EXACTEMENT le
 * projectId via /api/projects faisait retomber l'extension sur le NOM DE
 * DOSSIER — aucun socket abonné à ce pseudo-projectId → events sous-agents
 * invisibles (no-op silencieux).
 *
 * Ce test vérifie que le pont est bien publié au chargement de session.ts et
 * qu'il ne jette jamais (cwd vide / inconnu → null, pas d'exception).
 */
import { describe, expect, it } from "vitest";
import { resolveProjectIdByCwd } from "./session.js";

const BRIDGE_KEY = "__piWebResolveProjectIdByCwd__";

describe("pont global cwd → projectId (session.ts)", () => {
  it("est publié sur globalThis au chargement de session.ts", () => {
    expect(typeof (globalThis as any)[BRIDGE_KEY]).toBe("function");
  });

  it("le pont global est la même fonction que l'export (routage extension)", () => {
    expect((globalThis as any)[BRIDGE_KEY]).toBe(resolveProjectIdByCwd);
  });

  it("retourne null sans jeter pour un cwd vide ou inconnu", () => {
    expect(resolveProjectIdByCwd("")).toBeNull();
    expect(resolveProjectIdByCwd("/chemin/qui/n/existe/pas-xyz")).toBeNull();
  });
});
