import { simpleGit, type SimpleGit, type LogResult } from "simple-git";
import { existsSync, readdirSync, mkdirSync, statSync, unlinkSync, readFileSync, readlinkSync, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Project } from "./manager.js";
import { Mutex } from "../utils/mutex.js";
import { updateProjectGit } from "./manager.js";
import { credentialStore } from "./credential-store.js";
import { sanitizeRemoteUrl } from "./remote-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Empêche git de demander des identifiants sur stdin (sinon il attend indéfiniment).
// ⚠️ INSUFFISANT À LUI SEUL : cette variable posée sur `process.env` n'atteint PAS
// l'enfant git, car simple-git retire les variables `GIT_*` ambiantes (sauf si elles
// sont nommées dans `allowEnvironment`). Ce n'est qu'un filet pour les processus
// lancés hors simple-git ; la garantie réelle est `gitInstance()` ci-dessous.
process.env.GIT_TERMINAL_PROMPT = "0";

// ── Lock file cleanup ──────────────────────────
// BUG-04 (Lot A) : on ne supprime plus un verrou sur le seul critère d'ÂGE.
// Un .git/index.lock n'est détenu que par un processus git : tant qu'un
// processus git est actif sur ce dépôt (scan /proc, Linux), le verrou est
// légitime. Sinon, et uniquement si l'âge dépasse un seuil TRÈS conservateur,
// on considère le verrou orphelin (git planté) et on le retire en dernier recours.
const LOCK_STALE_MS = 5 * 60_000; // 5 minutes — seuil conservateur (dernier recours)
export { LOCK_STALE_MS };

/**
 * Y a-t-il un processus git actif dont le répertoire courant est ce dépôt ?
 * Scan /proc (Linux) : comm du processus + readlink du cwd. Si /proc est
 * indisponible (non-Linux), on ne détecte rien et le nettoyage retombe sur
 * le seul critère d'âge (comportement antérieur, conservateur).
 */
export function hasActiveGitProcessInRepo(cwd: string): boolean {
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc");
  } catch {
    return false; // /proc indisponible (macOS, CI minimaliste) → pas d'info
  }
  let repoRoot = "";
  try {
    repoRoot = realpathSync(cwd); // /proc/<pid>/cwd expose le chemin RÉEL
  } catch {
    return false; // dépôt disparu ou inaccessible → pas de processus détectable
  }
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    let comm = "";
    try {
      comm = readFileSync(`/proc/${entry}/comm`, "utf-8").trim();
    } catch {
      continue; // processus disparu ou illisible
    }
    // "git", "git-remote-https", "git-credential-…" (comm tronqué à 15 chars)
    if (!comm.startsWith("git")) continue;
    let procCwd = "";
    try {
      procCwd = readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      continue; // processus terminé entre-temps ou sans droit de lecture
    }
    if (procCwd === repoRoot || procCwd.startsWith(repoRoot + "/")) return true;
  }
  return false;
}

/**
 * Nettoie un verrou git orphelin. Retourne true si un verrou a été supprimé.
 * Ne supprime JAMAIS sans preuve raisonnable qu'il est orphelin : aucun
 * processus git actif sur le dépôt ET âge au-delà du seuil conservateur.
 * En cas d'échec du stat (état du verrou inconnu), lève une erreur explicite
 * au lieu de supprimer à l'aveugle (ancien comportement, BUG-04).
 */
export function cleanupGitLock(cwd: string): boolean {
  const lockFile = path.join(cwd, ".git", "index.lock");
  if (!existsSync(lockFile)) return false;
  let stat;
  try {
    stat = statSync(lockFile);
  } catch (e: any) {
    if (e?.code === "ENOENT") return false; // verrou disparu entre-temps (course)
    // Stat impossible (permissions, FS corrompu) : état inconnu → on ne
    // supprime JAMAIS à l'aveugle ; on remonte une erreur explicite.
    throw new Error(
      `[git] Impossible de statuer sur le verrou ${lockFile} (${e?.message || e}) — verrou conservé, opération annulée.`
    );
  }
  const age = Date.now() - stat.mtimeMs;
  // 1) Un processus git est-il actif sur ce dépôt ? Si oui, le verrou est
  //    possiblement légitime — on n'y touche pas.
  if (hasActiveGitProcessInRepo(cwd)) {
    console.log(`[git] Lock file present but a git process is active in ${cwd}, leaving it`);
    return false;
  }
  // 2) Dernier recours : aucun processus git actif + âge très conservateur.
  if (age > LOCK_STALE_MS) {
    try {
      unlinkSync(lockFile);
      console.log(
        `[git] Removed orphaned lock file (${Math.round(age / 1000)}s old, no active git process): ${lockFile}`
      );
      return true;
    } catch (e: any) {
      // Échec de suppression : on NE masque pas — l'opération git échouera avec
      // son propre message explicite sur le verrou.
      console.error(`[git] Failed to remove lock file ${lockFile}: ${e?.message || e}`);
      return false;
    }
  }
  // Verrou récent — un autre processus git pourrait avoir besoin du dépôt.
  console.log(`[git] Lock file is recent (${Math.round(age / 1000)}s), leaving it`);
  return false;
}

/** Check if an error is a git lock conflict */
function isLockError(msg: string): boolean {
  return msg.includes("index.lock") || msg.includes("Unable to create");
}

// Default timeout for git operations that may hang (push, pull, clone, etc.)
const GIT_NETWORK_TIMEOUT_MS = 30_000;

// Délai maximal d'attente du MUTEX par dépôt. Strictement supérieur au timeout
// d'une opération git : une opération coincée libère la place avec un message
// au lieu de bloquer le dépôt indéfiniment.
const GIT_MUTEX_ACQUIRE_TIMEOUT_MS = GIT_NETWORK_TIMEOUT_MS + 30_000;

/**
 * Variables d'environnement `GIT_*` que simple-git doit laisser passer.
 *
 * ⚠️ CAUSE RACINE du faux « timeout réseau » de 30 s au push : simple-git 4
 * SUPPRIME les variables `GIT_*` de l'environnement ambiant, sauf si elles sont
 * nommées dans `allowEnvironment` — et il REFUSE un `.env()` qui les contient
 * sans autorisation (« Use of "GIT_TERMINAL_PROMPT" is blocked by the
 * environment guard »). Le `process.env.GIT_TERMINAL_PROMPT = "0"` posé en tête
 * de ce module n'atteignait donc JAMAIS l'enfant : dans le conteneur (docker
 * compose `tty: true` / `stdin_open: true`), git ouvrait /dev/tty et attendait
 * un mot de passe → 30 s de blocage, puis un message qui accusait le réseau.
 */
