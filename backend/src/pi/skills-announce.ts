/**
 * skills-announce.ts — annonce des SKILLS (standard Agent Skills) aux
 * sous-agents du mode HARNESS/ROUTING.
 *
 * Problème : le SDK Pi n'ajoute la section `<available_skills>` au prompt
 * système QUE si l'agent possède l'outil `read` ou `bash`
 * (dist/core/system-prompt.js l.99-103). En mode HARNESS, le prompt des
 * sous-agents est ENTIÈREMENT remplacé par le prompt maison (rôle + carte du
 * repo + carnet) → les skills, pourtant chargées par le DefaultResourceLoader,
 * n'apparaissent nulle part et restent donc inexploitables.
 *
 * Ce module est PUR (aucun I/O, aucun accès au loader) : il reçoit la liste des
 * skills ACTIVES d'un `DefaultResourceLoader` (`resourceLoader.getSkills()` —
 * source de vérité : emplacements global/projet/.agents, packages, motifs
 * d'activation/désactivation de settings.json) et rend un bloc concis « nom +
 * description + chemin ». Le sous-agent lit la fiche SKILL.md lui-même quand la
 * tâche correspond. Zéro skill annonçable → "" : aucune section vide n'est
 * injectée dans le prompt.
 *
 * Le corps `<available_skills>` est rendu par `formatSkillsForPrompt` du SDK
 * (format standard compris par les modèles, échappement XML, exclusion des
 * skills `disable-model-invocation: true`) ; ce module n'ajoute que l'en-tête
 * français, le plafond de sécurité et les marqueurs de bloc.
 *
 * Respect de l'UI Pi-Web : la liste vient du chargement SDK, donc un motif
 * d'exclusion `!<nom>` écrit dans settings.json par POST /api/pi/toggle
 * (voir `updateSkillSettingsList`) retire réellement la skill de l'annonce.
 */

import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

// ── Constantes ──────────────────────────────────────────

/** Marqueur de début du bloc injecté dans le prompt système du sous-agent. */
export const SKILLS_MARKER_START = "<!-- PI_SKILLS -->";
/** Marqueur de fin du bloc injecté dans le prompt système du sous-agent. */
export const SKILLS_MARKER_END = "<!-- /PI_SKILLS -->";
/** Plafond de sécurité du nombre de skills annoncées (les suivantes sont comptées, pas détaillées). */
export const SKILLS_MAX = 32;

/** En-tête français du bloc (le SDK fournit le corps `<available_skills>`). */
const SKILLS_TITLE = "## Skills disponibles (Agent Skills)";
/** Consigne opérationnelle concise, cohérente avec le reste du prompt sous-agent. */
const SKILLS_INTRO =
  "Lis la fiche (`read` sur le chemin indiqué) UNIQUEMENT si la tâche correspond à sa description ; sinon, ignore-la.";

// ── Types ───────────────────────────────────────────────

/**
 * Sous-ensemble structurel d'une `Skill` du SDK : seuls les champs réellement
 * lus par `formatSkillsForPrompt` (vérifié dans dist/core/skills.js). Le loader
 * fournit des `Skill` complètes, qui satisfont ce type.
 */
export interface AnnounceableSkill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

// ── Sélection (pure) ────────────────────────────────────

/**
 * Collecte les skills annonçables : champs requis non vides, description
 * normalisée sur une ligne, dédoublonnées par nom, et `disable-model-invocation`
 * respecté (même règle que le SDK : ces skills ne sont chargeables que via
 * `/skill:name`, commande utilisateur indisponible au sous-agent).
 */
export function collectAnnounceableSkills(
  skills: readonly AnnounceableSkill[] | null | undefined,
): AnnounceableSkill[] {
  if (!Array.isArray(skills)) return [];
  const out: AnnounceableSkill[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue;
    if (typeof skill.name !== "string" || typeof skill.description !== "string" || typeof skill.filePath !== "string") {
      continue;
    }
    const name = skill.name.trim();
    const description = skill.description.replace(/\s+/g, " ").trim();
    const filePath = skill.filePath.trim();
    if (!name || !description || !filePath) continue;
    if (skill.disableModelInvocation === true) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description, filePath });
  }
  return out;
}

