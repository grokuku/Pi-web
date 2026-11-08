import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
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

// ── B2 (intégrité) : plus AUCUN temp file d'identifiants ────────────────────
// `withTempFile()` écrivait `user\ntoken` EN CLAIR dans /tmp/pi-web-creds/<hash>
// avant chaque pull/push/clone. Personne ne le lisait (Pi-Web n'assigne jamais
// GIT_ASKPASS, refusé par git >= 2.36 sans allowUnsafeAskPass) : c'était de la
// persistance de jeton en clair sur disque pour rien. Le test échoue si
// l'API revient (le plaintext redeviendrait résident).
describe("CredentialStore — plus de temp file d'identifiants (B2)", () => {
  it("n'expose plus withTempFile", () => {
    expect(
      (credentialStore as unknown as Record<string, unknown>).withTempFile,
    ).toBeUndefined();
  });

  it("set() n'écrit AUCUN fichier dans le dossier temporaire des identifiants", () => {
    const before = fs.existsSync(credentialStore.tmpPath(HOST));
    credentialStore.set(HOST, "user", "pass");
    expect(before).toBe(false);
    // Le plaintext ne doit pas être écrit sur disque à l'enregistrement.
    expect(fs.existsSync(credentialStore.tmpPath(HOST))).toBe(false);
  });

  it("cleanUp() efface un fichier résiduel laissé par une version antérieure", () => {
    const legacy = credentialStore.tmpPath(HOST);
    fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacy, "user\nlegacy-plaintext\n", { mode: 0o600 });
    expect(fs.existsSync(legacy)).toBe(true);

    credentialStore.cleanUp(HOST);

    expect(fs.existsSync(legacy)).toBe(false);
  });
});

// ── Hygiène : le script ASKPASS mort a été supprimé ─────────────────────────
// Il n'était lisible par personne (aucun GIT_ASKPASS assigné : git >= 2.36 le
// refuse sans allowUnsafeAskPass) et pointait des chemins différents du store.
// Le laisser reviendrait à exposer un script qui ment sur son rôle.
describe("CredentialStore — script ASKPASS supprimé (plus de code mort)", () => {
  it("n'expose plus askpassScript", () => {
    expect(
      (credentialStore as unknown as Record<string, unknown>).askpassScript
    ).toBeUndefined();
  });

  it("le fichier src/projects/git-askpass.sh n'existe plus", () => {
    const scriptPath = path.resolve(__dirname, "..", "git-askpass.sh");
    expect(fs.existsSync(scriptPath)).toBe(false);
  });
});
