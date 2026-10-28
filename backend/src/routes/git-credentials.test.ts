/**
 * Tests de l'effacement des identifiants git PAR HÔTE.
 *
 * Pourquoi ces tests : le store d'identifiants est indexé par HOSTNAME, pas par
 * dépôt. Un jeton inutilisable (ex. token GitHub sans le scope `workflow`, qui
 * fait échouer tout push de `.github/workflows/*`) doit pouvoir être oublié
 * SANS dépendre d'un projet particulier — sinon l'utilisateur ne peut pas
 * changer de jeton et reste bloqué.
 *
 * Aucun réseau, aucun disque : `credentialStore` est mocké.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { storeState, storeMock } = vi.hoisted(() => {
  const storeState = { entries: new Map<string, { username: string; password: string }>() };
  const storeMock = {
    listHosts: vi.fn(() => [...storeState.entries.keys()]),
    has: vi.fn((host: string) => storeState.entries.has(host)),
    delete: vi.fn((host: string) => {
      storeState.entries.delete(host);
    }),
    get: vi.fn((host: string) => storeState.entries.get(host)),
    set: vi.fn((host: string, username: string, password: string) => {
      storeState.entries.set(host, { username, password });
    }),
  };
  return { storeState, storeMock };
});

vi.mock("../projects/credential-store.js", () => ({ credentialStore: storeMock }));

import router from "./git-credentials.js";
import { hostFromRemoteUrl } from "../projects/git.js";

// ── Harnais : invocation directe du Router Express (pas de serveur HTTP) ──
function request(method: string, url: string) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req: any = { method, url, body: {}, headers: {}, query: {}, params: {} };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    (router as any)(req, res, () => resolve({ status: 404, body: { error: "no matching route" } }));
  });
}

beforeEach(() => {
  storeState.entries.clear();
  storeMock.listHosts.mockClear();
  storeMock.delete.mockClear();
  storeMock.has.mockClear();
});

describe("GET /api/git-credentials/hosts", () => {
  it("liste les hôtes ayant un jeton, SANS jamais renvoyer de valeur", async () => {
    storeState.entries.set("github.com", { username: "u", password: "secret-token" });

    const res = await request("GET", "/hosts");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hosts: ["github.com"] });
    // Aucune fuite : ni username ni jeton dans la réponse.
    expect(JSON.stringify(res.body)).not.toContain("secret-token");
  });
});

describe("DELETE /api/git-credentials/:host — efface TOUT l'hôte", () => {
  it("efface le jeton de l'hôte et le signale (removed: true)", async () => {
    storeState.entries.set("github.com", { username: "u", password: "secret-token" });

    const res = await request("DELETE", "/github.com");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, host: "github.com", removed: true });
    expect(storeMock.delete).toHaveBeenCalledWith("github.com");
    expect(storeState.entries.has("github.com")).toBe(false);
  });

  it("sans jeton enregistré : succès honnête (removed: false), pas d'effacement fictif", async () => {
    const res = await request("DELETE", "/gitlab.com");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, host: "gitlab.com", removed: false });
  });

  it("normalise la casse de l'hôte (clé du store en minuscules)", async () => {
    storeState.entries.set("github.com", { username: "u", password: "secret-token" });

    const res = await request("DELETE", "/GitHub.COM");

    expect(res.status).toBe(200);
    expect(res.body.host).toBe("github.com");
    expect(storeMock.delete).toHaveBeenCalledWith("github.com");
  });

  it("hôte invalide (schéma, caractères interdits, vide) → 400 sans rien effacer", async () => {
    for (const bad of ["https:", "-", "-x.com", "a_b", ".."]) {
      const res = await request("DELETE", `/${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("GIT_CREDENTIALS_INVALID_HOST");
    }
    // Une valeur avec chemin n'est même pas routée (aucune route ne la couvre
    // et aucun effacement n'a lieu).
    expect((await request("DELETE", "/a/b")).status).toBe(404);
    expect(storeMock.delete).not.toHaveBeenCalled();
  });
});

describe("hostFromRemoteUrl — hôte dérivé du remote (sans commande git)", () => {
  it("HTTPS", () => {
    expect(hostFromRemoteUrl("https://github.com/owner/repo.git")).toBe("github.com");
    expect(hostFromRemoteUrl("https://GitHub.com/owner/repo")).toBe("github.com");
  });

  it("SSH (scp-like et ssh://)", () => {
    expect(hostFromRemoteUrl("git@github.com:owner/repo.git")).toBe("github.com");
    expect(hostFromRemoteUrl("ssh://git@gitlab.example.com:2222/owner/repo.git")).toBe("gitlab.example.com");
  });

  it("valeurs vides ou illisibles → null", () => {
    expect(hostFromRemoteUrl("")).toBeNull();
    expect(hostFromRemoteUrl(null)).toBeNull();
    expect(hostFromRemoteUrl(undefined)).toBeNull();
    expect(hostFromRemoteUrl("pas une url")).toBeNull();
  });
});