// ── Rendu (pure) ────────────────────────────────────────

/**
 * Rend le contenu du bloc d'annonce (sans marqueurs) : en-tête français +
 * section `<available_skills>` standard du SDK. Retourne "" si aucune skill
 * n'est annonçable (cas zéro skill) — l'appelant n'injecte alors rien.
 */
export function buildSkillsAnnouncement(
  skills: readonly AnnounceableSkill[] | null | undefined,
): string {
  const valid = collectAnnounceableSkills(skills);
  if (valid.length === 0) return "";

  const shown = valid.slice(0, SKILLS_MAX);
  const dropped = valid.length - shown.length;
  // Le type SDK exige des `Skill` complètes (baseDir/sourceInfo) ; l'implémentation
  // ne lit que name/description/filePath/disableModelInvocation — vérifié dans
  // dist/core/skills.js (formatSkillsForPrompt).
  const sdkBlock = formatSkillsForPrompt(shown as unknown as Skill[], "read").trim();
  if (!sdkBlock) return "";

  const lines = [SKILLS_TITLE, SKILLS_INTRO];
  if (dropped > 0) {
    lines.push(`(${dropped} autre(s) skill(s) non annoncée(s) — plafond : ${SKILLS_MAX}.)`);
  }
  lines.push("", sdkBlock);
  return lines.join("\n");
}

/**
 * Rend le bloc COMPLET (marqueurs compris), prêt à concaténer au prompt système
 * du sous-agent. "" si aucune skill annonçable (le prompt reste inchangé).
 */
export function renderSkillsBlock(
  skills: readonly AnnounceableSkill[] | null | undefined,
): string {
  const body = buildSkillsAnnouncement(skills);
  if (!body) return "";
  return `\n\n${SKILLS_MARKER_START}\n${body}\n${SKILLS_MARKER_END}`;
}

// ── État activé/désactivé (UI Pi-Web) ───────────────────

/** Une entrée est un chemin de fichier/dossier (et non un nom nu de skill). */
export function isSkillPathSource(source: string): boolean {
  return (
    source.startsWith("/") ||
    source.startsWith("~") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.includes("/")
  );
}

/**
 * Calcule la nouvelle liste `settings.skills` après un toggle UI.
 *
 * Sémantique SDK (docs settings.md « Resources ») : les skills AUTO-DÉCOUVERTES
 * (dossiers `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/`…) sont
 * actives par défaut ; la liste `settings.skills` ajoute des fichiers/dossiers
 * et accepte des motifs d'exclusion (`!pattern`, `-path`). Un nom NU ajouté à
 * la liste ne désactive donc RIEN : pour désactiver, il faut écrire `!<nom>`.
 *
 *  - nom nu (skill auto-découverte) : activer → entrée nue ; désactiver →
 *    motif d'exclusion `!<nom>` (compris par le SDK, donc retiré de l'annonce) ;
 *  - chemin (fichier/dossier de skill) : comportement historique add/remove
 *    (le chemin n'est chargé QUE via cette entrée).
 *
 * Pure et idempotente : ré-appliquer le même toggle ne duplique pas d'entrée.
 */
export function updateSkillSettingsList(
  list: readonly string[],
  source: string,
  enabled: boolean,
): string[] {
  const raw = String(source ?? "").trim();
  const base = Array.isArray(list) ? [...list] : [];
  if (!raw) return base;
  // Normalise une éventuelle entrée déjà préfixée (re-clic depuis l'UI).
  const bare = raw.startsWith("!") || raw.startsWith("-") ? raw.slice(1).trim() : raw;
  if (!bare) return base;
  const withoutToggles = base.filter((entry) => entry !== bare && entry !== `!${bare}` && entry !== `-${bare}`);

  if (isSkillPathSource(bare)) {
    if (enabled) withoutToggles.push(bare);
    return withoutToggles;
  }
  // Nom nu : le SDK active par défaut → l'activer consiste à ne PAS l'exclure.
  withoutToggles.push(enabled ? bare : `!${bare}`);
  return withoutToggles;
}