const GIT_ENV_GUARD_ALLOW: readonly string[] = ["GIT_TERMINAL_PROMPT"];

/**
 * Crée une instance simple-git correctement configurée — TOUTE instance de ce
 * module passe par ici (aucun `simpleGit(` nu).
 *
 * - `allowEnvironment: ["GIT_TERMINAL_PROMPT"]` : autorise la variable à
 *   traverser le garde-fou de simple-git ;
 * - `.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })` : la fixe explicitement
 *   à "0" pour l'enfant → git échoue IMMÉDIATEMENT (« could not read
 *   Username »), message classé GIT_AUTH_REQUIRED → modale d'identifiants,
 *   au lieu d'un faux timeout de 30 s ;
 * - `timeout: { block }` : timeout OFFICIEL de simple-git, qui TUE réellement le
 *   process enfant après N ms sans aucune sortie (l'ancien
 *   `_executor.childProcess.kill()` ne tuait RIEN : ce champ n'existe pas dans
 *   simple-git 4).
 */
export function gitInstance(cwdOrBase: string, blockTimeoutMs: number = GIT_NETWORK_TIMEOUT_MS): SimpleGit {
  return simpleGit({
    baseDir: cwdOrBase,
    allowEnvironment: [...GIT_ENV_GUARD_ALLOW],
    timeout: { block: blockTimeoutMs },
  }).env({ ...process.env, GIT_TERMINAL_PROMPT: "0" });
}

/** Levée quand git n'a produit AUCUNE sortie pendant le délai maximal. */
export class GitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitTimeoutError";
  }
}

/**
 * Message HONNÊTE d'un timeout : git n'a pas répondu, et la cause la plus
 * probable — de très loin — est qu'il attend des identifiants. L'ancien texte
 * (« network unreachable or port blocked ») envoyait l'utilisateur sur une
 * fausse piste : le réseau n'y était pour rien.
 */
function gitTimeoutMessage(label: string, ms: number): string {
  return (
    `${label} did not answer within ${Math.round(ms / 1000)}s — git is probably waiting for ` +
    `credentials (interactive prompts are disabled). Check the token stored for this host, ` +
    `then retry.`
  );
}

/** Timeout du plugin `timeout.block` de simple-git (« block timeout reached »). */
function isBlockTimeoutError(error: any): boolean {
  const msg = String(error?.message || "").toLowerCase();
  return error?.plugin === "timeout" || msg.includes("block timeout");
}

/**
 * Per-project mutex to prevent concurrent git operations
 * from racing on credential injection/restoration.
 *
 * ⚠️ Délai maximal d'attente : sans lui, une opération coincée (git qui attend
 * un mot de passe) bloquait TOUTES les opérations suivantes du dépôt, sans
 * message.
 */
const gitMutexByCwd = new Map<string, Mutex>();
function getGitMutex(cwd: string): Mutex {
  let m = gitMutexByCwd.get(cwd);
  if (!m) {
    m = new Mutex({ acquireTimeoutMs: GIT_MUTEX_ACQUIRE_TIMEOUT_MS });
    gitMutexByCwd.set(cwd, m);
  }
  return m;
}

// ── Types ──────────────────────────────────────────────

export interface GitStatusFull {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  deleted: string[];
  created: string[];
  conflict: string[];
  files: Array<{ path: string; status: string }>;
  isClean: boolean;
}

export interface GitStatusNotRepo {
  notRepo: true;
  isEmpty: boolean;
}

export type GitStatusResult = GitStatusFull | GitStatusNotRepo;

// ── Helpers ────────────────────────────────────────────

function isEmptyDir(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath);
    return entries.filter((e: string) => !e.startsWith(".")).length === 0;
  } catch {
    return false;
  }
}

// ── Git operations ─────────────────────────────────────

export async function detectGit(project: Project): Promise<{
  hasGit: boolean;
  remote: string;
  branch: string;
}> {
  const gitPath = path.join(project.cwd, ".git");
  if (!existsSync(gitPath)) {
    return { hasGit: false, remote: "", branch: "" };
  }

  try {
    const git: SimpleGit = gitInstance(project.cwd);
    const remotes = await git.getRemotes(true);
    const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
    const origin = remotes.find((r) => r.name === "origin");

    return {
      hasGit: true,
      remote: origin?.refs?.fetch || "",
      branch: branch.trim(),
    };
  } catch {
    return { hasGit: false, remote: "", branch: "" };
  }
}

export async function getGitHistory(
  cwd: string,
  maxCount: number = 20
): Promise<
  Array<{
    hash: string;
    date: string;
    message: string;
    author: string;
  }>
> {
  const git: SimpleGit = gitInstance(cwd);
  try {
    const log: LogResult = await git.log({ maxCount });
    return log.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name,
    }));
  } catch {
    return [];
  }
}

/**
 * Get unified diff of all changes (staged + unstaged).
 * Used for AI commit message generation. Truncated to ~8KB.
 */
/**
 * Get the list of files changed (staged + unstaged) relative to HEAD.
 * Returns an array of file paths. Empty if no changes or not a git repo.
 */
export async function getChangedFiles(cwd: string): Promise<string[]> {
  const git: SimpleGit = gitInstance(cwd);
  try {
    const status = await git.status();
    const files: string[] = [];
    for (const f of status.files) {
      // status.files includes staged, unstaged, untracked, etc.
      if (f.path) files.push(f.path);
    }
    return [...new Set(files)]; // dedup
  } catch {
    return [];
  }
}

export async function getGitDiff(cwd: string): Promise<string> {
  const git: SimpleGit = gitInstance(cwd);
  try {
    // Get staged and unstaged diffs. Use HEAD for staged if there are commits.
    let staged = "";
    let unstaged = "";

    // staged diff: git diff --staged (or --cached HEAD for newer repos)
    try {
      staged = await git.diff(["--staged"]);
    } catch {
      // Repo may not have any commits yet
      try {
        staged = await git.diff(["--cached"]);
      } catch {
        // silent — no staged changes
      }
    }

    // unstaged working tree diff
    try {
      unstaged = await git.diff();
    } catch {
      // silent — no unstaged changes
    }

    let combined = "";
    if (staged && staged.trim()) combined += "Staged changes:\n" + staged + "\n";
    if (unstaged && unstaged.trim()) combined += "Unstaged changes:\n" + unstaged;

    if (!combined.trim()) {
      return "No changes detected in the working tree.";
    }

    if (combined.length > 8000) {
      combined = combined.slice(0, 8000) + "\n... (truncated)";
    }
    return combined;
  } catch {
    return "Unable to retrieve git diff (repository error).";
  }
}

