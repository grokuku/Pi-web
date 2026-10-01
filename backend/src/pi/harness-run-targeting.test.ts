/**
 * harness-run-targeting.test.ts — LOT 3/4 (orchestrateur interactif) :
 * résolution de cible (runId / fonction / "all") et messages de retour des
 * tools `delegate_stop` / `delegate_steer` / `delegate_list`.
 *
 * Ces helpers sont PURS et testés ici car l'extension harness-orchestrator
 * (chargée par jiti) n'est PAS couverte par vitest.
 */
import { describe, expect, it } from "vitest";
import {
  buildRunListMessage,
  buildSteerResultMessage,
  buildStopResultMessage,
  formatRunAge,
  formatRunLine,
  resolveRunTarget,
  runTargetInfoFromHandle,
  type RunTargetInfo,
} from "./harness-run-targeting.js";
import type { SubagentRunHandle } from "./harness-run-registry.js";

function run(runId: string, over: Partial<RunTargetInfo> = {}): RunTargetInfo {
  return { runId, delegateFunction: "execute", label: "Exécution", startedAt: 1_000, ...over };
}

describe("resolveRunTarget — cible souple runId / fonction / all", () => {
  it("aucun run actif → no-runs, quelle que soit la cible", () => {
    expect(resolveRunTarget([], "d-1").status).toBe("no-runs");
    expect(resolveRunTarget([], "execute").status).toBe("no-runs");
    expect(resolveRunTarget([], "all").status).toBe("no-runs");
    expect(resolveRunTarget([], "").status).toBe("no-runs");
  });

  it("runId exact → un seul run visé", () => {
    const runs = [run("d-1"), run("d-2", { delegateFunction: "review", label: "Relecture" })];
    const res = resolveRunTarget(runs, "d-2");
    expect(res.status).toBe("resolved");
    expect(res.runs.map((r) => r.runId)).toEqual(["d-2"]);
  });

  it("cible par fonction (un seul run de cette fonction) → résolu", () => {
    const runs = [run("d-1"), run("d-2", { delegateFunction: "review", label: "Relecture" })];
    const res = resolveRunTarget(runs, "review");
    expect(res.status).toBe("resolved");
    expect(res.runs.map((r) => r.runId)).toEqual(["d-2"]);
  });

  it("alias de rôle LEGACY → fonction (architect → planning)", () => {
    const runs = [run("d-1", { delegateFunction: "planning", label: "Planification" })];
    expect(resolveRunTarget(runs, "architect").status).toBe("resolved");
    expect(resolveRunTarget(runs, "Architect").status).toBe("resolved");
    expect(resolveRunTarget(runs, "code-reviewer").status).toBe("not-found");
    const reviews = [run("d-2", { delegateFunction: "review", label: "Relecture" })];
    expect(resolveRunTarget(reviews, "security-reviewer").status).toBe("resolved");
  });

  it("cible « all » (insensible à la casse) → tous les runs", () => {
    const runs = [run("d-1"), run("d-2", { delegateFunction: "review" })];
    const res = resolveRunTarget(runs, "ALL");
    expect(res.status).toBe("all");
    expect(res.runs.map((r) => r.runId)).toEqual(["d-1", "d-2"]);
  });

  it("AMBIGUÏTÉ : plusieurs runs de la même fonction → ambiguous + candidats (jamais de devinette)", () => {
    const runs = [run("d-1"), run("d-2"), run("d-3", { delegateFunction: "review" })];
    const res = resolveRunTarget(runs, "execute");
    expect(res.status).toBe("ambiguous");
    expect(res.target).toBe("execute");
    expect(res.runs.map((r) => r.runId)).toEqual(["d-1", "d-2"]);
  });

  it("cible inconnue → not-found (avec la cible normalisée)", () => {
    const runs = [run("d-1")];
    const res = resolveRunTarget(runs, "  Deploy  ");
    expect(res.status).toBe("not-found");
    expect(res.target).toBe("Deploy");
    expect(res.runs).toEqual([]);
  });

  it("cible vide avec runs actifs → not-found (jamais un « all » implicite)", () => {
    expect(resolveRunTarget([run("d-1")], "").status).toBe("not-found");
    expect(resolveRunTarget([run("d-1")], "   ").status).toBe("not-found");
    expect(resolveRunTarget([run("d-1")], undefined).status).toBe("not-found");
  });

  it("ignore les entrées de run invalides (sans runId)", () => {
    const runs = [{ runId: "" } as RunTargetInfo, run("d-ok")];
    expect(resolveRunTarget(runs, "all").runs.map((r) => r.runId)).toEqual(["d-ok"]);
  });
});

