/**
 * cbm-stats.test.ts — tests du module de persistance CUMULÉE des compteurs
 * d'observabilité CBM (backend/src/pi/cbm-stats.ts).
 *
 * Couvre : agrégation pure, vue cumulée = base persistée + session (sans
 * double comptage, gauge `indexedProjects` exclue), round-trip fichier, et
 * robustesse (fichier absent/corrompu/chemin non inscriptible → jamais
 * d'exception).
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  accumulateCumulativeStats,
  addFailureCounters,
  addUsageCounters,
  CBM_STATS_VERSION,
  emptyCumulativeStats,
  emptyFailureCounters,
  emptyUsageCounters,
  loadCbmStats,
  normalizeCumulativeStats,
  persistCbmStats,
} from "./cbm-stats.js";

const NOW = "2026-09-25T10:00:00.000Z";

/** Fichier temporaire isolé par test. */
function tempFile(name = "cbm-stats.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "cbm-stats-"));
  return join(dir, name);
}

describe("cbm-stats — agrégation pure", () => {
  it("additionne les compteurs d'usage (total + byTool + byMode)", () => {
    const a = { totalCalls: 2, totalErrors: 1, byTool: { cbm_search: { ok: 2, fail: 1 } }, byMode: { plan: 1 } };
    const b = { totalCalls: 3, totalErrors: 0, byTool: { cbm_search: { ok: 1, fail: 0 }, cbm_code: { ok: 2, fail: 0 } }, byMode: { plan: 1, execute: 2 } };
    const out = addUsageCounters(a, b);
    expect(out.totalCalls).toBe(5);
    expect(out.totalErrors).toBe(1);
    expect(out.byTool.cbm_search).toEqual({ ok: 3, fail: 1 });
    expect(out.byTool.cbm_code).toEqual({ ok: 2, fail: 0 });
    expect(out.byMode).toEqual({ plan: 2, execute: 2 });
  });

  it("additionne les compteurs d'échecs (dont repoMap served/empty)", () => {
    const a = { total: 1, byTool: { __repo_map: 1 }, byReason: { empty_graph: 1 }, repoMap: { served: 4, empty: 1 } };
    const b = { total: 2, byTool: { __repo_map: 1, cbm_trace: 1 }, byReason: { timeout: 1, empty_graph: 1 }, repoMap: { served: 1, empty: 1 } };
    const out = addFailureCounters(a, b);
    expect(out.total).toBe(3);
    expect(out.byTool).toEqual({ __repo_map: 2, cbm_trace: 1 });
    expect(out.byReason).toEqual({ empty_graph: 2, timeout: 1 });
    expect(out.repoMap).toEqual({ served: 5, empty: 2 });
  });

  it("tolère des compteurs vides", () => {
    expect(addUsageCounters(emptyUsageCounters(), emptyUsageCounters())).toEqual(emptyUsageCounters());
    expect(addFailureCounters(emptyFailureCounters(), emptyFailureCounters())).toEqual(emptyFailureCounters());
  });
});