export async function gitPull(cwd: string): Promise<string> {
  return getGitMutex(cwd).run(async () => {
    cleanupGitLock(cwd);
    return withAskpassTempFile(cwd, async () => {
      const git: SimpleGit = await gitWithAuth(cwd);
      try {
        // Timeout RÉEL : l'instance porte `timeout: { block }` (cf. gitInstance),
        // qui tue le process enfant. Plus de `withTimeout` (il ne tuait rien).
        const result = await git.pull();
        return result.summary.changes
          ? `${result.summary.changes} change(s), ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`
          : "Already up to date";
      } catch (error: any) {
        const msg = error.message || "";
        throw classifyGitFailure("Git pull", msg, await readRemoteUrl(cwd), error);
      } finally {
        try {
          await restoreRemoteUrl(cwd);
        } catch (e: any) {
          console.error(`[git] CRITICAL: Failed to restore remote URL after pull. Credentials may be leaked! cwd=${cwd}`, e.message);
        }
      }
    });
  });
}

export async function gitPush(cwd: string): Promise<string> {
  return getGitMutex(cwd).run(async () => {
    cleanupGitLock(cwd);
    return withAskpassTempFile(cwd, async () => {
      const git: SimpleGit = await gitWithAuth(cwd);
      try {
        // Timeout RÉEL : l'instance porte `timeout: { block }` (cf. gitInstance),
        // qui tue le process enfant. Plus de `withTimeout` (il ne tuait rien).
        const result = await git.push();
        return result.pushed
          ? `Pushed ${result.pushed.length} ref(s)`
          : "Nothing to push";
      } catch (error: any) {
        const msg = error.message || "";
        // Non-fast-forward : le distant a avancé → action utilisateur explicite.
        if (isNonFastForwardMessage(msg)) {
          const branch = await currentBranchSafe(cwd);
          throw new GitPushRejectedError(
            `Push rejected: the remote repository has commits you do not have, and it will not accept this push. ` +
            `Pull first (git pull --rebase origin ${branch}), then push again.`
          );
        }
        throw classifyGitFailure("Git push", msg, await readRemoteUrl(cwd), error);
      } finally {
        try {
          await restoreRemoteUrl(cwd);
        } catch (e: any) {
          console.error(`[git] CRITICAL: Failed to restore remote URL after push. Credentials may be leaked! cwd=${cwd}`, e.message);
        }
      }
    });
  });
}

// ── Commit message generation ─────────────────────────

function generateCommitMessage(status: GitStatusFull): { subject: string; body: string } {
  const { created, modified, deleted, staged, files } = status;

  const allChanged = [...new Set([...staged, ...modified, ...created, ...deleted])];
  if (allChanged.length === 0) {
    return { subject: "chore: no changes", body: "No changes to commit." };
  }

  // ── Build changelog body ──
  const lines: string[] = [];
  if (created.length > 0) {
    lines.push("Added:");
    for (const f of created) lines.push(`  + ${f}`);
  }
  if (modified.length > 0 || staged.length > 0) {
    lines.push("Modified:");
    for (const f of [...new Set([...staged, ...modified])]) lines.push(`  ~ ${f}`);
  }
  if (deleted.length > 0) {
    lines.push("Removed:");
    for (const f of deleted) lines.push(`  - ${f}`);
  }

  const body = lines.join("\n");

  // ── Generate short subject ──
  // Heuristic: find common directory prefix of changed files
  const allFiles = files.map((f) => f.path);
  const dirs = allFiles
    .map((f) => {
      const parts = f.split("/");
      return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    })
    .filter((d, i, arr) => arr.indexOf(d) === i);

  // Derive a concise area name
  const area =
    dirs.length === 1 && dirs[0] !== "."
      ? dirs[0].split("/").pop()!
      : dirs.length <= 2
        ? dirs.map((d) => d === "." ? "root" : d.split("/").pop()).join(", ")
        : `${allFiles.length} files across ${dirs.length} dirs`;

  // Choose action verb
  let verb: string;
  if (created.length > 0 && modified.length === 0 && deleted.length === 0) {
    verb = "Add";
  } else if (deleted.length > 0 && modified.length === 0 && created.length === 0) {
    verb = "Remove";
  } else {
    verb = "Update";
  }

  const total = allChanged.length;
  const subject =
    total === 1
      ? `${verb} ${area}: ${allChanged[0].split("/").pop()}`
      : `${verb} ${area}: ${total} changes`;

  return { subject: subject.slice(0, 72), body };
}

export async function gitAddAll(cwd: string): Promise<number> {
  // Audit mutex (Lot A/BUG-04) : gitAddAll écrit l'index → même mutex par projet.
  // Appelé par gitCommitAndPush SANS détenir le mutex → pas de deadlock.
  return getGitMutex(cwd).run(async () => {
    cleanupGitLock(cwd);
    const git: SimpleGit = gitInstance(cwd);
    await git.add("-A");
    const status = await git.status();
    return status.staged.length || status.files.length;
  });
}

export class GitIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitIdentityError";
  }
}

export class GitAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitAuthError";
  }
}

/**
 * L'origin du dépôt n'est pas en HTTPS (`git@host:owner/repo.git`, `ssh://…`).
 *
 * Pi-Web n'authentifie que par token inséré dans une URL HTTPS : sur un remote
 * SSH, les identifiants stockés ne peuvent PAS être transmis (aucune clé SSH
 * n'est gérée par l'application). On refuse donc explicitement, avec une
 * commande de correction, plutôt que de réécrire le remote en silence — et on
 * ne présente plus cela comme une « erreur d'authentification » (une saisie de
 * token ne peut pas la corriger).
 */
export class GitRemoteSchemeError extends Error {
  constructor(message: string, readonly remoteUrl?: string, readonly httpsUrl?: string) {
    super(message);
    this.name = "GitRemoteSchemeError";
  }
}

/**
 * Le dépôt distant est injoignable (DNS, firewall, port SSH filtré, timeout).
 * Distinct de GitAuthError : aucun identifiant ne corrige un problème réseau.
 */
export class GitUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUnreachableError";
  }
}

/**
 * Push refusé par le serveur (non-fast-forward / [rejected]) : le distant a des
 * commits que le local n'a pas. Action utilisateur requise (pull --rebase).
 */
export class GitPushRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitPushRejectedError";
  }
}