describe("runTargetInfoFromHandle — projection depuis le registre", () => {
  it("recopie les métadonnées d'affichage optionnelles", () => {
    const handle: SubagentRunHandle = {
      runId: "d-meta",
      projectId: "p1",
      delegateFunction: "execute",
      label: "Exécution",
      taskExcerpt: "Corriger le bug",
      startedAt: 42,
      model: "prov/model",
      cancel: () => {},
      steer: () => {},
    };
    expect(runTargetInfoFromHandle(handle)).toEqual({
      runId: "d-meta",
      delegateFunction: "execute",
      label: "Exécution",
      taskExcerpt: "Corriger le bug",
      projectId: "p1",
      startedAt: 42,
      model: "prov/model",
    });
  });

  it("supporte un handle minimal (métadonnées absentes)", () => {
    const info = runTargetInfoFromHandle({ runId: "d-min", cancel: () => {}, steer: () => {} });
    expect(info.runId).toBe("d-min");
    expect(info.delegateFunction).toBeUndefined();
  });
});

describe("formatRunAge / formatRunLine — affichage", () => {
  it("formate l'âge en s / min / h", () => {
    expect(formatRunAge(0)).toBe("0s");
    expect(formatRunAge(42_000)).toBe("42s");
    expect(formatRunAge(3 * 60_000)).toBe("3min");
    expect(formatRunAge(65 * 60_000)).toBe("1h05min");
    expect(formatRunAge(-1)).toBe("?");
    expect(formatRunAge(NaN)).toBe("?");
  });

  it("compose une ligne exploitable (runId présent pour cibler)", () => {
    const info = run("d-42", { taskExcerpt: "Corriger le bug d'affichage", model: "prov/model-1" });
    const line = formatRunLine(info, 60_000); // démarré à 1 000 → 59 s
    expect(line).toBe(
      "- Exécution (execute) · d-42 · il y a 59s · prov/model-1 · tâche : « Corriger le bug d'affichage »",
    );
  });

  it("affiche le projet d'appartenance quand il est connu", () => {
    const line = formatRunLine(run("d-p", { projectId: "proj-a" }), 1_000);
    expect(line).toContain("· projet proj-a");
  });

  it("repli sans libellé/fonction/modèle et avec durée inconnue", () => {
    expect(formatRunLine({ runId: "d-x" }, 0)).toBe("- sous-agent · d-x · début inconnu");
  });

  it("tronque une tâche trop longue", () => {
    const line = formatRunLine(run("d-long", { taskExcerpt: "x".repeat(200) }), 1_000);
    expect(line).toContain("« x");
    expect(line).toContain("… »");
    expect(line.length).toBeLessThan(160);
  });
});

