// Tests P4 : re-qualification de isStreaming depuis la vérité backend.
import { describe, expect, it } from "vitest";
import { mergeServerSessionState, promptMessageType } from "./session-sync.js";

describe("promptMessageType", () => {
  it("session idle (backend isStreaming=false) ⇒ pi_prompt", () => {
    expect(promptMessageType(false)).toBe("pi_prompt");
  });

  it("session en streaming ⇒ pi_steer", () => {
    expect(promptMessageType(true)).toBe("pi_steer");
  });
});

describe("mergeServerSessionState", () => {
  it("re-qualifie isStreaming depuis l'info backend", () => {
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
