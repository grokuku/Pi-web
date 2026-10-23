/**
 * Bac à sable temporaire pour les tests des racines autorisées.
 *
 * Problème résolu : `path-security.ts` définit ses racines par défaut sous
 * forme de constantes (`/projects`, `/mnt/smb`) sans aucun point d'injection.
 * Les tests qui exercent cette allow-list doivent donc disposer d'un dossier
 * réellement présent sous l'une de ces racines — or `/projects` n'est pas
 * accessible en écriture pour un utilisateur non-root (EACCES). Un test ne
 * doit JAMAIS écrire hors du dépôt ni dépendre des droits root.
 *
 * Solution : on crée un bac à sable avec `fs.mkdtempSync` dans `os.tmpdir()`
 * et on redirige UNIQUEMENT la résolution des deux racines par défaut vers
 * deux dossiers de ce bac à sable. Tout le reste du code de sécurité est
 * exécuté pour de vrai sur le vrai système de fichiers : `realpathSync` réel
 * pour les autres chemins, vrai `lstatSync`, vrais liens symboliques, vraie
 * deny-list, vrai test de préfixe « strictement sous la racine ».
 *
 * Ce module n'est importé que par des `*.test.ts` (suffixe `.test-util.ts`
 * pour être exclu du motif d'exécution vitest `src/**\/*.test.ts`).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { vi } from "vitest";

/** Racines par défaut définies en dur dans `path-security.ts`. */
const PROJECTS_ROOT = "/projects";
const SMB_ROOT = "/mnt/smb";

export interface AllowedRootMirror {
  /** Dossier temporaire qui joue le rôle de `/projects`. */
  readonly projects: string;
  /** Dossier temporaire qui joue le rôle de `/mnt/smb`. */
  readonly smb: string;
  /** Dossier racine du bac à sable (supprimé par `dispose`). */
  readonly sandbox: string;
  /** Active la redirection des racines par défaut (idempotent). */
  install(): void;
  /** Désactive la redirection : `getAllowedRoots()` rend les vraies racines. */
  uninstall(): void;
  /** Désactive la redirection et supprime le bac à sable. */
  dispose(): void;
}

/**
 * Crée le bac à sable et retourne le miroir de racines associé.
 * `prefix` préfixe le nom du dossier temporaire (`piweb-<prefix>-XXXXXX`).
 */
export function createAllowedRootMirror(prefix: string): AllowedRootMirror {
  // realpathSync sur le bac à sable : sur macOS `os.tmpdir()` est un lien
  // (/var → /private/var), il faut normaliser pour que les préfixes comparés
  // par path-security.ts soient bien les chemins réels.
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `piweb-${prefix}-`)));
  const projects = path.join(sandbox, "projects");
  const smb = path.join(sandbox, "smb");
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(smb, { recursive: true });

  const realRealpathSync = fs.realpathSync;
  let spy: { mockRestore(): void } | null = null;

  const install = (): void => {
    if (spy) return;
    spy = vi.spyOn(fs, "realpathSync").mockImplementation(((
      target: fs.PathLike,
      ...rest: unknown[]
    ) => {
      const asString = typeof target === "string" ? target : String(target);
      if (asString === PROJECTS_ROOT) return projects;
      if (asString === SMB_ROOT) return smb;
      return (realRealpathSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as unknown as typeof fs.realpathSync);
  };

  const uninstall = (): void => {
    if (!spy) return;
    spy.mockRestore();
    spy = null;
  };

  return {
    projects,
    smb,
    sandbox,
    install,
    uninstall,
    dispose(): void {
      uninstall();
      fs.rmSync(sandbox, { recursive: true, force: true });
    },
  };
}
