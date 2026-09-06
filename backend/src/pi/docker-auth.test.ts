import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ensureDockerHubLogin, getDockerHubStatus } from "./docker-auth.js";

// Force le chemin "fallback config.json" : le CLI docker est considéré
// indisponible (execFileSync lève), et spawnSync ne doit jamais être atteint.
vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  spawnSync: vi.fn(() => ({ status: 1, stderr: "docker: error", stdout: "" })),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-auth-test-"));
  process.env.DOCKER_CONFIG = tmpDir;
  // Silence des logs du module pour garder la sortie de test propre.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.DOCKER_CONFIG;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const DOCKER_HUB_KEY = "https://index.docker.io/v1/";

describe("ensureDockerHubLogin (fallback config.json)", () => {
  it("écrit config.json avec mode 0o600 et auth encodé", () => {
    const res = ensureDockerHubLogin("myuser", "secret-token");
    expect(res.ok).toBe(true);
    expect(res.method).toBe("config");

    const file = path.join(tmpDir, "config.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(config.auths[DOCKER_HUB_KEY].auth).toBe(
      Buffer.from("myuser:secret-token", "utf-8").toString("base64")
    );
  });

  it("préserve les auths existants (ghcr.io) et identitytoken", () => {
    const file = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        auths: {
          "https://ghcr.io": { auth: "Z2hjOnRva2Vu" },
          [DOCKER_HUB_KEY]: { auth: "b2xkOnRva2Vu", identitytoken: "old-identity" },
        },
      })
    );

    const res = ensureDockerHubLogin("newuser", "newtoken");
    expect(res.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    // Registre tiers intact.
    expect(config.auths["https://ghcr.io"].auth).toBe("Z2hjOnRva2Vu");
    // identitytoken de l'entrée docker.io préservé.
    expect(config.auths[DOCKER_HUB_KEY].identitytoken).toBe("old-identity");
    // Seul le champ auth de docker.io est (ré)écrit.
    expect(config.auths[DOCKER_HUB_KEY].auth).toBe(
      Buffer.from("newuser:newtoken", "utf-8").toString("base64")
    );
  });

  it("repart d'un objet vide si config.json est corrompu", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "not json");
    const res = ensureDockerHubLogin("u", "t");
    expect(res.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
    expect(config.auths[DOCKER_HUB_KEY].auth).toBe(Buffer.from("u:t", "utf-8").toString("base64"));
  });

  it("ne fuit pas le token dans le message d'erreur", () => {
    // DOCKER_CONFIG pointe vers un fichier → l'écriture de config.json échoue.
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "x");
    process.env.DOCKER_CONFIG = blocker;

    const res = ensureDockerHubLogin("bob", "leak-me-token");
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).not.toContain("leak-me-token");
  });
});

describe("getDockerHubStatus", () => {
  it("retourne non configuré si aucun fichier", () => {
    const status = getDockerHubStatus();
    expect(status.configured).toBe(false);
    expect(status.username).toBeNull();
  });

  it("décode le username sans exposer le token", () => {
    ensureDockerHubLogin("alice", "super-secret");
    const status = getDockerHubStatus();
    expect(status.configured).toBe(true);
    expect(status.username).toBe("alice");
    // Le token ne doit jamais apparaître dans l'objet retourné.
    expect(JSON.stringify(status)).not.toContain("super-secret");
  });

  it("gère un config.json corrompu", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "not json");
    const status = getDockerHubStatus();
    expect(status.configured).toBe(false);
    expect(status.username).toBeNull();
  });

  it("retourne username null si l'entrée auth est mal formée", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ auths: { [DOCKER_HUB_KEY]: { auth: "bm9jb2xvbg==" } } }) // "nocolon"
    );
    const status = getDockerHubStatus();
    expect(status.configured).toBe(true);
    expect(status.username).toBeNull();
  });
});
