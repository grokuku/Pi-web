/**
 * Utilitaires de nettoyage des URLs de remote git.
 *
 * Les credentials (username:token) ne doivent JAMAIS être persistés dans une
 * URL de remote (ni dans .git/config, ni dans projects.json). Ils sont injectés
 * temporairement en mémoire par gitWithAuth()/gitClone() au moment de l'opération,
 * puis restaurés. Ce module centralise la fonction de nettoyage pour éviter toute
 * duplication et tout risque de fuite.
 */

/**
 * Retire les credentials embarqués d'une URL de remote git.
 *
 *   https://user:token@host/path → https://host/path
 *   https://user@host/path        → https://host/path
 *   https://user:pa@ss@host/path  → https://host/path   (le @ du mot de passe)
 *
 * Ne touche pas aux URLs SSH (git@host:path) ni aux URLs sans credentials.
 *
 * ⚠️ BUG-15, même classe : l'ancienne regex `([^@]+@)?` s'arrêtait au PREMIER
 * `@`. Avec un mot de passe contenant `@`, le remplacement laissait
 * `https://ss@host/path` — un FRAGMENT DU MOT DE PASSE réécrit dans
 * `.git/config` et dans `projects.json`. On ancre donc sur le DERNIER `@` de
 * l'autorité (jamais au-delà : un `@` dans le chemin n'est pas un userinfo).
 */
export function sanitizeRemoteUrl(url: string): string {
  if (!url) return url;
  const match = /^(https?:\/\/)([^/?#]*)([\s\S]*)$/i.exec(url);
  if (!match) return url;
  const [, protocol, authority, rest] = match;
  const at = authority.lastIndexOf("@");
  if (at === -1) return url;
  return `${protocol}${authority.slice(at + 1)}${rest}`;
}

/**
 * Expurge les identifiants embarqués d'un MESSAGE (erreur git, log) — et non
 * d'une URL seule.
 *
 * Pourquoi : Pi-Web authentifie en injectant temporairement le jeton dans l'URL
 * du remote (`https://user:token@host/…`). Quand git échoue, il RECOPIE cette
 * URL dans son message (« fatal: unable to access 'https://user:token@host/…' »).
 * Ce message remonte jusqu'à l'écran de l'utilisateur (et peut finir dans un
 * rapport de bug) : un jeton ne doit JAMAIS en sortir.
 *
 *   fatal: unable to access 'https://u:ghp_x@github.com/o/r': 403
 * → fatal: unable to access 'https://****@github.com/o/r': 403
 *
 * ⚠️ Nettoyage du TEXTE, pas d'une URL : contrairement à `sanitizeRemoteUrl`
 * (qui analyse une URL complète), on remplace ici toute autorité `//…@` où
 * qu'elle apparaisse dans la phrase. `[^/\s]*` est GREEDY : on va jusqu'au
 * DERNIER `@` de l'autorité, sinon un mot de passe contenant `@` laisserait un
 * fragment du secret (`//****@ss@host`).
 */
export function redactSecretsInMessage(msg: string): string {
  if (!msg) return msg;
  return msg.replace(/\/\/[^/\s]*@/g, "//****@");
}
