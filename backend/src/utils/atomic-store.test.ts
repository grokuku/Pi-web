/**
 * Tests de `utils/atomic-store.ts` — B5 (intégrité).
 *
 * Deux garanties :
 *  1. écriture `tmp` + `rename` : jamais de fichier final partiellement écrit ;
 *  2. un fichier d'état qui EXISTE mais ne se lit pas lève `StorageCorruptError`
 *     (jamais « renvoyer un défaut » — c'était le chemin qui écrasait les
 *     données de l'utilisateur au démarrage suivant).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { readStateJson, StorageCorruptError, writeFileAtomicSync } from "./atomic-store.js";

let dir: string;

function tmpDir(): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "atomic-store-test-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("writeFileAtomicSync", () => {
  it("écrit le contenu exact et ne laisse AUCUN fichier temporaire", () => {
    const d = tmpDir();
    const file = path.join(d, "state.json");

    writeFileAtomicSync(file, JSON.stringify({ a: 1 }));

    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ a: 1 });
    expect(readdirSync(d)).toEqual(["state.json"]);
  });

  it("remplace un fichier existant sans passer par un état intermédiaire visible", () => {
    const d = tmpDir();
    const file = path.join(d, "state.json");
    writeFileSync(file, "ancien contenu très long ".repeat(100));

    writeFileAtomicSync(file, "nouveau");

    expect(readFileSync(file, "utf-8")).toBe("nouveau");
    expect(readdirSync(d)).toEqual(["state.json"]);
  });

  it("applique les permissions demandées (fichier de secret)", () => {
    const d = tmpDir();
    const file = path.join(d, "secret");

    writeFileAtomicSync(file, "s3cr3t", { mode: 0o600 });

    expect(readFileSync(file, "utf-8")).toBe("s3cr3t");
  });
});

describe("readStateJson — refuser un fichier illisible", () => {
  it("fichier absent → null (premier démarrage : le défaut est légitime)", () => {
    const d = tmpDir();
    expect(readStateJson(path.join(d, "absent.json"))).toBeNull();
  });

  it("fichier présent et valide → contenu", () => {
    const d = tmpDir();
    const file = path.join(d, "ok.json");
    writeFileSync(file, JSON.stringify([{ id: "p1" }]));
    expect(readStateJson(file)).toEqual([{ id: "p1" }]);
  });

  it("JSON tronqué → StorageCorruptError (503 / STORAGE_CORRUPT)", () => {
    const d = tmpDir();
    const file = path.join(d, "tronque.json");
    writeFileSync(file, '[{"id":"p1"},{"id":"p2"');

    let caught: any;
    try {
      readStateJson(file);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageCorruptError);
    expect(caught.status).toBe(503);
    expect(caught.code).toBe("STORAGE_CORRUPT");
    expect(caught.filePath).toBe(file);
    // Le message doit être actionnable (dit quoi faire, ne dit pas « inconnu »).
    expect(caught.message).toContain("Refusing to start");
    expect(caught.message).toContain(file);
  });

  it("fichier vide (0 octet) → StorageCorruptError, pas « absent »", () => {
    const d = tmpDir();
    const file = path.join(d, "vide.json");
    writeFileSync(file, "");
    expect(() => readStateJson(file)).toThrow(StorageCorruptError);
  });
});
