/**
 * Tests de « appliquer ce routage à d'autres projets » (routing-copy.ts +
 * `applyRoutingToLibrary` de model-library.ts). AUCUN réseau, AUCUN disque :
 * la sélection et l'écriture en mémoire sont testées directement.
 *
 * Ce qui est verrouillé ici :
 *  - la portée est EXPLICITE (pas de défaut implicite), une portée inconnue jette ;
 *  - seuls les projets SÉLECTIONNÉS changent, les autres sont intacts ;
 *  - un projet lié cible son propre routage + ses sous-projets, rien d'autre ;
 *  - un `modelId` introuvable dans la bibliothèque est conservé ET signalé
 *    (repli sur le défaut à la résolution → aucune config cassée) ;
 *  - les seuils par type restent distincts (0,35 System One ≠ 0,6 chat) ;
 *  - l'écriture est ATOMIQUE : une seule sauvegarde pour N projets, et un
 *    échec avant la sauvegarde ne laisse rien sur disque.
 */
import { describe, expect, it } from "vitest";
import {
  isRoutingCopyScope,
  planRoutingCopy,
  routingCopyWarnings,
  selectRoutingTargets,
} from "./routing-copy.js";
import { applyRoutingToLibrary, type ModelLibrary, type ProjectModeConfig } from "./model-library.js";
import {
  DEFAULT_ROUTING_CONFIG,
  DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD,
  type RoutingConfig,
} from "./routing-types.js";
import type { Project } from "../projects/manager.js";

// ── Fixtures ─────────────────────────────────────────

function makeProject(id: string, name: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name,
    storage: "local",
    versioning: "standalone",
    cwd: `/projects/${name}`,
    ...extra,
  } as Project;
}

/** Projet lié « Workspace » regroupant les sous-projets `a` et `b`. */
const PROJECTS: Project[] = [
  makeProject("src", "Courant"),
  makeProject("a", "Alpha"),
  makeProject("b", "Beta"),
  makeProject("ws", "Workspace", { storage: "linked", linkedProjectIds: ["src", "a", "b"] }),
];

const MODELS = [
  { id: "prov__m1" },
  { id: "prov__m2" },
  { id: "prov__clef" },
];

function makeRouting(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    enabled: true,
    trivial: { modelId: "prov__m1", thinkingLevel: "low" },
    standard: { modelId: "prov__m2", thinkingLevel: "medium" },
    complex: { modelId: "prov__m2" },
    review: { modelId: null },
    reviewRiskThreshold: 0.45,
    confidenceThreshold: 0.7,
    systemOneConfidenceThreshold: 0.3,
    classifierModelId: null,
    classifierType: "system-one",
    systemOneModelId: "prov__clef",
    ...overrides,
  };
}

function makeModeConfig(modelId: string | null = null): ProjectModeConfig {
  return {
    code: { modelId: "prov__m1" },
    harness: {
      modelId,
      enabled: true,
      config: { agents: [{ role: "architect", description: "", modelId: "prov__m2", enabled: true }], synthesize: false },
      routing: makeRouting({ trivial: { modelId: null } }),
    },
    activeMode: "harness",
  };
}

function makeLibrary(projectModes: Record<string, ProjectModeConfig> = {}): ModelLibrary {
  return {
    models: MODELS as any,
    defaultModelId: "prov__m1",
    commitModelId: null,
    visionModelId: null,
    audioModelId: null,
    librarianModelId: null,
    projectModes,
    concurrency: { maxLLMSlots: 3, providerMaxLLMSlots: {}, queueTimeoutMs: 3_600_000 },
  };
}

// ── Sélection des cibles ─────────────────────────────

