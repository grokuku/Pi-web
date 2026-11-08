/**
 * F20 — valeurs de mise en page persistées : `parseFloat`/`parseInt` sans
 * `Number.isFinite` produisaient `NaN`, appliqué en CSS (`fontSize: NaN%`,
 * largeur `NaN`) — panne NON réparable depuis l'interface.
 * Toute valeur non finie ou hors bornes doit retomber sur le défaut.
 */
import { describe, expect, it } from "vitest";
import {
  readFiniteNumber,
  readPersistedSidebarWidth,
  readPersistedZoom,
  SIDEBAR_WIDTH_BOUNDS,
  ZOOM_BOUNDS,
} from "./persisted-layout";

describe("persisted-layout — lecture blindée (F20)", () => {
  it("valeur absente → défaut", () => {
    expect(readPersistedZoom(null)).toBe(1.2);
    expect(readPersistedSidebarWidth(null)).toBe(192);
  });

  it("valeur normale → conservée", () => {
    expect(readPersistedZoom("1.4")).toBe(1.4);
    expect(readPersistedSidebarWidth("256")).toBe(256);
  });

  it("valeur corrompue → défaut (jamais NaN)", () => {
    for (const raw of ["abc", "NaN", "Infinity", "-Infinity", "", "   ", "1.2.3x"]) {
      const zoom = readPersistedZoom(raw);
      const width = readPersistedSidebarWidth(raw);
      expect(Number.isFinite(zoom)).toBe(true);
      expect(Number.isFinite(width)).toBe(true);
      expect(zoom).toBe(1.2);
      expect(width).toBe(192);
    }
  });

  it("valeur hors bornes → défaut (zoom 0.6–1.5, sidebar 140–400)", () => {
    expect(readPersistedZoom("9")).toBe(1.2);
    expect(readPersistedZoom("0.1")).toBe(1.2);
    expect(readPersistedSidebarWidth("4000")).toBe(192);
    expect(readPersistedSidebarWidth("10")).toBe(192);
    // Bornes incluses.
    expect(readPersistedZoom(String(ZOOM_BOUNDS.min))).toBe(ZOOM_BOUNDS.min);
    expect(readPersistedZoom(String(ZOOM_BOUNDS.max))).toBe(ZOOM_BOUNDS.max);
    expect(readPersistedSidebarWidth(String(SIDEBAR_WIDTH_BOUNDS.max))).toBe(SIDEBAR_WIDTH_BOUNDS.max);
  });

  it("readFiniteNumber : arrondi de la sidebar, parseFloat tolérant", () => {
    expect(readPersistedSidebarWidth("192.4")).toBe(192);
    expect(readFiniteNumber("250", 192, 140, 400)).toBe(250);
  });
});
