/**
 * skills-store.ts — lecture/écriture des skills installées (standard Agent
 * Skills : un dossier + une fiche `SKILL.md`), pour le panneau SKILLS de Pi-Web.
 *
 * Sources de vérité :
 *   - COPIE INSTALLÉE : `<agentDir>/skills/<nom>/SKILL.md` — c'est elle que
 *     l'agent lit (agentDir = `~/.pi/agent`, même résolution que skills-seed.ts).
 *   - VERSION LIVRÉE (référence) : `<racine Pi-Web>/skills/<nom>/` — semée au
 *     démarrage (seed-only, cf. skills-seed.ts) et jamais réécrite.
 *   - ÉCOSYSTÈME (référence, non livrée) : racines hors dépôt (par défaut
 *     `/projects/holaf-lib/skills`, surchargeable via
 *     `PI_WEB_ECOSYSTEM_SKILLS_DIRS`, séparateur de chemins du système).
 *   - GÉNÉRÉE : écrite par un outil externe (binaire CBM) et RÉÉCRITE à chaque
 *     mise à jour → `codebase-memory` est verrouillée (jamais éditable via l'UI,
 *     sous peine de perdre les modifications à la prochaine mise à jour de CBM).
 *
 * Concepts UI :
 *   - statut : `bundled` (livrée) | `ecosystem` | `generated` | `custom` ;
 *   - `modified` : la copie locale diffère de sa RÉFÉRENCE (comparaison par
 *     empreinte sha256 de l'arbre du dossier, pas seulement de SKILL.md) —
 *     permet de proposer « restaurer la version livrée » ;
 *   - `enabled` : dérivé de `settings.skills` (le nom nu désigne une skill
 *     auto-découverte ; la désactivation écrit un motif `!<nom>`, exactement le
 *     mécanisme de POST /api/pi/toggle — ne pas en inventer un autre).
 *
 * SÉCURITÉ (routes) :
 *   - nom validé selon les règles du spec Agent Skills (minuscules a-z, chiffres,
 *     tirets, ≤ 64 caractères, pas de tiret en début/fin ni de « -- ») : aucun
 *     séparateur de chemin possible (`/`, `..`, `.` sont rejetés) ;
 *   - confinement : tout chemin manipulé est construit comme
 *     `skillsDir/<nom>` APRÈS validation, et re-vérifié par un préfixe résolu
 *     (ceinture et bretelles) ;
 *   - écritures ATOMIQUES (fichier temporaire + rename, motif cbm-stats.ts) pour
 *     ne jamais laisser un SKILL.md tronqué en cas d'interruption.
 *
 * Le module est testable : toutes les racines sont injectables
 * (`SkillsStoreOptions`), les défauts visent l'installation réelle.
 */

import { createHash } from "crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { BUNDLED_SKILLS_DIR, listBundledSkills } from "./skills-seed.js";

// ── Constantes ──────────────────────────────────────────

/** Longueur maximale du nom d'une skill (spec Agent Skills). */
export const SKILL_NAME_MAX = 64;
/** Longueur maximale de la description (spec Agent Skills). */
export const SKILL_DESCRIPTION_MAX = 1024;
/** Taille maximale d'une fiche éditée via l'UI (garde-fou anti-abus). */
export const SKILL_CONTENT_MAX = 128 * 1024;

/**
 * Skills GÉNÉRÉES par un outil externe : réécrites à chaque mise à jour →
 * VERROUILLÉES dans l'UI. Le binaire codebase-memory-mcp écrit
 * `~/.pi/agent/skills/codebase-memory/SKILL.md` à chaque install/update ;
 * liste extensible si un autre outil génère une skill à l'avenir.
 */
export const GENERATED_SKILL_NAMES: readonly string[] = ["codebase-memory"];

/** Racine d'écosystème de référence (holaf-lib) — non livrée avec Pi-Web. */
export const DEFAULT_ECOSYSTEM_SKILLS_DIR = path.join("/projects", "holaf-lib", "skills");

// ── Types ───────────────────────────────────────────────

export type SkillStatus = "bundled" | "ecosystem" | "generated" | "custom";

