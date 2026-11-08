/**
 * bash-guard.ts — garde-fou git des appels de l'outil `bash`.
 *
 * Incident : un sous-agent a exécuté `git reset --mixed HEAD~1` « pour annuler un
 * commit qu'il croyait extérieur » — c'était le commit de l'utilisateur. La
 * consigne seule ne suffit pas (le prompt des sous-agents est remplacé, cf.
 * extensions/harness-orchestrator/index.ts) : il faut un refus TECHNIQUE.
 *
 * Point d'interception officiel du SDK : événement `tool_call`, qui peut BLOQUER
 * l'appel avant exécution (dist/core/extensions/types.d.ts:974-980, résultat
 * `ToolCallEventResult { block?, reason? }` :1089-1092, enregistrement `pi.on` :1224).
 * Le tool `bash` n'appartient pas à Pi-Web : on ne le modifie pas, on l'intercepte.
 *
 * Deux propriétés non négociables (Pi-Web tourne en production) :
 *  1. AUCUN faux positif : on ne cherche pas la sous-chaîne « git reset » mais on
 *     tokenise la commande pour identifier une VRAIE invocation git ;
 *  2. NE JAMAIS PLANTER : toute erreur interne du garde-fou laisse passer l'appel
 *     et se contente de tracer (`guardBashToolCall`).
 *
 * Module PUR (aucune I/O, aucun état global) → testable sans SDK ni réseau.
 */

/** Verdict du garde-fou. `reason` est renvoyé à l'agent (message actionnable). */
export interface GitSafetyVerdict {
  block: boolean;
  reason?: string;
}

/** Sous-commandes git purement en LECTURE (liste blanche). */
const ALLOWED_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "rev-list",
  "blame",
  "show-ref",
  "describe",
  "cat-file",
  "shortlog",
  "grep",
  "merge-base",
  "for-each-ref",
  "whatchanged",
  "name-rev",
  "count-objects",
  "check-ignore",
  "check-attr",
  "diff-tree",
  "diff-files",
  "diff-index",
  "version",
  "help",
]);

// ── Texte de consigne partagé (prompts de rôle + mode code) ───────────────────
// Volontairement dans ce module : il est importé À LA FOIS par le backend
// (system-prompt.ts) et par l'extension harness-orchestrator — une seule source,
// aucun couplage backend → extensions (qui casserait le rootDir de tsc).
// Les deux textes sont dérivés de la liste blanche : impossible d'annoncer au
// modèle un ensemble de lectures différent de celui réellement accepté.
const CONDITIONAL_READS = [
  "branch -vv",
  "reflog",
  "stash list",
  "stash show",
  "remote -v",
  "remote show",
  "remote get-url",
  "config --get/--list",
];
const ALLOWED_SUBCOMMANDS_TEXT = Array.from(ALLOWED_SUBCOMMANDS).join(", ");
const ALLOWED_READS_MARKDOWN = [
  ...Array.from(ALLOWED_SUBCOMMANDS).map((command, index) => `\`${index === 0 ? "git " : ""}${command}\``),
  ...CONDITIONAL_READS.map((command) => `\`${command}\``),
].join(", ");

export const GIT_SAFETY_RULES = `

## Historique git : INTERDICTION FORMELLE (garde-fou)
Tu n'exécutes JAMAIS : \`git commit\`, \`git push\`, \`git reset\`, \`git checkout\`,
\`git restore\`, \`git stash\`, \`git rebase\`, \`git clean\`, \`git revert\`,
\`git cherry-pick\`, \`git merge\`, ni aucune option \`--force\` —
même « pour nettoyer », « pour repartir d'un état propre » ou « pour annuler un commit
que tu crois extérieur ». Un commit que tu ne reconnais pas est TOUJOURS un travail de
l'utilisateur : ne le défais pas, signale-le.
Seules les lectures sont autorisées : ${ALLOWED_READS_MARKDOWN}.
L'utilisateur gère seul son historique. Un garde-fou technique bloque déjà ces
commandes : les tenter ne produit qu'un refus, jamais un effet.
Limite de conception : l'analyse est statique. Les scripts et lanceurs arbitraires
(node, python, make, npm, scripts .sh) ne sont pas tous interprétables ; seuls des
motifs d'écriture git explicites dans node -e / python -c sont refusés. Ne présente
jamais cette protection comme absolue et ne cherche pas à la contourner.`;

