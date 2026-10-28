// ── Décisions d'erreur git côté client (PUR, testable sans DOM) ──────────────
// Contexte (correctif « boucle de re-prompt du token ») :
//  - une erreur d'authentification n'est PAS la seule cause possible : un origin
//    SSH, un réseau injoignable ou un push rejeté (non-fast-forward) ne se
//    corrigent pas en saisissant un token ;
//  - le message réel du backend doit TOUJOURS être affiché (avant, il était
//    remplacé par la modale, donc invisible) ;
//  - la modale n'est ouverte qu'un nombre BORNÉ de fois (MAX_AUTH_ATTEMPTS)
//    puis on rend la main à l'utilisateur (erreur + « Réessayer ») : plus de
//    relance automatique en boucle.

/** Nombre maximal d'ouvertures de la modale d'identifiants pour une même action. */
export const MAX_AUTH_ATTEMPTS = 2;

export interface GitFailureLabels {
  /** Texte expliquant qu'on ne rouvre plus la modale (n = MAX_AUTH_ATTEMPTS). */
  authLimitReached: (max: number) => string;
}

export interface GitFailure {
  /** Message à afficher (jamais vide : plus d'échec silencieux). */
  message: string;
  /** true → ouvrir la modale d'identifiants (seule cause : token absent/refusé). */
  showAuthModal: boolean;
  /** true → borne atteinte : afficher l'erreur + un bouton « Réessayer ». */
  blocked: boolean;
}

interface ErrLike {
  message?: unknown;
  data?: { code?: unknown; error?: unknown } | null;
}

function errorMessage(err: unknown): string {
  const e = (err ?? {}) as ErrLike;
  if (typeof e.data?.error === "string" && e.data.error.trim()) return e.data.error;
  if (typeof e.message === "string" && e.message.trim()) return e.message;
  return String(err ?? "Unknown error");
}

function errorCode(err: unknown): string | undefined {
  const code = ((err ?? {}) as ErrLike).data?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Traduit un échec d'action git en décision d'UI.
 *
 * Seul `GIT_AUTH_REQUIRED` ouvre la modale (et seulement tant que la borne n'est
 * pas atteinte). `GIT_REMOTE_SCHEME`, `GIT_UNREACHABLE`, `GIT_PUSH_REJECTED` et
 * les erreurs génériques affichent leur message et n'ouvrent JAMAIS la modale.
 */
export function decideGitFailure(
  err: unknown,
  authAttempts: number,
  labels: GitFailureLabels
): GitFailure {
  const message = errorMessage(err);
  if (errorCode(err) !== "GIT_AUTH_REQUIRED") {
    return { message, showAuthModal: false, blocked: false };
  }
  if (authAttempts >= MAX_AUTH_ATTEMPTS) {
    return {
      message: `${message} — ${labels.authLimitReached(MAX_AUTH_ATTEMPTS)}`,
      showAuthModal: false,
      blocked: true,
    };
  }
  return { message, showAuthModal: true, blocked: false };
}

export interface CommitPushOutcome {
  /** false → l'action a ÉCHOUÉ : ne surtout pas annoncer un succès. */
  ok: boolean;
  /** true → quelque chose est réellement parti vers le distant. */
  pushed: boolean;
  /** Texte fidèle à ce qui s'est passé (commit puis push), vide si inconnu. */
  message: string;
}

/** Ancien format backend (`gitCommitAndPush` avalait l'échec) — traité comme échec. */
const SWALLOWED_PUSH_FAILURE = /^push failed/i;

/**
 * Interprète la réponse de `POST /:id/git/commit-push`. L'UI n'annonce un push
 * réussi que si `pushResult` est présent et ne décrit pas un échec.
 */
export function commitPushOutcome(
  data: { commitResult?: unknown; pushResult?: unknown } | null | undefined
): CommitPushOutcome {
  const pushResult = typeof data?.pushResult === "string" ? data.pushResult : "";
  const commitResult = typeof data?.commitResult === "string" ? data.commitResult : "";

  if (SWALLOWED_PUSH_FAILURE.test(pushResult)) {
    return { ok: false, pushed: false, message: pushResult };
  }

  const pushed = pushResult.length > 0;
  const message = [commitResult, pushResult].filter(Boolean).join(" → ");
  return { ok: pushed || commitResult.length > 0, pushed, message };
}

// ── Remotes : détection SSH et suggestion HTTPS (miroir du backend) ──────────
// Sert à prévenir AVANT la saisie du token : un origin SSH ne peut pas le
// recevoir (le backend refuse avec GIT_REMOTE_SCHEME).

/** true si l'URL du remote utilise SSH (`git@…`, `ssh://…`). */
export function looksLikeSshRemote(url: string | null | undefined): boolean {
  if (!url) return false;
  const u = url.trim();
  return /^git@/.test(u) || /^ssh:\/\//i.test(u) || /^git\+ssh:\/\//i.test(u);
}

/**
 * Équivalent HTTPS d'une URL SSH, pour la commande `git remote set-url` :
 *   git@github.com:owner/repo.git → https://github.com/owner/repo.git
 * null si l'URL n'est pas convertible (ou déjà HTTPS).
 */
export function suggestedHttpsRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  const scpLike = u.match(/^git@([^:/]+):(.+)$/);
  if (scpLike) return `https://${scpLike[1]}/${scpLike[2]}`;
  const sshUrl = u.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (sshUrl) return `https://${sshUrl[1]}/${sshUrl[2]}`;
  return null;
}
