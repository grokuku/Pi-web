// ── Tests unitaires : parseJsonResponse ─────────────────────────────
// Vérifie le parsing blindé des réponses fetch : détection de page de login
// SSO (Authentik), erreur serveur générique, erreur métier JSON avec code
// structuré (ex. GIT_AUTH_REQUIRED) et cas nominal.
import { describe, it, expect } from "vitest";
import { parseJsonResponse } from "./api";

// Libellés i18n simulés (le helper n'a pas accès au hook useTranslation).
const labels = {
  sessionExpired: "Session expirée",
  serverError: (status: number) => `Erreur serveur ${status}`,
};

// Construit un objet Response minimal avec le Content-Type voulu.
function makeResponse(body: string, contentType: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: new Headers({ "content-type": contentType }),
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  } as unknown as Response;
}

describe("parseJsonResponse", () => {
  it("Content-Type non-JSON avec page de login Authentik → sessionExpired", async () => {
    const html = `<html><head><title>Sign in</title></head>
      <body>Authentik · outpost.goauthentik.io · sign-in</body></html>`;
    const res = makeResponse(html, "text/html", false, 401);
    await expect(parseJsonResponse(res, labels)).rejects.toThrow("Session expirée");
  });

  it("Content-Type non-JSON autre → serverError(status)", async () => {
    const res = makeResponse("<html>proxy error</html>", "text/html", false, 502);
    await expect(parseJsonResponse(res, labels)).rejects.toThrow("Erreur serveur 502");
  });

  it("JSON !res.ok avec body.error → throw ce message et préserve err.data.code", async () => {
    const res = makeResponse(
      JSON.stringify({ error: "Git auth required", code: "GIT_AUTH_REQUIRED" }),
      "application/json",
      false,
      401,
    );
    try {
      await parseJsonResponse(res, labels);
      expect.unreachable("devrait avoir levé");
    } catch (err) {
      const e = err as Error & { data?: { code?: string } };
      expect(e.message).toBe("Git auth required");
      expect(e.data?.code).toBe("GIT_AUTH_REQUIRED");
    }
  });

  it("JSON ok → retourne les données", async () => {
    const res = makeResponse(JSON.stringify({ id: 42, name: "pi" }), "application/json", true, 200);
    await expect(parseJsonResponse<{ id: number; name: string }>(res, labels)).resolves.toEqual({
      id: 42,
      name: "pi",
    });
  });
});
