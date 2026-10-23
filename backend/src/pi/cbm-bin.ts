/**
 * backend/src/pi/cbm-bin.ts
 *
 * SOURCE DE VÉRITÉ UNIQUE du chemin du binaire `codebase-memory-mcp`.
 *
 * Le binaire est DÉSORMAIS EMBARQUÉ DANS L'IMAGE Docker (voir `Dockerfile`,
 * étape `runtime` : téléchargement de la release épinglée + vérification
 * sha256, extraction dans /opt/cbm/bin). Il n'est plus installé au démarrage
 * du conteneur : une mise à jour de CBM = une nouvelle image.
 *
 * Pourquoi /opt/cbm/bin et PAS /app/.data/bin (ancien emplacement) :
 * docker-compose.yml monte le volume `pi-appdata:/app/.data`. Tout ce qui est
 * écrit dans l'image sous /app/.data est DONC MASQUÉ par le volume au
 * démarrage — un binaire livré là serait invisible. /opt/cbm/bin est hors
 * volume : il vient toujours de l'image.
 *
 * Trois modules lisent ce chemin (extension codebase-memory, client MCP stdio,
 * route /api/cbm/*) : ils importent TOUS cette constante, jamais un littéral.
 *
 * Résolution, dans l'ordre :
 *   1. `CBM_BIN_PATH` (surcharge explicite : compose, entrée du conteneur) ;
 *   2. le chemin livré par l'image, s'il existe ;
 *   3. le repli historique `~/.local/bin` (poste de dev hors conteneur) ;
 *   4. le chemin de l'image (valeur par défaut : les messages d'erreur citent
 *      alors l'emplacement attendu, pas un chemin fantôme).
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Emplacement livré par l'image (hors volume — voir Dockerfile). */
export const CBM_BIN_IMAGE_PATH = "/opt/cbm/bin/codebase-memory-mcp";

/** Repli historique : installation manuelle / poste de dev hors conteneur. */
export const CBM_BIN_LEGACY_PATH = join(homedir(), ".local", "bin", "codebase-memory-mcp");

function resolveCbmBinPath(): string {
  const fromEnv = process.env.CBM_BIN_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(CBM_BIN_IMAGE_PATH)) return CBM_BIN_IMAGE_PATH;
  if (existsSync(CBM_BIN_LEGACY_PATH)) return CBM_BIN_LEGACY_PATH;
  return CBM_BIN_IMAGE_PATH;
}

/** Chemin effectif du binaire, résolu une fois au chargement du module. */
export const CBM_BIN_PATH: string = resolveCbmBinPath();
