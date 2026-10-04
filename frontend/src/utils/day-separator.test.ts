// ── Séparateur de journée : logique PURE (environnement node) ──────────────
// Contrat verrouillé ici (cf. utils/day-separator.ts) :
//  - détection du changement de jour LOCAL (jamais entre deux messages du
//    même jour) ;
//  - première entrée datée = un repère (haut de fil / ouverture de lot) ;
//  - entrées sans horodatage ignorées (aucun repère, repère de jour non
//    déplacé) ;
//  - insertion des marqueurs AVANT l'entrée qui ouvre le jour, sans recréer
//    les entrées (identité préservée → memo des groupes intact) ;
//  - libellés : TOUJOURS la date complète localisée (« Dimanche 4 Octobre 2026 »
//    en fr, « Sunday 4 October 2026 » en en), jamais « Aujourd'hui »/« Hier ».
import { describe, expect, it } from "vitest";
import { dayKey, daySeparatorIndices, formatDayLabel, withDaySeparators } from "./day-separator";

/** Timestamp LOCAL (new Date(y, m-1, d, h, min)) → indifférent au fuseau du runner. */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("dayKey", () => {
  it("renvoie la clé de jour LOCAL (YYYY-MM-DD)", () => {
    expect(dayKey(at(2024, 2, 2, 0, 0))).toBe("2024-02-02");
    expect(dayKey(at(2024, 2, 2, 23, 59))).toBe("2024-02-02");
    expect(dayKey(at(2024, 12, 31, 23, 59))).toBe("2024-12-31");
    expect(dayKey(at(2025, 1, 1, 0, 0))).toBe("2025-01-01");
  });

  it("renvoie null pour un horodatage absent ou illisible (0 = sentinelle)", () => {
    expect(dayKey(undefined)).toBeNull();
    expect(dayKey(null)).toBeNull();
    expect(dayKey(0)).toBeNull();
    expect(dayKey(-1)).toBeNull();
    expect(dayKey(Number.NaN)).toBeNull();
    expect(dayKey(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("daySeparatorIndices", () => {
  it("liste vide → aucun séparateur", () => {
    expect(daySeparatorIndices([])).toEqual([]);
  });

  it("liste d'un seul message daté → repère à l'index 0 (premier rendu)", () => {
    expect(daySeparatorIndices([at(2024, 2, 2)])).toEqual([0]);
  });

  it("messages du même jour → un seul séparateur (le premier)", () => {
    expect(daySeparatorIndices([at(2024, 2, 2, 9), at(2024, 2, 2, 14), at(2024, 2, 2, 23, 59)])).toEqual([0]);
  });

  it("changement de jour (même à minuit) → nouveau séparateur", () => {
    expect(daySeparatorIndices([at(2024, 2, 2, 23, 59), at(2024, 2, 3, 0, 1)])).toEqual([0, 1]);
  });

  it("plusieurs jours avec répétitions → un index par jour, au premier message du jour", () => {
    expect(
      daySeparatorIndices([
        at(2024, 2, 2, 8),
        at(2024, 2, 2, 12),
        at(2024, 2, 3, 9),
        at(2024, 2, 3, 23),
        at(2024, 2, 5, 6),
      ]),
    ).toEqual([0, 2, 4]);
  });

  it("entrées sans horodatage ignorées : aucun repère pour elles, repère suivant recalé", () => {
    expect(daySeparatorIndices([undefined, at(2024, 2, 2, 8), Number.NaN, at(2024, 2, 2, 18)])).toEqual([1]);
    expect(daySeparatorIndices([undefined, 0, Number.NaN])).toEqual([]);
  });

  it("entrée sans horodatage ENTRE deux messages du même jour → pas de faux séparateur", () => {
    expect(daySeparatorIndices([at(2024, 2, 2, 8), undefined, at(2024, 2, 2, 18)])).toEqual([0]);
  });

  it("première entrée datée APRÈS des entrées sans date → repère (jour de référence inconnu)", () => {
    expect(daySeparatorIndices([undefined, at(2024, 2, 2, 8), at(2024, 2, 3, 8)])).toEqual([1, 2]);
  });
});

describe("withDaySeparators", () => {
  it("insère un marqueur AVANT la première entrée de chaque jour", () => {
    const a = { kind: "group" as const, ts: at(2024, 2, 2, 8), id: "a" };
    const b = { kind: "group" as const, ts: at(2024, 2, 2, 20), id: "b" };
    const c = { kind: "group" as const, ts: at(2024, 2, 3, 9), id: "c" };
    const out = withDaySeparators([a, b, c]);
    expect(out.map((e) => (e.kind === "day" ? `day:${e.ts}` : e.id))).toEqual([
      `day:${a.ts}`,
      "a",
      "b",
      `day:${c.ts}`,
      "c",
    ]);
  });

  it("réutilise les entrées TELLES QUELLES (identité préservée → memo des groupes intact)", () => {
    const a = { kind: "group" as const, ts: at(2024, 2, 2, 8), id: "a" };
    const b = { kind: "group" as const, ts: at(2024, 2, 3, 9), id: "b" };
    const out = withDaySeparators([a, b]);
    expect(out[1]).toBe(a);
    expect(out[3]).toBe(b);
  });

  it("liste vide → liste vide ; même jour → un seul marqueur", () => {
    expect(withDaySeparators([])).toEqual([]);
    const out = withDaySeparators([
      { kind: "group" as const, ts: at(2024, 2, 2, 8) },
      { kind: "group" as const, ts: at(2024, 2, 2, 9) },
    ]);
    expect(out.filter((e) => e.kind === "day")).toHaveLength(1);
    expect(out).toHaveLength(3);
  });
});

describe("formatDayLabel", () => {
  it("fr : date complète (jour de semaine + jour + mois + année), format de l'utilisateur", () => {
    expect(formatDayLabel(at(2026, 10, 4), "fr")).toBe("Dimanche 4 Octobre 2026");
    expect(formatDayLabel(at(2024, 2, 2), "fr")).toBe("Vendredi 2 Février 2024");
  });

  it("en : même structure adaptée à la locale (jour de semaine, jour, mois, année)", () => {
    expect(formatDayLabel(at(2026, 10, 4), "en")).toBe("Sunday 4 October 2026");
    expect(formatDayLabel(at(2024, 2, 2), "en")).toBe("Friday 2 February 2024");
  });

  it("un message du JOUR affiche la date complète, jamais « Aujourd'hui »", () => {
    const todayNoon = new Date();
    todayNoon.setHours(12, 0, 0, 0);
    const label = formatDayLabel(todayNoon.getTime(), "fr");
    expect(label).not.toBe("Aujourd'hui");
    // Structure attendue : « <Jour> <n> <Mois> <année> ».
    expect(label).toMatch(/^\p{Lu}\p{Ll}+ \d{1,2} \p{Lu}\p{Ll}+ \d{4}$/u);
  });

  it("la veille affiche aussi la date complète, jamais « Hier »", () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    y.setHours(12, 0, 0, 0);
    expect(formatDayLabel(y.getTime(), "fr")).not.toBe("Hier");
  });

  it("horodatage illisible → chaîne vide (aucun repère rendu)", () => {
    expect(formatDayLabel(0, "fr")).toBe("");
    expect(formatDayLabel(Number.NaN, "en")).toBe("");
  });
});
