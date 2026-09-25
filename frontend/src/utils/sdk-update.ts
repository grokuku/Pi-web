// ── Garde-fou de mise à jour du SDK pi-agent (logique pure, testable) ──
// Le backend (GET /api/settings/update-check) renvoie la liste des ruptures
// connues applicables et si un acquittement explicite est requis (saut
// mineur/majeur). Ces helpers décident de l'état de la case de confirmation et
// du corps envoyé à POST /api/settings/update.

/** Rupture d'API renvoyée par le backend (pi/sdk-breaking-changes.ts). */
export interface SdkBreakingChange {
  version: string;
  summary: string;
  details: string[];
}

/**
 * La mise à jour est bloquée tant que l'utilisateur n'a pas coché la case de
 * reconnaissance, dès qu'un saut mineur/majeur est requis. On exige la case
 * même si la liste des ruptures est vide (version non encore répertoriée côté
 * backend) : l'acquittement reste nécessaire pour franchir le garde-fou.
 */
export function updateBlockedWithoutAck(requiresAck: boolean, acknowledged: boolean): boolean {
  return requiresAck && !acknowledged;
}

/** Corps JSON envoyé à la route POST /api/settings/update. */
export interface UpdateRequestBody {
  targetVersion: string;
  acknowledged: boolean;
}

/**
 * Construit le corps de la requête de mise à jour. Une cible vide laisse le
 * backend choisir la dernière version publiée (jamais `@latest` aveugle).
 */
export function buildUpdateBody(
  targetVersion: string,
  acknowledged: boolean,
): UpdateRequestBody {
  return { targetVersion: targetVersion.trim(), acknowledged };
}
