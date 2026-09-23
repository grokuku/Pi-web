/**
 * Tests unitaires de librarian-auth.ts — Lot A (BUG-01 + SEC-08).
 *
 * - La persistance touche `.data/librarian-keys.json` : le module `fs` est
 *   mocké avec un stockage en mémoire pour ne JAMAIS lire/écrire le vrai disque
 *   (le vrai fichier du repo n'est pas touché par ces tests).
 * - Vérifie : suppression par identifiant NON secret (BUG-01), clés héritées
 *   sans id lisibles, hachage scrypt des secrets (SEC-08), migration du chemin
 *   non persistant (backend/.data → /app/.data), aucune fuite du secret.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import {
  createKey,
  validateKey,
  revokeKey,
  loadKeys,
  keyIdOf,
  deriveIdFromSecret,
  findKeyName,
  type LibrarianKey,
} from "./librarian-auth.js";

// ── Mock fs : stockage en mémoire (mtime simulé pour l'invalidation du cache) ──
const { fsState } = vi.hoisted(() => ({
  fsState: {
    files: {} as Record<string, string>,
    mtime: {} as Record<string, number>,
    dirs: new Set<string>(),
    clock: 1000,
  },
}));

vi.mock("fs", () => ({
  existsSync: vi.fn((p: any) => Object.prototype.hasOwnProperty.call(fsState.files, p)),
  mkdirSync: vi.fn((p: any) => {
    fsState.dirs.add(p);
  }),
  readFileSync: vi.fn((p: any) => fsState.files[p]),
  writeFileSync: vi.fn((p: any, data: string) => {
    fsState.files[p] = data;
    fsState.mtime[p] = ++fsState.clock; // chaque écriture fait avancer le mtime simulé
  }),
  renameSync: vi.fn((a: any, b: any) => {
    if (!(a in fsState.files)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    fsState.files[b] = fsState.files[a];
    fsState.mtime[b] = fsState.mtime[a] ?? ++fsState.clock;
    delete fsState.files[a];
    delete fsState.mtime[a];
  }),
  chmodSync: vi.fn(() => {}),
  statSync: vi.fn((p: any) => {
    if (!(p in fsState.files)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return { mtimeMs: fsState.mtime[p] ?? 0 };
  }),
}));

/** Reconstruit les chemins exactement comme le module testé (dist ou src). */
function dataFilePath(...segments: string[]): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, ...segments);
}

const KEYS_FILE = dataFilePath("..", "..", "..", ".data", "librarian-keys.json");
const LEGACY_KEYS_FILE = dataFilePath("..", "..", ".data", "librarian-keys.json");

beforeEach(() => {
  for (const k of Object.keys(fsState.files)) delete fsState.files[k];
  for (const k of Object.keys(fsState.mtime)) delete fsState.mtime[k];
  fsState.dirs.clear();
});

function seedLegacyKeys(keys: Partial<LibrarianKey>[]): void {
  fsState.files[LEGACY_KEYS_FILE] = JSON.stringify(keys);
}

describe("BUG-01 — révocation par identifiant non secret", () => {
  it("une clé héritée sans id obtient un id dérivé STABLE entre deux chargements", () => {
    const secret = "lib-abcdef0123456789abcdef01234567";
    seedLegacyKeys([{ key: secret, name: "legacy", createdAt: "2024-01-01T00:00:00Z" }]);
    const first = keyIdOf(loadKeys()[0]);
    const second = keyIdOf(loadKeys()[0]);
    expect(first).toBe(second);
    expect(first).toBe(deriveIdFromSecret(secret)); // stable, dérivé du secret hérité
    expect(first).toMatch(/^libk_[0-9a-f]{12}$/);
  });

  it("revokeKey supprime par id (et non par le secret masqué qui ne matchait jamais)", () => {
    const created = createKey("agent-a");
    expect(revokeKey(created.id)).toBe(true);
    expect(loadKeys()).toHaveLength(0);
  });

  it("revokeKey avec un id inconnu échoue proprement (false, rien n'est supprimé)", () => {
    createKey("agent-a");
    expect(revokeKey("libk_000000000000")).toBe(false);
    expect(loadKeys()).toHaveLength(1);
  });

  it("revokeKey fonctionne aussi pour une clé héritée (id dérivé, sans réécriture préalable)", () => {
    const secret = "lib-0123456789abcdef0123456789abcdef";
    seedLegacyKeys([{ key: secret, name: "old", createdAt: "2024-01-01T00:00:00Z" }]);
    const keys = loadKeys();
    expect(revokeKey(keyIdOf(keys[0]))).toBe(true);
    expect(loadKeys()).toHaveLength(0);
  });
});

