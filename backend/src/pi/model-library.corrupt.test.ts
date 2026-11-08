/**
 * B5 (intégrité) — `model-library.json` : écriture atomique, et REFUS de
 * repartir sur la bibliothèque par défaut quand le fichier existe mais est
 * illisible.
 *
 * Avant : `loadModelLibrary()` loguait puis renvoyait `getDefaultLibrary()`
 * (0 provider, 0 modèle). Le premier enregistrement suivant — ajout d'un
 * modèle, changement de modèle par défaut… — écrasait DÉFINITIVEMENT le
 * fichier de l'utilisateur. Aucun `.bak`.
 *
 * `fs` n'est intercepté QUE pour `model-library.json` : le reste du système de
 * fichiers reste le vrai (aucune écriture sur les données réelles).
 */
import { describe, expect, it, vi } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { StorageCorruptError } from "../utils/atomic-store.js";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const p = await import("path");
  const isLibrary = (candidate: unknown): boolean =>
    typeof candidate === "string" && candidate.endsWith(p.join(".data", "model-library.json"));
  return {
    ...actual,
    readFileSync: ((candidate: any, ...rest: any[]) =>
      isLibrary(candidate)
        ? '{ "models": [ { "id": "broken"'
        : (actual.readFileSync as any)(candidate, ...rest)) as typeof actual.readFileSync,
  };
});

const { loadModelLibrary } = await import("./model-library.js");

describe("model-library — fichier corrompu : erreur claire, jamais un défaut écrasable", () => {
  it("loadModelLibrary() lève StorageCorruptError (503 STORAGE_CORRUPT)", () => {
    let caught: any;
    try {
      loadModelLibrary();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageCorruptError);
    expect(caught.status).toBe(503);
    expect(caught.code).toBe("STORAGE_CORRUPT");
    // Le chemin fautif est nommé → l'utilisateur peut réparer/restaurer.
    expect(caught.message).toContain("model-library.json");
  });

  it("ne renvoie JAMAIS la bibliothèque par défaut sur un fichier illisible", () => {
    expect(() => loadModelLibrary()).toThrow(StorageCorruptError);
    // Garde-fou de forme : la valeur de repli n'est atteignable que si le
    // fichier est ABSENT (readStateJson → null).
    const src = readFileSync(fileURLToPath(new URL("./model-library.ts", import.meta.url)), "utf-8");
    expect(src).toContain("if (data === null) return getDefaultLibrary();");
  });
});

describe("model-library — écriture atomique (tmp + rename)", () => {
  it("saveModelLibrary passe par writeFileAtomicSync, plus par writeFileSync direct", () => {
    const src = readFileSync(fileURLToPath(new URL("./model-library.ts", import.meta.url)), "utf-8");
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/?\*)/.test(line))
      .join("\n");
    expect(code).toContain("writeFileAtomicSync(LIBRARY_FILE");
    // Aucune écriture directe sur le fichier final (elle laisserait un fichier
    // tronqué en cas de crash → bibliothèque vide au démarrage suivant).
    expect(code).not.toMatch(/writeFileSync\(\s*LIBRARY_FILE/);
    expect(code).toContain("import { readStateJson, writeFileAtomicSync");
  });
});
