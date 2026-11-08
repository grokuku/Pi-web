// Tests P4 : re-qualification de isStreaming depuis la vérité backend.
import { describe, expect, it, vi, afterEach } from "vitest";
import { clientTimeZone, fetchProjectSession, mergeServerSessionState, promptMessageType } from "./session-sync.js";

describe("promptMessageType", () => {
  it("session idle (backend isStreaming=false) ⇒ pi_prompt", () => {
    expect(promptMessageType(false)).toBe("pi_prompt");
  });

  it("session en streaming ⇒ pi_steer", () => {
    expect(promptMessageType(true)).toBe("pi_steer");
  });
});

describe("mergeServerSessionState", () => {  it("re-qualifie isStreaming depuis l'info backend", () => {
    const patch = mergeServerSessionState({ isStreaming: false, activeMode: "harness", sessionId: "s1" });
    expect(patch.isStreaming).toBe(false);
    expect(patch.session).toEqual({ isStreaming: false, activeMode: "harness", sessionId: "s1" });
  });

  it("reconnexion après crash backend : isStreaming serveur false ⇒ pi_prompt", () => {
    // Scénario du bug : le front gardait isStreaming=true après un crash.
    const patch = mergeServerSessionState({ isStreaming: false });
    expect(promptMessageType(patch.isStreaming ?? true)).toBe("pi_prompt");
  });

  it("n'écrase pas isStreaming si le backend ne l'expose pas", () => {
    const patch = mergeServerSessionState({ activeMode: "code" });
    expect("isStreaming" in patch).toBe(false);
  });
});

describe("clientTimeZone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rend la zone IANA du navigateur (transmise avec le prompt)", () => {
    // Environnement vitest `node` : la zone existe toujours (défaut UTC).
    expect(typeof clientTimeZone()).toBe("string");
    expect((clientTimeZone() ?? "").length).toBeGreaterThan(0);
  });

  it("rend undefined si la plateforme n'expose pas de zone (jamais d'exception)", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype as any, "resolvedOptions").mockReturnValue({} as any);
    expect(clientTimeZone()).toBeUndefined();
  });

  it("rend undefined si l'accès à Intl lève", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("Intl indisponible");
    });
    expect(clientTimeZone()).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F21 — une réponse d'ERREUR ne doit jamais être stockée comme « session ».
// `handleModelApplied` faisait `.then(r => r.json())` SANS vérifier `r.ok` :
// `{ error: … }` devenait la session du projet (en-tête vide/incohérent).
// ─────────────────────────────────────────────────────────────────────────────
describe("fetchProjectSession — garde r.ok (F21)", () => {
  const jsonRes = (ok: boolean, body: unknown, status = ok ? 200 : 500) =>
    ({ ok, status, json: async () => body }) as unknown as Response;

  it("réponse 2xx → la session est renvoyée", async () => {
    const f = vi.fn(async () => jsonRes(true, { isStreaming: false, activeMode: "code" }));
    await expect(fetchProjectSession("p1", f as unknown as typeof fetch)).resolves.toEqual({
      isStreaming: false,
      activeMode: "code",
    });
    expect(f).toHaveBeenCalledWith("/api/settings/session?projectId=p1");
  });

  it("réponse 500 portant { error } → null (rien n'est stocké)", async () => {
    const f = vi.fn(async () => jsonRes(false, { error: "boom" }));
    await expect(fetchProjectSession("p1", f as unknown as typeof fetch)).resolves.toBeNull();
  });

  it("réponse 2xx mais charge { error } ou non-objet → null", async () => {
    const fErr = vi.fn(async () => jsonRes(true, { error: "boom" }));
    await expect(fetchProjectSession("p1", fErr as unknown as typeof fetch)).resolves.toBeNull();
    const fStr = vi.fn(async () => jsonRes(true, "nope"));
    await expect(fetchProjectSession("p1", fStr as unknown as typeof fetch)).resolves.toBeNull();
  });

  it("réseau en échec → null (aucun throw)", async () => {
    const f = vi.fn(async () => { throw new Error("NetworkError"); });
    await expect(fetchProjectSession("p1", f as unknown as typeof fetch)).resolves.toBeNull();
  });
});
