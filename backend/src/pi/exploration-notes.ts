/**
 * exploration-notes.ts — « Carnet d'exploration » (P2, étude tokens/contexte
 * des sous-agents : docs/etude-tokens-contexte-sous-agents.md).
 *
 * Problème : les découvertes d'un sous-agent (fait confirmé, piège rencontré,
 * décision actée) vivent dans sa fenêtre de contexte puis disparaissent à la
 * fin de la session. La session suivante — ou un autre sous-agent — re-paie la
 * même exploration. Le remède de l'état de l'art : écrire les découvertes dans
 * un stockage HORS REPO, dès qu'elles sont trouvées, et les relire au besoin.
 *
 * Stockage : `<racine>/.data/harness-notes/<projectId>/notes.jsonl`, JSONL
 * APPEND-ONLY (une ligne = une note). Le dossier est isolé du dépôt utilisateur
 * (jamais dans le cwd du projet) et indexé par projectId.
 *
 * Le rendu (digest) est PUR et BORNÉ (~2000 chars / 500 tokens) : boost des
 * notes citées par la tâche, dégradation ordonnée « complet → court → titres »,
 * troncature à la dernière ligne entière en dernier recours. Un projet sans
 * note rend une chaîne vide → l'appelant n'injecte rien.
 *
 * Cycle de vie : append atomique (appendFileSync), compaction PARESSEUSE au
 * moment d'écrire (TTL 90 j + plafond 300 notes, les plus récentes gagnent),
 * purge du dossier projet à la suppression du projet (projects/manager.ts).
 *
 * Toutes les fonctions d'E/S sont best-effort : elles ne jettent jamais vers
 * l'appelant (un carnet indisponible ne doit JAMAIS bloquer le spawn d'un
 * sous-agent ni la suppression d'un projet).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractTaskHints } from "./repo-map.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Convention DATA_DIR du backend (cf. utils/logger.ts, pi/harness-archive.ts) :
// <racine projet>/.data — 3 niveaux depuis pi/ (même profondeur en src/dev via
// tsx et en dist/prod via node : src/pi ≡ dist/pi).
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");

/** Racine du stockage des carnets (surchargeable via opts.dir pour les tests). */
export const NOTES_ROOT_DIR = path.join(DATA_DIR, "harness-notes");

// ── Constantes ──────────────────────────────────────────

/** Budget par défaut du digest injecté (~500 tokens ≈ 2000 chars). */
export const EXPLORATION_NOTES_BUDGET_CHARS = 2000;
/** Marqueur de début du bloc injecté dans le prompt système du sous-agent. */
export const EXPLORATION_NOTES_MARKER_START = "<!-- PI_EXPLORATION_NOTES -->";
/** Marqueur de fin du bloc injecté dans le prompt système du sous-agent. */
export const EXPLORATION_NOTES_MARKER_END = "<!-- /PI_EXPLORATION_NOTES -->";
/** Plafond de notes conservées après compaction (les plus récentes gagnent). */
export const EXPLORATION_NOTES_MAX = 300;
/** Rétention d'une note : 90 jours (purge paresseuse à l'écriture). */
export const EXPLORATION_NOTES_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Longueur maximale du texte d'une note (verbosité interdite). */
export const EXPLORATION_NOTE_TEXT_MAX = 400;
/** Longueur maximale de l'extrait de tâche attaché à une note. */
export const EXPLORATION_NOTE_TASK_MAX = 120;
/** Longueur maximale d'un chemin `fichier:symbole` attaché à une note. */
export const EXPLORATION_NOTE_FILE_MAX = 200;
/** Nombre max de notes considérées pour le digest (les mieux classées). */
export const EXPLORATION_NOTES_DIGEST_MAX_ITEMS = 40;
/** Largeur max d'une ligne rendue (au-delà : troncature avec « … »). */
export const EXPLORATION_NOTES_LINE_MAX = 200;