/** Référence de comparaison/restauration d'une skill. */
export interface SkillReference {
  kind: "bundled" | "ecosystem";
  /** Dossier de référence (contient SKILL.md). */
  dir: string;
}

export interface SkillEntry {
  name: string;
  /** Description du front-matter, normalisée sur une ligne (peut être vide). */
  description: string;
  status: SkillStatus;
  /** false uniquement pour les skills générées (réécrites par un outil). */
  editable: boolean;
  /** La copie locale diffère de sa référence (bundled/ecosystem seulement). */
  modified: boolean;
  /** Référence connue, ou null (custom/generated) — sert à « restaurer ». */
  reference: SkillReference | null;
  /** Dossier installé `<skillsDir>/<nom>`. */
  dir: string;
  /** Fiche `SKILL.md`. */
  file: string;
  /** Renseigné si la fiche est illisible ou son front-matter invalide. */
  invalid?: string;
}

export interface SkillsStoreOptions {
  /** Dossier des skills installées (défaut : `<agentDir>/skills`). */
  skillsDir?: string;
  /** Dossier des skills livrées (défaut : `<racine Pi-Web>/skills`). */
  bundledDir?: string;
  /** Racines d'écosystème à chercher (défaut : env puis holaf-lib). */
  ecosystemDirs?: readonly string[];
}

export type SkillErrorCode =
  | "invalid-name"
  | "invalid-content"
  | "not-found"
  | "generated"
  | "no-reference"
  | "already-exists"
  | "io-error";

export type SkillResult<T> = { ok: true; value: T } | { ok: false; code: SkillErrorCode; error: string };

// ── Chemins (défauts) ───────────────────────────────────

/** Dossier des skills globales de l'agent Pi (`~/.pi/agent/skills`). */
export function defaultAgentSkillsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "skills");
}

/** Racines d'écosystème : env `PI_WEB_ECOSYSTEM_SKILLS_DIRS` sinon holaf-lib. */
export function defaultEcosystemSkillDirs(): string[] {
  const fromEnv = process.env.PI_WEB_ECOSYSTEM_SKILLS_DIRS;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [DEFAULT_ECOSYSTEM_SKILLS_DIR];
}

function resolveOptions(opts: SkillsStoreOptions = {}): Required<SkillsStoreOptions> {
  return {
    skillsDir: opts.skillsDir ?? defaultAgentSkillsDir(),
    bundledDir: opts.bundledDir ?? BUNDLED_SKILLS_DIR,
    ecosystemDirs: opts.ecosystemDirs ?? defaultEcosystemSkillDirs(),
  };
}

// ── Validation (pure) ───────────────────────────────────

/**
 * Valide un nom de skill selon le spec Agent Skills (mêmes règles que le SDK :
 * `validateName` de dist/core/skills.js). Aucune traversée de chemin n'est
 * possible : l'ensemble des caractères autorisés exclut `/`, `.` et `\`.
 */
export function validateSkillName(name: unknown): SkillResult<string> {
  const raw = typeof name === "string" ? name.trim() : "";
  if (!raw) return { ok: false, code: "invalid-name", error: "nom requis" };
  if (raw.length > SKILL_NAME_MAX) {
    return { ok: false, code: "invalid-name", error: `nom trop long (maximum ${SKILL_NAME_MAX} caractères)` };
  }
  if (!/^[a-z0-9-]+$/.test(raw)) {
    return {
      ok: false,
      code: "invalid-name",
      error: "nom invalide : minuscules a-z, chiffres et tirets uniquement (pas de chemin)",
    };
  }
  if (raw.startsWith("-") || raw.endsWith("-")) {
    return { ok: false, code: "invalid-name", error: "le nom ne peut pas commencer ni finir par un tiret" };
  }
  if (raw.includes("--")) {
    return { ok: false, code: "invalid-name", error: "le nom ne peut pas contenir deux tirets consécutifs" };
  }
  return { ok: true, value: raw };
}

/**
 * Confinement (ceinture et bretelles) : résout `candidate` et exige qu'il soit
 * strictement sous `root`. Ne remplace PAS la validation du nom (qui, elle,
 * interdit déjà tout séparateur) — utile si un chemin vient d'ailleurs.
 */
