/**
 * harness-role-map.ts — correspondance RÔLE (héritage) → FONCTION de routage.
 *
 * POURQUOI CE MODULE EXISTE (LOT 4 / BUG09)
 * -----------------------------------------
 * L'extension harness-orchestrator acceptait un paramètre `role` (ancienne API)
 * et mappait TOUT rôle inconnu sur `execute` — la fonction la plus permissive
 * (edit/write/bash). Une simple faute de frappe (`role: "code_reviewer"`)
 * donnait donc à un délégué des droits d'ÉCRITURE alors que l'intention était
 * une relecture (`review`, read-only).
 *
 * Désormais : seuls les rôles explicitement listés sont acceptés, tout autre
 * rôle est REFUSÉ avec un message qui énumère les valeurs valides (fonctions
 * ET rôles hérités) — l'appelant peut se corriger immédiatement.
 *
 * Module PUR (aucun import SDK/Express) : l'extension (chargée par jiti) et le
 * backend partagent la même table, et les tests vitest du backend la couvrent.
 */

/** Rôles hérités acceptés → fonction de routage correspondante. */
export const LEGACY_ROLE_TO_FUNCTION: Readonly<Record<string, string>> = Object.freeze({
  architect: "planning",
  "code-reviewer": "review",
  "security-reviewer": "review",
});

/** Fonctions de routage valides (subset des 4 rôles de l'extension). */
export const VALID_FUNCTIONS: readonly string[] = Object.freeze([
  "planning",
  "execute",
  "review",
  "integrate",
]);

/**
 * Résout un rôle hérité en fonction de routage.
 *
 * @returns le nom de la fonction, ou `null` si le rôle n'est PAS reconnu.
 *          `null` doit être traité comme un REFUS (jamais comme `execute`) :
 *          c'est précisément le correctif BUG09.
 */
export function mapRoleToFunction(role: unknown): string | null {
  if (typeof role !== "string") return null;
  const key = role.trim();
  if (!key) return null;
  return LEGACY_ROLE_TO_FUNCTION[key] ?? null;
}

/** Liste humainement lisible des rôles hérités acceptés : `a → b, c → d`. */
export function describeLegacyRoles(): string {
  return Object.entries(LEGACY_ROLE_TO_FUNCTION)
    .map(([role, fn]) => `${role} → ${fn}`)
    .join(", ");
}

/**
 * Message de REFUS d'un rôle inconnu : nomme le rôle reçu, liste les rôles
 * acceptés et renvoie vers le paramètre `function` (API actuelle).
 */
export function roleRefusalMessage(role: unknown): string {
  const received = typeof role === "string" && role.trim() ? role.trim() : "(vide)";
  return (
    `❌ Rôle inconnu : "${received}". ` +
    `Rôles hérités acceptés : ${describeLegacyRoles()}. ` +
    `Préférez le paramètre "function" avec l'une des valeurs : ${VALID_FUNCTIONS.join(", ")}.`
  );
}
