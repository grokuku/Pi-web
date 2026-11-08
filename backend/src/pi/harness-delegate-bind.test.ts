/**
 * harness-delegate-bind.test.ts — LOT 4 / BUG02 : CÂBLAGE du bind des extensions
 * de la tempSession des délégués.
 *
 * ⚠️ Ce n'est PAS un test d'intégration SDK : l'extension n'est pas importable
 * depuis le backend (elle dépend du SDK — cf. prompt-stability.test.ts) et un
 * vrai `createAgentSession` demanderait un provider. On verrouille donc le
 * CÂBLAGE par une lecture STATIQUE de la source de l'extension (fs, aucun
 * réseau) : la tempSession doit être liée via `bindPiWebExtensions` (qui émet
 * `session_start` et fournit un `onError` journalisé).
 *
 * Bug d'origine : seul session.ts appelait bindExtensions. La tempSession des
 * délégués n'émettait donc jamais `session_start` (handlers d'extension inertes)
 * et, sans listener `onError`, `emitError` du SDK n'écrivait RIEN : échec muet.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXTENSION_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../extensions/harness-orchestrator/index.ts", import.meta.url)),
  "utf8",
);

describe("harness-orchestrator — bind des extensions de la tempSession", () => {
  it("lie la tempSession avec le branchement commun (émet session_start)", () => {
    expect(EXTENSION_SOURCE).toContain(
      'import("../../backend/src/pi/extension-bindings.js")',
    );
    expect(EXTENSION_SOURCE).toContain("await bindPiWebExtensions(tempSession");
  });

  it("lie APRÈS la création de la tempSession et AVANT la restriction d'outils", () => {
    const create = EXTENSION_SOURCE.indexOf("await createAgentSession({");
    const bind = EXTENSION_SOURCE.indexOf("await bindPiWebExtensions(tempSession");
    const restrict = EXTENSION_SOURCE.indexOf("setActiveToolsByName(effectiveFunc.tools)");
    expect(create).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(create);
    expect(restrict).toBeGreaterThan(bind);
  });

  it("ne lie qu'UNE fois (garde anti-double-bind)", () => {
    const calls = EXTENSION_SOURCE.match(/bindPiWebExtensions\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(EXTENSION_SOURCE).toContain("__piWebExtensionsBound");
  });

  it("un bind en échec ne fait pas échouer la délégation (dégradé, loggé)", () => {
    const bind = EXTENSION_SOURCE.indexOf("await bindPiWebExtensions(tempSession");
    const around = EXTENSION_SOURCE.slice(Math.max(0, bind - 900), bind + 400);
    expect(around).toContain("try {");
    expect(around).toContain("catch");
    expect(around).toContain("console.warn");
  });
});
