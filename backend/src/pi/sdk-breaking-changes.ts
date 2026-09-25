/**
 * sdk-breaking-changes.ts — GARDE-FOU de mise à jour du SDK pi-coding-agent.
 *
 * Pourquoi ce module : la route `POST /api/settings/update` installait
 * `@earendil-works/pi-coding-agent@latest` et sautait donc vers n'importe
 * quelle version SANS avertir. C'est exactement ce qui aurait cassé le
 * démarrage lors de la bascule 0.85.1 → 0.87.1 (`agent.state.systemPrompt`
 * était devenu un getter sans setter → `TypeError` à l'écriture).
 *
 * Ici : une TABLE STATIQUE, revue à la main, des ruptures d'API connues,
 * version par version. Elle sert à (1) afficher les ruptures applicables AVANT
 * l'action et (2) refuser (HTTP 409) un saut mineur/majeur non explicitement
 * acquitté.
 *
 * Ce module est PUR (aucune I/O) : entièrement testable.
 */

/** Une entrée de la table : version où la rupture apparaît + description. */
export interface SdkBreakingChange {
  /** Version (semver) dans laquelle la rupture / le correctif apparaît. */
  version: string;
  /** Résumé une ligne (affiché tel quel dans la modale). */
  summary: string;
  /** Détails techniques à relire avant de monter de version. */
  details: string[];
}

/**
 * Ruptures / changements notables connus, TRIÉS par version croissante.
 * Source : retour d'expérience réel des bascules 0.85.1 → 0.87.1.
 * Toute nouvelle rupture doit être ajoutée ici lors d'une montée de version.
 */
export const SDK_BREAKING_CHANGES: readonly SdkBreakingChange[] = [
  {
    version: "0.86.0",
    summary: "0.86.0 — refonte Context / outils (providers custom, arguments JSON stricts)",
    details: [
      "`Context` devient `TranscriptContext` pour les providers custom.",
      "Arguments et détails des outils validés en JSON strict.",
      "Sampling contraint par défaut sur read/bash/edit/write.",
      "Les outils sans schéma sont rejetés à l'enregistrement.",
    ],
  },
  {
    version: "0.86.1",
    summary: "0.86.1 — correctifs providers (dont z.ai « Prompt too long »)",
    details: [
      "Correctifs providers (z.ai « Prompt too long ») — aucune rupture d'API connue.",
    ],
  },
  {
    version: "0.87.0",
    summary: "0.87.0 — refonte du prompt système et du transcript (RUPTURE majeure)",
    details: [
      "`agent.state.systemPrompt` devient un GETTER sans setter : toute écriture lève `TypeError` ; `_baseSystemPrompt` disparaît.",
      "L'assignation de `agent.state.messages` ne pilote plus le contexte provider : utiliser `refreshContext()`, `SessionManager.inMemory` ou `appendContextEdit`.",
      "`SessionEntry` gagne `context_edit`.",
      "`ExtensionEvent` gagne `agent_before_settle`.",
      "`TurnEndEvent` a de nouveaux champs requis.",
      "`ExtensionRunner.emit()` n'accepte plus `turn_end`.",
      "`shouldStopAfterTurn` supprimé.",
    ],
  },
  {
    version: "0.87.1",
    summary: "0.87.1 — correctifs providers (dont z.ai « Prompt too long »)",
    details: [
      "Correctifs providers (dont z.ai « Prompt too long ») — aucune rupture d'API connue.",
    ],
  },
];

/** Version valide = `x.y.z` avec pré-release optionnelle (`x.y.z-beta.1`). */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** `true` si la chaîne est une version semver exploitable (« unknown » → false). */
export function isValidVersion(value: string): boolean {
  return VERSION_RE.test((value || "").trim());
}

/**
 * Parse `major.minor.patch` en tuple numérique.
 * Toute chaîne non reconnue (« unknown ») donne [0,0,0] : un saut vers une
 * version réelle est alors considéré comme majeur → garde-fou conservateur.
 */
export function parseVersion(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec((version || "").trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Comparaison semver : -1 si a<b, 0 si égal, 1 si a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * `true` si le saut change de version MAJEURE ou MINEURE (un patch seul ne
 * déclenche pas le garde-fou : ex. 0.87.0 → 0.87.1).
 */
export function isMajorOrMinorBump(installed: string, target: string): boolean {
  const [im, iMinor] = parseVersion(installed);
  const [tm, tMinor] = parseVersion(target);
  return im !== tm || iMinor !== tMinor;
}

/**
 * Ruptures applicables à un saut `installed → target` : toutes les entrées
 * dont la version est STRICTEMENT supérieure à l'installée et INFÉRIEURE OU
 * ÉGALE à la cible (les versions intermédiaires). Trié par version croissante.
 */
export function getApplicableBreakingChanges(
  installed: string,
  target: string,
): SdkBreakingChange[] {
  // Pas de saut vers le haut → aucune rupture intermédiaire.
  if (compareVersions(installed, target) >= 0) return [];
  return SDK_BREAKING_CHANGES.filter(
    (change) =>
      compareVersions(change.version, installed) > 0 &&
      compareVersions(change.version, target) <= 0,
  )
    .slice()
    .sort((a, b) => compareVersions(a.version, b.version));
}

/** Décision du garde-fou pour un saut donné. */
export interface UpdateGuardDecision {
  /** Cible identique à l'installée : rien à faire. */
  alreadyUpToDate: boolean;
  /** Le saut change de version mineure/majeure (case à cocher requise). */
  requiresAck: boolean;
  /** Ruptures connues applicables (versions intermédiaires). */
  breakingChanges: SdkBreakingChange[];
  /** `true` → la route doit répondre 409 tant que `acknowledged` est faux. */
  blocked: boolean;
}

/**
 * Calcule la décision du garde-fou. Fonction pure : la route l'utilise pour
 * décider entre « already up to date », 409 (non acquitté) et la mise à jour.
 */
export function evaluateUpdateTarget(
  installed: string,
  target: string,
  acknowledged: boolean,
): UpdateGuardDecision {
  const alreadyUpToDate = compareVersions(installed, target) === 0;
  const breakingChanges = getApplicableBreakingChanges(installed, target);
  const requiresAck = !alreadyUpToDate && isMajorOrMinorBump(installed, target);
  const blocked = requiresAck && !acknowledged;
  return { alreadyUpToDate, requiresAck, breakingChanges, blocked };
}

/**
 * Réécrit le pin du SDK dans le contenu d'entrypoint.sh (toutes les occurrences
 * `pi-coding-agent@x.y.z`). Throws si AUCUNE ligne n'est trouvée : mieux vaut
 * refuser la mise à jour que laisser un pin obsolète après l'install.
 * Fonction pure — testable sans I/O réel.
 */
export function replaceEntrypointPin(content: string, targetVersion: string): string {
  const updated = content.replace(
    /pi-coding-agent@[0-9]+\.[0-9]+\.[0-9]+/g,
    `pi-coding-agent@${targetVersion}`,
  );
  if (updated === content) {
    throw new Error("aucune ligne npm install pi-coding-agent trouvée dans entrypoint.sh");
  }
  return updated;
}
