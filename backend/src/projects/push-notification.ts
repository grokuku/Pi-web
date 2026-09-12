/**
 * Construction du résumé de push injecté dans le chat (git_notification).
 *
 * Deux formes :
 *  - push STANDARD (projet poussé === session affichée) : texte historique,
 *    volontairement inchangé (isSubPush === false) ;
 *  - push d'un SOUS-PROJET depuis le GitPanel d'un projet ACTIF (`isSubPush`) :
 *    le résumé doit identifier le sous-projet poussé (nom) et ses stats
 *    (branche, nombre de fichiers), sinon on croirait que le projet affiché a
 *    été poussé. Le texte reste calqué sur le standard (sujet, hash, remote).
 */
export interface PushNotificationParams {
  isSubPush: boolean;
  projectName: string;
  subject: string;
  body?: string;
  commitHash: string;
  remoteUrl: string;
  branch?: string;
  files?: number;
}

export function buildPushNotification(params: PushNotificationParams): string {
  const { isSubPush, projectName, subject, body, commitHash, remoteUrl, branch, files } = params;

  const header = isSubPush
    ? `✅ Sub-project "${projectName}" committed & pushed to GitHub.`
    : "✅ Code successfully pushed to GitHub.";
  const statsLines = isSubPush
    ? `\nBranch: ${branch || "—"}\nFiles: ${files ?? 0} change(s)`
    : "";

  return `${header}
Commit: ${subject}${body ? "\n" + body : ""}
Hash: ${commitHash}${statsLines}
Remote: ${remoteUrl || "origin"}

All changes from this commit are now live on the remote repository. Do not suggest modifications to files that were part of this commit unless the user explicitly asks for further changes.`;
}