/** Libellés FR des natures de note (affichés dans le digest et les tools). */
export const NOTE_KIND_LABELS: Record<ExplorationNoteKind, string> = {
  fact: "fait",
  pitfall: "piège",
  decision: "décision",
};

// ── Types ───────────────────────────────────────────────

/** Nature d'une note : un fait confirmé, un piège, ou une décision. */
export type ExplorationNoteKind = "fact" | "pitfall" | "decision";

/** Valeurs acceptées pour `kind` (validation des entrées tools). */
export const EXPLORATION_NOTE_KINDS: readonly ExplorationNoteKind[] = [
  "fact",
  "pitfall",
  "decision",
];

/** Une découverte persistée dans le carnet. */
export interface ExplorationNote {
  /** Horodatage ISO de l'écriture ("" si absent/corrompu). */
  at: string;
  /** Nature de la note. */
  kind: ExplorationNoteKind;
  /** Découverte, une ligne, verbeuse interdite. */
  text: string;
  /** Localisation optionnelle `fichier` ou `fichier:symbole`. */
  file?: string;
  /** Extrait court de la tâche qui a produit la note (contexte). */
  task?: string;
}

/** Entrée d'écriture (ce que fournit l'agent via le tool). */
export interface ExplorationNoteInput {
  kind: ExplorationNoteKind;
  text: string;
  file?: string;
  task?: string;
}

/** Options communes aux accès au stockage (surchargeables en test). */
export interface NotesStorageOptions {
  /** Répertoire racine du stockage (défaut : NOTES_ROOT_DIR). */
  dir?: string;
  /** Instant de référence (défaut : Date.now()). */
  now?: number | Date;
}

/**
 * Mode de classement du digest (P3, prompt caching) :
 *  - "task"   : boost par les hints de la tâche (comportement historique),
 *               réservé au PREMIER MESSAGE USER (contenu variable par tâche) ;
 *  - "stable" : AUCUN hint de tâche — tri par récence seule. Le texte ne
 *               dépend QUE de l'état du carnet → injectable dans le PROMPT
 *               SYSTÈME sans casser le cache cross-délégation.
 */
export type NotesDigestRank = "task" | "stable";

/** Options de rendu du digest. */
export interface BuildNotesDigestOptions {
  /** Budget en caractères (défaut : EXPLORATION_NOTES_BUDGET_CHARS). */
  budget?: number;
  /** Tâche déléguée : sert à booster les notes qui la mentionnent (rank "task"). */
  task?: string;
  /** Contexte additionnel (même rôle que task pour le boost). */
  context?: string;
  /** Largeur max d'une ligne (défaut : EXPLORATION_NOTES_LINE_MAX). */
  lineMax?: number;
  /** Mode de classement (défaut : "task" — rétrocompatible). */
  rank?: NotesDigestRank;
}

/** Palier de rendu, du plus riche au plus dégradé. */
export type NotesDigestTier = "full" | "short" | "titles";

/** Ordre de dégradation : premier palier qui tient dans le budget. */
export const NOTES_DIGEST_TIER_ORDER: readonly NotesDigestTier[] = [
  "full",
  "short",
  "titles",
];

// ── Normalisation (pure) ─────────────────────────────────

/** Réduit une chaîne sur une seule ligne (espaces/contrôles), bornée. */
export function normalizeOneLine(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const flat = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ") // contrôles (dont \n, \t)
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  return max <= 1 ? flat.slice(0, max) : flat.slice(0, max - 1) + "…";
}

/** Un `kind` valide ? Sinon repli sur "fact". */
export function normalizeKind(raw: unknown): ExplorationNoteKind {
  return EXPLORATION_NOTE_KINDS.includes(raw as ExplorationNoteKind)
    ? (raw as ExplorationNoteKind)
    : "fact";
}

