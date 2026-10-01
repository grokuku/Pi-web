/**
 * harness-run-targeting.ts — RÉSOLUTION DE CIBLE et COMPOSITION DES MESSAGES
 * des tools de contrôle de l'orchestrateur (LOT 3/4 « orchestrateur
 * interactif pendant que les sous-agents travaillent »).
 *
 * CONTEXTE : l'utilisateur ne parle JAMAIS aux sous-agents (décision utilisateur
 * de la passe 2). Ses consignes arrivent à l'orchestrateur, qui les RELAIE via
 * `delegate_steer` ; ses demandes d'arrêt passent par `delegate_stop` ; il peut
 * aussi demander « qu'est-ce qui tourne ? » → `delegate_list`. Ces trois tools
 * ciblent un run avec une syntaxe SOUPLE : identifiant de run (`d-…`), nom de
 * fonction (`planning`/`execute`/`review`/`integrate`, ou ancien rôle), ou
 * `"all"`.
 *
 * Pourquoi ce module est PUR et dans backend/src/pi/ : les extensions chargées
 * par jiti ne sont PAS couvertes par vitest. Toute la logique testable
 * (résolution runId/fonction/all, cas « aucun run », « cible inconnue »,
 * « ambiguïté — préciser le runId », messages de retour) vit donc ici, testée
 * dans harness-run-targeting.test.ts ; l'extension ne fait qu'appeler le
 * registre et composer via ces helpers.
 *
 * Choix d'ambiguïté : plusieurs runs de la MÊME fonction → on ne devine JAMAIS.
 * On renvoie un statut `ambiguous` avec la liste des candidats, et le message
 * demande explicitement de préciser un identifiant de run (ou « all »).
 */

import type { SubagentRunHandle } from "./harness-run-registry.js";

/** Vue enrichie d'un run pour la résolution de cible et l'affichage. */
export interface RunTargetInfo {
  runId: string;
  /** Fonction de routage effective (planning/execute/review/integrate). */
  delegateFunction?: string;
  /** Libellé humain du run (« Exécution », …), si connu. */
  label?: string;
  /** Extrait de la tâche déléguée, si connu. */
  taskExcerpt?: string;
  /** Projet d'appartenance (étanchéité), si connu. */
  projectId?: string;
  /** Début du run (epoch ms), si connu. */
  startedAt?: number;
  /** Modèle effectif du sous-agent, si connu. */
  model?: string;
}

/** Extrait les métadonnées d'affichage d'un handle du registre. PURE. */
export function runTargetInfoFromHandle(handle: SubagentRunHandle): RunTargetInfo {
  return {
    runId: handle.runId,
    delegateFunction: handle.delegateFunction,
    label: handle.label,
    taskExcerpt: handle.taskExcerpt,
    projectId: handle.projectId,
    startedAt: handle.startedAt,
    model: handle.model,
  };
}

/** Statut d'une résolution de cible. */
export type RunTargetStatus = "all" | "resolved" | "not-found" | "ambiguous" | "no-runs";

/** Résultat d'une résolution de cible (PURE — testée). */
export interface RunTargetResolution {
  status: RunTargetStatus;
  /** Runs visés (rempli pour "all" et "resolved" ; candidats pour "ambiguous"). */
  runs: RunTargetInfo[];
  /** Cible normalisée (remplie pour "not-found" et "ambiguous"). */
  target?: string;
}

/**
 * Alias de rôles LEGACY → fonction de routage (aligné sur mapRoleToFunction de
 * l'extension harness-orchestrator et sur harness-stream.) : l'utilisateur peut
 * dire « arrête l'architecte » et l'orchestrateur cibler « architect ».
 */
const ROLE_ALIASES: Record<string, string> = {
  architect: "planning",
  "code-reviewer": "review",
  "security-reviewer": "review",
};

/** Normalise une cible textuelle (trim + minuscules) ; "" si absente. */
function normalizeTarget(target: unknown): string {
  return typeof target === "string" ? target.trim().toLowerCase() : "";
}