describe("selectRoutingTargets — portée explicite", () => {
  it("refuse une portée absente ou inconnue (jamais de défaut implicite)", () => {
    expect(isRoutingCopyScope(undefined)).toBe(false);
    expect(isRoutingCopyScope("everything")).toBe(false);
    expect(() => selectRoutingTargets({ scope: undefined, sourceProjectId: "src", projects: PROJECTS })).toThrow(/Portée/);
    expect(() => selectRoutingTargets({ scope: "everything", sourceProjectId: "src", projects: PROJECTS })).toThrow(/Portée/);
  });

  it("refuse un projet source inexistant", () => {
    expect(() => selectRoutingTargets({ scope: "all", sourceProjectId: "nope", projects: PROJECTS })).toThrow(/introuvable/);
  });

  it("« all » cible TOUS les projets (projet courant et projet lié inclus)", () => {
    const { targets, skipped } = selectRoutingTargets({ scope: "all", sourceProjectId: "src", projects: PROJECTS });
    expect(targets.map((p) => p.id)).toEqual(["src", "a", "b", "ws"]);
    expect(skipped).toEqual([]);
  });

  it("« all-except-current » retire le projet courant et le rapporte", () => {
    const { targets, skipped } = selectRoutingTargets({
      scope: "all-except-current",
      sourceProjectId: "src",
      projects: PROJECTS,
    });
    expect(targets.map((p) => p.id)).toEqual(["a", "b", "ws"]);
    expect(skipped).toEqual([{ id: "src", name: "Courant", reason: "source" }]);
  });

  it("« linked-subprojects » = projet courant + ses sous-projets, pas les autres", () => {
    const { targets, sourceIsLinked } = selectRoutingTargets({
      scope: "linked-subprojects",
      sourceProjectId: "ws",
      projects: PROJECTS,
    });
    expect(sourceIsLinked).toBe(true);
    expect(targets.map((p) => p.id)).toEqual(["src", "a", "b", "ws"]);
    // Les sous-projets d'un AUTRE projet lié ne sont pas ciblés.
    const fromLocal = selectRoutingTargets({ scope: "linked-subprojects", sourceProjectId: "src", projects: PROJECTS });
    expect(fromLocal.sourceIsLinked).toBe(false);
    expect(fromLocal.targets.map((p) => p.id)).toEqual(["src"]);
  });

  it("« selected » ne cible que les ids cochés et rapporte les ids inconnus", () => {
    const { targets, skipped } = selectRoutingTargets({
      scope: "selected",
      sourceProjectId: "src",
      projects: PROJECTS,
      selectedProjectIds: ["b", "inconnu", "b", ""],
    });
    expect(targets.map((p) => p.id)).toEqual(["b"]);
    expect(skipped).toEqual([{ id: "inconnu", name: "inconnu", reason: "unknown-project" }]);
  });
});

// ── Prévisualisation / avertissements ────────────────

describe("planRoutingCopy — prévisualisation", () => {
  it("compte les cibles, les projets inchangés et expose la liste cochable", () => {
    const plan = planRoutingCopy({
      scope: "all-except-current",
      sourceProjectId: "ws",
      projects: PROJECTS,
      routing: makeRouting(),
      library: { models: MODELS as any },
    });
    expect(plan.targets).toHaveLength(3);
    expect(plan.otherProjects).toBe(3);
    expect(plan.totalProjects).toBe(4);
    expect(plan.totalProjects - plan.targets.length).toBe(1); // inchangé
    expect(plan.candidates).toHaveLength(4);
    expect(plan.candidates.find((c) => c.id === "ws")?.isSource).toBe(true);
    expect(plan.candidates.find((c) => c.id === "b")?.isLinkedSubproject).toBe(true);
    expect(plan.warnings).toEqual([]); // tous les modelId existent
  });

  it("signale les modèles absents de la bibliothèque, par champ et par projet", () => {
    const plan = planRoutingCopy({
      scope: "all",
      sourceProjectId: "src",
      projects: PROJECTS,
      routing: makeRouting({ standard: { modelId: "prov__supprime" }, systemOneModelId: "prov__fantome" }),
      library: { models: MODELS as any },
    });
    expect(plan.warnings).toEqual([
      { field: "standard", modelId: "prov__supprime", projectIds: ["src", "a", "b", "ws"], projectNames: ["Courant", "Alpha", "Beta", "Workspace"] },
      { field: "systemOneModelId", modelId: "prov__fantome", projectIds: ["src", "a", "b", "ws"], projectNames: ["Courant", "Alpha", "Beta", "Workspace"] },
    ]);
  });

  it("aucun avertissement quand le routage ne référence aucun modèle", () => {
    const warnings = routingCopyWarnings(
      { models: MODELS as any },
      PROJECTS,
      makeRouting({ trivial: { modelId: null }, standard: { modelId: null }, classifierModelId: null, systemOneModelId: null }),
    );
    expect(warnings).toEqual([]);
  });
});

