import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { credentialStore } from "../credential-store.js";

// Hostname unique pour ne pas interférer avec d'éventuels credentials réels.
const HOST = "test-host.example.com";

beforeEach(() => {
  // Silence des logs du module pour garder la sortie de test propre.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // Nettoyage : retire le credential de test (mémoire + disque chiffré).
  credentialStore.delete(HOST);
});

describe("CredentialStore — temp file transitoire (plaintext jamais résident)", () => {
  it("set() ne crée PAS de temp file résident", () => {
    credentialStore.set(HOST, "user", "pass");
    // Le plaintext ne doit pas être écrit sur disque à l'enregistrement.
    expect(fs.existsSync(credentialStore.tmpPath(HOST))).toBe(false);
  });

  it("le temp file existe PENDANT withTempFile et disparaît après", async () => {
    credentialStore.set(HOST, "user", "pass");
    const filePath = credentialStore.tmpPath(HOST);
    expect(fs.existsSync(filePath)).toBe(false);

    await credentialStore.withTempFile(HOST, "user", "pass", async () => {
      // Pendant l'opération git, le fichier transitoire existe (ligne 1 = user, ligne 2 = pass).
      expect(fs.existsSync(filePath)).toBe(true);
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      expect(lines[0]).toBe("user");
      expect(lines[1]).toBe("pass");
    });

    // Après l'opération, le fichier a été supprimé.
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("le temp file est supprimé même si fn throw (finally)", async () => {
    credentialStore.set(HOST, "user", "pass");
    const filePath = credentialStore.tmpPath(HOST);

    await expect(
      credentialStore.withTempFile(HOST, "user", "pass", async () => {
        expect(fs.existsSync(filePath)).toBe(true);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // Même en cas d'erreur, le plaintext ne reste pas sur disque.
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
