/**
 * B6 (intégrité) — montage SMB : le fichier d'identifiants survit à TOUS les
 * replis de dialecte, et le mot de passe n'est jamais passé en argument.
 *
 * Avant : `doMount()` supprimait le fichier dans son callback. Les replis v2
 * puis v1 réutilisaient ce MÊME chemin, déjà effacé → tout serveur exigeant
 * `vers=2.0`/`vers=1.0` ne pouvait JAMAIS être monté, avec un message
 * trompeur (« mount error »). Aggravant : si la création du fichier échouait,
 * le repli « inline » mettait `password=…` dans les arguments de `mount`,
 * donc en clair dans `/proc/<pid>/cmdline`.
 *
 * `execFile` est mocké : aucun montage réel, aucun privilège requis.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// Clé d'encryption de test : évite de générer/écrire une vraie clé SMB.
process.env.SMB_ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface Attempt {
  args: string[];
  credFile: string | null;
  credFileExistedAtAttempt: boolean;
  version: string;
}

const attempts: Attempt[] = [];

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], optsOrCb: any, maybeCb?: any) => {
    const cb: (e: any, out?: string, err?: string) => void =
      typeof optsOrCb === "function" ? optsOrCb : maybeCb;
    if (cmd === "mountpoint") {
      // Pas encore monté (err ≠ null → isMounted() === false).
      cb(new Error("not a mountpoint"));
      return;
    }
    const opts = args[args.length - 1] || "";
    const version = /vers=([\d.]+)/.exec(opts)?.[1] ?? "?";
    const credFile = /credentials=([^,]+)/.exec(opts)?.[1] ?? null;
    attempts.push({
      args: [...args],
      credFile,
      // Capturé AU MOMENT de la tentative, pas après.
      credFileExistedAtAttempt: credFile ? existsSync(credFile) : false,
      version,
    });
    if (version === "1.0") cb(null, "", "");
    else cb(new Error("mount error(95): Operation not supported"), "", "mount error(95): Operation not supported");
  },
}));

const { mountSmb } = await import("./smb.js");

function freshMountPoint(): string {
  return mkdtempSync(path.join(os.tmpdir(), "smb-mount-test-"));
}

describe("B6 — le fichier d'identifiants vit pendant tous les replis", () => {
  it("v3 échoue, v2 échoue, v1 réussit : le fichier existe à CHAQUE tentative", async () => {
    attempts.length = 0;
    const mountPoint = freshMountPoint();
    try {
      const result = await mountSmb("smb://server/share", mountPoint, {
        username: "user",
        password: "plain-password",
      });

      expect(result.ok).toBe(true);
      expect(attempts.map((a) => a.version)).toEqual(["3.0", "2.0", "1.0"]);
      // Cœur du bug : sans le correctif, les tentatives 2 et 3 lisaient un
      // chemin supprimé par la 1re.
      for (const attempt of attempts) {
        expect(attempt.credFile).toBeTruthy();
        expect(attempt.credFileExistedAtAttempt).toBe(true);
      }
      // Même fichier pour les 3 tentatives (l'identifiant n'est pas recréé).
      expect(new Set(attempts.map((a) => a.credFile)).size).toBe(1);
      // Et il est nettoyé APRÈS la dernière tentative.
      expect(existsSync(attempts[0].credFile!)).toBe(false);
      expect(existsSync(path.dirname(attempts[0].credFile!))).toBe(false);
    } finally {
      rmSync(mountPoint, { recursive: true, force: true });
    }
  });

  it("le mot de passe n'apparaît JAMAIS dans les arguments de mount (/proc)", async () => {
    attempts.length = 0;
    const mountPoint = freshMountPoint();
    try {
      await mountSmb("smb://server/share", mountPoint, {
        username: "user",
        password: "pl@in$secret",
      });
      const argv = attempts.map((a) => a.args.join(" ")).join("\n");
      expect(argv).not.toContain("pl@in$secret");
      expect(argv).not.toContain("password=");
    } finally {
      rmSync(mountPoint, { recursive: true, force: true });
    }
  });

  it("aucun repli inline « password= » ne subsiste dans le source", () => {
    const src = readFileSync(fileURLToPath(new URL("./smb.ts", import.meta.url)), "utf-8");
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/?\*)/.test(line))
      .join("\n");
    expect(code).not.toContain("password=${decryptedPassword}");
  });
});
