import { describe, expect, it } from "vitest";
import {
  applyContextUsage,
  EMPTY_CONTEXT_STATS,
  hasKnownContextSize,
  type ContextStats,
} from "./context-usage";

// ── Taille du contexte affichée (StatusBar) ────────────────────────────────
// Le SDK renvoie `contextUsage.tokens = null` juste après une compaction : la
// taille exacte n'est connue qu'à la réponse LLM suivante. Ces tests verrouillent
// la règle : on n'affiche JAMAIS l'ancienne valeur comme si elle était vraie, et
// on n'invente aucun chiffre.

const BEFORE: ContextStats = { tokens: 649565, contextPercent: 62, totalTokens: 1234 };

describe("applyContextUsage — compaction (tokens: null)", () => {
  it("remplace l'ancienne valeur par l'état INCONNU (plus de nombre périmé)", () => {
    const next = applyContextUsage(BEFORE, {
      tokens: null,
      contextWindow: 1048576,
      percent: null,
    });
    expect(next).toEqual({ tokens: null, contextPercent: null, totalTokens: 1234 });
    // Le total facturé n'est pas remis à zéro par une compaction.
    expect(next!.totalTokens).toBe(BEFORE.totalTokens);
    expect(hasKnownContextSize(next)).toBe(false);
  });

  it("crée l'état inconnu même si aucune mesure n'avait encore été reçue", () => {
    expect(applyContextUsage(null, { tokens: null, contextWindow: 128000, percent: null })).toEqual({
      tokens: null,
      contextPercent: null,
      totalTokens: 0,
    });
  });

  it("conserve la MÊME référence quand l'état inconnu est déjà affiché (pas de re-rendu)", () => {
    const unknown: ContextStats = { tokens: null, contextPercent: null, totalTokens: 7 };
    expect(applyContextUsage(unknown, { tokens: null, contextWindow: 128000, percent: null })).toBe(unknown);
  });
});

describe("applyContextUsage — non-régression (mesure réelle à chaque tour)", () => {
  it("applique tokens + pourcentage arrondi et conserve le total cumulé", () => {
    const next = applyContextUsage(
      { tokens: null, contextPercent: null, totalTokens: 900 },
      { tokens: 42000, contextWindow: 128000, percent: 32.81 },
    );
    expect(next).toEqual({ tokens: 42000, contextPercent: 33, totalTokens: 900 });
    expect(hasKnownContextSize(next)).toBe(true);
  });

  it("recalcule le pourcentage si `percent` est absent", () => {
    const next = applyContextUsage(BEFORE, { tokens: 64000, contextWindow: 128000 });
    expect(next).toEqual({ tokens: 64000, contextPercent: 50, totalTokens: 1234 });
  });

  it("met bien à jour une mesure qui change d'un tour à l'autre", () => {
    const t1 = applyContextUsage(BEFORE, { tokens: 660000, contextWindow: 1048576, percent: 63 });
    const t2 = applyContextUsage(t1, { tokens: 670000, contextWindow: 1048576, percent: 64 });
    expect(t1!.tokens).toBe(660000);
    expect(t2!.tokens).toBe(670000);
    expect(t2).not.toBe(t1);
  });

  it("conserve la même référence quand la mesure est identique", () => {
    const same = applyContextUsage(BEFORE, { tokens: 649565, contextWindow: 1048576, percent: 62 });
    expect(same).toBe(BEFORE);
  });
});

describe("applyContextUsage — payloads inexploitables", () => {
  it("ignore un usage absent, non-objet ou sans fenêtre exploitable", () => {
    expect(applyContextUsage(BEFORE, undefined)).toBe(BEFORE);
    expect(applyContextUsage(BEFORE, null)).toBe(BEFORE);
    expect(applyContextUsage(BEFORE, [])).toBe(BEFORE);
    // tokens numérique mais fenêtre absente/nulle : pas d'écrasement.
    expect(applyContextUsage(BEFORE, { tokens: 1000 })).toBe(BEFORE);
    expect(applyContextUsage(BEFORE, { tokens: 1000, contextWindow: 0 })).toBe(BEFORE);
    // tokens absent (payload d'un backend plus ancien) : rien à faire.
    expect(applyContextUsage(BEFORE, { contextWindow: 128000 })).toBe(BEFORE);
  });

  it("renvoie null quand il n'y a rien à afficher (ni mesure ni état connu)", () => {
    expect(applyContextUsage(null, undefined)).toBeNull();
    expect(applyContextUsage(undefined, {})).toBeNull();
  });

  it("EMPTY_CONTEXT_STATS sert d'amorçage à zéro (session fraîche)", () => {
    expect(EMPTY_CONTEXT_STATS).toEqual({ tokens: 0, contextPercent: 0, totalTokens: 0 });
    expect(hasKnownContextSize(EMPTY_CONTEXT_STATS)).toBe(true);
  });
});
