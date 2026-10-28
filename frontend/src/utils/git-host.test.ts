import { describe, expect, it } from "vitest";
import { hostFromRemoteUrl } from "./git-host";

describe("hostFromRemoteUrl — clé du store d'identifiants (hôte, pas dépôt)", () => {
  it("HTTPS : hostname seul, en minuscules", () => {
    expect(hostFromRemoteUrl("https://github.com/owner/repo.git")).toBe("github.com");
    expect(hostFromRemoteUrl("https://GitHub.com/owner/repo")).toBe("github.com");
  });

  it("SSH : scp-like et ssh://", () => {
    expect(hostFromRemoteUrl("git@github.com:owner/repo.git")).toBe("github.com");
    expect(hostFromRemoteUrl("ssh://git@gitlab.example.com:2222/owner/repo.git")).toBe("gitlab.example.com");
  });

  it("valeur vide ou illisible → null (aucune action globale proposée)", () => {
    expect(hostFromRemoteUrl("")).toBeNull();
    expect(hostFromRemoteUrl(null)).toBeNull();
    expect(hostFromRemoteUrl(undefined)).toBeNull();
    expect(hostFromRemoteUrl("pas une url")).toBeNull();
  });
});
