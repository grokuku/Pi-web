// ── Tests unitaires : réglage « détail d'affichage » + migration one-shot ───
// Renommage LOT 1 : pi-web-thinking-expand → pi-web-display-detail.
import { describe, it, expect, vi } from "vitest";
import {
  DISPLAY_DETAIL_KEY,
  LEGACY_THINKING_EXPAND_KEY,
  DEFAULT_DISPLAY_DETAIL_EXPANDED,
  readDisplayDetailExpanded,
  writeDisplayDetailExpanded,
  migrateDisplayDetailSetting,
  subscribeDisplayDetail,
  type SettingStorage,
} from "./display-detail";

/** localStorage de test en mémoire. */
function fakeStorage(initial: Record<string, string> = {}): SettingStorage & { dump(): Record<string, string | null> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map.entries()),
  };
}

describe("migration one-shot pi-web-thinking-expand → pi-web-display-detail", () => {
  it("copie la valeur de l'ancienne clé puis SUPPRIME l'ancienne", () => {
    const st = fakeStorage({ [LEGACY_THINKING_EXPAND_KEY]: "false" });
    migrateDisplayDetailSetting(st);
    expect(st.dump()).toEqual({ [DISPLAY_DETAIL_KEY]: "false" });
    expect(readDisplayDetailExpanded(st)).toBe(false);
  });

  it("la migration n'écrase PAS une valeur fraîche déjà présente", () => {
    const st = fakeStorage({ [LEGACY_THINKING_EXPAND_KEY]: "false", [DISPLAY_DETAIL_KEY]: "true" });
    migrateDisplayDetailSetting(st);
    expect(st.dump()[DISPLAY_DETAIL_KEY]).toBe("true");
    expect(st.dump()[LEGACY_THINKING_EXPAND_KEY]).toBeUndefined();
  });

  it("idempotent : re-passer la migration ne change rien", () => {
    const st = fakeStorage({ [LEGACY_THINKING_EXPAND_KEY]: "true" });
    migrateDisplayDetailSetting(st);
    migrateDisplayDetailSetting(st);
    expect(st.dump()).toEqual({ [DISPLAY_DETAIL_KEY]: "true" });
  });

  it("sans ancienne clé : aucune écriture", () => {
    const st = fakeStorage();
    migrateDisplayDetailSetting(st);
    expect(st.dump()).toEqual({});
  });
});

describe("readDisplayDetailExpanded", () => {
  it("défaut : déplié (true) quand aucune clé n'existe", () => {
    expect(readDisplayDetailExpanded(fakeStorage())).toBe(DEFAULT_DISPLAY_DETAIL_EXPANDED);
    expect(DEFAULT_DISPLAY_DETAIL_EXPANDED).toBe(true);
  });

  it("lit la valeur stockée (false / true)", () => {
    expect(readDisplayDetailExpanded(fakeStorage({ [DISPLAY_DETAIL_KEY]: "false" }))).toBe(false);
    expect(readDisplayDetailExpanded(fakeStorage({ [DISPLAY_DETAIL_KEY]: "true" }))).toBe(true);
  });

  it("lit ET migre en un seul appel", () => {
    const st = fakeStorage({ [LEGACY_THINKING_EXPAND_KEY]: "false" });
    expect(readDisplayDetailExpanded(st)).toBe(false);
    expect(st.dump()).toEqual({ [DISPLAY_DETAIL_KEY]: "false" });
  });
});

describe("writeDisplayDetailExpanded", () => {
  it("écrit la nouvelle clé (et nettoie l'ancienne si elle traîne)", () => {
    const st = fakeStorage({ [LEGACY_THINKING_EXPAND_KEY]: "true" });
    writeDisplayDetailExpanded(false, st);
    expect(st.dump()).toEqual({ [DISPLAY_DETAIL_KEY]: "false" });
  });

  it("notifie les abonnés (application live aux blocs déjà montés)", () => {
    const st = fakeStorage();
    const cb = vi.fn();
    const unsub = subscribeDisplayDetail(cb);
    writeDisplayDetailExpanded(true, st);
    writeDisplayDetailExpanded(false, st);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, true);
    expect(cb).toHaveBeenNthCalledWith(2, false);
    unsub();
    writeDisplayDetailExpanded(true, st);
    expect(cb).toHaveBeenCalledTimes(2); // désabonné
  });

  it("un abonné défaillant ne casse pas la notification des autres", () => {
    const st = fakeStorage();
    const boom = vi.fn(() => { throw new Error("boom"); });
    const ok = vi.fn();
    const u1 = subscribeDisplayDetail(boom);
    const u2 = subscribeDisplayDetail(ok);
    writeDisplayDetailExpanded(false, st);
    expect(ok).toHaveBeenCalledWith(false);
    u1(); u2();
  });
});