export function isInsideDir(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

/**
 * État activé/désactivé d'une skill d'après `settings.skills`.
 * Un nom nu (ou absent) = auto-découverte ACTIVÉE ; un motif `!<nom>` (ou
 * `-<nom>`) = désactivée (sémantique du SDK, cf. updateSkillSettingsList).
 */
export function isSkillEnabled(settingsSkills: readonly string[] | undefined | null, name: string): boolean {
  const list = Array.isArray(settingsSkills) ? settingsSkills : [];
  return !list.some((entry) => entry === `!${name}` || entry === `-${name}`);
}

// ── Front-matter (parse minimal, sans dépendance YAML) ──

export interface ParsedSkillFrontMatter {
  name: string;
  description: string;
  /** Présence d'un bloc front-matter délimité par `---`. */
  hasFrontMatter: boolean;
}

/** Retire les guillemets YAML d'une valeur simple (double ou simple). */
function unquoteYamlValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Parse le front-matter d'une fiche SKILL.md : seuls `name` et `description`
 * sont exploités (suffisant pour l'UI), avec support des valeurs simples
 * (guillemets) et des scalaires de bloc `|` / `>` (descriptions multilignes).
 * Parseur volontairement minimal — pas de dépendance YAML côté backend ; le
 * SDK, lui, parse le YAML complet pour charger la skill.
 */
export function parseSkillFrontMatter(content: string): ParsedSkillFrontMatter {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) {
    return { name: "", description: "", hasFrontMatter: false };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    return { name: "", description: "", hasFrontMatter: false };
  }
  const block = normalized.slice(normalized.indexOf("\n") + 1, end);
  const lines = block.split("\n");
  const values: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const inline = match[2].trim();
    if (inline === "|" || inline === ">") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      values[key] = inline === ">" ? parts.join(" ") : parts.join("\n");
    } else {
      values[key] = unquoteYamlValue(inline);
    }
  }
  return {
    name: (values.name ?? "").trim(),
    description: (values.description ?? "").trim(),
    hasFrontMatter: true,
  };
}

// ── Empreinte d'arbre (détection « modifiée ») ──────────

/**
 * Empreinte sha256 stable d'un dossier de skill : liste triée des entrées
 * (chemins relatifs posix) + contenu des fichiers (+ cible des liens). Deux
 * dossiers équivalents produisent la même empreinte ; null si illisible.
 */
