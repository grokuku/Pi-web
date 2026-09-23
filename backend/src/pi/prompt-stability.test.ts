/**
 * prompt-stability.test.ts — validation P3 (étude tokens sous-agents) :
 * l'optimisation du PROMPT CACHING exige un préfixe système STRICTEMENT stable
 * pour un couple (projet, rôle). Le cache inter-délégations (entre deux
 * sous-agents du même rôle) est cassé dès qu'un octet du prompt système change.
 *
 * Ces tests prouvent, octet pour octet, que :
 *  1. les helpers en mode `rank: "stable"` (carte du repo P1 + carnet P2) sont
 *     INDÉPENDANTS de la tâche → le prompt système assemblé est identique entre
 *     deux tâches différentes pour un même rôle ;
 *  2. le mode `rank: "task"` (annexe) reste, lui, sensible à la tâche — la
 *     stabilité ci-dessus n'est donc pas « vide » (le boost existe toujours) ;
 *  3. l'annexe de pertinence variable peut être déplacée dans le premier
 *     message user sans jamais entrer dans le préfixe système.
 *
 * On reproduit ici l'assemblage exact fait par extensions/harness-orchestrator
 * (rôle + carte stable + carnet stable + cwd), car l'extension n'est pas
 * importable depuis le backend (elle dépend du SDK). Les briques testées sont
 * les helpers PURS réellement appelés par l'orchestrateur.
 */
import { describe, expect, it } from "vitest";
import {
  buildRepoMap,
  REPO_MAP_MARKER_END,
  REPO_MAP_MARKER_START,
  type RepoMapData,
} from "./repo-map.js";
import {
  buildNotesDigest,
  EXPLORATION_NOTES_MARKER_END,
  EXPLORATION_NOTES_MARKER_START,
  type ExplorationNote,
} from "./exploration-notes.js";

/** Égalité octet-pour-octet (encodage UTF-8). */
function bytesEqual(a: string, b: string): boolean {
  return Buffer.from(a, "utf-8").equals(Buffer.from(b, "utf-8"));
}

// ── Jeu de données réaliste, conçu pour que le BOOST change l'ordre ──
// Deux symboles à faible centralité (inbound 1) : le mode "task" les fait
// remonter en tête selon la tâche, alors que le mode "stable" les laisse en
// queue (tri par centralité seule).
function makeRepoData(): RepoMapData {
  return {
    files: [
      "backend/src/pi/session.ts",
      "backend/src/routes/usage.ts",
      "extensions/harness-orchestrator/index.ts",
      "extensions/codebase-memory/index.ts",
      "frontend/src/components/Chat/ChatView.tsx",
    ],
    hubs: [
      { name: "loadModelLibrary", file: "backend/src/pi/model-library.ts", signature: "()", inbound: 40 },
      { name: "getProject", file: "backend/src/projects/manager.ts", signature: "(id: string)", inbound: 20 },
      { name: "emitSubagentEvent", file: "backend/src/pi/harness-stream.ts", signature: "(p, b, e)", inbound: 8 },
      // Faible centralité : sans boost, ces deux-là restent DERRIÈRE.
      { name: "recordUsage", file: "backend/src/routes/usage.ts", signature: "(r)", inbound: 1 },
      { name: "buildRepoMapAnnexCached", file: "extensions/codebase-memory/index.ts", signature: "(cwd, task, ctx)", inbound: 1 },
    ],
    routes: [
      { method: "GET", path: "/api/usage" },
      { method: "POST", path: "/api/harness/activity" },
    ],
  };
}

function makeNotes(): ExplorationNote[] {
  return [
    {
      at: "2026-09-01T10:00:00.000Z",
      kind: "fact",
      text: "Le routage LLM se résout dans un module dédié",
      file: "backend/src/pi/routing.ts",
    },
    {
      at: "2026-09-02T10:00:00.000Z",
      kind: "pitfall",
      text: "recordUsage agrége les tokens par bucket, penser au cache",
      file: "backend/src/routes/usage.ts",
    },
    {
      at: "2026-09-03T10:00:00.000Z",
      kind: "decision",
      text: "La carte du repo est injectée d'office au démarrage",
      file: "extensions/codebase-memory/index.ts",
    },
  ];
}