/**
 * Sous-commandes explicitement DANGEREUSES. Redondant avec le défaut-refus
 * (tout ce qui n'est pas en liste blanche est bloqué) mais conservé pour un
 * message de refus précis et pour documenter l'intention.
 */
const BLOCKED_SUBCOMMANDS = new Set([
  "commit",
  "push",
  "pull",
  "fetch",
  "reset",
  "checkout",
  "switch",
  "restore",
  "rebase",
  "clean",
  "revert",
  "cherry-pick",
  "merge",
  "am",
  "apply",
  "filter-branch",
  "filter-repo",
  "update-ref",
  "update-index",
  "gc",
  "prune",
  "add",
  "rm",
  "mv",
  "tag",
  "init",
  "clone",
  "submodule",
  "worktree",
  "notes",
  "replace",
  "symbolic-ref",
  "bisect",
  "format-patch",
  "repack",
  "pack-refs",
  "reflog", // conditionnellement autorisé, cf. checkGitArgs
  "stash", // conditionnellement autorisé (list/show)
  "branch", // conditionnellement autorisé (sans -d/-D/-m/-M)
  "remote", // conditionnellement autorisé (-v / show / get-url)
  "config", // conditionnellement autorisé (--get* / --list)
]);

// ── Préfixes de commande : on traverse jusqu'à la commande réelle ─────────────
// (valeurs = options qui consomment l'argument suivant).
const PREFIX_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from", "-h", "--host", "-r", "--role", "-t", "--type", "-U", "--other-user", "-D", "--chdir", "-T", "--command-timeout", "-R", "--chroot"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  xargs: new Set(["-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "-L", "--max-lines", "-I", "--replace", "-d", "--delimiter", "-E", "--eof", "-a", "--arg-file"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  exec: new Set(["-a"]),
  watch: new Set(["-n", "--interval", "-d", "--differences"]),
  command: new Set(),
  builtin: new Set(),
  nohup: new Set(),
  setsid: new Set(),
  unbuffer: new Set(),
  chronic: new Set(),
  busybox: new Set(),
};

/** Interpréteurs de shell : `bash -c "<script>"` doit être analysé récursivement. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "ash", "busybox-sh"]);

/** Mots-clés shell qui ne sont PAS la commande invoquée (en tête de segment). */
const SHELL_KEYWORDS = new Set(["if", "then", "elif", "else", "fi", "do", "done", "while", "until", "for", "in", "case", "esac", "!", "{", "}", "function", "select"]);

/** Options globales de git qui consomment l'argument suivant. */
const GIT_GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--attr-source"]);

/** Options de lecture de `git branch` dont la valeur suit dans un mot séparé. */
const GIT_BRANCH_VALUE_OPTS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);

/** Profondeur maximale d'analyse des charges et substitutions imbriquées. */
const MAX_ANALYSIS_DEPTH = 4;

/**
 * Motifs grossiers pour les interpréteurs non analysables statiquement. Le mot
 * `git` est exigé : un programme Node/Python qui évoque « reset » sans git ne
 * doit pas être bloqué.
 */
const GIT_WRITE_IN_SCRIPT_RE = /\b(?:commit|push|pull|fetch|reset|checkout|switch|restore|rebase|clean|revert|cherry-pick|merge|am|apply|filter-branch|filter-repo|update-ref|update-index|gc|prune|add|rm|mv|tag|init|clone|submodule|worktree|notes|replace|symbolic-ref|format-patch|repack|pack-refs)\b|--force(?:\b|=)/;

