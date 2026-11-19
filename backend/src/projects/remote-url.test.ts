/**
 * Tests de `sanitizeRemoteUrl` — B4 (intégrité).
 *
 * L'ancienne regex `([^@]+@)?` s'arrêtait au PREMIER `@` : avec un mot de passe
 * contenant `@`, un FRAGMENT DU MOT DE PASSE restait dans l'URL nettoyée, donc
 * réécrit dans `.git/config` et dans `projects.json`. Même classe de bug que
 * BUG-15 dans `redactUrl` (qui vise le DERNIER `@`).
 */
import { describe, expect, it } from "vitest";
import { redactSecretsInMessage, sanitizeRemoteUrl } from "./remote-url.js";

describe("sanitizeRemoteUrl", () => {
  it("retire un userinfo simple", () => {
    expect(sanitizeRemoteUrl("https://user:token@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
    expect(sanitizeRemoteUrl("https://user@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it("retire TOUT quand le mot de passe contient un @ (aucun fragment conservé)", () => {
    expect(sanitizeRemoteUrl("https://user:pa@ss@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
    expect(sanitizeRemoteUrl("https://user:p@ss@w@rd@gitlab.example.com/o/r.git")).toBe(
      "https://gitlab.example.com/o/r.git",
    );
    // Aucun résidu du secret, quel qu'il soit.
    expect(sanitizeRemoteUrl("https://u:sec@ret@host/o/r")).not.toContain("sec");
    expect(sanitizeRemoteUrl("https://u:sec@ret@host/o/r")).not.toContain("ret");
  });

  it("ne touche pas à une URL sans credentials", () => {
    expect(sanitizeRemoteUrl("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
    expect(sanitizeRemoteUrl("http://gitea.local:3000/owner/repo.git")).toBe(
      "http://gitea.local:3000/owner/repo.git",
    );
  });

  it("ne touche pas aux URLs SSH (le @ y est l'utilisateur, pas un secret)", () => {
    expect(sanitizeRemoteUrl("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git");
    expect(sanitizeRemoteUrl("ssh://git@github.com/owner/repo.git")).toBe(
      "ssh://git@github.com/owner/repo.git",
    );
  });

  it("un @ dans le CHEMIN n'est pas un userinfo", () => {
    expect(sanitizeRemoteUrl("https://github.com/owner/re@po.git")).toBe(
      "https://github.com/owner/re@po.git",
    );
  });

  it("conserve le port, les query et les valeurs vides", () => {
    expect(sanitizeRemoteUrl("https://u:p@host:8443/o/r.git?x=1")).toBe("https://host:8443/o/r.git?x=1");
    expect(sanitizeRemoteUrl("")).toBe("");
  });
});

// ── Expurgation d'un MESSAGE (pas d'une URL seule) ──────────────────────────
//
// Les messages d'échec git recopient l'URL temporaire d'authentification et
// remontent jusqu'à l'écran de l'utilisateur : le jeton ne doit jamais en sortir.
describe("redactSecretsInMessage", () => {
  it("remplace le userinfo d'une URL citée dans une phrase", () => {
    const msg =
      "fatal: unable to access 'https://x-access-token:ghp_SECRET@github.com/owner/repo.git/': 403";
    expect(redactSecretsInMessage(msg)).toBe(
      "fatal: unable to access 'https://****@github.com/owner/repo.git/': 403",
    );
    expect(redactSecretsInMessage(msg)).not.toContain("ghp_SECRET");
  });

  it("un mot de passe contenant @ ne laisse AUCUN fragment du secret", () => {
    const redacted = redactSecretsInMessage(
      "fatal: unable to access 'https://user:ghp_SEC@RET@github.com/o/r': 403",
    );
    expect(redacted).toBe("fatal: unable to access 'https://****@github.com/o/r': 403");
    expect(redacted).not.toContain("ghp_SEC");
    expect(redacted).not.toContain("RET@");
  });

  it("expurge plusieurs URLs dans un même message", () => {
    const redacted = redactSecretsInMessage(
      "https://u:p@a.example.com/x puis https://u:p@b.example.com/y",
    );
    expect(redacted).toBe("https://****@a.example.com/x puis https://****@b.example.com/y");
  });

  it("ne touche PAS un message sans identifiants (remote SSH, hôtes nus)", () => {
    for (const msg of [
      "fatal: Could not resolve host: github.com",
      "git@github.com: Permission denied (publickey).",
      "fatal: unable to access 'https://github.com/owner/repo.git/': 403",
      "! [rejected] main -> main (non-fast-forward)",
    ]) {
      expect(redactSecretsInMessage(msg)).toBe(msg);
    }
  });

  it("entrée vide → chaîne vide", () => {
    expect(redactSecretsInMessage("")).toBe("");
  });
});