/** Construit une note normalisée depuis une entrée agent (ou null si vide). */
export function normalizeNoteInput(
  input: ExplorationNoteInput,
  at: string = new Date().toISOString(),
): ExplorationNote | null {
  const text = normalizeOneLine(input?.text, EXPLORATION_NOTE_TEXT_MAX);
  if (!text) return null;
  const note: ExplorationNote = {
    at,
    kind: normalizeKind(input?.kind),
    text,
  };
  const file = normalizeOneLine(input?.file, EXPLORATION_NOTE_FILE_MAX);
  if (file) note.file = file;
  const task = normalizeOneLine(input?.task, EXPLORATION_NOTE_TASK_MAX);
  if (task) note.task = task;
  return note;
}

// ── Sérialisation JSONL (pure) ───────────────────────────

/** Sérialise une note en une ligne JSON (sans `\n` final). */
export function serializeNote(note: ExplorationNote): string {
  return JSON.stringify({
    at: note.at || "",
    kind: normalizeKind(note.kind),
    text: note.text || "",
    ...(note.file ? { file: note.file } : {}),
    ...(note.task ? { task: note.task } : {}),
  });
}

/**
 * Parse un JSONL de notes de façon TOLÉRANTE : une ligne illisible est
 * ignorée (jamais d'exception), une note sans texte est rejetée.
 */
export function parseNotesJsonl(content: string): ExplorationNote[] {
  const out: ExplorationNote[] = [];
  if (typeof content !== "string" || !content) return out;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== "object") continue;
      const text = normalizeOneLine((obj as any).text, EXPLORATION_NOTE_TEXT_MAX);
      if (!text) continue;
      const note: ExplorationNote = {
        at: typeof (obj as any).at === "string" ? (obj as any).at : "",
        kind: normalizeKind((obj as any).kind),
        text,
      };
      const file = normalizeOneLine((obj as any).file, EXPLORATION_NOTE_FILE_MAX);
      if (file) note.file = file;
      const task = normalizeOneLine((obj as any).task, EXPLORATION_NOTE_TASK_MAX);
      if (task) note.task = task;
      out.push(note);
    } catch {
      // ligne corrompue : on l'ignore sans interrompre le carnet
    }
  }
  return out;
}

// ── Classement et rendu (purs) ───────────────────────────

/** Horodatage ms d'une note (0 si `at` absent/invalide — jamais expirée). */
export function noteTimestamp(note: ExplorationNote): number {
  const t = Date.parse(note.at || "");
  return Number.isFinite(t) ? t : 0;
}

/** Nombre de hints contenus dans `value` (insensible à la casse). */
function hintBoost(value: string, hints: string[]): number {
  if (!value || hints.length === 0) return 0;
  const v = value.toLowerCase();
  let n = 0;
  for (const h of hints) {
    if (h && v.includes(h)) n += 1;
  }
  return n;
}

/**
 * Trie les notes par pertinence (hints de la tâche) puis par récence
 * DÉCROISSANTE. Déterministe : l'index d'origine (notes du plus récent au plus
 * ancien) casse les égalités.
 *
 * `rank` (P3) : "stable" ignore les hints → tri par récence seule, donc
 * indépendant de la tâche (prompt système cachable).
 */
export function rankNotes(
  notes: ExplorationNote[],
  task: string,
  context: string,
  rank: NotesDigestRank = "task",
): ExplorationNote[] {
  const hints = rank === "stable" ? [] : extractTaskHints(`${task}\n${context}`);
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => {
      const sa =
        hintBoost(a.note.text, hints) * 1_000_000 +
        hintBoost(a.note.file || "", hints) * 1_000;
      const sb =
        hintBoost(b.note.text, hints) * 1_000_000 +
        hintBoost(b.note.file || "", hints) * 1_000;
      if (sb !== sa) return sb - sa;
      // Égalité : la plus récente d'abord (indépendant de l'ordre d'entrée).
      const ta = noteTimestamp(a.note);
      const tb = noteTimestamp(b.note);
      if (tb !== ta) return tb - ta;
      return a.index - b.index;
    })
    .map((x) => x.note);
}

