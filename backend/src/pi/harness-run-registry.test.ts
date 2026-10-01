/**
 * harness-run-registry.test.ts — LOT 1 (orchestrateur interactif) : registre des
 * runs de sous-agents (arrêt CIBLÉ/GLOBAL, steer) + pont globalThis.
 *
 * Logique PURE (createRunRegistry) : le backend l'utilise via le pont pour
 * arrêter un run sans toucher à la session de l'orchestrateur. Ces tests
 * garantissent l'isolation entre runs (un Stop ciblé NE tue PAS les autres) et
 * l'étanchéité par projet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRunRegistry,
  ensureHarnessRunRegistry,
  registerHarnessRunRegistry,
  resolveHarnessRunRegistry,
  type SubagentRunHandle,
} from "./harness-run-registry.js";

const BRIDGE_KEY = "__piWebHarnessRunRegistry__";

/** Handle de test : enregistre les appels cancel/steer. */
function makeHandle(runId: string, projectId?: string) {
  const calls = { cancel: 0, steer: [] as string[] };
  const handle: SubagentRunHandle = {
    runId,
    projectId,
    delegateFunction: "execute",
    cancel: () => {
      calls.cancel++;
    },
    steer: (text: string) => {
      calls.steer.push(text);
    },
  };
  return { handle, calls };
}

describe("createRunRegistry (LOT 1)", () => {
  it("register/unregister/get/list", () => {
    const reg = createRunRegistry();
    const a = makeHandle("d-1", "proj-a");
    const b = makeHandle("d-2", "proj-b");
    reg.register(a.handle);
    reg.register(b.handle);
    expect(reg.get("d-1")).toBe(a.handle);
    expect(reg.list().map((h) => h.runId)).toEqual(["d-1", "d-2"]);
    expect(reg.list("proj-a").map((h) => h.runId)).toEqual(["d-1"]);
    reg.unregister("d-1");
    expect(reg.get("d-1")).toBeUndefined();
    expect(reg.list().map((h) => h.runId)).toEqual(["d-2"]);
  });

  it("ignore un handle sans runId", () => {
    const reg = createRunRegistry();
    reg.register({ runId: "", cancel: () => {}, steer: () => {} });
    expect(reg.list()).toHaveLength(0);
  });

  it("cancel CIBLÉ : seul le run visé est arrêté, les AUTRES continuent", () => {
    const reg = createRunRegistry();
    const a = makeHandle("d-1", "proj-a");
    const b = makeHandle("d-2", "proj-a");
    reg.register(a.handle);
    reg.register(b.handle);
    expect(reg.cancel("d-1", "proj-a")).toBe(true);
    expect(a.calls.cancel).toBe(1);
    expect(b.calls.cancel).toBe(0); // ← critère d'acceptation LOT 1
    expect(reg.list("proj-a")).toHaveLength(2); // toujours enregistrés
  });

  it("cancel ciblé refusé si le run appartient à un AUTRE projet (étanchéité)", () => {
    const reg = createRunRegistry();
    const a = makeHandle("d-1", "proj-a");
    reg.register(a.handle);
    expect(reg.cancel("d-1", "proj-b")).toBe(false);
    expect(a.calls.cancel).toBe(0);
    // Sans projectId → autorisé (usage interne).
    expect(reg.cancel("d-1")).toBe(true);
    expect(a.calls.cancel).toBe(1);
  });

  it("cancelAll(none projectId) arrête tous les runs du projet", () => {
    const reg = createRunRegistry();
    const a = makeHandle("d-1", "proj-a");
    const b = makeHandle("d-2", "proj-a");
    const c = makeHandle("d-3", "proj-b");
    reg.register(a.handle);
    reg.register(b.handle);
    reg.register(c.handle);
    expect(reg.cancelAll("proj-a")).toBe(2);
    expect(a.calls.cancel).toBe(1);
    expect(b.calls.cancel).toBe(1);
    expect(c.calls.cancel).toBe(0); // autre projet intact
  });

  it("un cancel qui jette ne bloque pas les autres runs", () => {
    const reg = createRunRegistry();
    const throwing: SubagentRunHandle = {
      runId: "d-boom",
      projectId: "proj-a",
      cancel: () => {
        throw new Error("boom");
      },
      steer: () => {},
    };
    const ok = makeHandle("d-ok", "proj-a");
    reg.register(throwing);
    reg.register(ok.handle);
    expect(() => reg.cancelAll("proj-a")).not.toThrow();
    expect(reg.cancelAll("proj-a")).toBe(2);
    expect(ok.calls.cancel).toBe(2);
  });

  it("steer ciblé dirige le bon run", () => {
    const reg = createRunRegistry();
    const a = makeHandle("d-1");
    reg.register(a.handle);
    expect(reg.steer("d-1", "précise la tâche")).toBe(true);
    expect(a.calls.steer).toEqual(["précise la tâche"]);
    expect(reg.steer("d-absent", "x")).toBe(false);
  });
});

describe("pont globalThis du registre", () => {
  let saved: unknown;

  beforeEach(() => {
    saved = (globalThis as any)[BRIDGE_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete (globalThis as any)[BRIDGE_KEY];
    else (globalThis as any)[BRIDGE_KEY] = saved;
  });

  it("registerHarnessRunRegistry / resolveHarnessRunRegistry", () => {
    const reg = createRunRegistry();
    registerHarnessRunRegistry(reg);
    expect(resolveHarnessRunRegistry()).toBe(reg);
  });

  it("resolve renvoie null si le pont n'est pas un registre valide", () => {
    delete (globalThis as any)[BRIDGE_KEY];
    expect(resolveHarnessRunRegistry()).toBeNull();
    (globalThis as any)[BRIDGE_KEY] = { cancel: () => {} }; // incomplet
    expect(resolveHarnessRunRegistry()).toBeNull();
  });

  it("ensureHarnessRunRegistry crée+publie si absent, puis RÉUTILISE le même registre", () => {
    delete (globalThis as any)[BRIDGE_KEY];
    const first = ensureHarnessRunRegistry();
    expect(resolveHarnessRunRegistry()).toBe(first);

    // Simule le chargement d'une AUTRE instance d'extension (jiti, une par
    // session/tempSession) : elle doit RÉUTILISER le registre publié au lieu de
    // l'écraser par un registre vide (sinon le Stop UI ne trouverait plus les
    // runs de l'orchestrateur).
    const second = ensureHarnessRunRegistry();
    expect(second).toBe(first);
    const a = makeHandle("d-1");
    first.register(a.handle);
    expect(second.list().map((h) => h.runId)).toEqual(["d-1"]);
    expect(resolveHarnessRunRegistry()!.get("d-1")).toBe(a.handle);
  });

  it("ensureHarnessRunRegistry remplace un pont invalide par un registre neuf", () => {
    (globalThis as any)[BRIDGE_KEY] = { cancel: () => {} }; // incomplet → invalide
    const reg = ensureHarnessRunRegistry();
    expect(resolveHarnessRunRegistry()).toBe(reg);
    expect(reg.list()).toEqual([]);
  });
});
