/**
 * Utilitaires centralisés de validation des chemins (correctifs BUG-51/52/53).
 *
 * Centralise la validation des chemins pour files.ts, agent.ts, cbm.ts et
 * index.ts (terminal WS) afin d'éviter la duplication et les désynchronisations.
 *
 * Durcissement sécurité :
 *  - résolution réelle des chemins (fs.realpathSync) pour neutraliser les
 *    contournements par lien symbolique ;
 *  - racines par défaut restreintes à /projects et /mnt/smb (SMB uniquement) ;
 *  - deny-list élargie aux fichiers de configuration sensibles.
 */

import fs from "fs";
import path from "path";
import { getAllProjects } from "../projects/manager.js";

// Racines par défaut — les cwd de projets sont ajoutés dynamiquement.
// /home et /mnt ont été retirés : ils exposaient des données trop larges.
// /mnt/smb reste nécessaire au fonctionnement des montages SMB.
const DEFAULT_ROOTS = ["/projects", "/mnt/smb"];

// Composants sensibles à ne jamais exposer (noms exacts de fichiers/dossiers).
const DENY_EXACT = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".config",
  ".git",
  ".git-credentials",
  ".npmrc",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".bash_history",
  ".zshrc",
  ".zsh_history",
  ".netrc",
  ".pgpass",
  ".dockercfg",
  ".docker",
  ".smb-key",
  // Dossier de données applicatif : contient projects.json et agent-keys.json.
  ".data",
  "credentials.enc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "authorized_keys",
]);

/**
 * Vérifie qu'un composant de chemin est interdit.
 * Couvre les noms exacts et les variantes .env.* (ex: .env.local).
 */
function isDeniedComponent(part: string): boolean {
  if (DENY_EXACT.has(part)) return true;
  if (part === ".env" || part.startsWith(".env.")) return true;
  return false;
}

/** Vérifie qu'un chemin contient un composant interdit. */
function isDeniedPath(targetPath: string): boolean {
  return targetPath
    .split(path.sep)
    .filter(Boolean)
    .some(isDeniedComponent);
}

/**
 * Résout le chemin réel d'un chemin cible.
 *
 * Contrairement à path.resolve() (purement lexical), cette fonction résout
 * les liens symboliques via fs.realpathSync. Pour un chemin qui n'existe pas
 * encore (ex: destination d'upload), on valide le parent réel existant le plus
 * proche puis on ré-applique le suffixe restant.
 *
 * Retourne null si le chemin ne peut pas être résolu de façon sûre
 * (permission refusée, lien symbolique cassé, etc.).
 */
function resolveRealPath(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);

  try {
    try {
      return fs.realpathSync(resolved);
    } catch (err) {
      // Seul ENOENT signifie "le chemin final n'existe pas encore".
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }

    // Le chemin final n'existe pas réellement. S'il existe en tant que lien
    // symbolique cassé, on refuse : une écriture pourrait suivre ce lien et
    // sortir de la racine autorisée.
    try {
      if (fs.lstatSync(resolved).isSymbolicLink()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }

    // Remonte au parent réel existant le plus proche.
    let ancestor = path.dirname(resolved);
    while (true) {
      try {
        const realAncestor = fs.realpathSync(ancestor);
        return path.join(realAncestor, path.relative(ancestor, resolved));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }

      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        // Plus de parent existant : on retourne le chemin résolu lexicalement.
        return resolved;
      }
      ancestor = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Résout une racine de travail. Si la racine n'existe pas encore, on conserve
 * le chemin résolu lexicalement (ex: /projects avant création du premier projet).
 */
function resolveRoot(root: string): string | null {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Vérifie qu'un chemin de travail (cwd de projet) est strictement sous une
 * racine autorisée par défaut. Contrairement à isPathAllowed(), cette fonction
 * ne consulte pas les projets existants : un cwd arbitraire ne peut donc pas
 * s'auto-légitimer.
 */
export function isCwdAllowed(targetPath: string): boolean {
  const real = resolveRealPath(targetPath);
  if (!real) return false;

  // Vérifie la deny-list sur le chemin lexical ET le chemin réel.
  if (isDeniedPath(path.resolve(targetPath)) || isDeniedPath(real)) return false;

  // Le cwd doit être strictement SOUS une racine (pas égal à la racine).
  return DEFAULT_ROOTS.some((root) => {
    const r = resolveRoot(root);
    if (!r) return false;
    return real.startsWith(r + path.sep);
  });
}

/**
 * Retourne les racines autorisées : racines par défaut + cwd des projets
 * qui sont eux-mêmes sous une racine autorisée.
 */
export function getAllowedRoots(): string[] {
  const roots = new Set<string>();
  for (const root of DEFAULT_ROOTS) {
    const r = resolveRoot(root);
    if (r) roots.add(r);
  }

  try {
    for (const p of getAllProjects()) {
      // Ne jamais ajouter un cwd arbitraire (ex: /etc) aux racines autorisées.
      if (p.cwd && isCwdAllowed(p.cwd)) {
        const r = resolveRoot(p.cwd);
        if (r) roots.add(r);
      }
    }
  } catch {}

  return [...roots];
}

/**
 * Vérifie qu'un chemin est dans une racine autorisée et ne contient pas de
 * composant sensible.
 *
 * Si `allowedRoot` est fourni, la vérification est confinée à ce sous-dossier
 * (utilisé par les routes de fichiers liées à un projet).
 */
export function isPathAllowed(targetPath: string, allowedRoot?: string): boolean {
  const real = resolveRealPath(targetPath);
  if (!real) return false;

  // Vérifie la deny-list sur le chemin lexical ET le chemin réel.
  if (isDeniedPath(path.resolve(targetPath)) || isDeniedPath(real)) return false;

  let roots: string[];
  if (allowedRoot) {
    // La racine de confinement doit elle-même être un cwd valide.
    if (!isCwdAllowed(allowedRoot)) return false;
    const r = resolveRoot(allowedRoot);
    if (!r) return false;
    roots = [r];
  } else {
    roots = getAllowedRoots();
  }

  return roots.some((root) => real === root || real.startsWith(root + path.sep));
}
