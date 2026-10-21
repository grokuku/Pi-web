/**
 * session-date-context.test.ts — non-régression du repère `[horodatage]` dans le
 * pipeline de session.
 *
 * Bug corrigé : l'injection formatte l'heure dans le fuseau du PROCESS backend
 * (UTC en conteneur), alors que le fil de discussion l'affiche côté navigateur.
 * Résultat : un repère décalé (2 h en Europe/Paris l'été) par rapport à l'heure
 * réellement vue par l'utilisateur.
 *
 * Le backend n'expose pas de seam pour injecter une session factice dans
 * `sessionsByProject` : comme session-steer-timeout.test.ts, on vérifie donc
 * l'invariant STRUCTUREL du code source — la zone du client traverse bien
 * sendPrompt/steerPrompt jusqu'à l'injection. Le calcul lui-même (zones, DST,
 * repli) est couvert par date-context.test.ts.
 */
import { describe, expect, it } from "vitest";
import { sendPrompt, steerPrompt } from "./session.js";

describe("repère temporel — la zone du client traverse le pipeline", () => {
  const sendSrc = sendPrompt.toString();
  const steerSrc = steerPrompt.toString();

  it("sendPrompt accepte la zone du navigateur et la transmet à l'injection", () => {
    expect(sendSrc).toContain("timeZone");
    expect(sendSrc).toContain("injectDateContext(state.session, timeZone)");
  });

  it("steerPrompt accepte la zone du navigateur et la transmet à l'injection", () => {
    expect(steerSrc).toContain("timeZone");
    expect(steerSrc).toContain("injectDateContext(state.session, timeZone)");
  });

  it("aucune injection ne se fait sans zone (repli silencieux interdit ici)", () => {
    // Toute occurrence d'injection doit porter l'argument de zone : sinon on
    // réintroduit le bug (heure du serveur présentée comme « heure locale »).
    const calls = (src: string) => src.match(/injectDateContext\([^)]*\)/g) ?? [];
    for (const call of [...calls(sendSrc), ...calls(steerSrc)]) {
      expect(call).toBe("injectDateContext(state.session, timeZone)");
    }
  });
});