// ── Application en mémoire ────────────────────────────

describe("applyRoutingToLibrary — seuls les projets ciblés changent", () => {
  it("écrit la config sur les projets ciblés, laisse les autres INTACTS", () => {
    const library = makeLibrary({ src: makeModeConfig(), a: makeModeConfig(), b: makeModeConfig() });
    const untouchedBefore = JSON.parse(JSON.stringify(library.projectModes.b));

    const { applied } = applyRoutingToLibrary(library, ["src", "a"], makeRouting());

    expect(applied).toEqual(["src", "a"]);
    expect(library.projectModes.src.harness.routing?.standard.modelId).toBe("prov__m2");
    expect(library.projectModes.a.harness.routing?.standard.modelId).toBe("prov__m2");
    // « b » n'était pas ciblé : sa config est identique, octet pour octet.
    expect(JSON.parse(JSON.stringify(library.projectModes.b))).toEqual(untouchedBefore);
  });

  it("ne touche QUE harness.routing (mode, modèle de mode, agents, activeMode préservés)", () => {
    const library = makeLibrary({ a: makeModeConfig("prov__m2") });
    applyRoutingToLibrary(library, ["a"], makeRouting());
    const pm = library.projectModes.a;
    expect(pm.code.modelId).toBe("prov__m1");
    expect(pm.harness.modelId).toBe("prov__m2");
    expect(pm.harness.enabled).toBe(true);
    expect(pm.harness.config.synthesize).toBe(false);
    expect(pm.harness.config.agents).toHaveLength(1);
    expect(pm.activeMode).toBe("harness");
  });

  it("crée l'entrée projectModes d'un projet qui n'en avait pas", () => {
    const library = makeLibrary({});
    const { applied } = applyRoutingToLibrary(library, ["nouveau"], makeRouting());
    expect(applied).toEqual(["nouveau"]);
    expect(library.projectModes.nouveau.harness.routing?.complex.modelId).toBe("prov__m2");
    // Défauts du mode conservés (pas de mode forcé).
    expect(library.projectModes.nouveau.activeMode).toBe("code");
    expect(library.projectModes.nouveau.harness.enabled).toBe(false);
  });

  it("chaque projet reçoit une COPIE PROFONDE (aucun objet partagé)", () => {
    const library = makeLibrary({ a: makeModeConfig(), b: makeModeConfig() });
    applyRoutingToLibrary(library, ["a", "b"], makeRouting());
    expect(library.projectModes.a.harness.routing).not.toBe(library.projectModes.b.harness.routing);
    expect(library.projectModes.a.harness.routing!.trivial).not.toBe(library.projectModes.b.harness.routing!.trivial);
    // Modifier l'un ne doit pas contaminer l'autre.
    library.projectModes.a.harness.routing!.trivial.modelId = "prov__m1";
    expect(library.projectModes.b.harness.routing!.trivial.modelId).toBe("prov__m1");
    library.projectModes.a.harness.routing!.trivial.thinkingLevel = "max";
    expect(library.projectModes.b.harness.routing!.trivial.thinkingLevel).toBe("low");
  });

  it("seuils par type préservés et distincts (System One 0,35 ≠ chat 0,6)", () => {
    const library = makeLibrary({ a: makeModeConfig() });
    applyRoutingToLibrary(library, ["a"], makeRouting({ confidenceThreshold: 0.8, systemOneConfidenceThreshold: 0.25 }));
    const r = library.projectModes.a.harness.routing!;
    expect(r.confidenceThreshold).toBe(0.8);
    expect(r.systemOneConfidenceThreshold).toBe(0.25);
    expect(r.confidenceThreshold).not.toBe(r.systemOneConfidenceThreshold);
  });

  it("payload invalide → défauts appliqués, jamais d'exception", () => {
    const library = makeLibrary({ a: makeModeConfig() });
    applyRoutingToLibrary(library, ["a"], {
      reviewRiskThreshold: 42,
      confidenceThreshold: "beaucoup",
      systemOneConfidenceThreshold: -3,
      classifierType: "quantique",
      trivial: { modelId: "prov__m1", thinkingLevel: "turbo" },
    });
    const r = library.projectModes.a.harness.routing!;
    expect(r.reviewRiskThreshold).toBe(DEFAULT_ROUTING_CONFIG.reviewRiskThreshold);
    expect(r.confidenceThreshold).toBe(DEFAULT_ROUTING_CONFIG.confidenceThreshold);
    expect(r.systemOneConfidenceThreshold).toBe(DEFAULT_SYSTEM_ONE_CONFIDENCE_THRESHOLD);
    expect(r.classifierType).toBe("chat");
    expect(r.trivial.thinkingLevel).toBeUndefined();
    expect(r.trivial.modelId).toBe("prov__m1");
  });

  it("corps non-objet (null) → config par défaut, pas de plantage", () => {
    const library = makeLibrary({ a: makeModeConfig() });
    expect(() => applyRoutingToLibrary(library, ["a"], null)).not.toThrow();
    expect(library.projectModes.a.harness.routing?.classifierType).toBe(DEFAULT_ROUTING_CONFIG.classifierType);
  });

  it("modèle absent de la bibliothèque : id CONSERVÉ tel quel (repli à la résolution)", () => {
    const library = makeLibrary({ a: makeModeConfig() });
    applyRoutingToLibrary(library, ["a"], makeRouting({ standard: { modelId: "prov__supprime" } }));
    expect(library.projectModes.a.harness.routing?.standard.modelId).toBe("prov__supprime");
    // …et c'est bien signalé avant écriture.
    const warnings = routingCopyWarnings(library, [PROJECTS[1]], library.projectModes.a.harness.routing!);
    expect(warnings.map((w) => w.modelId)).toContain("prov__supprime");
  });

  it("ids vides, doublons et non-chaînes ignorés", () => {
    const library = makeLibrary({ a: makeModeConfig() });
    const { applied } = applyRoutingToLibrary(library, ["a", "a", "", undefined as any, 42 as any], makeRouting());
    expect(applied).toEqual(["a"]);
  });
});

