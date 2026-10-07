/**
 * Tests de la MIGRATION de la préférence de thème persistée.
 *
 * Depuis la bascule sur la brique `tokens`, Pi-Web ne stocke plus un « accent »
 * ni un ancien « thème » (violet, indigo…) mais une FAMILLE de la brique. Toute
 * valeur héritée est RAMENÉE à une famille EXISTANTE — jamais d'état incohérent :
 *   • nouveaux thèmes supprimés → famille la plus proche ;
 *   • ancien accent (`pi-web-accent`) → famille, puis clé supprimée ;
 *   • valeur absente/vide/inconnue → `matrix` (DÉFAUT).
 * Aucun test ici ne modifie le visuel : l'équivalence Matrix est prouvée par
 * `pi-web-theme.test.ts` (valeurs) et `pi-web-themes.dom.test.ts` (DOM).
 */
import { describe, expect, it } from "vitest";
import {
  ACCENT_STORAGE_KEY,
  THEME_NAME_STORAGE_KEY,
  PI_WEB_FAMILY_ORDER,
  LEGACY_ACCENT_TO_THEME,
  LEGACY_THEME_TO_FAMILY,
  readPersistedThemeName,
  type ThemePreferenceStorage,
} from "./pi-web-theme";

// ─────────────────────────────────────────────────────────────────────────────
// Faux stockage (identique au contrat localStorage) — vérifie les écritures/
// suppressions de clés sans dépendre de jsdom.
// ─────────────────────────────────────────────────────────────────────────────
class FakeStorage implements ThemePreferenceStorage {
  map = new Map<string, string>();
  removed: string[] = [];
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.removed.push(key);
    this.map.delete(key);
  }
}