/**
 * Vrai uniquement pour une VRAIE erreur d'authentification (le token est
 * refusé ou absent). `Permission denied` (SSH) et `timed out` (réseau) en sont
 * volontairement EXCLUS : ils sont désormais routés vers
 * GitRemoteSchemeError / GitUnreachableError (cf. classifyGitFailure).
 */
function isAuthError(msg: string): boolean {
  return (
    msg.includes("could not read Username") ||
    msg.includes("Authentication failed") ||
    msg.includes("403") ||
    msg.includes("credential") ||
    msg.includes("fatal: could not read")
  );
}

/** Échec côté SSH (clé publique) : un token HTTPS n'y changerait rien. */
function isSshFailureMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("permission denied (publickey)") ||
    m.includes("host key verification failed") ||
    m.includes("could not open a connection to your authentication agent") ||
    (m.includes("permission denied") && m.includes("ssh"))
  );
}

/** Distant injoignable / opération coupée par le timeout. */
function isUnreachableMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("could not resolve host") ||
    m.includes("connection refused") ||
    m.includes("connection reset") ||
    m.includes("network is unreachable") ||
    m.includes("no route to host") ||
    m.includes("failed to connect") ||
    m.includes("unable to access")
  );
}

/** Push rejeté : le distant a avancé (non-fast-forward). */
function isNonFastForwardMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("non-fast-forward") ||
    m.includes("[rejected]") ||
    m.includes("updates were rejected") ||
    m.includes("fetch first") ||
    m.includes("remote contains work")
  );
}

/**
 * Extrait le hostname d'une URL de remote SANS lancer de commande git.
 *
 * La clé du credentialStore est le HOSTNAME nu (« github.com »), partagé par
 * TOUS les dépôts de cet hôte : c'est cette valeur que l'UI doit afficher
 * quand elle prévient qu'« oublier » concerne tout l'hôte.
 * Renvoie null si l'URL est vide/illisible.
 */
export function hostFromRemoteUrl(remote: string | null | undefined): string | null {
  const url = (remote || "").trim();
  if (!url) return null;
  // HTTPS / git:// / file:// … : URL standard.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^ssh:\/\//i.test(url)) {
    try {
      const hostname = new URL(url).hostname;
      return hostname ? hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  // SSH: ssh://git@host/path ou git@host:path (sans schéma).
  const sshMatch = url.match(/^(?:ssh:\/\/)?(?:[^@/:]+@)?([^:/]+)[:/]/);
  return sshMatch ? sshMatch[1].toLowerCase() : null;
}

/**
 * Extract the hostname from the git remote URL.
 *
 * ⚠️ SOURCE UNIQUE de la clé d'hôte : délègue à `hostFromRemoteUrl` (la même
 * fonction que celle utilisée par l'injection d'identifiants dans
 * `gitWithAuth`). Avant, l'écriture (ici) et la lecture (extractHost) étaient
 * deux implémentations distinctes : une URL encore porteuse d'un jeton donnait
 * `user:token@github.com` à la lecture (≠ clé du store `github.com`) et le push
 * partait SANS jeton, en silence.
 */
export async function getRemoteHost(cwd: string): Promise<string> {
  try {
    const git: SimpleGit = gitInstance(cwd);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    if (!origin?.refs?.fetch) {
      console.log(`[git] getRemoteHost: no origin remote, defaulting to github.com`);
      return "github.com";
    }
    const host = hostFromRemoteUrl(origin.refs.fetch);
    if (!host) {
      console.log(`[git] getRemoteHost: could not parse URL, defaulting to github.com`);
      return "github.com";
    }
    console.log(`[git] getRemoteHost: host=${host}`);
    return host;
  } catch {
    console.log(`[git] getRemoteHost: not a git repo (no .git), defaulting to github.com`);
    return "github.com";
  }
}

/**
 * Exécute fn() avec un temp file GIT_ASKPASS transitoire si des credentials
 * existent pour le host du dépôt. Le fichier est écrit avant l'opération et
 * supprimé en finally (via credentialStore.withTempFile).
 */
async function withAskpassTempFile<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const host = await getRemoteHost(cwd);
  if (host && credentialStore.has(host)) {
    const creds = credentialStore.get(host)!;
    return credentialStore.withTempFile(host, creds.username, creds.password, fn);
  }
  return fn();
}

/**
 * true si l'URL du remote est en HTTPS (seul schéma où Pi-Web sait injecter un token).
 */
export function isHttpsRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * Convertit une URL de remote SSH en son équivalent HTTPS (suggestion affichée
 * à l'utilisateur ; le remote n'est JAMAIS réécrit automatiquement).
 *
 *   git@github.com:owner/repo.git      → https://github.com/owner/repo.git
 *   ssh://git@github.com/owner/repo.git → https://github.com/owner/repo.git
 */
export function sshRemoteToHttps(url: string): string | null {
  const trimmed = url.trim();
  const scpLike = trimmed.match(/^git@([^:/]+):(.+)$/);
  if (scpLike) return `https://${scpLike[1]}/${scpLike[2]}`;
  const sshUrl = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (sshUrl) return `https://${sshUrl[1]}/${sshUrl[2]}`;
  return null;
}

/**
 * Message actionnable pour un remote non-HTTPS : dit ce qui se passe et donne
 * la commande exacte à exécuter (URL sans identifiants embarqués).
 */
export function buildRemoteSchemeMessage(remoteUrl: string): string {
  const safeUrl = redactUrl(remoteUrl);
  const httpsUrl = sshRemoteToHttps(remoteUrl);
  const command = httpsUrl
    ? `git remote set-url origin ${httpsUrl}`
    : "git remote set-url origin https://<host>/<owner>/<repo>.git";
  return (
    `This repository's origin uses SSH (${safeUrl}). ` +
    `Pi-Web authenticates with a personal token over HTTPS and cannot send it over SSH. ` +
    `Switch origin to HTTPS, then retry: ${command}`
  );
}

/** Lit l'URL de l'origin sans lever d'erreur (null si non disponible). */
async function readRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const url = (await gitInstance(cwd).raw(["remote", "get-url", "origin"])).trim();
    return url || null;
  } catch {
    return null;
  }
}

