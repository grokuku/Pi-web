/**
 * Shared path security utilities (BUG-51/52/53 fix).
 *
 * Centralise la validation des chemins pour files.ts et agent.ts
 * afin d'éviter la duplication et les désync entre les deux.
 */

import path from "path";
import { getAllProjects } from "../projects/manager.js";

// Racines par défaut — les cwd de projets sont ajoutés dynamiquement
const DEFAULT_ROOTS = ["/projects", "/home", "/mnt"];

// Chemins sensibles à ne jamais exposer
const DENY_LIST = [
  ".ssh",
  ".env",
  "credentials.enc",
  ".smb-key",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "authorized_keys",
];

/**
 * Retourne les racines autorisées : racines par défaut + cwd de chaque projet.
 * Les projets hors des racines par défaut sont ainsi accessibles.
 */
export function getAllowedRoots(): string[] {
  const roots = new Set(DEFAULT_ROOTS.map(r => path.resolve(r)));
  try {
    for (const p of getAllProjects()) {
      if (p.cwd) roots.add(path.resolve(p.cwd));
    }
  } catch {}
  return [...roots];
}

/**
 * Vérifie qu'un chemin est dans une racine autorisée et ne contient
 * pas de composant sensible. Utilise path.sep pour éviter le path traversal
 * (ex: /home ne doit pas matcher /homeetc).
 */
export function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const inAllowedRoot = getAllowedRoots().some((root) => {
    return resolved === root || resolved.startsWith(root + path.sep);
  });
  if (!inAllowedRoot) return false;
  const parts = resolved.split(path.sep);
  return !parts.some(part => DENY_LIST.includes(part));
}