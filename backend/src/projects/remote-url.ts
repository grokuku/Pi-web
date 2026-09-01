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
 *
 * Ne touche pas aux URLs SSH (git@host:path) ni aux URLs sans credentials.
 */
export function sanitizeRemoteUrl(url: string): string {
  if (!url) return url;
  // https://user:pass@host → https://host  (le @ est le dernier avant le chemin)
  return url.replace(/^(https?:\/\/)([^@]+@)?(.+)/, (_, protocol, _creds, rest) => `${protocol}${rest}`);
}
