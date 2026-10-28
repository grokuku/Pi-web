/**
 * Persistance / migration de la configuration du CLASSIFIEUR de triage.
 *
 * Le classifieur System One amène deux champs nouveaux dans `RoutingConfig`
 * (`classifierType`, `systemOneModelId`). Ce que cette suite verrouille :
 *   - une config HISTORIQUE (sans ces champs) reste un classifieur `chat` —
 *     aucune régression pour les projets existants ;
 *   - le choix `system-one` et le modèle associé survivent à un aller-retour
 *     disque (migrateLibrary est la fonction de lecture du fichier) ;
 *   - les deux modèles (`classifierModelId` / `systemOneModelId`) sont
 *     INDÉPENDANTS ;
 *   - une valeur de type inconnue (fichier édité à la main) est ramenée au
 *     défaut documenté `chat` ;
 *
 * `migrateLibrary` est une fonction pure : aucun disque n'est touché.
 */
import { describe, expect, it } from "vitest";
import { migrateLibrary } from "./model-library.js";

function libraryWithRouting(routing: unknown) {
  return {
    models: [
      { id: "m-cheap", providerId: "p1", modelId: "cheap", name: "Cheap" },
      { id: "m-clef", providerId: "p2", modelId: "clef", name: "clef" },
    ],
    defaultModelId: "m-cheap",
    projectModes: {
      projet: {
        code: { modelId: "m-cheap" },
        harness: { modelId: "m-cheap", enabled: true, config: {}, routing },
        activeMode: "harness",
      },
    },
  };
}

describe("persistance du type de classifieur", () => {
  it("config historique (sans classifierType ni systemOneModelId) → chat, aucun modèle System One", () => {
    const lib = migrateLibrary(
      libraryWithRouting({
        enabled: true,
        trivial: { modelId: null },
        standard: { modelId: null },
        complex: { modelId: null },
        review: { modelId: null },
        reviewRiskThreshold: 0.5,
        confidenceThreshold: 0.6,
        classifierModelId: "m-cheap",
      }),
    );
    const routing = lib.projectModes.projet.harness.routing!;
    expect(routing.classifierType).toBe("chat");
    expect(routing.systemOneModelId).toBeNull();
    expect(routing.classifierModelId).toBe("m-cheap"); // non régressé
  });

  it("choix system-one + modèle dédié conservés, classifieur chat intact", () => {
    const lib = migrateLibrary(
      libraryWithRouting({
        enabled: true,
        trivial: { modelId: null },
        standard: { modelId: null },
        complex: { modelId: null },
        review: { modelId: null },
        reviewRiskThreshold: 0.5,
        confidenceThreshold: 0.6,
        classifierModelId: "m-cheap",
        classifierType: "system-one",
        systemOneModelId: "m-clef",
      }),
    );
    const routing = lib.projectModes.projet.harness.routing!;
    expect(routing.classifierType).toBe("system-one");
    expect(routing.systemOneModelId).toBe("m-clef");
    expect(routing.classifierModelId).toBe("m-cheap");
  });

  it("type inconnu sur disque → ramené à `chat` (jamais un 3e comportement implicite)", () => {
    const lib = migrateLibrary(
      libraryWithRouting({
        enabled: true,
        trivial: { modelId: null },
        standard: { modelId: null },
        complex: { modelId: null },
        review: { modelId: null },
        reviewRiskThreshold: 0.5,
        confidenceThreshold: 0.6,
        classifierModelId: null,
        classifierType: "chat-v2",
        systemOneModelId: "m-clef",
      }),
    );
    const routing = lib.projectModes.projet.harness.routing!;
    expect(routing.classifierType).toBe("chat");
  });
});

describe("persistance du seuil de confiance System One", () => {
  const base = {
    enabled: true,
    trivial: { modelId: null },
    standard: { modelId: null },
    complex: { modelId: null },
    review: { modelId: null },
    reviewRiskThreshold: 0.5,
    confidenceThreshold: 0.6,
    classifierModelId: null,
    classifierType: "system-one",
    systemOneModelId: "m-clef",
  };

  it("config historique (sans systemOneConfidenceThreshold) → défaut 0.35", () => {
    const lib = migrateLibrary(libraryWithRouting(base));
    const routing = lib.projectModes.projet.harness.routing!;
    expect(routing.systemOneConfidenceThreshold).toBe(0.35);
    expect(routing.confidenceThreshold).toBe(0.6); // seuil du chat intact
  });

  it("valeur enregistrée par l'interface conservée telle quelle", () => {
    const lib = migrateLibrary(libraryWithRouting({ ...base, systemOneConfidenceThreshold: 0.15 }));
    expect(lib.projectModes.projet.harness.routing!.systemOneConfidenceThreshold).toBe(0.15);
  });

  it("valeur hors bornes ou illisible → défaut 0.35, jamais d'exception", () => {
    for (const bad of [1.4, -3, "0.2", null, Number.NaN]) {
      const lib = migrateLibrary(libraryWithRouting({ ...base, systemOneConfidenceThreshold: bad }));
      expect(lib.projectModes.projet.harness.routing!.systemOneConfidenceThreshold).toBe(0.35);
    }
  });
});
