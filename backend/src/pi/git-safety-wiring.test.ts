/**
 * git-safety-wiring.test.ts — VÉRIFIE QUE LA CONSIGNE ATTEINT BIEN LES AGENTS.
 *
 * Cause racine de l'incident : le prompt d'un sous-agent est REMPLACÉ par
 * l'extension INLINE de la tempSession (extensions/harness-orchestrator/index.ts,
 * handler `before_agent_start`). Les interdictions git du bloc `code` de
 * system-prompt.ts ne les atteignaient donc JAMAIS. La parade est de concaténer
 * GIT_SAFETY_RULES aux 4 prompts de rôle.
 *
 * L'extension n'est pas importable depuis le backend (elle dépend du SDK — cf.
 * prompt-stability.test.ts) : on verrouille donc le câblage par une lecture
 * STATIQUE de sa source (fs, aucun réseau).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GIT_SAFETY_RULES, guardBashToolCall } from "./bash-guard.js";
import { buildPiWebSystemPrompt } from "./system-prompt.js";

const EXTENSION_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../extensions/harness-orchestrator/index.ts", import.meta.url)),
  "utf8",
);

const SYSTEM_PROMPT_CTX = { projectContext: "", memoryContext: "" };

describe("injection de GIT_SAFETY_RULES — prompts de rôle (extension harness)", () => {
  it("importe la consigne partagée depuis le module backend", () => {
    expect(EXTENSION_SOURCE).toContain("backend/src/pi/bash-guard.js");
    expect(EXTENSION_SOURCE).toContain("GIT_SAFETY_RULES");
  });

  it("concatène la consigne aux 4 prompts de rôle (planning, execute, review, integrate)", () => {
    // Chaque prompt se termine par `… + CBM_EXPLORATION_GUIDE + SCRATCHPAD_GUIDE + GIT_SAFETY_RULES`.
    const injections = EXTENSION_SOURCE.match(/\+ SCRATCHPAD_GUIDE \+ GIT_SAFETY_RULES/g) ?? [];
    expect(injections).toHaveLength(4);
  });

  it("chaque rôle de routage déclare bien la consigne", () => {
    for (const role of ["planning", "execute", "review", "integrate"]) {
      expect(EXTENSION_SOURCE, role).toContain(`name: "${role}"`);
    }
    // Aucune autre constante de guide ne doit être oubliée dans la chaîne.
    expect(EXTENSION_SOURCE).not.toMatch(/\+ SCRATCHPAD_GUIDE,(?!\s*\n)/);
  });
});

describe("injection de GIT_SAFETY_RULES — bloc `code` (session principale)", () => {
  it("le prompt système en mode code contient la consigne", () => {
    const prompt = buildPiWebSystemPrompt("You are an expert coding assistant.", "code", ["bash"], SYSTEM_PROMPT_CTX);
    expect(prompt).toContain(GIT_SAFETY_RULES);
    expect(prompt).toContain("INTERDICTION FORMELLE");
    expect(prompt).toContain("L'utilisateur gère seul son historique");
  });

  it("la consigne est dans le bloc <!-- PI_MODE:CODE --> (et pas hors bloc)", () => {
    const prompt = buildPiWebSystemPrompt("base", "code", ["bash"], SYSTEM_PROMPT_CTX);
    const block = prompt.split("<!-- PI_MODE:CODE -->")[1]?.split("<!-- /PI_MODE:CODE -->")[0] ?? "";
    expect(block).toContain("INTERDICTION FORMELLE");
  });

  it("le mode harness reste inchangé sur ce point (l'orchestrateur n'a pas bash)", () => {
    const prompt = buildPiWebSystemPrompt("base", "harness", [], SYSTEM_PROMPT_CTX);
    expect(prompt).not.toContain("INTERDICTION FORMELLE");
  });
});

describe("branchement du garde-fou technique (hook tool_call)", () => {
  it("l'extension des sous-agents enregistre le hook", () => {
    expect(EXTENSION_SOURCE).toContain('pi.on("tool_call"');
    expect(EXTENSION_SOURCE).toContain("guardBashToolCall");
  });

  it("system-prompt.ts (session principale) enregistre le hook", () => {
    const source = readFileSync(fileURLToPath(new URL("./system-prompt.ts", import.meta.url)), "utf8");
    expect(source).toContain('pi.on("tool_call"');
    expect(source).toContain("guardBashToolCall");
  });

  it("les deux branchements bloquent réellement une écriture git", () => {
    const decision = guardBashToolCall({ toolName: "bash", input: { command: "git reset --mixed HEAD~1" } });
    expect(decision?.block).toBe(true);
    expect(guardBashToolCall({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
  });
});