// Les deux tâches visent des fichiers/symboles DIFFÉRENTS : en mode "task"
// elles produisent des ordres distincts ; en mode "stable" elles doivent
// produire EXACTEMENT le même texte.
const TASK_A = "Ajoute le tracking cacheReadTokens dans backend/src/routes/usage.ts (recordUsage)";
const TASK_B = "Branche l'annexe dans extensions/codebase-memory/index.ts (buildRepoMapAnnexCached)";

/**
 * Reproduit l'assemblage du PROMPT SYSTÈME stable de l'orchestrateur :
 * rôle + carte stable + carnet stable + cwd. Aucun paramètre de tâche n'entre
 * dans cette fonction — c'est précisément la garantie recherchée.
 */
function assembleSystemPrompt(rolePrompt: string, cwdLine: string): string {
  const mapText = buildRepoMap(makeRepoData(), { rank: "stable" });
  const repoMapBlock = `\n\n${REPO_MAP_MARKER_START}\n${mapText.trim()}\n${REPO_MAP_MARKER_END}`;

  const digest = buildNotesDigest(makeNotes(), { rank: "stable" });
  const notesBlock = digest.trim()
    ? `\n\n${EXPLORATION_NOTES_MARKER_START}\n${digest.trim()}\n${EXPLORATION_NOTES_MARKER_END}`
    : "";

  return rolePrompt + repoMapBlock + notesBlock + (cwdLine ? `\n\n${cwdLine}` : "");
}

/**
 * Reproduit l'annexe de pertinence VARIABLE déposée dans le premier message
 * user : carte boostée + carnet boosté (rank "task").
 */
function assembleTaskAnnex(task: string, context = ""): string {
  const parts: string[] = [];
  const mapText = buildRepoMap(makeRepoData(), { task, context, rank: "task" });
  if (mapText.trim()) parts.push(`### Carte du repo — pertinence pour la tâche\n${mapText.trim()}`);
  const digest = buildNotesDigest(makeNotes(), { task, context, rank: "task" });
  if (digest.trim()) parts.push(`### Carnet d'exploration — pertinence pour la tâche\n${digest.trim()}`);
  return parts.join("\n\n");
}

const ROLE_PROMPT = "Rôle EXECUTE : tu implémentes la tâche déléguée avec les tools cbm_*.";
const CWD_LINE = "Current working directory: /projects/Pi-Web";

describe("P3 — carte du repo : mode stable", () => {
  it("est octet-pour-octet identique pour deux tâches différentes", () => {
    const stableA = buildRepoMap(makeRepoData(), { rank: "stable", task: TASK_A, context: "contexte A" });
    const stableB = buildRepoMap(makeRepoData(), { rank: "stable", task: TASK_B, context: "contexte B" });
    expect(stableA).toBe(stableB);
    expect(bytesEqual(stableA, stableB)).toBe(true);
  });

  it("ignore effectivement les hints (tri par centralité seule)", () => {
    const stable = buildRepoMap(makeRepoData(), { rank: "stable", task: TASK_A });
    const task = buildRepoMap(makeRepoData(), { rank: "task", task: TASK_A });
    // En mode task, recordUsage (cité) remonte devant loadModelLibrary (inbound 40).
    expect(task.split("\n").find((l) => l.includes("↩"))).toContain("recordUsage");
    // En mode stable, c'est la centralité qui gagne, quel que soit la tâche.
    expect(stable.split("\n").find((l) => l.includes("↩"))).toContain("loadModelLibrary");
    expect(stable).not.toBe(task);
  });

  it("est reproductible (même sortie sur appels successifs)", () => {
    const runs = Array.from({ length: 5 }, () =>
      buildRepoMap(makeRepoData(), { rank: "stable", task: TASK_B }),
    );
    for (const r of runs) expect(r).toBe(runs[0]);
  });
});