/**
 * Résout une cible SOUPLE (`runId` exact | fonction/rôle | "all") en liste de
 * runs à contrôler. PURE — testée.
 *
 * Règles (dans cet ordre) :
 *  0. aucun run actif → `no-runs` (quel que soit la cible) ;
 *  1. « all » (insensible à la casse) → tous les runs ;
 *  2. correspondance EXACTE par runId → ce run ;
 *  3. correspondance par fonction (ou alias de rôle legacy) : 1 seul → ce run ;
 *     plusieurs → `ambiguous` (le message demandera de préciser le runId) ;
 *  4. sinon → `not-found`.
 */
export function resolveRunTarget(runs: RunTargetInfo[], target: unknown): RunTargetResolution {
  const list = Array.isArray(runs)
    ? runs.filter((r) => r && typeof r.runId === "string" && r.runId.length > 0)
    : [];
  const raw = typeof target === "string" ? target.trim() : "";
  const norm = normalizeTarget(target);

  if (list.length === 0) return { status: "no-runs", runs: [] };
  if (norm === "all") return { status: "all", runs: list };

  // runId EXACT (casse conservée : l'identifiant est sensible à la casse).
  const exact = list.find((r) => r.runId === raw);
  if (exact) return { status: "resolved", runs: [exact] };

  const fnWanted = ROLE_ALIASES[norm] ?? norm;
  const byFunction = list.filter(
    (r) => normalizeTarget(r.delegateFunction) === fnWanted,
  );
  if (byFunction.length === 1) return { status: "resolved", runs: byFunction };
  if (byFunction.length > 1) return { status: "ambiguous", runs: byFunction, target: raw };
  return { status: "not-found", runs: [], target: raw };
}

/** Tronque un texte en signalant la coupure (PURE). */
function clip(text: string, max: number): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Durée écoulée lisible (« 42s », « 3min », « 1h05min »). PURE — testée. */
export function formatRunAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}min`;
}

/**
 * Ligne d'affichage d'un run : libellé, fonction, runId (pour cibler), âge,
 * modèle, extrait de tâche. PURE — testée.
 */
export function formatRunLine(run: RunTargetInfo, now: number = Date.now()): string {
  const label = run.label || run.delegateFunction || "sous-agent";
  const fn = run.delegateFunction ? ` (${run.delegateFunction})` : "";
  const age =
    typeof run.startedAt === "number" && Number.isFinite(run.startedAt)
      ? `il y a ${formatRunAge(Math.max(0, now - run.startedAt))}`
      : "début inconnu";
  const project = run.projectId ? ` · projet ${run.projectId}` : "";
  const model = run.model && run.model !== "?" ? ` · ${run.model}` : "";
  const task = run.taskExcerpt ? ` · tâche : « ${clip(run.taskExcerpt, 90)} »` : "";
  return `- ${label}${fn} · ${run.runId} · ${age}${project}${model}${task}`;
}

/** Cibles candidates (lignes) d'une résolution ambiguë. */
function candidateLines(resolution: RunTargetResolution): string {
  return resolution.runs.map((r) => formatRunLine(r)).join("\n");
}

/** Entrée de `buildStopResultMessage`. */
export interface StopResultInput {
  target: string;
  resolution: RunTargetResolution;
  /** Nombre de runs effectivement annulés (cancel retourne true). */
  cancelled: number;
}

/**
 * Compose le message de retour de `delegate_stop` (PURE — testée).
 * Toujours explicite : combien de runs arrêtés, lesquels, et le cas
 * « aucun run actif » ; jamais de silence sur une cible introuvable.
 */
export function buildStopResultMessage(input: StopResultInput): string {
  const { resolution, cancelled } = input;
  const target = typeof input.target === "string" && input.target.trim() ? input.target.trim() : "(vide)";

  switch (resolution.status) {
    case "no-runs":
      return (
        `ℹ️ Aucun sous-agent n'est actif : rien à arrêter (demande « ${target} »). ` +
        `Tu peux répondre à l'utilisateur ou lancer une nouvelle délégation.`
      );
    case "not-found":
      return (
        `⚠️ Aucun sous-agent actif ne correspond à « ${target} ». ` +
        `Appelle \`delegate_list\` pour voir les runs en cours (identifiant + fonction), puis réessaie.`
      );
    case "ambiguous":
      return (
        `⚠️ Plusieurs sous-agents « ${target} » sont en cours — précise lequel arrêter par son ` +
        `identifiant de run (paramètre \`target\`), ou cible « all » pour les arrêter TOUS :\n` +
        candidateLines(resolution)
      );
    default: {
      const lines = resolution.runs.map((r) => formatRunLine(r)).join("\n");
      if (cancelled <= 0) {
        return (
          `⚠️ L'arrêt de « ${target} » n'a rien pu annuler (les runs viennent probablement de se ` +
          `terminer). Appelle \`delegate_list\` pour vérifier ce qui tourne encore.`
        );
      }
      const already = resolution.runs.length - cancelled;
      const partial = already > 0 ? ` (${already} déjà terminé(s))` : "";
      return (
        `🛑 Arrêt demandé pour ${cancelled} sous-agent(s)${partial} :\n${lines}\n` +
        `Chaque run s'arrête proprement ; leur travail partiel te sera livré via \`subagent_result\` ` +
        `(statut « annulé »). Ne considère PAS leur travail comme terminé.`
      );
    }
  }
}

