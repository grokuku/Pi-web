// ── Tests de la logique du garde-fou de mise à jour du SDK (helpers purs) ──
import { describe, expect, it } from "vitest";
import {
  buildUpdateBody,
  updateBlockedWithoutAck,
  type SdkBreakingChange,
} from "./sdk-update.js";

describe("utils/sdk-update — garde-fou", () => {
  it("updateBlockedWithoutAck : bloqué si un saut est requis et non coché", () => {
    expect(updateBlockedWithoutAck(true, false)).toBe(true);
    expect(updateBlockedWithoutAck(true, true)).toBe(false);
    // Aucun saut mineur/majeur → jamais bloqué.
    expect(updateBlockedWithoutAck(false, false)).toBe(false);
  });

  it("buildUpdateBody transmet la cible explicite + l'acquittement", () => {
    expect(buildUpdateBody(" 0.90.0 ", true)).toEqual({
      targetVersion: "0.90.0",
      acknowledged: true,
    });
    // Cible vide → le backend choisit la dernière version publiée.
    expect(buildUpdateBody("", false)).toEqual({ targetVersion: "", acknowledged: false });
  });

  it("SdkBreakingChange expose version/summary/details (contrat backend)", () => {
    const change: SdkBreakingChange = {
      version: "0.87.0",
      summary: "refonte prompt système",
      details: ["systemPrompt est un getter sans setter"],
    };
    expect(change.version).toBe("0.87.0");
    expect(change.details).toHaveLength(1);
  });
});
