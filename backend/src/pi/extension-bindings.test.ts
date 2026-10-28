/**
 * extension-bindings.test.ts — branchement du SDK MCP dans Pi-Web.
 *
 * Ce que ces tests verrouillent (aucun réseau, aucun LLM, aucun spawn) :
 *  1. `createMcpExtension()` est bien dans les `extensionFactories` (l'extension
 *     MCP du SDK est enregistrée et déclare un handler `session_start`) ;
 *  2. `bindExtensions` est appelé UNE fois, après la création de session, avec
 *     la forme d'appel des modes du SDK (mode + onError + uiContext) ;
 *  3. un handler `session_start` qui LÈVE ne bloque pas le démarrage ;
 *  4. `session.ts` câble bien les deux (extension-bindings + bind après création),
 *     sans toucher au chargement des extensions existantes (cbm_*, harness).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bindPiWebExtensions,
  createLogOnlyUIContext,
  createPiWebExtensionFactories,
  type BindableSession,
  type ExtensionBindings,
} from "./extension-bindings.js";
import type { PiWebPromptContext } from "./system-prompt.js";

const SESSION_SOURCE = readFileSync(fileURLToPath(new URL("./session.ts", import.meta.url)), "utf8");

const PROMPT_CTX: PiWebPromptContext = {
  projectContext: "",
  memoryContext: "",
  getMode: () => "code",
};

/** Faux `ExtensionAPI` : enregistre les abonnements `on(...)` demandés. */
function fakePi(): { pi: ExtensionAPI; events: string[] } {
  const events: string[] = [];
  const pi = {
    on: (event: string) => {
      events.push(event);
      return () => {};
    },
    registerTool: () => {},
    registerCommand: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    getSettings: () => ({}),
    registerToolRenderer: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return { pi, events };
}

/** Faux session : compte les appels à `bindExtensions` et rejoue `session_start`. */
function fakeSession(handlers: Array<() => unknown> = []) {
  const calls: ExtensionBindings[] = [];
  const session: BindableSession = {
    bindExtensions: async (bindings: ExtensionBindings) => {
      calls.push(bindings);
      // Reproduit le contrat du SDK : `emit` attrape handler par handler.
      for (const handler of handlers) {
        try {
          await handler();
        } catch (e: any) {
          bindings.onError?.({
            extensionPath: "fake-extension",
            event: "session_start",
            error: e?.message || String(e),
          });
        }
      }
    },
  };
  return { session, calls };
}

describe("extensionFactories — MCP du SDK présent", () => {
  it("expose les deux extensions inline (prompt Pi-Web + MCP)", () => {
    const factories = createPiWebExtensionFactories(PROMPT_CTX);
    expect(factories).toHaveLength(2);
  });

  it("l'extension MCP s'enregistre et déclare un handler session_start", async () => {
    const factories = createPiWebExtensionFactories(PROMPT_CTX);
    // `createMcpExtension()` renvoie une ExtensionFactory NUE (forme fonction,
    // pas `{ name, factory }`) : elle s'exécute au chargement, pas au bind.
    const mcp = factories[1] as (api: ExtensionAPI) => unknown;
    const { pi, events } = fakePi();
    await mcp(pi);
    expect(events).toContain("session_start");
  });

  it("le prompt Pi-Web reste branché (before_agent_start + garde-fou tool_call)", async () => {
    const factories = createPiWebExtensionFactories(PROMPT_CTX);
    const { pi, events } = fakePi();
    const prompt = factories[0] as { factory: (api: ExtensionAPI) => unknown };
    await prompt.factory(pi);
    expect(events).toContain("before_agent_start");
    expect(events).toContain("tool_call");
  });
});

describe("bindPiWebExtensions — un seul appel, forme d'appel des modes du SDK", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appelle bindExtensions exactement une fois", async () => {
    const { session, calls } = fakeSession();
    await bindPiWebExtensions(session, "proj-1");
    expect(calls).toHaveLength(1);
  });

  it("fournit mode, uiContext et surtout onError (pas d'échec silencieux)", async () => {
    const { session, calls } = fakeSession();
    await bindPiWebExtensions(session, "proj-1");
    const bindings = calls[0];
    expect(bindings.mode).toBe("print");
    expect(typeof bindings.onError).toBe("function");
    expect(bindings.uiContext).toBeTruthy();
    expect(typeof bindings.uiContext?.notify).toBe("function");
  });

  it("un handler session_start qui lève n'empêche PAS le démarrage", async () => {
    const { session, calls } = fakeSession([
      () => {
        throw new Error("boum dans session_start");
      },
    ]);
    await expect(bindPiWebExtensions(session, "proj-1")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("boum dans session_start");
  });

  it("un bindExtensions qui rejette est journalisé et avalé", async () => {
    const session: BindableSession = {
      bindExtensions: async () => {
        throw new Error("bind cassé");
      },
    };
    await expect(bindPiWebExtensions(session, "proj-1")).resolves.toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("bind cassé");
  });
});

describe("uiContext log-only — les notify MCP deviennent des logs backend", () => {
  it("route info/warning/error vers les logs", () => {
    const lines: string[] = [];
    const ui = createLogOnlyUIContext((level, message) => lines.push(`${level}: ${message}`));
    ui.notify("MCP servers need attention", "warning");
    ui.notify("MCP failed to load", "error");
    ui.notify("Signed in", "info");
    expect(lines).toEqual([
      "warning: MCP servers need attention",
      "error: MCP failed to load",
      "info: Signed in",
    ]);
  });

  it("n'ouvre jamais de dialogue interactif", async () => {
    const ui = createLogOnlyUIContext(() => {});
    expect(await ui.select("t", ["a"])).toBeUndefined();
    expect(await ui.confirm("t", "m")).toBe(false);
    expect(ui.getToolsExpanded()).toBe(false);
  });
});

describe("session.ts — câblage effectif", () => {
  it("utilise createPiWebExtensionFactories(promptContext) pour le loader", () => {
    expect(SESSION_SOURCE).toContain("extensionFactories: createPiWebExtensionFactories(promptContext)");
    // La liste en dur précédente ne doit plus exister.
    expect(SESSION_SOURCE).not.toContain("extensionFactories: [createPromptExtension(");
  });

  it("appelle bindPiWebExtensions une seule fois, après createAgentSession", () => {
    const occurrences = SESSION_SOURCE.match(/await bindPiWebExtensions\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(SESSION_SOURCE.indexOf("await createAgentSession({")).toBeLessThan(
      SESSION_SOURCE.indexOf("await bindPiWebExtensions("),
    );
  });

  it("ne retire pas le chargement des extensions existantes (cbm_*, harness)", () => {
    // Les extensions fichiers restent chargées PAR DÉFAUT par le SDK via
    // settings.extensions : aucun override ni filtre ne doit revenir.
    expect(SESSION_SOURCE).not.toMatch(/extensionsOverride\s*:/);
    expect(SESSION_SOURCE).toContain("new DefaultResourceLoader({");
  });
});
