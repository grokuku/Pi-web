/**
 * Tests de `sanitizeRemoteUrl` — B4 (intégrité).
 *
 * L'ancienne regex `([^@]+@)?` s'arrêtait au PREMIER `@` : avec un mot de passe
 * contenant `@`, un FRAGMENT DU MOT DE PASSE restait dans l'URL nettoyée, donc
 * réécrit dans `.git/config` et dans `projects.json`. Même classe de bug que
 * BUG-15 dans `redactUrl` (qui vise le DERNIER `@`).
 */
import { describe, expect, it } from "vitest";
import { sanitizeRemoteUrl } from "./remote-url.js";

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