describe("buildStopResultMessage — compte-rendu d'arrêt", () => {
  it("aucun run actif → message explicite (pas de silence)", () => {
    const msg = buildStopResultMessage({
      target: "execute",
      resolution: { status: "no-runs", runs: [] },
      cancelled: 0,
    });
    expect(msg).toContain("Aucun sous-agent n'est actif");
    expect(msg).toContain("execute");
  });

  it("cible inconnue → invite à utiliser delegate_list", () => {
    const msg = buildStopResultMessage({
      target: "deploy",
      resolution: { status: "not-found", runs: [], target: "deploy" },
      cancelled: 0,
    });
    expect(msg).toContain("Aucun sous-agent actif ne correspond à « deploy »");
    expect(msg).toContain("delegate_list");
  });

  it("ambiguïté → demande de préciser le runId et liste les candidats", () => {
    const msg = buildStopResultMessage({
      target: "execute",
      resolution: { status: "ambiguous", runs: [run("d-1"), run("d-2")], target: "execute" },
      cancelled: 0,
    });
    expect(msg).toContain("Plusieurs sous-agents");
    expect(msg).toContain("d-1");
    expect(msg).toContain("d-2");
    expect(msg).toContain("identifiant de run");
  });

  it("arrêt résolu → compte-rendu avec les runs et le statut « annulé » attendu", () => {
    const msg = buildStopResultMessage({
      target: "d-1",
      resolution: { status: "resolved", runs: [run("d-1")] },
      cancelled: 1,
    });
    expect(msg).toContain("Arrêt demandé pour 1 sous-agent(s)");
    expect(msg).toContain("d-1");
    expect(msg).toContain("subagent_result");
    expect(msg).toContain("annulé");
  });

  it("course avec une fin de run → signale les runs déjà terminés", () => {
    const msg = buildStopResultMessage({
      target: "all",
      resolution: { status: "all", runs: [run("d-1"), run("d-2")] },
      cancelled: 1,
    });
    expect(msg).toContain("1 déjà terminé(s)");
  });

  it("arrêt sans effet (runs disparus) → message explicite + delegate_list", () => {
    const msg = buildStopResultMessage({
      target: "d-1",
      resolution: { status: "resolved", runs: [run("d-1")] },
      cancelled: 0,
    });
    expect(msg).toContain("rien pu annuler");
    expect(msg).toContain("delegate_list");
  });
});

describe("buildSteerResultMessage — relais d'une consigne", () => {
  it("transmission réussie → compte-rendu + consigne", () => {
    const msg = buildSteerResultMessage({
      target: "d-1",
      resolution: { status: "resolved", runs: [run("d-1")] },
      text: "Utilise le fichier B au lieu de A",
      steered: 1,
    });
    expect(msg).toContain("Consigne transmise à 1 sous-agent(s)");
    expect(msg).toContain("d-1");
    expect(msg).toContain("Utilise le fichier B au lieu de A");
  });

  it("run déjà terminé (steered=0) → propose de relancer une délégation de suivi", () => {
    const msg = buildSteerResultMessage({
      target: "d-1",
      resolution: { status: "resolved", runs: [run("d-1")] },
      text: "précision",
      steered: 0,
    });
    expect(msg).toContain("run déjà terminé");
    expect(msg).toContain("`delegate`");
    expect(msg).toContain("« précision »");
  });

  it("aucun run actif → renvoie aussi la piste de relance", () => {
    const msg = buildSteerResultMessage({
      target: "execute",
      resolution: { status: "no-runs", runs: [] },
      text: "corrige aussi les tests",
      steered: 0,
    });
    expect(msg).toContain("Aucun sous-agent n'est actif");
    expect(msg).toContain("TERMINÉ");
    expect(msg).toContain("corrige aussi les tests");
  });

  it("ambiguïté → demande de préciser (pas de diffusion à tous implicitement)", () => {
    const msg = buildSteerResultMessage({
      target: "execute",
      resolution: { status: "ambiguous", runs: [run("d-1"), run("d-2")], target: "execute" },
      text: "x",
      steered: 0,
    });
    expect(msg).toContain("Plusieurs sous-agents");
    expect(msg).toContain("d-1");
    expect(msg).toContain("d-2");
  });
});

describe("buildRunListMessage — visibilité des runs en cours", () => {
  it("aucun run → message d'état clair", () => {
    expect(buildRunListMessage([], 0)).toContain("Aucun sous-agent n'est en cours");
  });

  it("liste id, fonction, âge et tâche", () => {
    const msg = buildRunListMessage(
      [
        run("d-1", { taskExcerpt: "Tâche A" }),
        run("d-2", { delegateFunction: "review", label: "Relecture", startedAt: 0 }),
      ],
      10_000,
    );
    expect(msg).toContain("Sous-agents en cours (2)");
    expect(msg).toContain("d-1");
    expect(msg).toContain("d-2");
    expect(msg).toContain("il y a 9s");
    expect(msg).toContain("Tâche A");
    expect(msg).toContain("delegate_stop");
    expect(msg).toContain("delegate_steer");
  });
});