/** Entrée de `buildSteerResultMessage`. */
export interface SteerResultInput {
  target: string;
  resolution: RunTargetResolution;
  /** Texte de la consigne relayée. */
  text: string;
  /** Nombre de runs effectivement dirigés. */
  steered: number;
}

/**
 * Compose le message de retour de `delegate_steer` (PURE — testée).
 * Le cas « run déjà terminé » est EXPLICITE et propose la relance d'une
 * délégation de suivi contenant la précision (l'orchestrateur ne doit pas
 * croire la consigne transmise).
 */
export function buildSteerResultMessage(input: SteerResultInput): string {
  const { resolution, steered } = input;
  const target = typeof input.target === "string" && input.target.trim() ? input.target.trim() : "(vide)";
  const consigne = clip(input.text, 120);
  const relaunchHint =
    `Relance une délégation de suivi via \`delegate\` (function execute) en incluant cette ` +
    `précision : « ${consigne} ».`;

  switch (resolution.status) {
    case "no-runs":
      return (
        `ℹ️ Aucun sous-agent n'est actif : la consigne n'a pas pu être transmise. Le run est ` +
        `probablement déjà TERMINÉ. ${relaunchHint}`
      );
    case "not-found":
      return (
        `⚠️ Aucun sous-agent actif ne correspond à « ${target} » : la consigne n'a pas été transmise. ` +
        `Appelle \`delegate_list\` pour vérifier les runs en cours. S'il n'y en a plus, ${relaunchHint}`
      );
    case "ambiguous":
      return (
        `⚠️ Plusieurs sous-agents « ${target} » sont en cours — précise lequel diriger par son ` +
        `identifiant de run (paramètre \`target\`), ou cible « all » pour tous les diriger :\n` +
        candidateLines(resolution)
      );
    default: {
      const lines = resolution.runs.map((r) => formatRunLine(r)).join("\n");
      if (steered <= 0) {
        return (
          `⚠️ La consigne n'a pas pu être transmise à « ${target} » (run déjà terminé ou en fin de vie). ` +
          relaunchHint
        );
      }
      return (
        `📨 Consigne transmise à ${steered} sous-agent(s) en cours :\n${lines}\n` +
        `La consigne « ${consigne} » leur sera injectée dans leur session en cours. ` +
        `Accuse réception à l'utilisateur ; n'invente pas leur résultat, ils te le livreront.`
      );
    }
  }
}

/**
 * Compose la liste des runs en cours pour `delegate_list` (PURE — testée).
 * C'est l'outil qui permet à l'orchestrateur de cibler correctement un
 * stop/steer : identifiant, fonction, tâche résumée, temps écoulé.
 */
export function buildRunListMessage(runs: RunTargetInfo[], now: number = Date.now()): string {
  const list = Array.isArray(runs) ? runs.filter((r) => r && typeof r.runId === "string" && r.runId) : [];
  if (list.length === 0) {
    return (
      "ℹ️ Aucun sous-agent n'est en cours. Tu es disponible : réponds à l'utilisateur ou lance " +
      "une délégation via `delegate`."
    );
  }
  const lines = list.map((r) => formatRunLine(r, now)).join("\n");
  return (
    `🔄 Sous-agents en cours (${list.length}) :\n${lines}\n` +
    `Utilise l'identifiant de run pour cibler \`delegate_stop\` / \`delegate_steer\` (ou « all »).`
  );
}