export function hashSkillDir(dir: string): string | null {
  try {
    if (!statSync(dir).isDirectory()) return null;
    const hash = createHash("sha256");
    const walk = (rel: string, depth: number): void => {
      // Garde-fou : une skill ne devrait jamais être un arbre profond.
      if (depth > 12) return;
      const abs = rel ? path.join(dir, rel) : dir;
      const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const full = path.join(dir, relPath);
        if (entry.isDirectory()) {
          hash.update(`D:${relPath}\n`);
          walk(relPath, depth + 1);
        } else if (entry.isSymbolicLink()) {
          hash.update(`L:${relPath}:${readlinkSync(full)}\n`);
        } else if (entry.isFile()) {
          hash.update(`F:${relPath}\n`);
          hash.update(readFileSync(full));
        }
      }
    };
    walk("", 0);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

// ── Références ──────────────────────────────────────────

/**
 * Référence d'une skill : livrée (dépôt Pi-Web) sinon première racine
 * d'écosystème contenant un dossier `<nom>/SKILL.md`. null sinon.
 */
export function findSkillReference(name: string, opts: SkillsStoreOptions = {}): SkillReference | null {
  const { bundledDir, ecosystemDirs } = resolveOptions(opts);
  if (listBundledSkills(bundledDir).includes(name)) {
    return { kind: "bundled", dir: path.join(bundledDir, name) };
  }
  for (const root of ecosystemDirs) {
    const dir = path.join(root, name);
    if (existsSync(path.join(dir, "SKILL.md"))) {
      return { kind: "ecosystem", dir };
    }
  }
  return null;
}

function isGeneratedSkill(name: string): boolean {
  return GENERATED_SKILL_NAMES.includes(name);
}

/** Statut d'une skill d'après sa référence + la liste des générées. */
export function skillStatus(name: string, reference: SkillReference | null): SkillStatus {
  if (reference?.kind === "bundled") return "bundled";
  if (isGeneratedSkill(name)) return "generated";
  if (reference?.kind === "ecosystem") return "ecosystem";
  return "custom";
}

// ── Lecture ─────────────────────────────────────────────

/** Lit une fiche et construit son entrée UI (sans état activé — voir isSkillEnabled). */
function readEntry(name: string, dir: string, reference: SkillReference | null): SkillEntry {
  const file = path.join(dir, "SKILL.md");
  const status = skillStatus(name, reference);
  const entry: SkillEntry = {
    name,
    description: "",
    status,
    editable: status !== "generated",
    modified: false,
    reference,
    dir,
    file,
  };
  try {
    const content = readFileSync(file, "utf-8");
    const fm = parseSkillFrontMatter(content);
    entry.description = fm.description.replace(/\s+/g, " ").trim();
    if (!fm.hasFrontMatter) {
      entry.invalid = "front-matter YAML absent (la fiche doit commencer par « --- »)";
    } else if (!fm.name) {
      entry.invalid = "front-matter sans « name »";
    } else if (!fm.description) {
      entry.invalid = "front-matter sans « description »";
    }
  } catch (e: any) {
    entry.invalid = `fiche illisible : ${e?.message ?? "erreur inconnue"}`;
  }
  if (reference) {
    const referenceHash = hashSkillDir(reference.dir);
    const localHash = hashSkillDir(dir);
    entry.modified = referenceHash !== null && localHash !== null && referenceHash !== localHash;
  }
  return entry;
}

/**
 * Liste les skills installées : sous-dossiers de `skillsDir` contenant un
 * `SKILL.md` (format Agent Skills), triés par nom. Les dossiers sans fiche et
 * les entrées cachées sont ignorés (comme le seed).
 */
export function listSkills(opts: SkillsStoreOptions = {}): SkillEntry[] {
  const { skillsDir, bundledDir, ecosystemDirs } = resolveOptions(opts);
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return []; // dossier absent (installation neuve) : aucune skill installée
  }
  const bundled = new Set(listBundledSkills(bundledDir));
  const out: SkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    // Noms hors spec ignorés : couvre les dossiers temporaires de restauration
    // (`<nom>.restore-<pid>`), les résidus et toute entrée non gérable.
    if (!validateSkillName(entry.name).ok) continue;
    const dir = path.join(skillsDir, entry.name);
    if (!existsSync(path.join(dir, "SKILL.md"))) continue;
    let reference: SkillReference | null = null;
    if (bundled.has(entry.name)) {
      reference = { kind: "bundled", dir: path.join(bundledDir, entry.name) };
    } else {
      for (const root of ecosystemDirs) {
        if (existsSync(path.join(root, entry.name, "SKILL.md"))) {
          reference = { kind: "ecosystem", dir: path.join(root, entry.name) };
          break;
        }
      }
    }
    out.push(readEntry(entry.name, dir, reference));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Détail d'une skill : entrée + contenu de la fiche + contenu de référence. */
export interface SkillDetail {
  entry: SkillEntry;
  content: string;
  /** Contenu de la fiche de référence (livrée/écosystème), null sinon. */
  referenceContent: string | null;
}

/** Lit le détail d'une skill installée. */
export function readSkill(name: unknown, opts: SkillsStoreOptions = {}): SkillResult<SkillDetail> {
  const valid = validateSkillName(name);
  if (!valid.ok) return valid;
  const { skillsDir, bundledDir, ecosystemDirs } = resolveOptions(opts);
  const dir = path.join(skillsDir, valid.value);
  if (!isInsideDir(skillsDir, dir) || !existsSync(path.join(dir, "SKILL.md"))) {
    return { ok: false, code: "not-found", error: `skill « ${valid.value} » introuvable` };
  }
  const bundled = new Set(listBundledSkills(bundledDir));
  let reference: SkillReference | null = null;
  if (bundled.has(valid.value)) {
    reference = { kind: "bundled", dir: path.join(bundledDir, valid.value) };
  } else {
    for (const root of ecosystemDirs) {
      if (existsSync(path.join(root, valid.value, "SKILL.md"))) {
        reference = { kind: "ecosystem", dir: path.join(root, valid.value) };
        break;
      }
    }
  }
  const entry = readEntry(valid.value, dir, reference);
  let content = "";
  try {
    content = readFileSync(entry.file, "utf-8");
  } catch (e: any) {
    return { ok: false, code: "io-error", error: `lecture impossible : ${e?.message ?? "erreur inconnue"}` };
  }
  let referenceContent: string | null = null;
  if (reference) {
    try {
      referenceContent = readFileSync(path.join(reference.dir, "SKILL.md"), "utf-8");
    } catch {
      referenceContent = null;
    }
  }
  return { ok: true, value: { entry, content, referenceContent } };
}

// ── Écriture ────────────────────────────────────────────

/** Écrit un fichier de façon atomique (fichier temporaire + rename). */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, file);
}

