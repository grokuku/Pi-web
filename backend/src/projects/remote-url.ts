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