/** Tronque une ligne (au plus `max` caractères, suffixe « … »). */
function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  if (max <= 1) return line.slice(0, max);
  return line.slice(0, max - 1) + "…";
}

/** En-tête du digest : compte + rappel d'usage des tools. */
function renderHeader(count: number, tier: NotesDigestTier): string {
  const label =
    tier === "full" ? "complet" : tier === "short" ? "court" : "titres";
  return (
    `Carnet d'exploration (${count} notes · ${label}) — faits/pièges/décisions persistés hors repo. ` +
    `Relis avec exploration_notes, écris avec exploration_note.`
  );
}

/** Bornes de texte par palier (le palier dégradé coupe plus court). */
const TIER_TEXT_MAX: Record<NotesDigestTier, number> = {
  full: 180,
  short: 100,
  titles: 60,
};

/** Ligne d'une note pour un palier donné. */
function renderNoteLine(
  note: ExplorationNote,
  tier: NotesDigestTier,
  lineMax: number,
): string {
  const label = `[${NOTE_KIND_LABELS[note.kind]}]`;
  const text = normalizeOneLine(note.text, TIER_TEXT_MAX[tier]);
  if (tier === "full" && note.file) {
    return truncateLine(`- ${label} ${note.file} — ${text}`, lineMax);
  }
  return truncateLine(`- ${label} ${text}`, lineMax);
}

/** Rend un palier SANS appliquer le budget (le budget est décidé par l'appelant). */
function renderTier(
  notes: ExplorationNote[],
  tier: NotesDigestTier,
  lineMax: number,
): string {
  const lines: string[] = [renderHeader(notes.length, tier)];
  for (const note of notes) lines.push(renderNoteLine(note, tier, lineMax));
  return lines.join("\n");
}

/** Tronque un texte à la dernière ligne entière tenant dans `budget`. */
function truncateAtLine(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  const suffix = "\n…";
  const room = Math.max(0, budget - suffix.length);
  const slice = text.slice(0, room);
  const cut = slice.lastIndexOf("\n");
  const head = cut > 0 ? slice.slice(0, cut) : slice;
  return head + suffix;
}

/**
 * Rend un palier donné (classé/boosté) — exporté pour les tests (mesure de
 * taille par palier).
 */
export function renderNotesDigestTier(
  notes: ExplorationNote[],
  tier: NotesDigestTier,
  options: BuildNotesDigestOptions = {},
): string {
  const ranked = rankNotes(
    notes,
    options.task ?? "",
    options.context ?? "",
    options.rank ?? "task",
  ).slice(0, EXPLORATION_NOTES_DIGEST_MAX_ITEMS);
  const lineMax =
    options.lineMax && options.lineMax > 0
      ? options.lineMax
      : EXPLORATION_NOTES_LINE_MAX;
  return renderTier(ranked, tier, lineMax);
}

/**
 * Construit le digest borné du carnet, ou "" si le carnet est vide.
 *
 * Dégradation ordonnée (« complet » → « court » → « titres ») : le premier
 * palier dont le rendu tient dans le budget est retourné. En dernier recours,
 * le palier « titres » est tronqué à la dernière ligne entière.
 */
export function buildNotesDigest(
  notes: ExplorationNote[],
  options: BuildNotesDigestOptions = {},
): string {
  if (!Array.isArray(notes) || notes.length === 0) return "";
  const budget =
    Number.isFinite(options.budget as number) && (options.budget as number) > 0
      ? (options.budget as number)
      : EXPLORATION_NOTES_BUDGET_CHARS;
  const ranked = rankNotes(
    notes,
    options.task ?? "",
    options.context ?? "",
    options.rank ?? "task",
  ).slice(0, EXPLORATION_NOTES_DIGEST_MAX_ITEMS);
  const lineMax =
    options.lineMax && options.lineMax > 0
      ? options.lineMax
      : EXPLORATION_NOTES_LINE_MAX;

  for (const tier of NOTES_DIGEST_TIER_ORDER) {
    const text = renderTier(ranked, tier, lineMax);
    if (text.length <= budget) return text;
  }
  return truncateAtLine(renderTier(ranked, "titles", lineMax), budget);
}

