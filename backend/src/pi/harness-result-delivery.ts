/**
 * harness-result-delivery.ts — livraison/lotissement des RÉSULTATS de
 * sous-agents vers la conversation de l'orchestrateur (LOT 2 « orchestrateur
 * interactif pendant que les sous-agents travaillent »).
 *
 * DÉCISION UTILISATEUR n°2 : c'est le BACKEND qui réinjecte les résultats
 * (et non l'extension) — la session de l'orchestrateur peut avoir été
 * rechargée/disposée pendant le run (référence `pi` stale côté extension), le
 * backend retrouve toujours la session COURANTE du projet.
 *
 * DÉCISION UTILISATEUR n°3 : si un sous-agent finit PENDANT que l'utilisateur
 * parle (orchestrateur en streaming), la livraison se fait en `followUp`
 * (le SDK attend la fin du tour en cours, puis démarre un NOUVEAU tour) — sinon
 * un tour normal (`triggerTurn: true`).
 *
 * LOTISSEMENT : plusieurs fins de runs rapprochées ne doivent PAS déclencher N
 * tours LLM. On les regroupe sur une fenêtre COURTE (~3 s) et on déclenche UN
 * SEUL tour. Toute la logique (options de livraison + lotisseur) est PURE et
 * testée dans harness-result-delivery.test.ts.
 *
 * ARBITRAGE DU SLOT LLM (LOT 5.2) : le tour orchestrateur déclenché par un
 * `subagent_result` (comme un message utilisateur) n'est PAS borné par le
 * limiteur `maxLLMSlots` — seuls les appels de sous-agents (extension harness)
 * et le classifieur de routage acquièrent un slot. Le risque « N fins de runs
 * simultanées » est donc borné par deux mécanismes :
 *  1. le lotisseur ci-dessus (fenêtre fixe ~3 s) transforme une rafale de fins
 *     en UN SEUL tour orchestrateur ;
 *  2. le SDK sérialise de toute façon les prompts d'une même session (un
 *     `triggerTurn` pendant un tour actif est livré en `followUp`).
 * DÉCISION : ne pas faire acquérir de slot au tour orchestrateur — ce serait un
 * changement de comportement GLOBAL des prompts (y compris les messages
 * utilisateur), sans nécessité démontrée. Documenté dans ROADMAP.md.
 *
 * Ce module ne dépend ni du SDK Pi ni d'Express : il reste chargeable par
 * vitest et importable (si besoin) par l'extension via jiti.
 */

import type { SubagentEndStatus } from "./harness-stream.js";

/** Fenêtre de lotissement par défaut (ms). */
export const RESULT_BATCH_WINDOW_MS = 3_000;
/** Plafond de sécurité du texte d'un résultat réinjecté (chars). */
export const RESULT_TEXT_MAX = 20_000;

/** Résultat d'un run de sous-agent, transmis pour réinjection. */
export interface SubagentResultPayload {
  /** Identifiant de la délégation (makeDelegateRunId). */
  delegateRunId: string;
  /** Fonction de routage effective. */
  delegateFunction?: string;
  /** Libellé humain (« Exécution », …). */
  label?: string;
  /** Statut de fin de vie. */
  status: SubagentEndStatus;
  /** Cause d'échec/arrêt éventuelle (court). */
  cause?: string | null;
  /** Message d'erreur éventuel. */
  errorMessage?: string | null;
  /** Réponse (complète) du sous-agent OU extrait partiel récupéré. */
  response?: string;
  /** Durée effective (ms). */
  durationMs?: number;
  /** Nombre d'actions d'outils. */
  actionCount?: number;
}

/** Options passées à `session.sendCustomMessage` pour la réinjection. */
export interface ResultDeliveryOptions {
  triggerTurn: true;
  /**
   * `followUp` UNIQUEMENT si l'orchestrateur est en streaming (l'utilisateur
   * parle) — sinon absent (tour normal immédiat).
   */
  deliverAs?: "followUp";
}

/**
 * Décide des options de livraison selon l'état de streaming de l'orchestrateur.
 * PURE — testée. `triggerTurn` est toujours vrai : le résultat doit faire
 * réagir spontanément l'orchestrateur (nouveau tour).
 */
export function resultDeliveryOptions(isStreaming: boolean): ResultDeliveryOptions {
  return isStreaming ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true };
}

