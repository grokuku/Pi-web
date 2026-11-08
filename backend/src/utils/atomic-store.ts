/**
 * Fichiers d'ÉTAT de Pi-Web (projects.json, model-library.json,
 * credentials.enc…) : écriture atomique et lecture qui REFUSE un fichier
 * illisible.
 *
 * Pourquoi (intégrité des données) : `JSON.stringify` + `writeFileSync` en
 * direct sur le fichier final laisse, en cas de crash ou de disque plein, un
 * fichier TRONQUÉ. Au démarrage suivant, l'ancien code loguait puis repartait
 * sur un défaut (`return []`, `getDefaultLibrary()`), si bien que le premier
 * enregistrement écrasait DÉFINITIVEMENT l'original. Deux garanties ici :
 *
 *  1. écriture `tmp` + `rename` (atomique sur POSIX) : le fichier final est
 *     toujours soit l'ancien, soit le nouveau, jamais un mélange ;
 *  2. `readStateJson()` lève `StorageCorruptError` quand le fichier EXISTE mais
 *     n'est pas lisible : plus aucun chemin ne peut repartir d'un défaut puis
 *     écraser un fichier qu'on n'a pas su lire.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "fs";

/**
 * Un fichier d'état existe mais son contenu est inexploitable.
 *
 * `status`/`code` sont portés par l'erreur elle-même pour que la couche HTTP
 * réponde 503 `STORAGE_CORRUPT` sans avoir à connaître chaque type de store.
 */
export class StorageCorruptError extends Error {
  readonly status = 503;
  readonly code = "STORAGE_CORRUPT";

  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {
    super(
      `State file "${filePath}" exists but could not be read (${reason}). ` +
        `Refusing to start from an empty/default state: saving now would overwrite ` +
        `data that may still be recoverable. Repair the file (or restore ` +
        `"${filePath}.bak") and restart.`,
    );
    this.name = "StorageCorruptError";
  }
}

/**
 * Écrit un fichier de façon ATOMIQUE : contenu complet dans un fichier
 * temporaire du même dossier, puis `rename()` — jamais d'écriture partielle sur
 * le fichier final.
 *
 * @param opts.mode   permissions du fichier final (ex. 0o600 pour un secret).
 */
export function writeFileAtomicSync(
  filePath: string,
  content: string,
  opts: { mode?: number } = {},
): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, opts.mode !== undefined ? { mode: opts.mode } : undefined);
    renameSync(tmp, filePath);
  } catch (e) {
    // Ne jamais laisser un temporaire (potentiellement porteur de secrets).
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
}

/**
 * Lit un fichier d'état JSON.
 *
 * @returns `null` si le fichier n'existe pas (premier démarrage : le défaut est
 *          légitime). Lève `StorageCorruptError` si le fichier existe mais que
 *          la lecture ou le parse échoue — le défaut est alors INTERDIT.
 */
export function readStateJson(filePath: string): unknown | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw new StorageCorruptError(filePath, e?.message || String(e));
  }
  // Fichier vide : illisible, pas « absent » (une troncature à 0 octet est
  // exactement le cas qu'on veut signaler au lieu de l'écraser).
  try {
    return JSON.parse(raw);
  } catch (e: any) {
    throw new StorageCorruptError(filePath, e?.message || String(e));
  }
}
