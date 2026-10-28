/**
 * Hostname d'une URL de remote git, côté frontend.
 *
 * Le backend stocke les identifiants PAR HÔTE (`credentials.enc`, clé =
 * « github.com ») : un seul jeton couvre donc TOUS les dépôts du même hôte.
 * Le panneau Git s'en sert pour prévenir que « Oublier les identifiants »
 * concerne tout l'hôte, et pour nommer l'action globale.
 *
 * Aucune commande réseau : simple analyse de chaîne, symétrique de
 * `hostFromRemoteUrl` (backend/src/projects/git.ts).
 */
export function hostFromRemoteUrl(remote: string | null | undefined): string | null {
  const url = (remote ?? "").trim();
  if (!url) return null;
  // HTTPS / git:// / file:// … : URL standard (SSH traité à part).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^ssh:\/\//i.test(url)) {
    try {
      const hostname = new URL(url).hostname;
      return hostname ? hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  // ssh://git@host/path ou git@host:path
  const sshMatch = url.match(/^(?:ssh:\/\/)?(?:[^@/:]+@)?([^:/]+)[:/]/);
  return sshMatch ? sshMatch[1].toLowerCase() : null;
}
