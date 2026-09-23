/**
 * Tests unitaires de agent-keys.ts — SEC-08 (Lot A).
 *
 * - La persistance touche `.data/agent-keys.json` : `fs` est mocké en mémoire
 *   (le vrai fichier du repo n'est pas touché).
 * - Vérifie : token haché validé (scrypt), token hérité en clair validé PUIS
 *   migré (plaintext retiré du disque), token invalide rejeté, écriture
 *   atomique (tmp + rename) + permissions 0600, secret jamais loggé.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { hashSecret } from "../utils/secret-hash.js";
import { validateToken, isAgentEnabled } from "./agent-keys.js";

// ── Mock fs : stockage en mémoire ──
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
    fsState.mtime[p] = ++fsState.clock;
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

const KEYS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".data",
  "agent-keys.json"
);

function seedStore(keys: unknown[]): void {
  fsState.files[KEYS_FILE] = JSON.stringify({ keys });
}

beforeEach(() => {
  for (const k of Object.keys(fsState.files)) delete fsState.files[k];
  for (const k of Object.keys(fsState.mtime)) delete fsState.mtime[k];
  fsState.dirs.clear();
});

describe("SEC-08 — tokens hachés (agent-keys)", () => {
  it("un token haché (nouveau format) est validé par scrypt", () => {
    const token = "pia_newformat_0000000000000000000000000000";
    seedStore([
      {
        id: "key_hashed",
        name: "hashed",
        tokenHash: hashSecret(token),
        createdAt: "2024-01-01T00:00:00Z",
        lastUsedAt: null,
      },
    ]);
    expect(validateToken(token)?.id).toBe("key_hashed");
    // Un autre token ne passe pas (vérification à temps constant).
    expect(validateToken("pia_whatever")).toBeNull();
  });

  it("un token hérité en clair est validé PUIS migré (plaintext retiré du disque)", () => {
    const legacyToken = "pia_legacytoken0000000000000000000000000000000000";
    seedStore([
      { id: "key_legacy", name: "old", token: legacyToken, createdAt: "2024-01-01T00:00:00Z", lastUsedAt: null },
    ]);
    // Avant migration : validé en clair
    const key = validateToken(legacyToken);
    expect(key?.name).toBe("old");
    expect(key?.lastUsedAt).toBeTruthy();
    // Sur disque : hash présent, plaintext absent
    const onDisk = fsState.files[KEYS_FILE];
    expect(onDisk).toContain("scrypt:");
    expect(onDisk).not.toContain(legacyToken);
    const stored = JSON.parse(onDisk).keys[0];
    expect(stored.tokenHash).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(stored.token).toBeUndefined();
    expect(stored.tokenPreview).toBe(legacyToken.slice(0, 8) + "…");
    // Après migration : toujours valide (hash vérifié)
    expect(validateToken(legacyToken)?.id).toBe("key_legacy");
  });

  it("un token invalide est rejeté et ne déclenche aucune écriture", () => {
    seedStore([
      { id: "key_legacy", name: "old", token: "pia_the-real-token", createdAt: "2024-01-01T00:00:00Z", lastUsedAt: null },
    ]);
    expect(validateToken("pia_wrong-token")).toBeNull();
    // Le fichier original est inchangé (pas de migration ni de lastUsedAt écrit)
    expect(fsState.files[KEYS_FILE]).toContain("pia_the-real-token");
  });

  it("isAgentEnabled reflète la présence de clés (hashées ou héritées)", () => {
    seedStore([]);
    expect(isAgentEnabled()).toBe(false);
    seedStore([{ id: "k", name: "n", tokenHash: "scrypt:00:00", createdAt: "", lastUsedAt: null }]);
    expect(isAgentEnabled()).toBe(true);
  });

  it("les écritures sont atomiques (tmp + rename) et restrictives (mode 0600)", () => {
    seedStore([
      { id: "key_legacy", name: "old", token: "pia_legacytoken0000000000000000000000000000000000", createdAt: "2024-01-01T00:00:00Z", lastUsedAt: null },
    ]);
    validateToken("pia_legacytoken0000000000000000000000000000000000");
    const calls = (writeFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[string, string, { mode: number }]>;
    const lastCall = calls[calls.length - 1];
    expect(lastCallPath(lastCall)).toBe(KEYS_FILE + ".tmp");
    expect(lastCall[2].mode).toBe(0o600);
    expect(fsState.files[KEYS_FILE + ".tmp"]).toBeUndefined(); // rename consommé
  });

  it("le token n'apparaît jamais dans les logs", () => {
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    const legacyToken = "pia_secret-never-logged-000000000000000000000000";
    seedStore([
      { id: "key_l", name: "n", token: legacyToken, createdAt: "", lastUsedAt: null },
    ]);
    validateToken(legacyToken);
    validateToken("pia_wrong");
    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join("\n");
    expect(allLogs).not.toContain(legacyToken);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

/** Chemin du dernier appel writeFileSync (1er argument). */
function lastCallPath(call: [string, string, { mode: number }]): string {
  return call[0];
}