/** Nom de la branche courante, pour un message de correction (« pull --rebase origin <branche> »). */
async function currentBranchSafe(cwd: string): Promise<string> {
  try {
    const branch = (
      await gitInstance(cwd).raw(["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // pas de commit / pas un dépôt — repli ci-dessous
  }
  return "main";
}

/**
 * Transforme un échec git en erreur typée, pour que la route réponde
 * un code DISTINCT par cause (plus de « tout est un problème de token »).
 *
 * @param error erreur brute (facultative) : elle seule porte le marqueur
 *   `plugin: "timeout"` du timeout `block` de simple-git, qu'un message
 *   "block timeout reached" ne suffit pas à identifier de façon fiable.
 */
function classifyGitFailure(label: string, msg: string, remoteUrl?: string | null, error?: any): Error {
  // Timeout RÉEL (process tué par le plugin `timeout.block` de simple-git) :
  // message honnête, sans jamais accuser le réseau.
  if (isBlockTimeoutError(error) || isBlockTimeoutError({ message: msg })) {
    return new GitTimeoutError(gitTimeoutMessage(label, GIT_NETWORK_TIMEOUT_MS));
  }
  // Ordre important : « unable to access … 403 » est une erreur d'IDENTIFIANTS
  // (le serveur a répondu), donc l'auth est testée avant l'injoignabilité.
  if (isSshFailureMessage(msg)) {
    return new GitRemoteSchemeError(
      buildRemoteSchemeMessage(remoteUrl || "git@<host>:<owner>/<repo>.git"),
      remoteUrl || undefined,
      sshRemoteToHttps(remoteUrl || "") || undefined
    );
  }
  if (isAuthError(msg)) {
    return new GitAuthError(`${label} authentication failed: ${msg}`);
  }
  if (isUnreachableMessage(msg)) {
    return new GitUnreachableError(`${label} failed: the remote did not answer (${msg})`);
  }
  return new Error(`${label} failed: ${msg}`);
}

/**
 * Create a simple-git instance with credentials embedded in the remote URL.
 *
 * Instead of GIT_ASKPASS (blocked by git >=2.36 unless allowUnsafeAskPass
 * is set), we rewrite the remote URL to include the token:
 *
 *   https://x-access-token:TOKEN@github.com/user/repo.git
 *
 * This works with GitHub, GitLab, Bitbucket personal access tokens.
 *
 * Refus explicite si l'origin n'est pas HTTPS (SSH) : voir GitRemoteSchemeError.
 * On ne convertit JAMAIS le remote en silence (le protocole d'un dépôt ne se
 * change pas dans le dos de l'utilisateur).
 */
async function gitWithAuth(cwd: string): Promise<SimpleGit> {
  const git = gitInstance(cwd);

  let remoteUrl: string;
  try {
    remoteUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
  } catch (e: any) {
    console.log(`[git] gitWithAuth: no origin remote (${e?.message || e}) — proceeding without auth`);
    return git;
  }

  // ⚠️ MÊME fonction que celle utilisée pour écrire dans le store
  // (`getRemoteHost`) : la clé lue et la clé écrite sont forcément identiques.
  // L'ancien `extractHost` renvoyait `user:token@github.com` sur une URL encore
  // porteuse d'un jeton → `hasCreds` faux → push SANS jeton, sans un mot.
  const host = hostFromRemoteUrl(remoteUrl);
  const hasCreds = !!host && credentialStore.has(host);
  console.log(`[git] gitWithAuth: remoteUrl=${redactUrl(remoteUrl)}, host=${host}, hasCreds=${hasCreds}`);

  if (!host || !hasCreds) {
    // Pas d'identifiants pour cet hôte : on tente sans auth (l'échec éventuel
    // sera classé par classifyGitFailure → GIT_AUTH_REQUIRED / GIT_REMOTE_SCHEME).
    // ⚠️ On ne part plus en silence : si des identifiants existent pour d'AUTRES
    // hôtes, c'est très probablement la cause de l'échec à venir → avertissement.
    warnIfCredentialsForOtherHost(remoteUrl, host);
    return git;
  }

  // Remote SSH + identifiants stockés : le token ne peut pas passer → refus net.
  if (!isHttpsRemoteUrl(remoteUrl)) {
    throw new GitRemoteSchemeError(
      buildRemoteSchemeMessage(remoteUrl),
      remoteUrl,
      sshRemoteToHttps(remoteUrl) || undefined
    );
  }

  const creds = credentialStore.get(host)!;
  const authUrl = injectCredentialsInUrl(remoteUrl, creds.username, creds.password);
  console.log(`[git] gitWithAuth: injecting credentials, result=${redactUrl(authUrl)}`);
  // Temporarily set the remote URL with credentials for this operation
  await git.raw(["remote", "set-url", "origin", authUrl]);
  // Git 2.38+ may reject credentials in URLs — explicitly allow it
  try {
    await git.raw(["config", "transfer.credentialsInUrl", "allow"]);
  } catch {
    // config may not support this option (older git), ignore
  }
  // Return the git instance (caller will use it for pull/push/etc)
  return git;
}

// BUG-15 fix: regex robuste qui matche du : jusqu'au DERNIER @ (pas le premier)
// Si le password contient un @, l'ancien regex /:[^@]+@/ laissait une partie du credential
function redactUrl(url: string): string {
  return url.replace(/:[^@]*@(?=[^@]*$)/, ":****@");
}

/**
 * Avertit quand des identifiants existent — mais pour un AUTRE hôte que celui du
 * remote. C'est le symptôme exact du bug « push sans jeton en silence » : rien
 * n'était journalisé, donc invisible. Aucune valeur secrète n'est loggée
 * (uniquement des noms d'hôtes).
 */
function warnIfCredentialsForOtherHost(remoteUrl: string, host: string | null): void {
  try {
    const stored = credentialStore.listHosts();
    if (stored.length === 0) return;
    if (host && stored.includes(host)) return;
    console.warn(
      `[git] WARNING: credentials are stored for [${stored.join(", ")}] but the origin host is ` +
      `'${host ?? "unparsable"}' (remote=${redactUrl(remoteUrl)}) — this operation runs WITHOUT a token. ` +
      `Re-save the credentials for this host.`
    );
  } catch (e: any) {
    console.warn(`[git] warnIfCredentialsForOtherHost failed: ${e?.message || e}`);
  }
}

/**
 * Inject credentials into a git remote URL.
 *
 * For GitHub tokens, the username is typically "x-access-token" or the actual username,
 * and the password/token goes in the password field.
 *
 * Examples:
 *   https://github.com/user/repo.git → https://x-access-token:TOKEN@github.com/user/repo.git
 *   https://user@github.com/user/repo.git → https://x-access-token:TOKEN@github.com/user/repo.git
 *
 * ⚠️ Les identifiants DÉJÀ présents sont retirés avant l'injection. L'ancienne
 * implémentation laissait passer le cas « URL déjà porteuse des MÊMES
 * identifiants » : le remplacement renvoyait l'URL inchangée, le code croyait
 * qu'il n'y en avait aucun et préfixait → `user:token@user:token@host` (userinfo
 * malformé).
 */
function injectCredentialsInUrl(url: string, username: string, password: string): string {
  const userInfo = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  // Le userinfo est tout ce qui précède le DERNIER @ de l'autorité, sans « / ».
  return url.replace(/^(https?:\/\/)(?:[^/@]+@)?/i, (_m, protocol: string) => `${protocol}${userInfo}`);
}

/**
 * Remove credentials from a git remote URL (restore original).
 * Call this after any authenticated git operation.
 */
export async function restoreRemoteUrl(cwd: string): Promise<void> {
  const git = gitInstance(cwd);
  try {
    const remoteUrl = (await git.raw(["remote", "get-url", "origin"])).trim();
    // Strip credentials: https://user:pass@host → https://host
    const cleanUrl = sanitizeRemoteUrl(remoteUrl);
    if (cleanUrl !== remoteUrl) {
      await git.raw(["remote", "set-url", "origin", cleanUrl]);
    }
  } catch {
    // Not a git repo — ignore
  }
}

/**
 * Store git credentials for HTTPS auth in memory (not on disk).
 * Credentials are written to a per-host temp file (0600) that the
 * GIT_ASKPASS helper reads during git operations. These temp files
 * are cleaned up when credentials are removed or on process exit.
 *
 * No credential.helper store or ~/.git-credentials is used — this avoids
 * the allowUnsafeCredentialHelper restriction entirely.
 */
export async function setGitCredentials(
  cwd: string,
  username: string,
  password: string
): Promise<void> {
  const host = await getRemoteHost(cwd);
  console.log(`[git] setGitCredentials: host=${host}, username=${username}`);
  credentialStore.set(host, username, password);
  // Credentials are now injected into remote URLs at operation time
  // (no ASKPASS script needed with git >= 2.36)
}

export async function getGitIdentity(cwd: string): Promise<{ name: string; email: string } | null> {
  const git: SimpleGit = gitInstance(cwd);
  // Check repo-local config first, then global
  for (const scope of ["local", "global"] as const) {
    try {
      const scopeFlag = scope === "global" ? ["--global"] : [];
      const name = (await git.raw([...scopeFlag, "config", "user.name"])).trim();
      const email = (await git.raw([...scopeFlag, "config", "user.email"])).trim();
      if (name && email) return { name, email };
    } catch {}
  }
  return null;
}

export async function setGitIdentity(cwd: string, name: string, email: string): Promise<void> {
  // BUG-13 fix: ne configurer QUE le repo local, pas le global.
  // L'ancien code écrivait aussi dans --global, ce qui causait des conflits
  // quand plusieurs projets avaient des identités git différentes.
  const git: SimpleGit = gitInstance(cwd);
  await git.raw(["config", "user.name", name]);
  await git.raw(["config", "user.email", email]);
}

export async function gitCommit(
  cwd: string,
  subject: string,
  body?: string
): Promise<string> {
  // Audit mutex (Lot A/BUG-04) : gitCommit écrit l'index → même mutex par projet.
  return getGitMutex(cwd).run(async () => {
    cleanupGitLock(cwd);
    const git: SimpleGit = gitInstance(cwd);
    const message = body ? `${subject}\n\n${body}` : subject;
    try {
      const result = await git.commit(message);
      if (result.commit === null || result.summary.changes === 0) {
        return "Nothing to commit";
      }
      return `Committed ${result.summary.changes} change(s) as ${result.commit.slice(0, 7)}`;
    } catch (error: any) {
      const msg = error.message || "";
      if (isLockError(msg)) {
        // BUG-04 : cleanupGitLock peut désormais échouer explicitement (stat
        // impossible) — on ne masque pas, le retry échouera avec le message git.
        try { cleanupGitLock(cwd); } catch { /* verrou conservé, cf. message ci-dessus */ }
        try {
          const result = await git.commit(message);
          if (result.commit === null || result.summary.changes === 0) return "Nothing to commit";
          return `Committed ${result.summary.changes} change(s) as ${result.commit.slice(0, 7)} (lock cleared)`;
        } catch (e2: any) {
          throw new Error(`Git commit failed (lock persisted): ${e2.message || e2}`);
        }
      }
      if (msg.includes("author identity") || msg.includes("Please tell me who you are") || msg.includes("unable to auto-detect email address")) {
        // Try to inherit identity from global git config
        try {
          const globalIdentity = await getGitIdentity(cwd);
          if (globalIdentity) {
            await setGitIdentity(cwd, globalIdentity.name, globalIdentity.email);
            const result = await git.commit(message);
            if (result.commit === null || result.summary.changes === 0) return "Nothing to commit";
            return `Committed ${result.summary.changes} change(s) as ${result.commit.slice(0, 7)}`;
          }
        } catch {}
        throw new GitIdentityError(msg);
      }
      throw new Error(`Git commit failed: ${msg}`);
    }
  });
}

export interface CommitPushResult {
  staged: number;
  commitResult?: string;
  pushResult?: string;
  commitMessage?: { subject: string; body: string };
  commitHash?: string;
  remoteUrl?: string;
}

/**
 * Construit un statut "comme après `git add -A`" sans toucher au dépôt.
 * Utilisé par l'aperçu de commit pour montrer ce qui serait commité sans modifier
 * l'état du staging de l'utilisateur (l'ancien `git add -A` + `git reset` était
 * destructeur). On reste sur l'état réel si le dépôt est propre ou en conflit.
 */
function simulateCommitAllStatus(status: GitStatusFull): GitStatusFull {
  // On ne simule que lorsqu'un `git add -A` apporterait réellement un changement
  // (fichiers non suivis, modifiés ou supprimés hors index). Sinon, le statut réel
  // est déjà celui qui serait commité. En cas de conflit, on ne touche à rien et on
  // renvoie le statut réel pour ne surtout pas altérer l'état du merge.
  const hasUnstaged =
    status.modified.length > 0 || status.created.length > 0 || status.deleted.length > 0;
  if (status.isClean || status.conflict.length > 0 || !hasUnstaged) {
    return status;
  }

  // `f.status` est le code porcelain déjà trimé par getGitStatus
  // (ex. "A", "M", "D", "R" ou "??"). On en déduit le code index après add.
  const files = status.files
    .map((f) => {
      const idx = f.status[0] ?? " ";
      const ws = f.status[1] ?? " ";

      let newIdx: string;
      if (idx === "?" && ws === "?") {
        newIdx = "A"; // non-suivi → ajouté
      } else if (idx === "A") {
        newIdx = "A"; // déjà ajouté dans l'index, le restera
      } else if (idx === "D" || ws === "D") {
        newIdx = "D"; // suppression
      } else if (ws !== " " && ws !== "?") {
        newIdx = ws; // modification du worktree stagée telle quelle
      } else {
        newIdx = idx !== " " ? idx : "M";
      }

      return { path: f.path, status: newIdx };
    })
    // `git status` trie par chemin dans ce cas ; on reproduit l'ordre post-add.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Après un `git add -A`, toutes les modifications sont dans l'index.
  // getGitStatus range les suppressions dans `deleted` et le reste dans `staged`.
  const staged: string[] = [];
  const deleted: string[] = [];
  for (const f of files) {
    if (f.status === "D") deleted.push(f.path);
    else staged.push(f.path);
  }

  return {
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    staged,
    modified: [],
    deleted,
    created: [],
    conflict: status.conflict,
    files,
    isClean: false,
  };
}

export async function gitCommitPushPreview(
  cwd: string
): Promise<{ status: GitStatusFull; proposedMessage: { subject: string; body: string } }> {
  cleanupGitLock(cwd);
  const status = await getGitStatus(cwd);
  if ("notRepo" in status) {
    throw new Error("Not a git repository");
  }

  // Fix aperçu de commit : ne plus faire `git add -A` + `git reset` ici, car cela
  // dé-stage les modifications préalablement stagées par l'utilisateur. On simule
  // le statut "tout stagé" à partir du statut réel, sans effet de bord sur l'index.
  const effectiveStatus = simulateCommitAllStatus(status);

  const proposedMessage = generateCommitMessage(effectiveStatus);
  return { status: effectiveStatus, proposedMessage };
}

export async function gitCommitAndPush(
  cwd: string,
  subject?: string,
  body?: string
): Promise<CommitPushResult> {
  cleanupGitLock(cwd);
  const result: CommitPushResult = { staged: 0 };

  // 1. Get current status
  const status = await getGitStatus(cwd);
  if ("notRepo" in status) {
    throw new Error("Not a git repository");
  }

  // 2. If clean, just try to push existing commits
  if (status.isClean && status.staged.length === 0 &&
      status.modified.length === 0 && status.created.length === 0 &&
      status.deleted.length === 0) {
    // Nothing to commit, but maybe we have unpushed commits
    if (status.ahead > 0) {
      const pushResult = await gitPush(cwd);
      result.pushResult = pushResult;
      return result;
    }
    result.commitResult = "Nothing to commit";
    return result;
  }

  // 3. Stage all changes
  const stagedCount = await gitAddAll(cwd);
  result.staged = stagedCount;

  // 4. Re-read status after staging (now files are in the index)
  const statusAfterStaging = await getGitStatus(cwd);
  if ("notRepo" in statusAfterStaging) {
    throw new Error("Not a git repository");
  }

  // 5. Generate commit message (use custom if provided)
  const msg = subject
    ? { subject, body: body || "" }
    : generateCommitMessage(statusAfterStaging);
  result.commitMessage = msg;

  // 6. Commit
  const commitResult = await gitCommit(cwd, msg.subject, msg.body || undefined);
  result.commitResult = commitResult;

  // 6b. Get commit hash and remote URL
  try {
    const git: SimpleGit = gitInstance(cwd);
    const hashResult = await git.raw(["rev-parse", "--short", "HEAD"]);
    result.commitHash = hashResult.trim();
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r: any) => r.name === "origin");
    if (origin?.refs?.push) {
      result.remoteUrl = origin.refs.push;
    }
  } catch {
    // Non-critical
  }

  // 7. Push — AUCUN échec n'est avalé : répondre 200 avec un `pushResult`
  // « Push failed: … » faisait croire à un push réussi à l'UI (faux succès).
  // Toute erreur remonte donc à l'appelant avec son type (auth / SSH /
  // injoignable / push rejeté), et la route répond en erreur.
  result.pushResult = await gitPush(cwd);

  return result;
}

export async function gitCheckout(
  cwd: string,
  ref: string
): Promise<string> {
  // Audit mutex (Lot A/BUG-04) : checkout écrit l'index → même mutex par projet.
  return getGitMutex(cwd).run(async () => {
    const git: SimpleGit = gitInstance(cwd);
    try {
      await git.checkout(ref);
      return `Checked out ${ref}`;
    } catch (error: any) {
      throw new Error(`Git checkout failed: ${error.message}`);
    }
  });
}

export async function gitClone(
  cwd: string,
  remote: string,
  branch: string = "main"
): Promise<string> {
  const parentDir = path.dirname(cwd);
  const repoName = path.basename(cwd);

  console.log(`[git-clone] cwd=${cwd}, parentDir=${parentDir}, repoName=${repoName}`);
  console.log(`[git-clone] remote=${remote}, branch=${branch}`);

  // ⚠️ Même extraction d'hôte que `getRemoteHost` / `gitWithAuth` : la clé lue
  // ici doit être identique à celle écrite dans le store après la saisie du token.
  const host = hostFromRemoteUrl(remote) || "github.com";

  console.log(`[git-clone] Extracted host: ${host}, hasCredentials: ${credentialStore.has(host)}`);

  const git: SimpleGit = gitInstance(parentDir);

  // Inject credentials into remote URL if available
  if (host && credentialStore.has(host)) {
    const creds = credentialStore.get(host)!;
    console.log(`[git-clone] Found credentials for ${host}, username=${creds.username}`);
    // Temp file GIT_ASKPASS transitoire : vit pendant TOUTE la commande clone,
    // supprimé en finally (même en cas d'erreur/timeout).
    return credentialStore.withTempFile(host, creds.username, creds.password, async () => {
      const authUrl = injectCredentialsInUrl(remote, creds.username, creds.password);
      console.log(`[git-clone] Auth URL (redacted): ${redactUrl(authUrl)}`);
      try {
        // Git 2.38+ may reject credentials in URLs — explicitly allow it
        await git.raw(["-c", "transfer.credentialsInUrl=allow", "clone", authUrl, repoName, "--branch", branch]);
        console.log(`[git-clone] Clone succeeded!`);
        // Sécurité : git clone persiste l'URL fournie (avec token) dans le
        // .git/config du nouveau dépôt. On la remplace immédiatement par l'URL
        // nettoyée pour ne jamais laisser le token sur disque.
        try {
          const clonedGit = gitInstance(cwd);
          await clonedGit.raw(["remote", "set-url", "origin", sanitizeRemoteUrl(remote)]);
        } catch (e: any) {
          console.error(`[git-clone] Failed to sanitize cloned remote URL: ${e?.message || e}`);
        }
        return `Cloned ${remote} (${branch})`;
      } catch (error: any) {
        const msg = error.message || "";
        console.error(`[git-clone] Clone WITH auth FAILED: ${msg}`);
        throw classifyGitFailure("Git clone", msg, remote, error);
      }
    });
  }

  // No credentials — try without auth
  console.log(`[git-clone] No credentials for ${host}, trying without auth...`);
  try {
    // BUG-37 fix: utiliser git.raw() comme la branche avec auth pour cohérence
    await git.raw(["clone", remote, repoName, "--branch", branch]);
    console.log(`[git-clone] Clone succeeded (no auth)!`);
    // Sécurité : même sans auth, l'URL fournie peut contenir un token collé par
    // l'utilisateur. On nettoie le remote persisté dans le .git/config.
    try {
      const clonedGit = gitInstance(cwd);
      await clonedGit.raw(["remote", "set-url", "origin", sanitizeRemoteUrl(remote)]);
    } catch (e: any) {
      console.error(`[git-clone] Failed to sanitize cloned remote URL: ${e?.message || e}`);
    }
    return `Cloned ${remote} (${branch})`;
  } catch (error: any) {
    const msg = error.message || "";
    console.error(`[git-clone] Clone WITHOUT auth FAILED: ${msg}`);
    throw classifyGitFailure("Git clone", msg, remote, error);
  }
}

/**
 * Vérifie qu'une référence git existe sans lever d'erreur.
 * Utilisé par gitInit pour ne définir l'upstream que si c'est possible.
 */
async function gitRefExists(git: SimpleGit, ref: string): Promise<boolean> {
  try {
    await git.raw(["rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

export async function gitInit(cwd: string, remote: string, branch: string = "main"): Promise<string> {
  // Audit mutex (Lot A/BUG-04) : init + checkoutLocalBranch écrivent l'index
  // → même mutex par projet que les autres opérations sensibles.
  return getGitMutex(cwd).run(async () => {
    const git: SimpleGit = gitInstance(cwd);
    try {
      await git.init();
      // Sécurité : ne jamais persister de credentials dans le remote.
      await git.addRemote("origin", sanitizeRemoteUrl(remote));
      await git.checkoutLocalBranch(branch);

      // Fix gitInit : ne configurer l'upstream que si le dépôt a au moins un commit
      // ET que la ref distante existe. Sinon `git branch --set-upstream-to` échoue
      // sur un dépôt fraîchement initialisé (aucun commit) ou sans ref distante.
      const hasCommit = await gitRefExists(git, "HEAD");
      const hasRemoteRef = await gitRefExists(git, `origin/${branch}`);
      if (hasCommit && hasRemoteRef) {
        await git.raw(["branch", "--set-upstream-to", `origin/${branch}`, branch]);
      }

      return `Initialized repo, remote set to ${remote}`;
    } catch (error: any) {
      throw new Error(`Git init failed: ${error.message}`);
    }
  });
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  const gitPath = path.join(cwd, ".git");
  if (!existsSync(gitPath)) {
    return { notRepo: true, isEmpty: isEmptyDir(cwd) };
  }

  try {
    const git: SimpleGit = gitInstance(cwd);
    const status = await git.status();

    const staged: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const created: string[] = [];
    const conflict: string[] = [];
    const files: Array<{ path: string; status: string }> = [];

    for (const f of status.files) {
      const ws = f.working_dir;
      const idx = f.index;
      files.push({ path: f.path, status: `${idx}${ws}`.trim() || "?" });

      if (ws === "D" || idx === "D") deleted.push(f.path);
      else if (ws === "?" && idx === "?") created.push(f.path);
      else if (idx !== " " && idx !== "?") staged.push(f.path);
      else if (ws !== " ") modified.push(f.path);

      if (ws === "U" || idx === "U") conflict.push(f.path);
    }

    const unique = (arr: string[]) => [...new Set(arr)];

    return {
      branch: status.current || "unknown",
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      staged: unique(staged),
      modified: unique(modified),
      deleted: unique(deleted),
      created: unique(created),
      conflict: unique(conflict),
      files,
      isClean: status.isClean(),
    };
  } catch {
    return { notRepo: true, isEmpty: false };
  }
}

export async function syncGitInfo(project: Project): Promise<Project> {
  const info = await detectGit(project);
  if (info.hasGit) {
    return await updateProjectGit(project.id, {
      remote: info.remote,
      branch: info.branch,
      lastSync: new Date().toISOString(),
    });
  }
  return project;
}

/**
 * Purge de sécurité au boot : retire tout credential embarqué des URLs de
 * remote git, à la fois dans projects.json (remote stocké) et dans le
 * .git/config de chaque dépôt. Log un warning par remote nettoyé.
 *
 * Couvre :
 *  - les projets enregistrés (projects.json + .git/config de leur cwd) ;
 *  - les dépôts git présents sous les racines de travail (/projects) même s'ils
 *    ne sont pas enregistrés comme projets (ex: un clone fait hors Pi-Web).
 */
export async function purgeEmbeddedCredentialsFromRemotes(): Promise<void> {
  const { getAllProjects } = await import("./manager.js");
  const projects = getAllProjects();

  const cleanOnDisk = async (cwd: string, label: string): Promise<void> => {
    try {
      const git = gitInstance(cwd);
      const current = (await git.raw(["remote", "get-url", "origin"])).trim();
      const clean = sanitizeRemoteUrl(current);
      if (clean !== current) {
        console.warn(`[git] SECURITY: stripped embedded credentials from ${label} remote (${cwd})`);
        await git.raw(["remote", "set-url", "origin", clean]);
      }
    } catch {
      // pas un dépôt git ou pas de remote origin — ignorer
    }
  };

  // 1. Projets enregistrés
  for (const project of projects) {
    if (project.versioning !== "git" || !project.git?.remote) continue;
    const clean = sanitizeRemoteUrl(project.git.remote);
    if (clean !== project.git.remote) {
      console.warn(`[git] SECURITY: stripped embedded credentials from stored remote of project "${project.name}" (${project.id})`);
      await updateProjectGit(project.id, { remote: clean });
    }
    await cleanOnDisk(project.cwd, "project");
  }

  // 2. Dépôts sous /projects non enregistrés (ex: /projects/Talky)
  try {
    const roots = ["/projects", "/mnt/smb"];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const repoDir = path.join(root, entry.name);
        if (existsSync(path.join(repoDir, ".git"))) {
          await cleanOnDisk(repoDir, "unregistered");
        }
      }
    }
  } catch (e: any) {
    console.error(`[git] SECURITY purge: error scanning project roots: ${e?.message || e}`);
  }
}