/**
 * Écrit la fiche d'une skill existante.
 * Refus explicites : nom invalide, skill générée (verrouillée), contenu hors
 * limites, front-matter invalide ou dont le `name` ne correspond pas au dossier
 * (sinon le SDK chargerait la skill sous un autre nom), skill inexistante.
 */
export function writeSkill(
  name: unknown,
  content: unknown,
  opts: SkillsStoreOptions = {},
): SkillResult<SkillDetail> {
  const valid = validateSkillName(name);
  if (!valid.ok) return valid;
  const { skillsDir, bundledDir, ecosystemDirs } = resolveOptions(opts);
  const dir = path.join(skillsDir, valid.value);
  if (!isInsideDir(skillsDir, dir)) {
    return { ok: false, code: "invalid-name", error: "chemin hors du dossier des skills" };
  }
  if (isGeneratedSkill(valid.value)) {
    return {
      ok: false,
      code: "generated",
      error: `« ${valid.value} » est générée par l'outil CBM et réécrite à chaque mise à jour — édition interdite`,
    };
  }
  if (!existsSync(path.join(dir, "SKILL.md"))) {
    return { ok: false, code: "not-found", error: `skill « ${valid.value} » introuvable` };
  }
  if (typeof content !== "string") {
    return { ok: false, code: "invalid-content", error: "contenu manquant (chaîne attendue)" };
  }
  if (Buffer.byteLength(content, "utf-8") > SKILL_CONTENT_MAX) {
    return {
      ok: false,
      code: "invalid-content",
      error: `fiche trop volumineuse (maximum ${Math.floor(SKILL_CONTENT_MAX / 1024)} Ko)`,
    };
  }
  const fm = parseSkillFrontMatter(content);
  if (!fm.hasFrontMatter) {
    return { ok: false, code: "invalid-content", error: "front-matter YAML absent (la fiche doit commencer par « --- »)" };
  }
  if (!fm.name) {
    return { ok: false, code: "invalid-content", error: "front-matter sans « name »" };
  }
  if (fm.name !== valid.value) {
    return {
      ok: false,
      code: "invalid-content",
      error: `le « name » du front-matter (« ${fm.name} ») doit correspondre au nom du dossier (« ${valid.value} »)`,
    };
  }
  if (!fm.description) {
    return { ok: false, code: "invalid-content", error: "front-matter sans « description »" };
  }
  if (fm.description.length > SKILL_DESCRIPTION_MAX) {
    return {
      ok: false,
      code: "invalid-content",
      error: `description trop longue (maximum ${SKILL_DESCRIPTION_MAX} caractères)`,
    };
  }
  try {
    writeFileAtomic(path.join(dir, "SKILL.md"), content);
  } catch (e: any) {
    return { ok: false, code: "io-error", error: `écriture impossible : ${e?.message ?? "erreur inconnue"}` };
  }
  const res = readSkill(valid.value, { skillsDir, bundledDir, ecosystemDirs });
  return res.ok ? res : { ok: false, code: "io-error", error: "fiche écrite mais relecture impossible" };
}

