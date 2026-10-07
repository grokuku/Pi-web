/**
 * skills-seed.ts — installation au démarrage des skills maison LIVRÉES avec
 * Pi-Web.
 *
 * Où vivent les fiches livrées : `<racine du dépôt>/skills/<nom>/SKILL.md`
 * (versionnées avec le code, donc présentes sur toute installation neuve —
 * cf. `skills/` et la copie Docker dans Dockerfile).
 *
 * Où elles sont installées : `<agentDir>/skills/` — le dossier des skills
 * globales de l'agent Pi (agentDir = `~/.pi/agent`, même résolution que
 * PI_AGENT_DIR de session.ts), scanné par le SDK et par l'UI Paramètres →
 * « Extensions & Skills ».
 *
 * Règle de seed (motif existant du projet — cf. entrypoint.sh qui crée
 * settings.json « s'il est absent » et n'écrit que si le contenu change, et
 * seedSettingsFile() de Yuki qui « ne remplace JAMAIS un fichier existant ») :
 * SEED SEULEMENT SI ABSENT. Une skill déjà présente n'est jamais relue ni
 * réécrite — l'utilisateur peut personnaliser sa copie locale sans craindre
 * qu'un redémarrage la lui reprenne. Conséquences volontaires de cette
 * itération « seed-only » :
 *   - la copie locale ne reçoit PAS les évolutions de la fiche livrée : pour
 *     repartir de la version d'origine, supprimer `<agentDir>/skills/<nom>`
 *     puis redémarrer le backend (elle sera re-semée) ;
 *   - une skill supprimée volontairement revient au prochain démarrage (le seed
 *     ne peut pas distinguer « jamais installée » de « désinstallée »).
 * Un fichier d'état à empreinte (hash) a été écarté pour cette itération : il
 * faudrait détecter « copie locale intacte » avant d'autoriser une réécriture,
 * au prix d'un registre supplémentaire en écriture ET d'un risque d'écrasement
 * silencieux ; la sûreté maximale est préférée (ne jamais écrire sur l'existant).
 *
 * Idempotent : un 2e passage ne copie rien (`copied: []`). Best-effort : un échec
 * (lecture de la cible, copie) n'interrompt jamais le démarrage du backend —
 * l'appelant journalise le résumé (`copied` / `skipped` / `failed`).
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// ── Chemins ─────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Racine du dépôt Pi-Web. Le module vit dans `backend/src/pi/` (dev) et dans
 * `backend/dist/pi/` après compilation (production) : trois niveaux au-dessus
 * dans les deux cas — `/app` dans l'image Docker, la racine du dépôt sinon.
 */
export const REPO_ROOT = path.join(__dirname, "..", "..", "..");

/** Dossier des skills maison livrées, versionné avec le code. */
export const BUNDLED_SKILLS_DIR = path.join(REPO_ROOT, "skills");

/**
 * Dossier des skills globales de l'agent Pi — cible du seed.
 * Même résolution que `PI_AGENT_DIR` de session.ts : `~/.pi/agent/skills`.
 */
export function defaultAgentSkillsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "skills");
}

// ── Types ───────────────────────────────────────────────

export interface SkillsSeedOptions {
  /** Dossier des skills livrées (défaut : BUNDLED_SKILLS_DIR). */
  sourceDir?: string;
  /** Dossier cible du seed (défaut : defaultAgentSkillsDir()). */
  targetDir?: string;
}

export interface SkillsSeedResult {
  sourceDir: string;
  targetDir: string;
  /** Skills copiées pendant ce passage (dossier absent côté cible). */
  copied: string[];
  /** Skills livrées déjà présentes côté cible — JAMAIS réécrites. */
  skipped: string[];
  /** Skills non installables (lecture/copie en échec) — à signaler. */
  failed: string[];
}

// ── Sélection (pure) ────────────────────────────────────

/**
 * Liste les noms des skills livrées : sous-dossiers de `sourceDir` contenant
 * un `SKILL.md` (format Agent Skills). Les entrées cachées (`.git`…) et les
 * dossiers sans fiche sont ignorés ; source absente → liste vide.
 */
export function listBundledSkills(sourceDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    // Dossier absent (packaging incomplet, ancien checkout) : rien à semer.
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!existsSync(path.join(sourceDir, entry.name, "SKILL.md"))) continue;
    names.push(entry.name);
  }
  return names.sort();
}

/**
 * Décision pure du seed : les skills livrées à copier = celles qui ne sont
 * PAS déjà présentes dans la cible (un nom existant — fichier ou dossier —
 * compte comme présent : on ne touche jamais à l'existant).
 */
export function selectSkillsToSeed(
  bundled: readonly string[],
  existing: readonly string[],
): string[] {
  const present = new Set(existing);
  return bundled.filter((name) => !present.has(name));
}

// ── Seed (I/O) ──────────────────────────────────────────

/**
 * Installe dans `targetDir` les skills livrées qui y sont absentes, copiées
 * telles quelles depuis `sourceDir`. Ne réécrit JAMAIS une entrée existante.
 * Peut être appelée à chaque démarrage : le 2e passage ne copie rien.
 */
export function seedBundledSkills(opts: SkillsSeedOptions = {}): SkillsSeedResult {
  const sourceDir = opts.sourceDir ?? BUNDLED_SKILLS_DIR;
  const targetDir = opts.targetDir ?? defaultAgentSkillsDir();
  const result: SkillsSeedResult = { sourceDir, targetDir, copied: [], skipped: [], failed: [] };

  const bundled = listBundledSkills(sourceDir);
  if (bundled.length === 0) return result;

  // Fichiers ET dossiers de la cible comptent comme « présents ».
  let existing: string[];
  try {
    existing = existsSync(targetDir) ? readdirSync(targetDir) : [];
  } catch {
    // Cible illisible : impossible de garantir « ne rien écraser » → on ne
    // touche à rien et on le signale à l'appelant.
    result.failed.push(...bundled);
    return result;
  }

  const toSeed = selectSkillsToSeed(bundled, existing);
  result.skipped.push(...bundled.filter((name) => !toSeed.includes(name)));
  if (toSeed.length === 0) return result;

  try {
    mkdirSync(targetDir, { recursive: true });
  } catch {
    result.failed.push(...toSeed);
    return result;
  }

  for (const name of toSeed) {
    const from = path.join(sourceDir, name);
    const to = path.join(targetDir, name);
    try {
      // Re-vérification juste avant copie (ceinture et bretelles : l'entrée a
      // pu apparaître entre le scan et la copie).
      if (existsSync(to)) {
        result.skipped.push(name);
        continue;
      }
      cpSync(from, to, { recursive: true });
      result.copied.push(name);
    } catch {
      result.failed.push(name);
    }
  }
  return result;
}