describe("cbm-stats — vue cumulée = base + session", () => {
  it("agrège session sur la base persistée en conservant `since`", () => {
    const base = emptyCumulativeStats("2026-01-01T00:00:00.000Z");
    base.usage = { totalCalls: 10, totalErrors: 1, byTool: { cbm_search: { ok: 10, fail: 1 } }, byMode: {} };
    base.failures = { total: 2, byTool: {}, byReason: {}, repoMap: { served: 8, empty: 1 } };

    const view = accumulateCumulativeStats(
      base,
      { totalCalls: 3, totalErrors: 0, byTool: { cbm_search: { ok: 3, fail: 0 } }, byMode: { plan: 1 } },
      { total: 1, byTool: { __repo_map: 1 }, byReason: { empty_graph: 1 }, repoMap: { served: 2, empty: 1 } },
      NOW,
    );

    expect(view.since).toBe("2026-01-01T00:00:00.000Z");
    expect(view.updatedAt).toBe(NOW);
    expect(view.version).toBe(CBM_STATS_VERSION);
    expect(view.usage.totalCalls).toBe(13);
    expect(view.usage.byTool.cbm_search).toEqual({ ok: 13, fail: 1 });
    expect(view.usage.byMode).toEqual({ plan: 1 });
    expect(view.failures.total).toBe(3);
    expect(view.failures.repoMap).toEqual({ served: 10, empty: 2 });
  });

  it("EXCLUT la jauge indexedProjects et l'anneau recent (non cumulables)", () => {
    const base = emptyCumulativeStats(NOW);
    const sessionUsage = { totalCalls: 1, totalErrors: 0, byTool: {}, byMode: {}, indexedProjects: 7 };
    const sessionFailures = { total: 0, byTool: {}, byReason: {}, repoMap: { served: 0, empty: 0 }, recent: [{ tool: "x" }] };
    const view = accumulateCumulativeStats(base, sessionUsage, sessionFailures, NOW);
    expect((view.usage as unknown as Record<string, unknown>).indexedProjects).toBeUndefined();
    expect((view.failures as unknown as Record<string, unknown>).recent).toBeUndefined();
    // Recalculer base + session (base figée) ne double JAMAIS : on obtient 1.
    expect(view.usage.totalCalls).toBe(1);
  });

  it("ignore des compteurs de session absents/invalides", () => {
    const base = emptyCumulativeStats(NOW);
    const view = accumulateCumulativeStats(base, undefined, null, NOW);
    expect(view.usage).toEqual(emptyUsageCounters());
    expect(view.failures).toEqual(emptyFailureCounters());
  });
});

describe("cbm-stats — normalisation (robustesse)", () => {
  it("repart de zéro sur une valeur non-objet", () => {
    expect(normalizeCumulativeStats(null, NOW).usage.totalCalls).toBe(0);
    expect(normalizeCumulativeStats("garbage", NOW).failures.total).toBe(0);
  });

  it("coerce les champs manquants/parasites et borne les négatifs", () => {
    const out = normalizeCumulativeStats(
      { since: 123, usage: { totalCalls: -5, byTool: { t: { ok: "3", fail: null } } }, failures: { repoMap: { served: "2" } } },
      NOW,
    );
    expect(out.since).toBe(NOW); // non-string → now
    expect(out.usage.totalCalls).toBe(0); // négatif → 0
    expect(out.usage.byTool.t).toEqual({ ok: 3, fail: 0 });
    expect(out.failures.repoMap).toEqual({ served: 2, empty: 0 });
  });
});

describe("cbm-stats — persistance", () => {
  it("round-trip : persist puis load", () => {
    const file = tempFile();
    const stats = emptyCumulativeStats("2026-01-01T00:00:00.000Z");
    stats.usage.totalCalls = 42;
    stats.failures.repoMap = { served: 9, empty: 3 };
    expect(persistCbmStats(stats, file)).toBe(true);
    expect(existsSync(file)).toBe(true);
    const back = loadCbmStats(file);
    expect(back?.usage.totalCalls).toBe(42);
    expect(back?.failures.repoMap).toEqual({ served: 9, empty: 3 });
    expect(back?.since).toBe("2026-01-01T00:00:00.000Z");
  });

  it("fichier absent → null", () => {
    expect(loadCbmStats(join(tmpdir(), "cbm-absent-xyz.json"))).toBeNull();
  });

  it("fichier corrompu → null (repart de zéro, jamais d'exception)", () => {
    const file = tempFile();
    writeFileSync(file, "{ ceci n'est pas du json", "utf-8");
    expect(loadCbmStats(file)).toBeNull();
  });

  it("chemin non inscriptible → false sans exception", () => {
    const file = tempFile("blocker");
    writeFileSync(file, "x", "utf-8");
    // dirname = fichier régulier existant → mkdirSync échoue, persist ne jette pas.
    expect(() => persistCbmStats(emptyCumulativeStats(NOW), join(file, "sub", "s.json"))).not.toThrow();
    expect(persistCbmStats(emptyCumulativeStats(NOW), join(file, "sub", "s.json"))).toBe(false);
    // Le fichier « blocker » n'a pas été altéré.
    expect(readFileSync(file, "utf-8")).toBe("x");
  });
});
