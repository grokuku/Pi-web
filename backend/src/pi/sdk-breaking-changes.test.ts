/**
 * Tests du GARDE-FOU de mise à jour du SDK (backend/src/pi/sdk-breaking-changes.ts).
 *
 * Objectif : vérifier que la table des ruptures est bien exploitée par la route
 * POST /api/settings/update — un saut mineur/majeur non acquitté est REFUSÉ
 * (409), un saut acquitté passe, une cible identique est « already up to date »,
 * et la réécriture du pin échoue clairement si la ligne est introuvable.
 */
import { describe, expect, it } from "vitest";
import {
  SDK_BREAKING_CHANGES,
  compareVersions,
  evaluateUpdateTarget,
  getApplicableBreakingChanges,
  isMajorOrMinorBump,
  isValidVersion,
  parseVersion,
  replaceEntrypointPin,
} from "./sdk-breaking-changes.js";

describe("sdk-breaking-changes — table statique", () => {
  it("couvre les ruptures 0.86.0 et 0.87.0 (retour d'expérience réel)", () => {
    const versions = SDK_BREAKING_CHANGES.map((c) => c.version);
    expect(versions).toContain("0.86.0");
    expect(versions).toContain("0.87.0");
    expect(versions).toContain("0.86.1");
    expect(versions).toContain("0.87.1");

    const v87 = SDK_BREAKING_CHANGES.find((c) => c.version === "0.87.0")!;
    // La rupture clé de 0.87.0 : systemPrompt est un getter sans setter.
    expect(v87.details.join("\n")).toContain("agent.state.systemPrompt");
    expect(v87.details.join("\n")).toContain("_baseSystemPrompt");

    const v86 = SDK_BREAKING_CHANGES.find((c) => c.version === "0.86.0")!;
    expect(v86.details.join("\n")).toContain("TranscriptContext");
  });
});

describe("sdk-breaking-changes — versions", () => {
  it("parseVersion tolère les pré-releases et l'inconnu", () => {
    expect(parseVersion("0.87.1")).toEqual([0, 87, 1]);
    expect(parseVersion("1.2.3-beta.4")).toEqual([1, 2, 3]);
    expect(parseVersion("unknown")).toEqual([0, 0, 0]);
  });

  it("compareVersions ordonne correctement", () => {
    expect(compareVersions("0.85.1", "0.87.1")).toBe(-1);
    expect(compareVersions("0.87.1", "0.87.1")).toBe(0);
    expect(compareVersions("0.88.0", "0.87.1")).toBe(1);
  });

  it("isValidVersion accepte x.y.z (pré-release optionnelle) et rejette le reste", () => {
    expect(isValidVersion("0.87.1")).toBe(true);
    expect(isValidVersion("1.0.0-rc.1")).toBe(true);
    expect(isValidVersion("latest")).toBe(false);
    expect(isValidVersion("0.87")).toBe(false);
    expect(isValidVersion("")).toBe(false);
  });
});

describe("sdk-breaking-changes — ruptures applicables", () => {
  it("liste les versions intermédiaires d'un saut 0.85.1 → 0.87.1", () => {
    const changes = getApplicableBreakingChanges("0.85.1", "0.87.1");
    expect(changes.map((c) => c.version)).toEqual(["0.86.0", "0.86.1", "0.87.0", "0.87.1"]);
  });

  it("ne liste rien si la cible est identique ou inférieure", () => {
    expect(getApplicableBreakingChanges("0.87.1", "0.87.1")).toEqual([]);
    expect(getApplicableBreakingChanges("0.87.1", "0.86.0")).toEqual([]);
  });

  it("isMajorOrMinorBump : vrai sur mineur/majeur, faux sur patch seul", () => {
    expect(isMajorOrMinorBump("0.85.1", "0.87.1")).toBe(true);
    expect(isMajorOrMinorBump("0.86.0", "0.87.0")).toBe(true);
    expect(isMajorOrMinorBump("0.87.0", "0.87.1")).toBe(false);
    expect(isMajorOrMinorBump("0.87.1", "0.87.1")).toBe(false);
  });
});

describe("sdk-breaking-changes — décision du garde-fou (route POST /update)", () => {
  it("cible mineure SANS acknowledged → bloqué (409) + ruptures listées", () => {
    const d = evaluateUpdateTarget("0.85.1", "0.87.1", false);
    expect(d.blocked).toBe(true);
    expect(d.requiresAck).toBe(true);
    expect(d.alreadyUpToDate).toBe(false);
    expect(d.breakingChanges.map((c) => c.version)).toEqual([
      "0.86.0",
      "0.86.1",
      "0.87.0",
      "0.87.1",
    ]);
  });

  it("cible mineure AVEC acknowledged → passe", () => {
    const d = evaluateUpdateTarget("0.85.1", "0.87.1", true);
    expect(d.blocked).toBe(false);
    expect(d.requiresAck).toBe(true);
    expect(d.breakingChanges.length).toBeGreaterThan(0);
  });

  it("cible identique à l'installée → already up to date (pas de blocage)", () => {
    const d = evaluateUpdateTarget("0.87.1", "0.87.1", false);
    expect(d.alreadyUpToDate).toBe(true);
    expect(d.requiresAck).toBe(false);
    expect(d.blocked).toBe(false);
    expect(d.breakingChanges).toEqual([]);
  });

  it("saut patch (0.87.0 → 0.87.1) → pas d'acquittement requis", () => {
    const d = evaluateUpdateTarget("0.87.0", "0.87.1", false);
    expect(d.requiresAck).toBe(false);
    expect(d.blocked).toBe(false);
    // La version intermédiaire reste listée (pour information).
    expect(d.breakingChanges.map((c) => c.version)).toEqual(["0.87.1"]);
  });
});

describe("sdk-breaking-changes — réécriture du pin entrypoint.sh", () => {
  const sample =
    "npm install @earendil-works/pi-coding-agent@0.87.1 --no-audit --no-fund --save\n";

  it("remplace la version épinglée par la cible", () => {
    const updated = replaceEntrypointPin(sample, "0.90.0");
    expect(updated).toContain("pi-coding-agent@0.90.0");
    expect(updated).not.toContain("pi-coding-agent@0.87.1");
  });

  it("ligne de pin absente → erreur explicite", () => {
    expect(() => replaceEntrypointPin("echo rien ici\n", "0.90.0")).toThrow(
      /aucune ligne npm install pi-coding-agent/,
    );
  });
});