/** Libellés français des statuts de fin (alignés sur l'UI). */
const STATUS_LABELS: Record<SubagentEndStatus, string> = {
  success: "succès",
  error: "erreur",
  "timeout-inactivity": "timeout (inactivité)",
  "timeout-global": "timeout (global)",
  aborted: "interrompu",
  cancelled: "annulé par l'utilisateur",
};

/** Libellé lisible d'un statut (fallback sur la valeur brute). */
export function resultStatusLabel(status: SubagentEndStatus | string): string {
  return STATUS_LABELS[status as SubagentEndStatus] || String(status);
}

/** Tronque à `max` chars en signalant la coupure. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (tronqué)`;
}

/**
 * Construit le TEXTE du message `subagent_result` (conversationnel : vu par le
 * LLM). Un seul message peut agréger PLUSIEURS résultats (lotissement) — il est
 * alors introduit par un en-tête « Résultat de N sous-agents ». PURE — testée.
 */
export function buildResultMessageContent(results: SubagentResultPayload[]): string {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  if (list.length === 0) return "";
  const blocks = list.map((r) => {
    const label = r.label || r.delegateFunction || "sous-agent";
    const fn = r.delegateFunction ? ` (${r.delegateFunction})` : "";
    const head = `### ${label}${fn} — ${resultStatusLabel(r.status)}`;
    const metaParts: string[] = [];
    if (typeof r.actionCount === "number" && r.actionCount > 0) metaParts.push(`${r.actionCount} action(s)`);
    if (typeof r.durationMs === "number" && r.durationMs > 0) metaParts.push(`${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.cause) metaParts.push(`cause : ${r.cause}`);
    const meta = metaParts.length > 0 ? `\n_${metaParts.join(" · ")}_` : "";
    const body = (r.response && r.response.trim())
      ? clip(r.response.trim(), RESULT_TEXT_MAX)
      : (r.errorMessage ? clip(r.errorMessage, RESULT_TEXT_MAX) : "(aucune sortie)");
    return `${head}${meta}\n\n${body}`;
  });
  const header = list.length > 1
    ? `🧩 Résultat de ${list.length} sous-agents (délégations terminées)\n\n`
    : `🧩 Résultat du sous-agent (délégation terminée)\n\n`;
  return header + blocks.join("\n\n---\n\n");
}

// ── Lotisseur (batching) ────────────────────────────────

export interface ResultBatcher {
  /** Ajoute un résultat ; arme la fenêtre si elle ne l'est pas déjà. */
  add(item: SubagentResultPayload): void;
  /** Flush immédiat (tests, arrêt propre). */
  flushNow(): void;
  /** Nombre de résultats en attente de flush. */
  pendingCount(): number;
}

export interface ResultBatcherOptions {
  /** Callback appelé UNE fois avec le lot accumulé. */
  onFlush: (items: SubagentResultPayload[]) => void;
  /** Fenêtre de regroupement (défaut RESULT_BATCH_WINDOW_MS). */
  windowMs?: number;
  /** Horloges injectables (tests) — défauts = globals. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
}

/**
 * Crée un lotisseur à FENÊTRE FIXE : le timer démarre à l'arrivée du PREMIER
 * résultat et n'est pas repoussé (contrairement à un debounce) — la latence est
 * donc bornée par `windowMs`, même si des résultats continuent d'arriver.
 * PURE (horloges injectables) — testée.
 */
export function createResultBatcher(opts: ResultBatcherOptions): ResultBatcher {
  const windowMs = Math.max(0, opts?.windowMs ?? RESULT_BATCH_WINDOW_MS);
  const setTimeoutFn = opts?.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn = opts?.clearTimeoutFn ?? ((t: unknown) => clearTimeout(t as any));

  let pending: SubagentResultPayload[] = [];
  let timer: unknown = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const items = pending;
    pending = [];
    try {
      opts.onFlush(items);
    } catch {
      // Un flush défaillant ne doit jamais remonter (best-effort).
    }
  };

  return {
    add(item: SubagentResultPayload): void {
      if (!item) return;
      pending.push(item);
      if (timer === null) {
        timer = setTimeoutFn(() => {
          timer = null;
          flush();
        }, windowMs);
        // Timer non bloquant côté node (tests / process long).
        (timer as any)?.unref?.();
      }
    },
    flushNow: flush,
    pendingCount: () => pending.length,
  };
}