/**
 * Rend une liste lisible de notes pour le tool de lecture, avec filtre
 * optionnel (recherche plein texte insensible à la casse) et plafond.
 */
export function renderNotesList(
  notes: ExplorationNote[],
  options: { query?: string; limit?: number } = {},
): string {
  let filtered = notes;
  const query = (options.query || "").trim().toLowerCase();
  if (query) {
    filtered = notes.filter((n) =>
      `${n.text} ${n.file || ""} ${NOTE_KIND_LABELS[n.kind]}`
        .toLowerCase()
        .includes(query),
    );
  }
  const limit =
    Number.isFinite(options.limit) && (options.limit as number) > 0
      ? (options.limit as number)
      : 20;
  // Du plus récent au plus ancien (l'append laisse le plus récent en fin).
  const ordered = [...filtered].reverse();
  const shown = ordered.slice(0, limit);

  const scopeLabel = query ? ` (filtre « ${options.query} »)` : "";
  const lines = [
    `## Carnet d'exploration${scopeLabel} — ${filtered.length} note(s)` +
      (ordered.length > shown.length ? ` · ${shown.length} affichée(s)` : ""),
  ];
  if (shown.length === 0) {
    lines.push(
      query
        ? "Aucune note ne correspond à ce filtre."
        : "Carnet vide : aucune découverte persistée pour ce projet.",
    );
    return lines.join("\n");
  }
  for (const n of shown) {
    const ts = n.at || "?";
    const loc = n.file ? ` ${n.file}` : "";
    lines.push(`- [${NOTE_KIND_LABELS[n.kind]}] ${ts}${loc} — ${n.text}`);
  }
  return lines.join("\n");
}

// ── Stockage (effets de bord, jamais d'exception vers l'appelant) ──

/** Résout l'instant de référence (nombre ms). */
function resolveNow(now?: number | Date): number {
  if (typeof now === "number" && Number.isFinite(now)) return now;
  if (now instanceof Date) return now.getTime();
  return Date.now();
}

/**
 * Assainit l'identifiant projet en un segment de dossier sûr : un id projet
 * est un UUID, mais le repli de resolveProjectId() peut être un nom de dossier.
 * On interdit `..`, les séparateurs et les caractères de contrôle.
 */