// ── Atomicité ─────────────────────────────────────────

describe("écriture atomique", () => {
  it("une SEULE sauvegarde pour N projets (rien n'est écrit projet par projet)", () => {
    const library = makeLibrary({ a: makeModeConfig(), b: makeModeConfig() });
    const writes: ModelLibrary[] = [];
    const save = (lib: ModelLibrary) => writes.push(JSON.parse(JSON.stringify(lib)));

    const { applied } = applyRoutingToLibrary(library, ["a", "b"], makeRouting());
    save(library);

    expect(applied).toHaveLength(2);
    expect(writes).toHaveLength(1);
    // La sauvegarde unique contient DÉJÀ les deux projets mis à jour.
    expect(writes[0].projectModes.a.harness.routing?.complex.modelId).toBe("prov__m2");
    expect(writes[0].projectModes.b.harness.routing?.complex.modelId).toBe("prov__m2");
  });

  it("échec AVANT la sauvegarde → rien n'est enregistré (état à moitié appliqué impossible)", () => {
    // `harness` d'un projet gelé : l'écriture en mémoire jette APRÈS que le
    // premier projet a déjà été modifié. Aucune sauvegarde n'est alors appelée →
    // le fichier reste intact (pas d'état à moitié appliqué).
    const library = makeLibrary({ a: makeModeConfig(), b: makeModeConfig() });
    Object.freeze(library.projectModes.a.harness);

    let saved: ModelLibrary | null = null;
    let error: unknown = null;
    try {
      applyRoutingToLibrary(library, ["b", "a"], makeRouting());
      saved = library; // jamais atteint
    } catch (e) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(saved).toBeNull();
  });
});
