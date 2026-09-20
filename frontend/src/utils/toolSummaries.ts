// ── Résumés d'outils 100 % frontend (LOT 1 refonte chat) ────────────────────
// Génère une ligne de résumé compacte par tool call, à partir des SEULES
// données locales (args, output, details, startedAt/endedAt) : AUCUN appel
// réseau ni LLM. Branché dans ToolCallRow (ChatView) à la place de l'aperçu
// d'args de 50 chars (→ ~100 chars).
//
// Règles par outil (spécification LOT 1) :
//   read            → read <path> · N lignes (· tronqué si details.truncation)
//   write           → write <path> · N lignes écrites
//   edit            → edit <path> · +A/−B (via details.diff, fallback N lignes)
//   bash            → bash <cmd 50c> · exit N · N lignes (échec si exit≠0)
//   grep            → grep <pattern> · N résultats
//   find            → find <glob> · N fichiers
//   ls              → ls <dir> · N entrées
//   web_screenshot  → screenshot <url>
//   analyze_file    → analyze <fichier> · OK
//   open_preview / preview_html → preview <path>
//   cbm_*           → cbm <sub> <query> · N lignes
//   échec (tous)    → ⚠ <1re ligne, 120c> + auto-dépli (CollapsibleBlock)
//
// Durée : live (startedAt→endedAt ; elapsed si streaming) ; en historique la
// durée est absente (pas de startedAt/endedAt sérialisés) → omise.
// Les segments (« N lignes », « tronqué »…) sont volontairement NON i18nisés :
// formats fixés par la spécification validée (parité fr/en des libellés courts).

import type { ToolCallInfo } from "../types";

// ── Types publics ────────────────────────────────────────────────────────────

