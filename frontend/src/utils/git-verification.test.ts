// ── Honnêteté du badge git : throttle d'auto-fetch + états de vérification ──
// Bug d'origine : le panneau affichait « à jour » sans avoir JAMAIS interrogé le
// distant (Pi-Web ne faisait pas de `git fetch`) → « à jour » sur une photo
// périmée du dépôt distant. Ces fonctions sont la base du correctif :
//  - le throttle (60 s par dépôt) empêche une rafale de fetchs au repli/dépliage ;
//  - `verificationState` ne dit « à jour » (fresh) QUE sur un fetch récent, et
//    ne dit jamais rien d'autre que « non vérifié » quand il n'y a pas de fetch
//    réussi.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  badgeState,
  GIT_FETCH_THROTTLE_MS,
  GIT_VERIFICATION_FRESH_MS,
  isSuccessfulFetch,
  markFetchAttempt,
  resetFetchThrottle,
  shouldAutoFetch,
  verificationState,
} from "./git-verification";

beforeEach(() => resetFetchThrottle());
afterEach(() => resetFetchThrottle());

describe("throttle d'auto-fetch (60 s par dépôt)", () => {
  it("premier appel : autorisé", () => {
    expect(shouldAutoFetch("p1", 1_000)).toBe(true);
  });

  it("juste après une tentative : refusé (pas de fetch en boucle au repli/dépliage)", () => {
    markFetchAttempt("p1", 1_000);

    expect(shouldAutoFetch("p1", 1_000)).toBe(false);
    expect(shouldAutoFetch("p1", 1_000 + GIT_FETCH_THROTTLE_MS - 1)).toBe(false);
    expect(shouldAutoFetch("p1", 1_000 + GIT_FETCH_THROTTLE_MS)).toBe(true);
  });

  it("le throttle est PAR DÉPÔT (un projet lié n'est pas privé de fetch par le principal)", () => {
    markFetchAttempt("p1", 1_000);

    expect(shouldAutoFetch("p1", 1_000)).toBe(false);
    expect(shouldAutoFetch("p2", 1_000)).toBe(true);
  });

  it("un ÉCHEC compte comme une tentative (pas de martèlement d'un dépôt injoignable)", () => {
    // Aucune distinction succès/échec : la tentative est enregistrée dans les
    // deux cas, sinon un dépôt hors ligne serait re-testé à chaque rendu.
    markFetchAttempt("p1", 5_000);

    expect(shouldAutoFetch("p1", 5_000 + 10_000)).toBe(false);
  });
});

describe("verificationState — trois états, jamais un « à jour » gratuit", () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("aucun fetch réussi → unverified (ni « à jour » ni « vérifié »)", () => {
    expect(verificationState(null, now)).toBe("unverified");
    expect(verificationState(undefined, now)).toBe("unverified");
  });

  it("fetch récent → fresh (seul cas où « à jour » est affirmable)", () => {
    expect(verificationState(iso(0), now)).toBe("fresh");
    expect(verificationState(iso(GIT_VERIFICATION_FRESH_MS - 1), now)).toBe("fresh");
  });

  it("fetch ancien → stale (on date la photo au lieu d'affirmer le présent)", () => {
    expect(verificationState(iso(GIT_VERIFICATION_FRESH_MS), now)).toBe("stale");
    expect(verificationState(iso(3 * 60 * 60_000), now)).toBe("stale");
  });

  it("horodatage illisible ou dans le futur → unverified (on ne prétend rien)", () => {
    expect(verificationState("not-a-date", now)).toBe("unverified");
    expect(verificationState(new Date(now + 24 * 3_600_000).toISOString(), now)).toBe("unverified");
  });
});

describe("badgeState — une tentative ratée ne dit jamais « à jour »", () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("tentative ratée + aucun succès antérieur → unverified", () => {
    expect(badgeState(null, true, now)).toBe("unverified");
  });

  it("tentative ratée + succès antérieur → stale (photo datée), jamais fresh", () => {
    // Même un succès très récent est démotionné : le dernier contrôle a échoué,
    // donc on n'affirme plus le présent.
    expect(badgeState(iso(1_000), true, now)).toBe("stale");
    expect(badgeState(iso(3_600_000), true, now)).toBe("stale");
  });

  it("aucune tentative ratée → état déduit de l'horodatage", () => {
    expect(badgeState(iso(0), false, now)).toBe("fresh");
    expect(badgeState(iso(3_600_000), false, now)).toBe("stale");
    expect(badgeState(null, false, now)).toBe("unverified");
  });
});

describe("isSuccessfulFetch — un échec structuré n'est pas un succès", () => {
  it("ok:true + horodatage → vrai", () => {
    expect(isSuccessfulFetch({ ok: true, fetchedAt: "2026-11-08T10:00:00.000Z" })).toBe(true);
  });

  it("ok:false (no_remote / network / auth / timeout) → faux", () => {
    expect(isSuccessfulFetch({ ok: false, reason: "no_remote", fetchedAt: null })).toBe(false);
    expect(isSuccessfulFetch({ ok: false, reason: "network", fetchedAt: null })).toBe(false);
  });

  it("ok:true sans horodatage → faux (pas de « à jour » sans date)", () => {
    expect(isSuccessfulFetch({ ok: true, fetchedAt: null })).toBe(false);
    expect(isSuccessfulFetch({ ok: true })).toBe(false);
    expect(isSuccessfulFetch(null)).toBe(false);
  });
});