function containsGitWritePattern(value: string): boolean {
  return /\bgit(?:\.exe)?\b/i.test(value) && GIT_WRITE_IN_SCRIPT_RE.test(value);
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHORT_FLAG_RE = /^-[A-Za-z]+$/;

const REFUSAL_HINT =
  "L'utilisateur gère seul son historique git. Un commit que tu ne reconnais pas est TOUJOURS un travail de l'utilisateur : ne le défais pas, signale-le dans ton rapport. " +
  `Seules les lectures sont autorisées : git ${ALLOWED_SUBCOMMANDS_TEXT}, ${CONDITIONAL_READS.join(", ")}.`;

function refusal(detail: string): GitSafetyVerdict {
  return { block: true, reason: `Commande git refusée (garde-fou Pi-Web) : ${detail}. ${REFUSAL_HINT}` };
}

// ── Tokenisation ─────────────────────────────────────────────────────────────

interface Word {
  /** Valeur dé-quotée (les guillemets sont retirés). */
  value: string;
  /** Vrai si le mot contenait des guillemets (donc jamais une commande invoquée... sauf shell -c). */
  quoted: boolean;
}

/** Retrouve l'accolade fermante d'une substitution `$( ... )` (en respectant les quotes). */
function findMatchingParen(s: string, openIdx: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Retrouve le backtick fermant. */
function findClosingBacktick(s: string, startIdx: number): number {
  for (let i = startIdx; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "`") return i;
  }
  return -1;
}

/**
 * Extrait les substitutions de commande (`$(…)`, `` `…` ``, y compris dans les
 * doubles quotes) : leur contenu est analysé comme une commande à part entière,
 * remplacé par un espace dans la chaîne principale.
 */
function splitSubstitutions(input: string): { outer: string; subs: string[] } {
  const subs: string[] = [];
  let outer = "";
  let inDouble = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\\" && i + 1 < input.length) {
      outer += input.slice(i, i + 2);
      i += 2;
      continue;
    }
    // Simple quotes : AUCUNE substitution à l'intérieur.
    if (!inDouble && ch === "'") {
      let j = i + 1;
      while (j < input.length && input[j] !== "'") j++;
      outer += input.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      outer += ch;
      i++;
      continue;
    }
    if (ch === "$" && input[i + 1] === "(") {
      const end = findMatchingParen(input, i + 1);
      if (end !== -1) {
        subs.push(input.slice(i + 2, end));
        outer += " ";
        i = end + 1;
        continue;
      }
    }
    if (ch === "`") {
      const end = findClosingBacktick(input, i + 1);
      if (end !== -1) {
        subs.push(input.slice(i + 1, end));
        outer += " ";
        i = end + 1;
        continue;
      }
    }
    outer += ch;
    i++;
  }
  return { outer, subs };
}

/**
 * Découpe la commande en SEGMENTS de pipeline/liste (`;`, `&&`, `||`, `|`, `&`,
 * saut de ligne) puis en mots. Les redirections sont retirées ; un `#` en début
 * de mot ouvre un commentaire jusqu'à la fin de ligne.
 */
function splitSegments(command: string): Word[][] {
  const segments: Word[][] = [];
  let current: Word[] = [];
  let word = "";
  let wordQuoted = false;
  let hasWord = false;

  const pushWord = () => {
    if (hasWord) current.push({ value: word, quoted: wordQuoted });
    word = "";
    wordQuoted = false;
    hasWord = false;
  };
  const endSegment = () => {
    pushWord();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "\\") {
      if (i + 1 < command.length) {
        word += command[i + 1];
        hasWord = true;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < command.length && command[j] !== "'") j++;
      word += command.slice(i + 1, j);
      wordQuoted = true;
      hasWord = true;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let buf = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) {
          buf += command[j + 1];
          j += 2;
          continue;
        }
        buf += command[j];
        j++;
      }
      word += buf;
      wordQuoted = true;
      hasWord = true;
      i = j + 1;
      continue;
    }
    if (ch === "#" && !hasWord) {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      endSegment();
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      i++;
      continue;
    }
    if (ch === "<" || ch === ">") {
      // Redirection : l'opérateur n'est pas un mot, la cible reste un mot inerte.
      pushWord();
      i++;
      continue;
    }
    word += ch;
    hasWord = true;
    i++;
  }
  endSegment();
  return segments;
}