class ThrowingStorage implements ThemePreferenceStorage {
  getItem(): string | null {
    throw new Error("stockage indisponible");
  }
  setItem(): void {
    throw new Error("stockage indisponible");
  }
  removeItem(): void {
    throw new Error("stockage indisponible");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration de la clé d'accent historique `pi-web-accent`
// ─────────────────────────────────────────────────────────────────────────────
describe("migration pi-web-accent → pi-web-theme-name", () => {
  it("migre chacun des 5 accents vers sa famille et nettoie l'ancienne clé", () => {
    for (const [accent, expected] of Object.entries(LEGACY_ACCENT_TO_THEME)) {
      const storage = new FakeStorage();
      storage.setItem(ACCENT_STORAGE_KEY, accent);
      const theme = readPersistedThemeName(storage);
      expect(theme, accent).toBe(expected);
      expect(storage.getItem(THEME_NAME_STORAGE_KEY), accent).toBe(expected);
      expect(storage.getItem(ACCENT_STORAGE_KEY), accent).toBeNull();
      expect(storage.removed, accent).toContain(ACCENT_STORAGE_KEY);
    }
  });

  it("sans aucune clé : famille par défaut Matrix, nouvelle clé écrite, rien à supprimer", () => {
    const storage = new FakeStorage();
    expect(readPersistedThemeName(storage)).toBe("matrix");
    expect(storage.getItem(THEME_NAME_STORAGE_KEY)).toBe("matrix");
    expect(storage.removed).toEqual([]);
  });

  it("ancien accent inconnu → Matrix (jamais d'écran cassé), ancienne clé nettoyée", () => {
    const storage = new FakeStorage();
    storage.setItem(ACCENT_STORAGE_KEY, "turquoise");
    expect(readPersistedThemeName(storage)).toBe("matrix");
    expect(storage.getItem(THEME_NAME_STORAGE_KEY)).toBe("matrix");
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it("ancienne valeur vide (cas réel : l'ancien code écrivait \"\") → Matrix", () => {
    const storage = new FakeStorage();
    storage.setItem(ACCENT_STORAGE_KEY, "");
    expect(readPersistedThemeName(storage)).toBe("matrix");
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration du vocabulaire « thème » historique (clé pi-web-theme-name)
// ─────────────────────────────────────────────────────────────────────────────
describe("migration des anciens thèmes stockés dans pi-web-theme-name", () => {
  it("réécrit chaque ancien thème vers sa famille (purge du vocabulaire)", () => {
    for (const [oldTheme, family] of Object.entries(LEGACY_THEME_TO_FAMILY)) {
      const storage = new FakeStorage();
      storage.setItem(THEME_NAME_STORAGE_KEY, oldTheme);
      const theme = readPersistedThemeName(storage);
      expect(theme, oldTheme).toBe(family);
      // La clé est réécrite en famille uniquement si elle différait.
      expect(storage.getItem(THEME_NAME_STORAGE_KEY), oldTheme).toBe(family);
    }
  });

  it("une famille déjà valide est conservée telle quelle (aucune réécriture)", () => {
    for (const family of PI_WEB_FAMILY_ORDER) {
      const storage = new FakeStorage();
      storage.setItem(THEME_NAME_STORAGE_KEY, family);
      expect(readPersistedThemeName(storage), family).toBe(family);
      expect(storage.getItem(THEME_NAME_STORAGE_KEY), family).toBe(family);
      expect(storage.removed, family).toEqual([]);
    }
  });

  it("ancien thème supprimé « violet » → amethyste", () => {
    const storage = new FakeStorage();
    storage.setItem(THEME_NAME_STORAGE_KEY, "violet");
    expect(readPersistedThemeName(storage)).toBe("amethyste");
    expect(storage.getItem(THEME_NAME_STORAGE_KEY)).toBe("amethyste");
  });

  it("nouvelle clé CORROMPUE → re-migration ; valeur inconnue → Matrix + réécriture", () => {
    const storage = new FakeStorage();
    storage.setItem(THEME_NAME_STORAGE_KEY, "pas-un-theme");
    expect(readPersistedThemeName(storage)).toBe("matrix");
    expect(storage.getItem(THEME_NAME_STORAGE_KEY)).toBe("matrix");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Priorité & robustesse
// ─────────────────────────────────────────────────────────────────────────────
describe("priorité des clés & robustesse", () => {
  it("la NOUVELLE clé valide gagne et ne touche pas l'ancienne clé d'accent", () => {
    const storage = new FakeStorage();
    storage.setItem(THEME_NAME_STORAGE_KEY, "corail");
    storage.setItem(ACCENT_STORAGE_KEY, "green");
    expect(readPersistedThemeName(storage)).toBe("corail");
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBe("green"); // conservée : inoffensive
    expect(storage.removed).toEqual([]);
  });

  it("la nouvelle clé (même ancien thème) gagne sur l'ancienne clé d'accent", () => {
    const storage = new FakeStorage();
    storage.setItem(THEME_NAME_STORAGE_KEY, "midnight");
    storage.setItem(ACCENT_STORAGE_KEY, "rose");
    expect(readPersistedThemeName(storage)).toBe("amethyste");
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBe("rose");
  });

  it("stockage en panne : rend Matrix sans lever d'erreur", () => {
    expect(() => readPersistedThemeName(new ThrowingStorage())).not.toThrow();
    expect(readPersistedThemeName(new ThrowingStorage())).toBe("matrix");
  });

  it("valeur absente/vide/nulle : toujours une famille valide en sortie", () => {
    for (const raw of [null, undefined, "", "  "]) {
      const storage = new FakeStorage();
      if (raw !== null && raw !== undefined) storage.setItem(THEME_NAME_STORAGE_KEY, raw);
      const theme = readPersistedThemeName(storage);
      expect(PI_WEB_FAMILY_ORDER).toContain(theme);
    }
  });

  it("deux lectures successives sont idempotentes (aucune dérive, accent supprimé une fois)", () => {
    const storage = new FakeStorage();
    storage.setItem(ACCENT_STORAGE_KEY, "purple");
    expect(readPersistedThemeName(storage)).toBe("amethyste");
    expect(readPersistedThemeName(storage)).toBe("amethyste");
    expect(storage.removed.filter((k) => k === ACCENT_STORAGE_KEY).length).toBe(1);
  });

  it("ancien accent orange (legacy) → famille Ambre", () => {
    const storage = new FakeStorage();
    storage.setItem(ACCENT_STORAGE_KEY, "orange");
    expect(readPersistedThemeName(storage)).toBe("ambre");
  });
});