/**
 * Restaure la copie locale depuis sa référence (livrée ou écosystème) : le
 * dossier local est REMPLACÉ par la référence (modifications locales perdues —
 * c'est le sens de « restaurer la version livrée »). Refusé sans référence
 * (custom/generated).
 */
export function restoreSkill(name: unknown, opts: SkillsStoreOptions = {}): SkillResult<SkillDetail> {
  const valid = validateSkillName(name);
  if (!valid.ok) return valid;
  const { skillsDir, bundledDir, ecosystemDirs } = resolveOptions(opts);
  const dir = path.join(skillsDir, valid.value);
  if (!isInsideDir(skillsDir, dir)) {
    return { ok: false, code: "invalid-name", error: "chemin hors du dossier des skills" };
  }
  const reference = findSkillReference(valid.value, { skillsDir, bundledDir, ecosystemDirs });
  if (!reference) {
    return {
      ok: false,
      code: "no-reference",
      error: `« ${valid.value} » n'a pas de version de référence à restaurer`,
    };
  }
  if (!existsSync(path.join(reference.dir, "SKILL.md"))) {
    return { ok: false, code: "io-error", error: "version de référence introuvable sur le disque" };
  }
  // Copie vers un dossier temporaire PUIS bascule : si la copie échoue, la copie
  // locale n'est pas touchée (pas de fenêtre où le dossier serait absent).
  const tmpDir = `${dir}.restore-${process.pid}`;
  try {
    mkdirSync(skillsDir, { recursive: true });
    rmSync(tmpDir, { recursive: true, force: true });
    cpSync(reference.dir, tmpDir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmpDir, dir);
  } catch (e: any) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* résidu éventuel ignoré par listSkills (nom hors spec) */
    }
    return { ok: false, code: "io-error", error: `restauration impossible : ${e?.message ?? "erreur inconnue"}` };
  }
  const res = readSkill(valid.value, { skillsDir, bundledDir, ecosystemDirs });
  return res.ok ? res : { ok: false, code: "io-error", error: "restauration effectuée mais relecture impossible" };
}

/** Rend la description sûre pour une valeur YAML entre guillemets doubles. */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim()}"`;
}

/**
 * Crée une nouvelle skill (`<skillsDir>/<nom>/SKILL.md`) avec un front-matter
 * minimal. Refusé si le nom est déjà pris (local OU version livrée), pour ne
 * jamais entrer en conflit avec le seed du démarrage.
 */
export function createSkill(
  name: unknown,
  description: unknown,
  opts: SkillsStoreOptions = {},
): SkillResult<SkillDetail> {
  const valid = validateSkillName(name);
  if (!valid.ok) return valid;
  const desc = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
  if (!desc) {
    return { ok: false, code: "invalid-content", error: "description requise" };
  }
  if (desc.length > SKILL_DESCRIPTION_MAX) {
    return {
      ok: false,
      code: "invalid-content",
      error: `description trop longue (maximum ${SKILL_DESCRIPTION_MAX} caractères)`,
    };
  }
  const { skillsDir, bundledDir, ecosystemDirs } = resolveOptions(opts);
  const dir = path.join(skillsDir, valid.value);
  if (!isInsideDir(skillsDir, dir)) {
    return { ok: false, code: "invalid-name", error: "chemin hors du dossier des skills" };
  }
  if (existsSync(dir) || listBundledSkills(bundledDir).includes(valid.value)) {
    return { ok: false, code: "already-exists", error: `« ${valid.value} » existe déjà` };
  }
  const content =
    `---\nname: ${valid.value}\ndescription: ${yamlQuote(desc)}\n---\n\n# ${valid.value}\n\n${desc}\n`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, "SKILL.md"), content);
  } catch (e: any) {
    // Pas de dossier orphelin si la fiche n'a pas pu être écrite.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    return { ok: false, code: "io-error", error: `création impossible : ${e?.message ?? "erreur inconnue"}` };
  }
  const res = readSkill(valid.value, { skillsDir, bundledDir, ecosystemDirs });
  return res.ok ? res : { ok: false, code: "io-error", error: "skill créée mais relecture impossible" };
}