export interface ToolSummaryInput {
  name: string;
  args?: any;
  output?: string;
  /** details du toolResult (historique) ou de l'event tool_execution_end (live). */
  details?: any;
  isError?: boolean;
  isStreaming?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface ToolSummary {
  /** Verbe court (read, write, bash, « cbm search »…). */
  verb: string;
  /** Cible tronquée (chemin, commande, pattern, url…). */
  target: string | null;
  /** Segments d'information (« 42 lignes », « +3/−1 », « exit 0 »…). */
  segments: string[];
  /** Ligne complète prête à afficher (≤ 100 chars). */
  text: string;
  /** Durée en ms si calculable — absente en historique. */
  durationMs?: number;
  /** Échec : isError explicite OU exit code bash ≠ 0. → auto-dépli + ⚠. */
  failed: boolean;
  /** Exit code bash si déterminable. */
  exitCode?: number;
  /** Nombre de lignes de l'output (0 si vide). */
  lineCount: number;
}

// ── Constantes ───────────────────────────────────────────────────────────────

const SUMMARY_MAX_CHARS = 100;
const BASH_CMD_MAX_CHARS = 50;
const ERROR_LINE_MAX_CHARS = 120;

const PATH_ARG_KEYS = ["file_path", "path", "filePath", "filepath"];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Réduit une chaîne sur une ligne et tronque avec ellipse. */
function oneLine(s: string, max: number): string {
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Nombre de lignes d'un texte (lignes vides de fin ignorées). */
export function countLines(output: string | undefined): number {
  if (!output || !output.trim()) return 0;
  return output.replace(/\s+$/, "").split("\n").length;
}

/**
 * Compte les lignes « résultats » d'un outil de listing (grep/find/ls) : les
 * notices du SDK (« [200 results limit reached…] ») sont ajoutées APRÈS une
 * ligne vide → ne pas les compter comme résultats.
 */
function countResultLines(output: string | undefined): number {
  if (!output) return 0;
  // Convention du SDK : répertoire vide → texte dédié, PAS un résultat.
  if (output.trim() === "(empty directory)") return 0;
  return countLines(output.split(/\n\n\[/)[0]);
}

/** Premier argument string trouvé (clés priorisées si fournies). */
function firstStringArg(args: any, keys?: string[]): string | null {
  if (!args || typeof args !== "object") return null;
  if (keys) {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  }
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** details.truncation présent et effectif (SDK : TruncationResult.truncated). */
function isTruncated(details: any): boolean {
  return details?.truncation?.truncated === true || details?.linesTruncated === true;
}

/**
 * Premier compte ± d'un diff unifié de type « +N ligne / -N ligne / N contexte ».
 * Aligné sur la version backend (backend/src/pi/harness-stream.ts) : les lignes
 * d'en-tête de fichier (`+++`/`---`) sont IGNORÉES (elles ne comptent ni en
 * ajout ni en suppression).
 */
function countDiffLines(diff: string | undefined): { added: number; removed: number } {
  if (!diff || typeof diff !== "string") return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

const BASH_EXIT_RE = /Command exited with code (-?\d+)/;

/**
 * Exit code bash : details.exitCode (si un jour sérialisé) > parsing du
 * message d'échec du SDK (« Command exited with code N ») > 0 si l'outil a
 * réussi (le SDK lève une Error dès que exitCode ≠ 0) > undefined sinon
 * (échec sans code identifiable, ou tool encore en cours).
 */
export function computeBashExitCode(
  output: string | undefined,
  details?: any,
  isError?: boolean,
): number | undefined {
  if (details && typeof details.exitCode === "number") return details.exitCode;
  if (output) {
    const m = output.match(BASH_EXIT_RE);
    if (m) return parseInt(m[1], 10);
  }
  if (isError) return undefined;
  return 0;
}

/**
 * Durée calculable (ms) :
 *  - startedAt + endedAt → durée exacte (outil terminé en live) ;
 *  - startedAt + streaming + now → elapsed (durée live, rafraîchie au render) ;
 *  - historique (pas de startedAt) OU terminé sans endedAt connu → undefined.
 */
export function computeDurationMs(
  input: Pick<ToolSummaryInput, "startedAt" | "endedAt" | "isStreaming">,
  now?: number,
): number | undefined {
  const { startedAt, endedAt, isStreaming } = input;
  if (typeof startedAt !== "number") return undefined;
  if (typeof endedAt === "number" && endedAt >= startedAt) return endedAt - startedAt;
  if (isStreaming && typeof now === "number" && now >= startedAt) return now - startedAt;
  return undefined;
}

/** Formate une durée ms → « 12s » / « 1m 05s » (cohérent avec ToolCallTimer). */
export function formatToolDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** Verbe court d'un tool (miroir de shortName de ChatView, autonome pour les tests). */
export function shortVerb(name: string): string {
  const s = (name || "tool").replace(/^(analyze_|git_|firecrawl_|memory_)/, "");
  return s.length > 16 ? s.slice(0, 14) + "…" : s;
}

/** Première ligne non vide d'un output (pour la règle d'erreur « ⚠ 1re ligne »). */
function firstNonEmptyLine(output: string | undefined): string {
  if (!output) return "";
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

// ── Builder principal ────────────────────────────────────────────────────────

export function buildToolSummary(input: ToolSummaryInput, now?: number): ToolSummary {
  const { name, args, output = "", details, isError = false, isStreaming = false } = input;
  const durationMs = computeDurationMs(input, now);
  const lineCount = countLines(output);
  const truncated = isTruncated(details);

  let verb = shortVerb(name);
  let target: string | null = null;
  let segments: string[] = [];
  let exitCode: number | undefined;
  // Échec détecté par outil (exit≠0 bash en plus de isError).
  let failed = isError;

  switch (name) {
    case "read": {
      verb = "read";
      target = oneLine(firstStringArg(args, PATH_ARG_KEYS) ?? "", 60) || null;
      if (lineCount > 0) segments.push(`${lineCount} lignes`);
      if (truncated) segments.push("tronqué");
      break;
    }
    case "write": {
      verb = "write";
      target = oneLine(firstStringArg(args, PATH_ARG_KEYS) ?? "", 60) || null;
      // Le nombre de lignes écrites vient du CONTENU envoyé (args.content) :
      // l'output du SDK ne contient que « Successfully wrote to <path> ».
      const written = countLines(typeof args?.content === "string" ? args.content : undefined);
      if (written > 0) segments.push(`${written} lignes écrites`);
      break;
    }
    case "edit": {
      verb = "edit";
      target = oneLine(firstStringArg(args, PATH_ARG_KEYS) ?? "", 60) || null;
      const { added, removed } = countDiffLines(details?.diff);
      if (added > 0 || removed > 0) {
        segments.push(`+${added}/−${removed}`);
      } else {
        // Fallback : pas de details.diff (historique ancien) → N lignes d'output.
        if (lineCount > 0) segments.push(`${lineCount} lignes`);
      }
      break;
    }
    case "bash":
    case "shell": {
      verb = "bash";
      target = oneLine(typeof args?.command === "string" ? args.command : "", BASH_CMD_MAX_CHARS) || null;
      exitCode = computeBashExitCode(output, details, isError);
      if (!isStreaming) {
        if (exitCode !== undefined) segments.push(`exit ${exitCode}`);
        if (lineCount > 0) segments.push(`${lineCount} lignes`);
        if (truncated) segments.push("tronqué");
      }
      if (exitCode !== undefined && exitCode !== 0) failed = true;
      break;
    }
    case "grep": {
      verb = "grep";
      target = oneLine(firstStringArg(args, ["pattern"]) ?? "", 60) || null;
      const results = countResultLines(output);
      if (results > 0) segments.push(`${results} résultats`);
      if (truncated) segments.push("tronqué");
      break;
    }
    case "find": {
      verb = "find";
      target = oneLine(firstStringArg(args, ["pattern", "glob"]) ?? "", 60) || null;
      const files = countResultLines(output);
      if (files > 0) segments.push(`${files} fichiers`);
      if (truncated) segments.push("tronqué");
      break;
    }
    case "ls": {
      verb = "ls";
      target = oneLine(firstStringArg(args, PATH_ARG_KEYS) ?? "", 60) || null;
      const entries = countResultLines(output);
      if (entries > 0) segments.push(`${entries} entrées`);
      if (truncated) segments.push("tronqué");
      break;
    }
    case "web_screenshot": {
      verb = "screenshot";
      const url = firstStringArg(args, ["url", "htmlPath"]);
      target = url ? oneLine(url, 60) : typeof args?.html === "string" ? "(html)" : null;
      break;
    }
    case "analyze_file": {
      verb = "analyze";
      target = oneLine(firstStringArg(args, ["file_id", "fileId"]) ?? "", 60) || null;
      if (!failed) segments.push("OK");
      break;
    }
    case "open_preview":
    case "preview_html": {
      verb = "preview";
      target = oneLine(firstStringArg(args, ["path", "htmlPath"]) ?? "", 60) || null;
      break;
    }
    default: {
      if (name?.startsWith("cbm_")) {
        // cbm_search / cbm_trace / cbm_code / cbm_cypher… → « cbm <sub> <query> »
        verb = `cbm ${name.slice(4)}`;
        target = oneLine(firstStringArg(args) ?? "", 60) || null;
        if (lineCount > 0) segments.push(`${lineCount} lignes`);
      }
      // Fallback générique (git_*, memory_*, firecrawl_*, webfetch…) :
      // verbe court + 1er arg string + N lignes.
      else {
        target = oneLine(firstStringArg(args) ?? "", 60) || null;
        if (lineCount > 0) segments.push(`${lineCount} lignes`);
        if (truncated) segments.push("tronqué");
      }
      break;
    }
  }

  // Règle d'erreur UNIFORME (tous outils) : « ⚠ <1re ligne, 120c> ».
  // Le CollapsibleBlock auto-déplie le bloc (failed → isError).
  if (failed) {
    const firstLine = firstNonEmptyLine(output);
    const label = oneLine(firstLine || target || verb, ERROR_LINE_MAX_CHARS);
    return {
      verb,
      target,
      segments: [],
      text: `⚠ ${label}`,
      durationMs,
      failed: true,
      exitCode,
      lineCount,
    };
  }

  // Format : « <verb> <target> · <seg1> · <seg2> » — l'espace verbe↔cible vs
  // le séparateur « · » des segments d'information.
  const head = target ? `${verb} ${target}` : verb;
  const text = oneLine(
    segments.length ? `${head} · ${segments.join(" · ")}` : head,
    SUMMARY_MAX_CHARS,
  );
  return { verb, target, segments, text, durationMs, failed: false, exitCode, lineCount };
}

/** Résumé à partir d'un ToolCallInfo complet (branchement ToolCallRow). */
export function buildToolSummaryFromCall(tc: ToolCallInfo, now?: number): ToolSummary {
  return buildToolSummary(
    {
      name: tc.name,
      args: tc.args,
      output: tc.output,
      details: tc.details,
      isError: tc.isError,
      isStreaming: tc.isStreaming,
      startedAt: tc.startedAt,
      endedAt: tc.endedAt,
    },
    now,
  );
}