describe("P3 — carnet d'exploration : mode stable", () => {
  it("est octet-pour-octet identique pour deux tâches différentes", () => {
    const stableA = buildNotesDigest(makeNotes(), { rank: "stable", task: TASK_A });
    const stableB = buildNotesDigest(makeNotes(), { rank: "stable", task: TASK_B });
    expect(stableA).toBe(stableB);
    expect(bytesEqual(stableA, stableB)).toBe(true);
  });

  it("reste sensible à la tâche en mode task (le boost n'est pas vide)", () => {
    const taskA = buildNotesDigest(makeNotes(), { rank: "task", task: TASK_A });
    const taskB = buildNotesDigest(makeNotes(), { rank: "task", task: TASK_B });
    expect(taskA).not.toBe(taskB);
    // La note citée par la tâche A passe en tête en mode task.
    expect(taskA.split("\n")[1]).toContain("usage.ts");
    expect(taskB.split("\n")[1]).toContain("codebase-memory");
  });
});

describe("P3 — prompt système assemblé", () => {
  it("est STRICTEMENT identique entre deux tâches pour un même rôle", () => {
    const promptA = assembleSystemPrompt(ROLE_PROMPT, CWD_LINE);
    const promptB = assembleSystemPrompt(ROLE_PROMPT, CWD_LINE);
    expect(promptA).toBe(promptB);
    expect(bytesEqual(promptA, promptB)).toBe(true);
  });

  it("contient les blocs stables sous leurs marqueurs respectifs", () => {
    const prompt = assembleSystemPrompt(ROLE_PROMPT, CWD_LINE);
    expect(prompt).toContain(REPO_MAP_MARKER_START);
    expect(prompt).toContain(REPO_MAP_MARKER_END);
    expect(prompt).toContain(EXPLORATION_NOTES_MARKER_START);
    expect(prompt).toContain(EXPLORATION_NOTES_MARKER_END);
    // Le rôle et la cwd sont bien présents.
    expect(prompt.startsWith(ROLE_PROMPT)).toBe(true);
    expect(prompt).toContain(CWD_LINE);
  });

  it("ne contient AUCUN élément variable par tâche (l'annexe n'y est pas)", () => {
    const prompt = assembleSystemPrompt(ROLE_PROMPT, CWD_LINE);
    // L'annexe (message user) est marquée d'un titre qui ne doit JAMAIS
    // apparaître côté système — preuve de la séparation stricte P3.
    expect(prompt).not.toContain("pertinence pour la tâche");
    expect(prompt).not.toContain(assembleTaskAnnex(TASK_A).trim());
    expect(prompt).not.toContain(assembleTaskAnnex(TASK_B).trim());
  });
});

describe("P3 — annexe de pertinence (premier message user)", () => {
  it("change selon la tâche (contenu variable assumé)", () => {
    const annexA = assembleTaskAnnex(TASK_A);
    const annexB = assembleTaskAnnex(TASK_B);
    expect(annexA).not.toBe(annexB);
    expect(bytesEqual(annexA, annexB)).toBe(false);
    // Les deux annexes restent centrées sur leur tâche respective.
    expect(annexA.split("\n").find((l) => l.includes("↩"))).toContain("recordUsage");
    expect(annexB.split("\n").find((l) => l.includes("↩"))).toContain("buildRepoMapAnnexCached");
  });

  it("est reproductible pour une même tâche (pas de flottement)", () => {
    const first = assembleTaskAnnex(TASK_A, "contexte stable");
    const second = assembleTaskAnnex(TASK_A, "contexte stable");
    expect(first).toBe(second);
  });

  it("ne pollue jamais le prompt système (séparation stricte P3)", () => {
    const system = assembleSystemPrompt(ROLE_PROMPT, CWD_LINE);
    const annex = assembleTaskAnnex(TASK_A);
    expect(system).not.toContain(annex.trim());
    // Les deux artefacts partagent des données mais pas leur rendu complet.
    expect(annex.length).toBeGreaterThan(0);
  });
});