/** Dernier composant d'un chemin (`/usr/bin/git` → `git`). */
function baseName(value: string): string {
  const cleaned = value.replace(/\\/g, "/");
  const idx = cleaned.lastIndexOf("/");
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

/**
 * Remonte la chaîne des préfixes (`sudo`, `env`, `xargs`, `timeout`, mots-clés
 * shell…) et renvoie la VRAIE commande du segment (nom + position), ou null.
 * C'est ce qui évite les faux positifs : dans `echo "git reset"`, la commande
 * est `echo`, pas `git` (et le mot quoté n'est jamais une commande).
 */
function resolveCommand(segment: Word[]): { base: string; index: number } | null {
  let i = 0;
  let steps = 0;
  while (i < segment.length && steps++ < 64) {
    while (i < segment.length && ASSIGNMENT_RE.test(segment[i]!.value)) i++;
    if (i >= segment.length) return null;
    const raw = segment[i]!.value;
    const commandIndex = i;
    if (SHELL_KEYWORDS.has(raw)) {
      i++;
      continue;
    }
    const base = baseName(raw);
    const valueOpts = PREFIX_VALUE_OPTS[base];
    if (!valueOpts) return { base, index: i }; // commande réelle (ou inconnue)
    i++;
    while (i < segment.length) {
      const t = segment[i]!.value;
      if (t === "--") {
        i++;
        break;
      }
      if (t.startsWith("-")) {
        const optName = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
        // `env -S` n'est pas une simple option à valeur : son argument est une
        // ligne de commande qu'il faut analyser, jamais sauter aveuglément.
        if (base === "env" && (optName === "-S" || optName === "--split-string")) {
          return { base, index: commandIndex };
        }
        i++;
        if (valueOpts.has(optName) && !t.includes("=")) i++;
        continue;
      }
      break;
    }
    // `timeout 5 git …` : la première positionnelle est la DURÉE.
    if (base === "timeout" && i < segment.length && !segment[i]!.value.startsWith("-")) i++;
  }
  return null;
}

/** Mots suivant une invocation `git` (null si le segment n'invoque pas git). */
function gitArgsOfSegment(segment: Word[]): Word[] | null {
  const resolved = resolveCommand(segment);
  if (!resolved || resolved.base !== "git") return null;
  return segment.slice(resolved.index + 1);
}

/**
 * Charge utile de `bash -c "<script>"` / `sh -c '<script>'` (sinon null).
 * Passe par `resolveCommand` : `sudo bash -c "…"` et `timeout 5 bash -c "…"`
 * sont couverts, pas seulement `bash -c "…"` en tête de segment.
 */
function shellPayload(segment: Word[]): string | null {
  const resolved = resolveCommand(segment);
  if (!resolved || !SHELLS.has(resolved.base)) return null;
  // Cherche `-c` dans les options de l'interpréteur.
  for (let j = resolved.index + 1; j < segment.length; j++) {
    const opt = segment[j]!.value;
    if (opt === "-c" || (SHORT_FLAG_RE.test(opt) && opt.slice(1).includes("c"))) {
      const payload = segment[j + 1];
      return payload ? payload.value : null;
    }
    if (!opt.startsWith("-")) return null;
  }
  return null;
}

/**
 * Charge de `env -S 'commande …'`. `resolveCommand` s'arrête volontairement sur
 * `env` pour cette option afin que l'appelant analyse la charge récursivement.
 */
function envSplitPayload(segment: Word[]): string | null {
  const resolved = resolveCommand(segment);
  if (!resolved || resolved.base !== "env") return null;
  for (let j = resolved.index + 1; j < segment.length; j++) {
    const value = segment[j]!.value;
    if (value === "-S" || value === "--split-string") return segment[j + 1]?.value ?? null;
    if (value.startsWith("--split-string=")) return value.slice("--split-string=".length);
    if (value.startsWith("-S") && value.length > 2) return value.slice(2);
  }
  return null;
}

/** Charges `find … -exec commande {} \\;` et `find … -exec commande {} +`. */
function findExecPayloads(segment: Word[]): Word[][] {
  const resolved = resolveCommand(segment);
  if (!resolved || resolved.base !== "find") return [];
  const payloads: Word[][] = [];
  for (let j = resolved.index + 1; j < segment.length; j++) {
    if (segment[j]!.value !== "-exec" && segment[j]!.value !== "-execdir") continue;
    const start = j + 1;
    let end = start;
    while (end < segment.length && segment[end]!.value !== ";" && segment[end]!.value !== "+") end++;
    if (end > start) payloads.push(segment.slice(start, end));
    j = end;
  }
  return payloads;
}

/** Charge évaluée par Node ou Python, dont le contenu n'est pas du shell. */
function evalPayload(segment: Word[]): { base: string; payload: string } | null {
  const resolved = resolveCommand(segment);
  if (!resolved) return null;
  const isNode = resolved.base === "node" || resolved.base === "nodejs";
  const isPython = /^(?:python\d*(?:\.\d+)*|pypy\d*)$/.test(resolved.base);
  if (!isNode && !isPython) return null;

  for (let j = resolved.index + 1; j < segment.length; j++) {
    const value = segment[j]!.value;
    if (isNode && (value === "-e" || value === "--eval")) {
      const payload = segment[j + 1]?.value;
      return payload === undefined ? null : { base: resolved.base, payload };
    }
    if (isNode && value.startsWith("--eval=")) return { base: resolved.base, payload: value.slice(7) };
    if (isPython && value === "-c") {
      const payload = segment[j + 1]?.value;
      return payload === undefined ? null : { base: resolved.base, payload };
    }
    if (isPython && value.startsWith("-c") && value.length > 2) {
      return { base: resolved.base, payload: value.slice(2) };
    }
    if (!value.startsWith("-")) return null;
  }
  return null;
}

function hasUnresolvedExpansion(payload: string): boolean {
  return payload.includes("$") || payload.includes("`");
}

function excessiveDepthVerdict(command: string): GitSafetyVerdict {
  // À cette profondeur on ne prétend plus comprendre la commande. On refuse les
  // formes dynamiques ou portant un motif d'écriture, tout en laissant passer
  // les imbrications bénignes (aucun faux positif sur `echo $(echo …)`).
  if (containsGitWritePattern(command) || hasUnresolvedExpansion(command)) {
    return refusal("profondeur maximale d'analyse atteinte sur une commande dynamique ou dangereuse");
  }
  return { block: false };
}
function isForceToken(value: string): boolean {
  if (value === "--force" || value.startsWith("--force")) return true;
  if (/^-[A-Za-z]*f[A-Za-z]*$/.test(value)) return true;
  return false;
}

/** `-D`/`-d`/`-m`/`-M` (y compris groupés : `-aD`) et leurs formes longues. */
function isBranchMutationToken(value: string): boolean {
  if (value === "--delete" || value.startsWith("--delete") || value === "--move" || value.startsWith("--move")) return true;
  if (value === "--force" || value === "-f") return true;
  return /^-[A-Za-z]*[dDmM][A-Za-z]*$/.test(value);
}

/**
 * Verdict pour un segment dont la commande est `git` : `args` = mots après `git`.
 */
function checkGitArgs(args: Word[]): GitSafetyVerdict | null {
  // 1. Options globales, jusqu'à la sous-commande.
  let i = 0;
  while (i < args.length) {
    const t = args[i]!.value;
    if (!t.startsWith("-")) break;
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (GIT_GLOBAL_VALUE_OPTS.has(name)) i += t.includes("=") ? 1 : 2;
    else i++;
  }
  if (i > args.length) i = args.length;

  const allArgs = args.map((w) => w.value);
  const sub = allArgs[i];
  const subArgs = allArgs.slice(i + 1);

  // 2. Forçage : bloqué quelle que soit la sous-commande.
  const force = allArgs.find(isForceToken);
  if (force) return refusal(`option ${force} (git ${sub ?? ""}) — aucune écriture forcée n'est permise`);

  if (!sub || sub.startsWith("-")) return null; // `git`, `git --version`, `git -C /p` seul : inoffensif

  // 3. Même une sous-commande de lecture ne doit pas écrire dans un fichier.
  const output = subArgs.find((a) => a === "-o" || a === "--output" || a.startsWith("--output="));
  if (output) return refusal(`option ${output} (git ${sub}) — l'écriture d'un fichier est interdite`);

  // 4. Cas conditionnels.
  if (sub === "reflog") {
    if (subArgs.some((a) => a === "expire" || a === "delete" || a === "drop")) {
      return refusal("git reflog expire/delete réécrit l'historique");
    }
    return null;
  }
  if (sub === "stash") {
    const first = subArgs.find((a) => !a.startsWith("-"));
    // `git stash` SANS argument crée un stash : seule la lecture est permise.
    if (first === "list" || first === "show") return null;
    return refusal(`git stash${first ? ` ${first}` : ""} modifie l'arbre de travail et l'historique`);
  }
  if (sub === "branch") {
    const mutation = subArgs.find(isBranchMutationToken);
    if (mutation) return refusal(`git branch ${mutation} supprime/déplace une branche`);
    for (let j = 0; j < subArgs.length; j++) {
      const arg = subArgs[j]!;
      if (arg === "--") {
        if (j + 1 < subArgs.length) return refusal("git branch avec un argument positionnel crée ou modifie une ref");
        break;
      }
      if (arg.startsWith("-")) {
        const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
        if (GIT_BRANCH_VALUE_OPTS.has(name) && !arg.includes("=")) j++;
        continue;
      }
      return refusal(`git branch ${arg} crée ou modifie une ref`);
    }
    return null;
  }
  if (sub === "remote") {
    const first = subArgs.find((a) => !a.startsWith("-"));
    if (first === undefined || first === "show" || first === "get-url") return null;
    return refusal(`git remote ${first} modifie la configuration du dépôt`);
  }
  if (sub === "config") {
    const readOnly = subArgs.some((a) => a === "-l" || a === "--list" || a.startsWith("--get"));
    if (readOnly) return null;
    return refusal("git config hors lecture (--get/--list) écrit la configuration");
  }

  // 5. Liste blanche.
  if (ALLOWED_SUBCOMMANDS.has(sub)) return null;

  if (BLOCKED_SUBCOMMANDS.has(sub)) {
    return refusal(`git ${sub} modifie le dépôt ou son historique`);
  }

  // 6. Défaut-refus : une sous-commande hors liste blanche n'est jamais exécutée.
  return refusal(`git ${sub} n'est pas dans la liste blanche des lectures autorisées`);
}

/** Analyse un segment déjà tokenisé, y compris ses lanceurs et charges. */
function checkSegment(segment: Word[], depth: number): GitSafetyVerdict | null {
  if (depth > MAX_ANALYSIS_DEPTH) {
    const verdict = excessiveDepthVerdict(segment.map((word) => word.value).join(" "));
    return verdict.block ? verdict : null;
  }

  const payloads = [shellPayload(segment), envSplitPayload(segment)].filter((payload): payload is string => payload !== null);
  for (const payload of payloads) {
    if (hasUnresolvedExpansion(payload)) {
      return refusal("charge de shell/env contenant une expansion ($ ou backtick) impossible à résoudre statiquement");
    }
    const verdict = assertGitSafe(payload, depth + 1);
    if (verdict.block) return verdict;
  }

  for (const payload of findExecPayloads(segment)) {
    const verdict = checkSegment(payload, depth + 1);
    if (verdict) return verdict;
  }

  const evaluated = evalPayload(segment);
  if (evaluated && containsGitWritePattern(evaluated.payload)) {
    return refusal(`${evaluated.base} évalue une charge contenant un motif d'écriture git`);
  }

  const gitArgs = gitArgsOfSegment(segment);
  return gitArgs ? checkGitArgs(gitArgs) : null;
}

/**
 * Verdict pour la commande shell complète.
 *
 * PUR : mêmes entrées → même sortie, aucune I/O. Analyse récursive des
 * substitutions (`$(…)`, backticks) et des scripts passés à `bash -c` / `env -S`.
 */
export function assertGitSafe(command: string, depth = 0): GitSafetyVerdict {
  if (typeof command !== "string" || command.trim() === "") return { block: false };
  if (depth > MAX_ANALYSIS_DEPTH) return excessiveDepthVerdict(command);

  // Contrôle sur la forme BRUTE : splitSubstitutions retire ensuite $(…) et
  // les backticks pour les analyser, mais une charge -c dynamique doit être
  // refusée même si son expansion masque ensuite le script à examiner.
  for (const segment of splitSegments(command)) {
    const payloads = [shellPayload(segment), envSplitPayload(segment)];
    if (payloads.some((payload) => payload !== null && hasUnresolvedExpansion(payload))) {
      return refusal("charge de shell/env contenant une expansion ($ ou backtick) impossible à résoudre statiquement");
    }
  }

  const { outer, subs } = splitSubstitutions(command);
  for (const sub of subs) {
    const verdict = assertGitSafe(sub, depth + 1);
    if (verdict.block) return verdict;
  }

  for (const segment of splitSegments(outer)) {
    const verdict = checkSegment(segment, depth);
    if (verdict) return verdict;
  }
  return { block: false };
}

// ── Branchement SDK (`pi.on("tool_call", …)`) ────────────────────────────────

/** Sous-ensemble structurel de `ToolCallEvent` (évite un import SDK côté backend). */
export interface ToolCallLike {
  toolName?: string;
  input?: Record<string, unknown>;
}

/** Sous-ensemble structurel de `ToolCallEventResult`. */
export interface ToolCallGuardDecision {
  block?: boolean;
  reason?: string;
}

/**
 * Handler `tool_call` : ne s'applique QU'à l'outil `bash`, ne bloque que sur un
 * verdict explicite, et NE PLANTE JAMAIS (toute erreur → laisser passer + tracer).
 */
export function guardBashToolCall(
  event: ToolCallLike | undefined,
  options?: { log?: (message: string) => void },
): ToolCallGuardDecision | undefined {
  try {
    if (!event || event.toolName !== "bash") return undefined;
    const command = event.input?.["command"];
    if (typeof command !== "string" || command === "") return undefined;
    const verdict = assertGitSafe(command);
    if (!verdict.block) return undefined;
    try {
      options?.log?.(`[bash-guard] appel bash bloqué : ${command.slice(0, 200).replace(/\s+/g, " ")}`);
    } catch {
      /* le log ne doit jamais faire échouer le garde-fou */
    }
    return { block: true, reason: verdict.reason };
  } catch (e: any) {
    try {
      options?.log?.(`[bash-guard] erreur interne (appel laissé passer) : ${e?.message || e}`);
    } catch {
      /* ignore */
    }
    return undefined;
  }
}
