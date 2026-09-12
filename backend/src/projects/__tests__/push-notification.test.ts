/**
 * Tests du résumé de push injecté dans le chat.
 *
 * Contrat clé : un push STANDARD garde le texte historique inchangé, tandis
 * qu'un push de SOUS-PROJET (vers la session du projet actif) identifie le
 * sous-projet et ajoute ses stats (branche, fichiers) sans perdre sujet/hash.
 */
import { describe, it, expect } from "vitest";
import { buildPushNotification } from "../push-notification.js";

describe("buildPushNotification", () => {
  it("push standard : texte historique inchangé (pas de nom de projet ni stats)", () => {
    const text = buildPushNotification({
      isSubPush: false,
      projectName: "MonProjet",
      subject: "Fix bug",
      body: "détail",
      commitHash: "abc1234",
      remoteUrl: "git@github.com:o/r.git",
      branch: "main",
      files: 3,
    });

    expect(text).toBe(`✅ Code successfully pushed to GitHub.
Commit: Fix bug
détail
Hash: abc1234
Remote: git@github.com:o/r.git

All changes from this commit are now live on the remote repository. Do not suggest modifications to files that were part of this commit unless the user explicitly asks for further changes.`);
    // Le push standard ne doit PAS afficher le nom ni les stats du sous-projet.
    expect(text).not.toContain("MonProjet");
    expect(text).not.toContain("Branch:");
    expect(text).not.toContain("Files:");
  });

  it("push sous-projet : nom du sous-projet + branche + fichiers", () => {
    const text = buildPushNotification({
      isSubPush: true,
      projectName: "Alpha",
      subject: "Add feature",
      commitHash: "def5678",
      remoteUrl: "",
      branch: "dev",
      files: 5,
    });

    expect(text).toContain('✅ Sub-project "Alpha" committed & pushed to GitHub.');
    expect(text).toContain("Commit: Add feature");
    expect(text).toContain("Hash: def5678");
    expect(text).toContain("Branch: dev");
    expect(text).toContain("Files: 5 change(s)");
    // remote absent → repli "origin"
    expect(text).toContain("Remote: origin");
  });

  it("sous-projet sans branche/body : fallbacks propres", () => {
    const text = buildPushNotification({
      isSubPush: true,
      projectName: "Beta",
      subject: "Chore",
      commitHash: "",
      remoteUrl: "x",
      branch: "",
      files: 0,
    });

    expect(text).toContain("Branch: —");
    expect(text).toContain("Files: 0 change(s)");
    expect(text).toContain("Commit: Chore");
  });
});
