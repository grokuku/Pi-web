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
import {
  buildHarnessRolePrompt,
  CBM_EXPLORATION_GUIDE,
  LIBRARY_GUIDE,
  SCRATCHPAD_GUIDE,
  type HarnessRole,
} from "./harness-prompts.js";
import { buildPiWebSystemPrompt } from "./system-prompt.js";

/** Rôles de sous-agent (fonctions de routage du mode harness). */
const ROLES: HarnessRole[] = ["planning", "execute", "review", "integrate"];

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
    // La chaîne de guides a migré dans le module PUR backend/src/pi/harness-prompts.ts
    // (buildHarnessRolePrompt) : c'est le TEXTE réellement envoyé, donc on l'IMPORTE
    // au lieu de grepper une concaténation dans la source de l'extension.
    for (const role of ROLES) {
      const prompt = buildHarnessRolePrompt(role);
      expect(prompt.endsWith(GIT_SAFETY_RULES), `${role} : la consigne doit clore le prompt`).toBe(true);
      expect(prompt).toContain(CBM_EXPLORATION_GUIDE);
      expect(prompt).toContain(SCRATCHPAD_GUIDE);
      expect(prompt).toContain(LIBRARY_GUIDE);
    }
  });

  it("chaque rôle de routage déclare bien la consigne", () => {
    for (const role of ROLES) {
      expect(EXTENSION_SOURCE, role).toContain(`name: "${role}"`);
    }
    // Aucun rôle ne doit composer son prompt à la main (ce serait une 2e source).
    expect(EXTENSION_SOURCE).not.toMatch(/systemPrompt: `## RÔLE/);
    const built = EXTENSION_SOURCE.match(/buildHarnessRolePrompt\("/g) ?? [];
    expect(built).toHaveLength(4);
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

  it("le handler guardBashToolCall bloque une écriture git (test unitaire, sans dispatch SDK)", () => {
    const decision = guardBashToolCall({ toolName: "bash", input: { command: "git reset --mixed HEAD~1" } });
    expect(decision?.block).toBe(true);
    expect(guardBashToolCall({ toolName: "bash", input: { command: "git status" } })).toBeUndefined();
  });
});
