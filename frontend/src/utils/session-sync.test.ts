// Tests P4 : re-qualification de isStreaming depuis la vérité backend.
import { describe, expect, it, vi, afterEach } from "vitest";
import { clientTimeZone, mergeServerSessionState, promptMessageType } from "./session-sync.js";

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
