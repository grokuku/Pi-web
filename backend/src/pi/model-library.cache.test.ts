/**
 * B12 (performance) — `loadModelLibrary()` relisait et re-parsait
 * `model-library.json` À CHAQUE APPEL (~40 appels par tour de chat).
 *
 * Après : cache mémoire invalidé par `mtime` + `taille`, invalidation EXPLICITE
 * dans `saveModelLibrary()` et reset exposé pour les tests.
 *
 * ⚠️ L'intégrité (lot 1) est préservée : le cache n'est JAMAIS consulté sans
 * lecture stricte préalable d'un fichier modifié. Un fichier devenu illisible
 * fait lever `StorageCorruptError` — il n'est jamais remplacé par une valeur
 * périmée ni par la bibliothèque par défaut.
 *
 * `fs` est entièrement simulé en mémoire : aucun accès au vrai `.data`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { StorageCorruptError } from "../utils/atomic-store.js";

type Entry = { content: string; mtimeMs: number; size: number };

const { fsState } = vi.hoisted(() => ({
  fsState: {
    files: {} as Record<string, { content: string; mtimeMs: number; size: number }>,
    reads: 0,
    clock: 1000,
  },
}));

vi.mock("fs", () => {
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return {
    existsSync: (p: string) => Object.prototype.hasOwnProperty.call(fsState.files, p),
    mkdirSync: () => {},
    readFileSync: (p: string) => {
      fsState.reads++;
      const e = fsState.files[p];
      if (!e) throw enoent(p);
      return e.content;
    },
    writeFileSync: (p: string, data: string) => {
      fsState.files[p] = { content: String(data), mtimeMs: ++fsState.clock, size: String(data).length };
    },
    renameSync: (from: string, to: string) => {
      const e = fsState.files[from];
      if (!e) throw enoent(from);
      fsState.files[to] = e;
      delete fsState.files[from];
    },
    rmSync: (p: string) => {
      delete fsState.files[p];
    },
    statSync: (p: string) => {
      const e = fsState.files[p];
      if (!e) throw enoent(p);
      return { mtimeMs: e.mtimeMs, size: e.size };
    },
  };
});

const {
  loadModelLibrary,
  saveModelLibrary,
  resetModelLibraryCache,
} = await import("./model-library.js");

const LIBRARY_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", ".data", "model-library.json",
);

function makeLibrary(models: string[]) {
  return {
    models: models.map((id) => ({
      id,
      providerId: "p1",
      modelId: id,
      name: id,
      isDefault: false,
      reasoning: false,
      vision: false,
      contextWindow: 8192,
      maxTokens: 4096,
    })),
    defaultModelId: models[0] ?? null,
    commitModelId: null,
    visionModelId: null,
    audioModelId: null,
    librarianModelId: null,
    projectModes: {},
    concurrency: { maxLLMSlots: 3, providerMaxLLMSlots: {} },
  };
}

/** Écrit le fichier « hors application » (comme un éditeur externe). */
function writeExternally(content: string) {
  fsState.files[LIBRARY_FILE] = { content, mtimeMs: ++fsState.clock, size: content.length };
}

beforeEach(() => {
  fsState.files = {};
  fsState.reads = 0;
  resetModelLibraryCache();
});

describe("B12 — cache de lecture de model-library.json", () => {
  it("ne relit PAS le fichier quand mtime et taille sont inchangés", () => {
    writeExternally(JSON.stringify(makeLibrary(["m1"])));
    expect(loadModelLibrary().models.map((m) => m.id)).toEqual(["m1"]);
    expect(loadModelLibrary().models.map((m) => m.id)).toEqual(["m1"]);
    expect(loadModelLibrary().models.length).toBe(1);
    // Un seul accès disque pour trois lectures.
    expect(fsState.reads).toBe(1);
  });

  it("saveModelLibrary() invalide explicitement le cache (aucune valeur périmée)", () => {
    writeExternally(JSON.stringify(makeLibrary(["m1"])));
    expect(loadModelLibrary().models.length).toBe(1);
    saveModelLibrary(makeLibrary(["m1", "m2"]) as any);
    expect(loadModelLibrary().models.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("un fichier réécrit hors application (mtime/taille) est repris", () => {
    writeExternally(JSON.stringify(makeLibrary(["m1"])));
    expect(loadModelLibrary().models.length).toBe(1);
    writeExternally(JSON.stringify(makeLibrary(["m1", "m2", "m3"])));
    expect(loadModelLibrary().models.length).toBe(3);
  });

  it("un fichier devenu CORROMPU lève StorageCorruptError, cache chaud compris", () => {
    writeExternally(JSON.stringify(makeLibrary(["m1"])));
    expect(loadModelLibrary().models.length).toBe(1); // cache chaud
    writeExternally('{ "models": [ { "id": "broken"');
    expect(() => loadModelLibrary()).toThrow(StorageCorruptError);
    // Et jamais de repli silencieux sur la bibliothèque par défaut.
    try {
      loadModelLibrary();
    } catch (e: any) {
      expect(e.code).toBe("STORAGE_CORRUPT");
      expect(e.message).toContain("model-library.json");
    }
  });

  it("les objets renvoyés ne partagent PAS d'état avec un fichier réécrit", () => {
    // Sémantique conservée : chaque rechargement repart du disque.
    writeExternally(JSON.stringify(makeLibrary(["m1"])));
    const first = loadModelLibrary();
    writeExternally(JSON.stringify(makeLibrary(["m1", "m2"])));
    const second = loadModelLibrary();
    expect(second.models.length).toBe(2);
    expect(first.models.length).toBe(1);
  });

  it("resetModelLibraryCache() force une relecture (outil de test)", () => {
    writeExternally(JSON.stringify(makeLibrary(["m1"])));
    loadModelLibrary();
    expect(fsState.reads).toBe(1);
    resetModelLibraryCache();
    loadModelLibrary();
    expect(fsState.reads).toBe(2);
  });
});