describe("SEC-08 — secrets hachés (librarian)", () => {
  it("createKey retourne le secret complet (affiché une fois) mais ne le persiste JAMAIS", () => {
    const created = createKey("agent-b");
    expect(created.key).toMatch(/^lib-[0-9a-f]{32}$/);
    const onDisk = fsState.files[KEYS_FILE];
    expect(onDisk).toBeDefined();
    expect(onDisk).not.toContain(created.key); // le secret en clair n'est pas sur disque
    const stored = JSON.parse(onDisk)[0];
    expect(stored.keyHash).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(stored.keyPreview).toBe(created.key.slice(0, 12) + "…");
  });

  it("aucun fichier temporaire ne subsiste après écriture (tmp + rename atomique)", () => {
    createKey("agent-tmp");
    expect(fsState.files[KEYS_FILE + ".tmp"]).toBeUndefined();
  });

  it("le secret créé valide via le hash, un secret invalide est rejeté", () => {
    const created = createKey("agent-b");
    expect(validateKey(created.key)).toBe(true);
    expect(validateKey("lib-ffffffffffffffffffffffffffffffff")).toBe(false);
  });

  it("une clé héritée en clair reste valide, puis est migrée (plaintext retiré du disque)", () => {
    const secret = "lib-99998888777766665555444433332222";
    seedLegacyKeys([{ key: secret, name: "legacy", createdAt: "2024-01-01T00:00:00Z" }]);
    // Avant migration : validée via le plaintext hérité
    expect(validateKey(secret)).toBe(true);
    const stored = JSON.parse(fsState.files[KEYS_FILE])[0];
    expect(stored.keyHash).toMatch(/^scrypt:/);
    expect(stored.key).toBeUndefined(); // plaintext retiré après migration
    expect(fsState.files[KEYS_FILE]).not.toContain(secret);
    // Après migration : toujours valide via le hash
    expect(validateKey(secret)).toBe(true);
    expect(findKeyName(secret)).toBe("legacy");
  });

  it("une clé héritée invalide ne déclenche aucune migration de FORMAT", () => {
    seedLegacyKeys([{ key: "lib-migration-test-0000000000000001", name: "l", createdAt: "2024-01-01T00:00:00Z" }]);
    expect(validateKey("lib-wrong-key-0000000000000000000000")).toBe(false);
    // Migration d'EMPLACEMENT au chargement (backend/.data → .data) uniquement :
    // le plaintext hérité est conservé, PAS de migration de format (hash).
    const stored = JSON.parse(fsState.files[KEYS_FILE])[0];
    expect(stored.keyHash).toBeUndefined();
    expect(stored.key).toBe("lib-migration-test-0000000000000001");
  });

  it("le secret n'apparaît jamais dans les logs", () => {
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    const created = createKey("agent-log");
    validateKey(created.key);
    validateKey("lib-wrong");
    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join("\n");
    expect(allLogs).not.toContain(created.key);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("migration du chemin de stockage (SEC-08, vérification du rapport externe)", () => {
  it("migre librarian-keys.json de backend/.data (non persistant) vers .data (volume /app/.data)", () => {
    const secret = "lib-aaaa1111bbbb2222cccc3333dddd4444";
    seedLegacyKeys([{ key: secret, name: "prod-key", createdAt: "2024-01-01T00:00:00Z" }]);
    expect(fsState.files[KEYS_FILE]).toBeUndefined();
    loadKeys(); // déclenche la migration au chargement
    expect(fsState.files[KEYS_FILE]).toBeDefined();
    expect(fsState.files[KEYS_FILE]).toContain("prod-key");
    expect(fsState.files[LEGACY_KEYS_FILE]).toBeUndefined(); // renommé (pas ré-importé en boucle)
    expect(fsState.files[LEGACY_KEYS_FILE + ".migrated"]).toBeDefined();
  });

  it("n'écrase pas le nouveau fichier s'il existe déjà", () => {
    fsState.files[KEYS_FILE] = "[]";
    fsState.files[LEGACY_KEYS_FILE] = "[]";
    loadKeys();
    expect(fsState.files[KEYS_FILE]).toBe("[]");
  });
});