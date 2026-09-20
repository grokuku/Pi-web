// ── Tests unitaires : règle de repli/dépli des blocs (LOT 1 + auto-gestion) ──
// La règle est le cœur du correctif « le réglage global doit s'appliquer aux
// blocs DÉJÀ MONTÉS » : elle est évaluée à chaque render (fonction pure), elle
// n'est plus figée dans un useState d'initialisation.
//
// Correctif auto-gestion (rétablissement des comportements perdus) :
//   - auto-dépli de l'OUTIL EN COURS (isRunning) → sortie live (tail -f) ;
//   - auto-repli de la RÉFLEXION CONSOMMÉE (hasTextStarted) → « a réfléchi Xs ».
// Les deux sont TRANSITOIRES (pas des overrides mémorisés) : une fois l'état
// passé (outil terminé / tour terminé), la règle normale reprend.
import { describe, it, expect } from "vitest";
import { resolveExpanded } from "./collapse";

// Raccourci : le réglage global est requis, tous les autres champs optionnels.
const resolve = (o: Omit<Parameters<typeof resolveExpanded>[0], "defaultDetailExpanded"> & { defaultDetailExpanded?: boolean }) =>
  resolveExpanded({ defaultDetailExpanded: false, ...o });

describe("resolveExpanded — précédence : override > outil en cours > réflexion consommée > erreur > réglage", () => {
  it("l'override utilisateur PRIME toujours (y compris sur erreur, outil en cours et réflexion consommée)", () => {
    expect(resolve({ userOverride: true, isError: true, isRunning: true, hasTextStarted: true })).toBe(true);
    expect(resolve({ userOverride: false, isError: true, isRunning: true, hasTextStarted: true })).toBe(false);
    expect(resolve({ userOverride: false, defaultDetailExpanded: true, isError: true, isRunning: true })).toBe(false);
    expect(resolve({ userOverride: true, defaultDetailExpanded: true, hasTextStarted: true })).toBe(true);
  });

  it("AUTO-DÉPLI outil en cours : déplié quel que soit le réglage, même sans output d'erreur", () => {
    expect(resolve({ isRunning: true })).toBe(true);                          // réglage replié
    expect(resolve({ isRunning: true, defaultDetailExpanded: true })).toBe(true);
    expect(resolve({ isRunning: true, isError: true })).toBe(true);           // théorique : running gagne
  });

  it("AUTO-REPLI réflexion consommée : replié même si le réglage global est « déplié », même en turn échoué", () => {
    expect(resolve({ hasTextStarted: true, defaultDetailExpanded: true })).toBe(false); // réglage déplié
    expect(resolve({ hasTextStarted: true, isError: true })).toBe(false);               // texte commencé > erreur
    expect(resolve({ hasTextStarted: true })).toBe(false);                              // réglage replié
  });

  it("sans auto-état : les ERREURS sont toujours dépliées (auto-dépli forcé)", () => {
    expect(resolve({ isError: true })).toBe(true);
    expect(resolve({ isError: true, defaultDetailExpanded: true })).toBe(true);
    expect(resolve({ isError: false })).toBe(false);
  });

  it("sans auto-état ni erreur : le réglage global décide", () => {
    expect(resolve({ defaultDetailExpanded: true })).toBe(true);
    expect(resolve({})).toBe(false);
  });

  it("AUTO-GESTION TRANSITOIRE : une fois l'état passé, la règle normale reprend", () => {
    // Outil en cours → déplié ; outil terminé (isRunning=false) → réglage global.
    expect(resolve({ isRunning: true })).toBe(true);
    expect(resolve({ isRunning: false })).toBe(false);
    expect(resolve({ isRunning: false, defaultDetailExpanded: true })).toBe(true);
    // Réflexion consommée pendant le stream → repliée ; tour terminé
    // (hasTextStarted retombe à false, calculé par l'appelant) → réglage global.
    expect(resolve({ hasTextStarted: true, defaultDetailExpanded: true })).toBe(false);
    expect(resolve({ hasTextStarted: false, defaultDetailExpanded: true })).toBe(true);
  });

  it("objectif clé LOT 1 : le réglage affecte les blocs déjà montés — sauf override ou auto-état actif", () => {
    for (const isError of [false, true]) {
      for (const override of [undefined, true, false]) {
        const before = resolve({ userOverride: override, defaultDetailExpanded: true, isError });
        const after = resolve({ userOverride: override, defaultDetailExpanded: false, isError });
        if (override !== undefined) {
          expect(before).toBe(after); // l'override isole du réglage
        } else {
          expect(before === after).toBe(isError); // sinon le réglage agit (sauf erreur forcée)
        }
      }
    }
    // Les auto-états isolent AUSSI du réglage (déplié/replié identique)…
    expect(resolve({ defaultDetailExpanded: true, isRunning: true }))
      .toBe(resolve({ defaultDetailExpanded: false, isRunning: true }));
    expect(resolve({ defaultDetailExpanded: true, hasTextStarted: true }))
      .toBe(resolve({ defaultDetailExpanded: false, hasTextStarted: true }));
    // …mais restent transitoires : sans eux, le réglage redevient décisionnaire.
    expect(resolve({ defaultDetailExpanded: true })).not.toBe(resolve({ defaultDetailExpanded: false }));
  });

  it("matrice complète (5 dimensions) : la précédence est totale et déterministe", () => {
    for (const defaultDetailExpanded of [false, true]) {
      for (const isError of [false, true]) {
        for (const isRunning of [false, true]) {
          for (const hasTextStarted of [false, true]) {
            for (const userOverride of [undefined, false, true]) {
              const expanded = resolveExpanded({ userOverride, defaultDetailExpanded, isError, isRunning, hasTextStarted });
              const attendu =
                userOverride !== undefined ? userOverride       // 1. l'utilisateur décide
                : isRunning ? true                              // 2. outil en cours → déplié
                : hasTextStarted ? false                        // 3. réflexion consommée → replié
                : isError || defaultDetailExpanded;             // 4/5. erreur, puis réglage
              expect(expanded).toBe(attendu);
            }
          }
        }
      }
    }
  });
});