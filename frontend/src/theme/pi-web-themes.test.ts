/**
 * Tests du NOUVEAU modèle de THÈME de Pi-Web (remplace la notion d'« accent ») :
 *   • catalogue affiché (Matrix en premier, DÉFAUT, puis Violet/Orange/Cyan/Rose
 *     et les thèmes de la bibliothèque holaf) ;
 *   • mapping thème × mode → pack réellement appliqué ;
 *   • pastilles de couleur (aperçu par mode) ;
 *   • MIGRATION de l'ancienne clé `pi-web-accent` → nouvelle clé
 *     `pi-web-theme-name` : les 5 conversions, valeur inconnue, valeur absente,
 *     priorité de la nouvelle clé, stockage en panne ;
 *   • packs hôte des thèmes bibliothèque (triples RGB présents, aucun radius /
 *     shadow / font-size hérité).
 * Aucun test ici ne modifie le visuel : les valeurs Matrix sont prouvées
 * identiques aux anciennes par `pi-web-themes.dom.test.ts`.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  ACCENT_STORAGE_KEY,
  THEME_NAME_STORAGE_KEY,
  DEFAULT_THEME_ID,
  PI_WEB_ACCENTS,
  PI_WEB_LIBRARY_THEME_IDS,
  PI_WEB_PRIMARY_THEME_IDS,
  PI_WEB_THEME_IDS,
  PI_WEB_THEMES,
  LEGACY_ACCENT_TO_THEME,
  hexToRgbTriple,
  libraryPackName,
  mixHex,
  normalizeThemeId,
  readPersistedThemeName,
  themeFromLegacyAccent,
  themePackNameFor,
  themeSwatchColor,
  getThemeDefinition,
  getHolafTokens,
  registerPiWebPacks,
  __resetPacksRegistrationForTests,
  type PiWebThemeId,
  type ThemePreferenceStorage,
} from "./pi-web-theme";

// ─────────────────────────────────────────────────────────────────────────────
// Faux stockage (identique au contrat localStorage) — permet de vérifier les
// écritures/suppressions de clés sans dépendre de jsdom.
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
// Catalogue
// ─────────────────────────────────────────────────────────────────────────────
describe("catalogue des thèmes", () => {
  it("affiche Matrix en premier, puis les 4 autres couleurs, puis la bibliothèque", () => {
    expect(PI_WEB_THEMES.map((def) => def.id)).toEqual([
      "matrix",
      "violet",
      "orange",
      "cyan",
      "rose",
      "indigo",
      "emerald",
      "midnight",
      "slate",
      "amber",
    ]);
    expect(PI_WEB_PRIMARY_THEME_IDS).toEqual(["matrix", "violet", "orange", "cyan", "rose"]);
    expect(PI_WEB_LIBRARY_THEME_IDS).toEqual(["indigo", "emerald", "midnight", "slate", "amber"]);
    for (const id of PI_WEB_THEME_IDS) {
      expect(getThemeDefinition(id), id).toBeTruthy();
    }
  });

  it("n'a qu'un seul thème par défaut : Matrix", () => {
    const defaults = PI_WEB_THEMES.filter((def) => def.isDefault);
    expect(defaults.map((def) => def.id)).toEqual(["matrix"]);
    expect(DEFAULT_THEME_ID).toBe("matrix");
  });

  it("chaque thème porte une clé i18n unique et un mapping cohérent (accent XOR bibliothèque)", () => {
    const labelKeys = new Set<string>();
    for (const def of PI_WEB_THEMES) {
      expect(def.labelKey).toBe(`themes.names.${def.id}`);
      expect(labelKeys.has(def.labelKey), def.labelKey).toBe(false);
      labelKeys.add(def.labelKey);
      expect(!!def.accent !== !!def.library, def.id).toBe(true); // XOR
      if (def.accent) {
        expect(PI_WEB_ACCENTS).toContain(def.accent);
        expect(def.library).toBeNull();
      } else {
        expect(PI_WEB_LIBRARY_THEME_IDS).toContain(def.library as string);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation & anciens accents
// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeThemeId / themeFromLegacyAccent", () => {
  it("convertit les 5 anciens accents vers leur thème (règle de migration)", () => {
    expect(themeFromLegacyAccent("green")).toBe("matrix");
    expect(themeFromLegacyAccent("purple")).toBe("violet");
    expect(themeFromLegacyAccent("orange")).toBe("orange");
    expect(themeFromLegacyAccent("cyan")).toBe("cyan");
    expect(themeFromLegacyAccent("rose")).toBe("rose");
    expect(LEGACY_ACCENT_TO_THEME).toEqual({
      green: "matrix",
      purple: "violet",
      orange: "orange",
      cyan: "cyan",
      rose: "rose",
    });
  });

  it("retombe sur Matrix pour toute valeur inconnue / absente / vide", () => {
    for (const value of ["", "  ", "turquoise", "nope", null, undefined, 42, {}]) {
      expect(themeFromLegacyAccent(value), String(value)).toBe("matrix");
    }
  });

  it("ignore casse et espaces, et laisse passer les identifiants de thème", () => {
    expect(normalizeThemeId("  PURPLE ")).toBe("violet");
    expect(normalizeThemeId("Matrix")).toBe("matrix");
    expect(normalizeThemeId("indigo")).toBe("indigo");
    expect(normalizeThemeId("AMBER")).toBe("amber");
    expect(normalizeThemeId("inconnu")).toBe("matrix");
  });

  it("accepte les anciens accents comme identifiants (compat appels historiques)", () => {
    expect(normalizeThemeId("green")).toBe("matrix");
    expect(normalizeThemeId("purple")).toBe("violet");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration de la clé persistée
// ─────────────────────────────────────────────────────────────────────────────
describe("migration pi-web-accent → pi-web-theme-name", () => {
  it("migre chacun des 5 accents vers le thème équivalent et nettoie l'ancienne clé", () => {
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

  it("sans ancienne clé : thème par défaut Matrix, nouvelle clé écrite, rien à supprimer", () => {
    const storage = new FakeStorage();
    expect(readPersistedThemeName(storage)).toBe("matrix");
    expect(storage.getItem(THEME_NAME_STORAGE_KEY)).toBe("matrix");
    expect(storage.removed).toEqual([]);
  });

  it("ancienne valeur inconnue → Matrix (jamais d'écran cassé) et ancienne clé nettoyée", () => {
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

  it("la NOUVELLE clé valide gagne et ne touche pas l'ancienne", () => {
    const storage = new FakeStorage();
    storage.setItem(THEME_NAME_STORAGE_KEY, "rose");
    storage.setItem(ACCENT_STORAGE_KEY, "green");
    expect(readPersistedThemeName(storage)).toBe("rose");
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBe("green"); // conservée : inoffensive
    expect(storage.removed).toEqual([]);
  });

  it("nouvelle clé corrompue → re-migration depuis l'ancienne clé", () => {
    const storage = new FakeStorage();
    storage.setItem(THEME_NAME_STORAGE_KEY, "pas-un-theme");
    storage.setItem(ACCENT_STORAGE_KEY, "rose");
    expect(readPersistedThemeName(storage)).toBe("rose");
    expect(storage.getItem(THEME_NAME_STORAGE_KEY)).toBe("rose");
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it("stockage en panne : rend Matrix sans lever d'erreur", () => {
    expect(() => readPersistedThemeName(new ThrowingStorage())).not.toThrow();
    expect(readPersistedThemeName(new ThrowingStorage())).toBe("matrix");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mapping thème × mode → pack
// ─────────────────────────────────────────────────────────────────────────────
describe("mapping thème → pack", () => {
  const CASES: Array<[PiWebThemeId, string, string]> = [
    ["matrix", "pi-web-green-dark", "pi-web-green-light"],
    ["violet", "pi-web-purple-dark", "pi-web-purple-light"],
    ["orange", "pi-web-orange-dark", "pi-web-orange-light"],
    ["cyan", "pi-web-cyan-dark", "pi-web-cyan-light"],
    ["rose", "pi-web-rose-dark", "pi-web-rose-light"],
    ["indigo", "pi-web-lib-indigo-dark", "pi-web-lib-indigo-light"],
    ["emerald", "pi-web-lib-emerald-dark", "pi-web-lib-emerald-light"],
    ["midnight", "pi-web-lib-midnight-dark", "pi-web-lib-midnight-light"],
    ["slate", "pi-web-lib-slate-dark", "pi-web-lib-slate-light"],
    ["amber", "pi-web-lib-amber-dark", "pi-web-lib-amber-light"],
  ];

  it("applique le pack pi-web-<accent>-<mode> ou pi-web-lib-<famille>-<mode>", () => {
    for (const [id, dark, light] of CASES) {
      expect(themePackNameFor(id, "dark"), id).toBe(dark);
      expect(themePackNameFor(id, "light"), id).toBe(light);
    }
  });

  it("accepte encore un ancien accent (green → pack vert) et retombe sur Matrix sinon", () => {
    expect(themePackNameFor("green", "dark")).toBe("pi-web-green-dark");
    expect(themePackNameFor("purple", "light")).toBe("pi-web-purple-light");
    expect(themePackNameFor("turquoise", "dark")).toBe("pi-web-green-dark");
    expect(themePackNameFor("", "light")).toBe("pi-web-green-light");
  });

  it("libraryPackName construit le nom des packs hôte de la bibliothèque", () => {
    expect(libraryPackName("indigo", "dark")).toBe("pi-web-lib-indigo-dark");
    expect(libraryPackName("amber", "light")).toBe("pi-web-lib-amber-light");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pastilles de couleur (aperçu selon le mode)
// ─────────────────────────────────────────────────────────────────────────────
describe("themeSwatchColor", () => {
  const EXPECTED: Array<[PiWebThemeId, string, string]> = [
    ["matrix", "#00ff41", "#166534"],
    ["violet", "#c084fc", "#8b5cf6"],
    ["orange", "#fb923c", "#ea580c"],
    ["cyan", "#22d3ee", "#0891b2"],
    ["rose", "#f472b6", "#db2777"],
    ["indigo", "#6366f1", "#4f46e5"],
    ["emerald", "#34d399", "#047857"],
    ["midnight", "#818cf8", "#5b63d3"],
    ["slate", "#94a3b8", "#475569"],
    ["amber", "#fbbf24", "#b45309"],
  ];

  it("rend la couleur d'accent réelle du pack pour chaque thème × mode", () => {
    for (const [id, dark, light] of EXPECTED) {
      expect(themeSwatchColor(id, "dark"), `${id} dark`).toBe(dark);
      expect(themeSwatchColor(id, "light"), `${id} light`).toBe(light);
    }
  });

  it("accepte un ancien accent et retombe sur le vert si inconnu", () => {
    expect(themeSwatchColor("green", "dark")).toBe("#00ff41");
    expect(themeSwatchColor("purple", "light")).toBe("#8b5cf6");
    expect(themeSwatchColor("turquoise", "dark")).toBe("#00ff41");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Packs hôte de la bibliothèque holaf
// ─────────────────────────────────────────────────────────────────────────────
describe("packs hôte de la bibliothèque holaf", () => {
  beforeEach(() => {
    getHolafTokens().reset();
    __resetPacksRegistrationForTests();
    registerPiWebPacks();
  });

  it("enregistre les 10 packs pi-web-lib-* (5 familles × 2 modes)", () => {
    const names = getHolafTokens().listPresets();
    for (const family of PI_WEB_LIBRARY_THEME_IDS) {
      expect(names).toContain(libraryPackName(family, "dark"));
      expect(names).toContain(libraryPackName(family, "light"));
    }
  });

  it("recopie les couleurs du preset intégré + triples RGB, sans radius/shadow/font-size", () => {
    const preset = getHolafTokens().getPreset(libraryPackName("indigo", "dark"));
    expect(preset).not.toBeNull();
    expect(preset!.surface).toBe("#1e1e1e");
    expect(preset!.border).toBe("#3f3f46");
    expect(preset!.text).toBe("#e4e4e7");
    expect(preset!.accent).toBe("#6366f1");
    expect(preset!["accent-hover"]).toBe("#818cf8");
    // Compléments dérivés (absents du preset intégré).
    expect(preset!["border-bright"]).toBe("#67676d");
    expect(preset!["text-bright"]).toBe("#ededef");
    // Triples RGB calculés (opacité Tailwind).
    expect(preset!["bg-rgb"]).toBe(hexToRgbTriple("#1e1e1e"));
    expect(preset!["accent-rgb"]).toBe("99 102 241");
    expect(preset!["text-bright-rgb"]).toBe(hexToRgbTriple("#ededef"));
    // Aucun héritage hors vocabulaire Pi-Web.
    for (const leaked of ["radius", "shadow", "font-size", "accent-text", "danger-text", "danger-hover"]) {
      expect(preset![leaked], leaked).toBeUndefined();
    }
  });

  it("chaque pack bibliothèque porte accent, base et triples RGB valides", () => {
    for (const family of PI_WEB_LIBRARY_THEME_IDS) {
      for (const mode of ["dark", "light"] as const) {
        const pack = libraryPackName(family, mode);
        const preset = getHolafTokens().getPreset(pack);
        expect(preset, pack).not.toBeNull();
        for (const key of ["surface", "surface-elev", "surface-raised", "border", "border-bright", "text", "text-bright", "text-muted", "accent", "accent-hover", "danger"]) {
          expect(typeof preset![key], `${pack}.${key}`).toBe("string");
        }
        for (const key of ["bg-rgb", "surface-rgb", "surface-raised-rgb", "border-rgb", "border-bright-rgb", "text-rgb", "text-bright-rgb", "text-dim-rgb", "error-rgb", "accent-rgb", "accent-dim-rgb"]) {
          expect(preset![key], `${pack}.${key}`).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mixHex (dérivation border-bright / text-bright des thèmes bibliothèque)
// ─────────────────────────────────────────────────────────────────────────────
describe("mixHex", () => {
  it("interpole deux hex et borne le ratio", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#FFFFFF");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000000", "#ffffff", 2)).toBe("#FFFFFF"); // borné
    expect(mixHex("#000000", "#ffffff", -1)).toBe("#000000"); // borné
  });

  it("renvoie la première couleur si une entrée est invalide", () => {
    expect(mixHex("rgba(0,0,0,.3)", "#ffffff", 0.5)).toBe("rgba(0,0,0,.3)");
    expect(mixHex("#000000", "pas-un-hex", 0.5)).toBe("#000000");
  });
});
