/**
 * system-prompt.test.ts — Assemblage du prompt système Pi-Web (migration SDK 0.87.1).
 *
 * Contexte : en 0.87.1 `agent.state.systemPrompt` est un getter sans setter ; le
 * prompt est désormais posé par une extension INLINE via `before_agent_start`
 * (voir system-prompt.ts). Ces tests verrouillent :
 *  - la présence des blocs attendus (contexte projet, mémoire, bannière, instructions) ;
 *  - le remplacement de l'identité par défaut en mode harness ;
 *  - la STABILITÉ byte-à-byte pour un même (projet, mode) — exigence cache P3 ;
 *  - le câblage du handler (outils lus depuis selectedTools, mode relu à chaque run).
 */
import { describe, expect, it } from "vitest";
import { buildPiWebSystemPrompt, createPromptExtension, type PiWebPromptContext } from "./system-prompt.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMode } from "./model-library.js";

const DEFAULT_BASE = `You are an expert coding assistant working in a terminal.

Available tools: read, bash, edit, write

Guidelines:
- Be concise.

Current working directory: /work/proj
`;

const PROJECT_CONTEXT = `\n\n<!-- PI_PROJECT_CONTEXT -->\nYou are working on project "Proj" (ID: p1).\nWorking directory: /work/proj\n<!-- /PI_PROJECT_CONTEXT -->`;
const MEMORY_CONTEXT = `\n\n<!-- PI_MEMORY_CONTEXT -->\n- fait\n<!-- /PI_MEMORY_CONTEXT -->`;

function ctxFor(mode: AgentMode, over: Partial<PiWebPromptContext> = {}): PiWebPromptContext {
  return {
    projectContext: PROJECT_CONTEXT,
    memoryContext: MEMORY_CONTEXT,
    getMode: () => mode,
    ...over,
  };
}

describe("buildPiWebSystemPrompt", () => {
  it("code : conserve l'identité par défaut et injecte contexte + mémoire + bannière", () => {
    const out = buildPiWebSystemPrompt(DEFAULT_BASE, "code", ["read", "bash"], ctxFor("code"));

    expect(out).toContain("You are an expert coding assistant");
    expect(out).toContain("<!-- PI_PROJECT_CONTEXT -->");
    expect(out).toContain("<!-- PI_MEMORY_CONTEXT -->");
    expect(out).toContain("<!-- PI_MODE:CODE -->");
    expect(out).toContain("<!-- PI_MODE_BANNER -->");
    expect(out).toContain("MODE ACTUEL : CODE");
    // La bannière est en TÊTE de prompt.
    expect(out.startsWith("<!-- PI_MODE_BANNER -->")).toBe(true);
    // Les outils actifs apparaissent dans la bannière (source : selectedTools).
    expect(out).toContain("Vos outils : read, bash");
    // Pas d'identité harness en mode code.
    expect(out).not.toContain("chef de projet");
  });

  it("harness : remplace l'identité par défaut et signale le mode ROUTING", () => {
    const out = buildPiWebSystemPrompt(DEFAULT_BASE, "harness", ["delegate"], ctxFor("harness"));

    // L'identité SDK est retirée au profit de l'identité chef de projet.
    expect(out).not.toContain("You are an expert coding assistant");
    expect(out).toContain("Tu es le chef de projet");
    expect(out).toContain("<!-- PI_MODE:HARNESS -->");
    expect(out).toContain("MODE ACTUEL : ROUTING");
    expect(out).toContain("Vos outils : delegate");
  });

  it("est déterministe (stabilité du préfixe pour le cache P3)", () => {
    const a = buildPiWebSystemPrompt(DEFAULT_BASE, "harness", ["read", "delegate"], ctxFor("harness"));
    const b = buildPiWebSystemPrompt(DEFAULT_BASE, "harness", ["read", "delegate"], ctxFor("harness"));
    expect(a).toBe(b);
  });

  it("est idempotent : réassembler un prompt déjà construit ne duplique pas les blocs", () => {
    const once = buildPiWebSystemPrompt(DEFAULT_BASE, "code", ["read"], ctxFor("code"));
    const twice = buildPiWebSystemPrompt(once, "code", ["read"], ctxFor("code"));
    const count = (s: string, needle: string) => s.split(needle).length - 1;
    expect(count(twice, "<!-- PI_PROJECT_CONTEXT -->")).toBe(1);
    expect(count(twice, "<!-- PI_MEMORY_CONTEXT -->")).toBe(1);
    expect(count(twice, "<!-- PI_MODE_BANNER -->")).toBe(1);
  });

  it("tolère un prompt de base vide", () => {
    const out = buildPiWebSystemPrompt("", "code", [], ctxFor("code"));
    expect(out).toContain("MODE ACTUEL : CODE");
    expect(out).toContain("<!-- PI_PROJECT_CONTEXT -->");
  });
});

describe("createPromptExtension", () => {
  it("enregistre un handler before_agent_start et utilise les outils du run", async () => {
    let handler: ((event: any) => any) | undefined;
    const fakePi = { on: (name: string, h: any) => { if (name === "before_agent_start") handler = h; } } as unknown as ExtensionAPI;

    const ext = createPromptExtension(ctxFor("harness"));
    expect(typeof ext).toBe("object");
    await (ext as any).factory(fakePi);

    expect(handler).toBeDefined();
    const result = handler!({
      systemPrompt: DEFAULT_BASE,
      systemPromptOptions: { selectedTools: ["delegate", "read"] },
    });

    expect(result.systemPrompt).toContain("Tu es le chef de projet");
    expect(result.systemPrompt).toContain("Vos outils : delegate, read");
    expect(result.systemPrompt).toContain("<!-- PI_MODE:HARNESS -->");
  });

  it("relit le mode à chaque run (bascule code → harness)", async () => {
    let current: AgentMode = "code";
    let handler: ((event: any) => any) | undefined;
    const fakePi = { on: (_n: string, h: any) => { handler = h; } } as unknown as ExtensionAPI;

    await (createPromptExtension(ctxFor("code", { getMode: () => current })) as any).factory(fakePi);

    const code = handler!({ systemPrompt: DEFAULT_BASE, systemPromptOptions: { selectedTools: [] } });
    expect(code.systemPrompt).toContain("MODE ACTUEL : CODE");

    current = "harness";
    const harness = handler!({ systemPrompt: DEFAULT_BASE, systemPromptOptions: { selectedTools: ["delegate"] } });
    expect(harness.systemPrompt).toContain("MODE ACTUEL : ROUTING");
  });
});
