// ── Tests : décisions d'erreur git côté client (correctif boucle d'auth) ─────
// Objectif : ne plus appeler « auth » ce qui n'en est pas, toujours afficher le
// message réel, et BORNER les ouvertures de la modale d'identifiants.
import { describe, expect, it } from "vitest";
import {
  MAX_AUTH_ATTEMPTS,
  commitPushOutcome,
  decideGitFailure,
  looksLikeSshRemote,
  suggestedHttpsRemote,
} from "./git-errors";

const labels = { authLimitReached: (max: number) => `limite ${max} atteinte` };

/** Erreur telle que fabriquée par parseJsonResponse (corps JSON dans .data). */
function apiError(code: string, message: string) {
  const err = new Error(message) as Error & { data?: unknown };
  err.data = { error: message, code };
  return err;
}

describe("decideGitFailure", () => {
  it("GIT_AUTH_REQUIRED sous la borne → ouvre la modale et affiche le message", () => {
    const d = decideGitFailure(
      apiError("GIT_AUTH_REQUIRED", "Git push authentication failed: 403"),
      0,
      labels
    );
    expect(d.showAuthModal).toBe(true);
    expect(d.blocked).toBe(false);
    expect(d.message).toBe("Git push authentication failed: 403");
  });

  it("borne atteinte (max 2) → plus de modale, message + état bloqué", () => {
    const d = decideGitFailure(
      apiError("GIT_AUTH_REQUIRED", "Git push authentication failed: 403"),
      MAX_AUTH_ATTEMPTS,
      labels
    );
    expect(MAX_AUTH_ATTEMPTS).toBe(2);
    expect(d.showAuthModal).toBe(false);
    expect(d.blocked).toBe(true);
    expect(d.message).toContain("limite 2 atteinte");
  });

  it("GIT_REMOTE_SCHEME (origin SSH) → message seul, jamais la modale", () => {
    const d = decideGitFailure(
      apiError("GIT_REMOTE_SCHEME", "This repository's origin uses SSH (git@github.com:o/r.git)."),
      0,
      labels
    );
    expect(d.showAuthModal).toBe(false);
    expect(d.blocked).toBe(false);
    expect(d.message).toContain("uses SSH");
  });

  it("GIT_UNREACHABLE / GIT_PUSH_REJECTED → message seul, jamais la modale", () => {
    for (const code of ["GIT_UNREACHABLE", "GIT_PUSH_REJECTED"]) {
      const d = decideGitFailure(apiError(code, `échec ${code}`), 1, labels);
      expect(d.showAuthModal).toBe(false);
      expect(d.message).toBe(`échec ${code}`);
    }
  });

  it("erreur sans code → message affiché (plus d'échec silencieux)", () => {
    const d = decideGitFailure(new Error("Network down"), 0, labels);
    expect(d).toEqual({ message: "Network down", showAuthModal: false, blocked: false });
  });
});

describe("commitPushOutcome", () => {
  it("push réel confirmé → succès et mention du push", () => {
    const o = commitPushOutcome({ commitResult: "Committed 2 change(s) as abc1234", pushResult: "Pushed 1 ref(s)" });
    expect(o.ok).toBe(true);
    expect(o.pushed).toBe(true);
    expect(o.message).toBe("Committed 2 change(s) as abc1234 → Pushed 1 ref(s)");
  });

  it("`Push failed: …` (ancien faux succès avalé) → échec explicite", () => {
    const o = commitPushOutcome({ commitResult: "Committed 2 change(s) as abc1234", pushResult: "Push failed: remote rejected" });
    expect(o.ok).toBe(false);
    expect(o.pushed).toBe(false);
    expect(o.message).toBe("Push failed: remote rejected");
  });

  it("rien à pousser → pas de « poussé » annoncé", () => {
    const o = commitPushOutcome({ commitResult: "Nothing to commit" });
    expect(o.ok).toBe(true);
    expect(o.pushed).toBe(false);
    expect(o.message).toBe("Nothing to commit");
  });

  it("réponse vide → pas de succès inventé", () => {
    expect(commitPushOutcome(undefined).ok).toBe(false);
    expect(commitPushOutcome({}).pushed).toBe(false);
  });
});

describe("remotes SSH — avertissement avant saisie du token", () => {
  it("détecte les formes SSH et ignore HTTPS", () => {
    expect(looksLikeSshRemote("git@github.com:owner/repo.git")).toBe(true);
    expect(looksLikeSshRemote("ssh://git@github.com/owner/repo.git")).toBe(true);
    expect(looksLikeSshRemote("https://github.com/owner/repo.git")).toBe(false);
    expect(looksLikeSshRemote(undefined)).toBe(false);
  });

  it("propose l'URL HTTPS équivalente (commande git remote set-url)", () => {
    expect(suggestedHttpsRemote("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo.git");
    expect(suggestedHttpsRemote("ssh://git@gitlab.com/owner/repo.git")).toBe("https://gitlab.com/owner/repo.git");
    expect(suggestedHttpsRemote("https://github.com/owner/repo.git")).toBeNull();
  });
});