export function safeProjectSegment(projectId: string): string {
  const cleaned = String(projectId || "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[._-]+/, "_")
    .slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return "_unknown";
  return cleaned;
}

/** Répertoire du carnet d'un projet. */
export function notesProjectDir(
  projectId: string,
  opts: NotesStorageOptions = {},
): string {
  const root = opts.dir || NOTES_ROOT_DIR;
  return path.join(root, safeProjectSegment(projectId));
}

/** Chemin du fichier JSONL d'un projet. */
export function notesFilePath(
  projectId: string,
  opts: NotesStorageOptions = {},
): string {
  return path.join(notesProjectDir(projectId, opts), "notes.jsonl");
}

/**
 * Lit le carnet d'un projet (best-effort). Retourne [] si le fichier est absent
 * ou illisible. Ordre = ordre d'écriture (du plus ancien au plus récent).
 */
export function readExplorationNotes(
  projectId: string,
  opts: NotesStorageOptions = {},
): ExplorationNote[] {
  try {
    const file = notesFilePath(projectId, opts);
    if (!existsSync(file)) return [];
    return parseNotesJsonl(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

/** Recherche plein texte dans le carnet (best-effort). */
export function searchExplorationNotes(
  projectId: string,
  query: string,
  opts: NotesStorageOptions = {},
): ExplorationNote[] {
  const notes = readExplorationNotes(projectId, opts);
  const q = (query || "").trim().toLowerCase();
  if (!q) return notes;
  return notes.filter((n) =>
    `${n.text} ${n.file || ""}`.toLowerCase().includes(q),
  );
}

/**
 * Compaction paresseuse du carnet : retire les notes expirées (TTL 90 j) et
 * plafonne à EXPLORATION_NOTES_MAX (les plus récentes gagnent). Ne réécrit
 * que si le contenu a changé (écriture atomique tmp + rename). Best-effort.
 *
 * @returns le nombre de notes supprimées.
 */
export function compactExplorationNotes(
  projectId: string,
  opts: NotesStorageOptions = {},
): number {
  try {
    const file = notesFilePath(projectId, opts);
    if (!existsSync(file)) return 0;
    const notes = parseNotesJsonl(readFileSync(file, "utf-8"));
    const cutoff = resolveNow(opts.now) - EXPLORATION_NOTES_TTL_MS;

    // TTL : ne expire QUE les notes dont l'horodatage est lisible et ancien
    // (une note corrompue à `at` vide n'est jamais supprimée par le TTL).
    let kept = notes.filter((n) => {
      const t = noteTimestamp(n);
      return t === 0 || t >= cutoff;
    });

    // Plafond : on conserve les plus récentes.
    if (kept.length > EXPLORATION_NOTES_MAX) {
      kept = kept
        .map((n, i) => ({ n, i }))
        .sort((a, b) => noteTimestamp(b.n) - noteTimestamp(a.n) || b.i - a.i)
        .slice(0, EXPLORATION_NOTES_MAX)
        // Rétablit l'ordre chronologique d'écriture.
        .sort((a, b) => a.i - b.i)
        .map((x) => x.n);
    }

    if (kept.length === notes.length) return 0;

    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, kept.map(serializeNote).join("\n") + (kept.length ? "\n" : ""));
    renameSync(tmp, file);
    return notes.length - kept.length;
  } catch {
    return 0;
  }
}

/**
 * Ajoute une note au carnet (append-only). Best-effort : retourne la note
 * écrite, ou null si l'entrée est vide / l'écriture échoue. Une compaction
 * paresseuse est déclenchée à chaque écriture (TTL + plafond).
 */
export function appendExplorationNote(
  projectId: string,
  input: ExplorationNoteInput,
  opts: NotesStorageOptions = {},
): ExplorationNote | null {
  try {
    const at = new Date(resolveNow(opts.now)).toISOString();
    const note = normalizeNoteInput(input, at);
    if (!note) return null;
    const dir = notesProjectDir(projectId, opts);
    mkdirSync(dir, { recursive: true });
    appendFileSync(notesFilePath(projectId, opts), serializeNote(note) + "\n", {
      encoding: "utf-8",
    });
    // Compaction paresseuse : TTL + plafond, au moment d'écrire (pas de cron).
    // Lecture d'un fichier borné (≤ quelques centaines de lignes) : négligeable.
    compactExplorationNotes(projectId, opts);
    return note;
  } catch {
    return null;
  }
}

/**
 * Taille (octets) du carnet d'un projet, 0 s'il est absent/illisible. Utilisé
 * par la compaction paresseuse / le diagnostic.
 */
export function explorationNotesSize(
  projectId: string,
  opts: NotesStorageOptions = {},
): number {
  try {
    const file = notesFilePath(projectId, opts);
    if (!existsSync(file)) return 0;
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Purge COMPLÈTE du carnet d'un projet (suppression du dossier). Appelé par
 * projects/manager.ts à la suppression du projet. Best-effort : ne jette
 * jamais (une purge ratée ne doit pas faire échouer la suppression du projet).
 *
 * @returns true si un dossier a été supprimé.
 */
export function purgeProjectNotes(
  projectId: string,
  opts: NotesStorageOptions = {},
): boolean {
  try {
    const dir = notesProjectDir(projectId, opts);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
