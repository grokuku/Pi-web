/**
 * harness-stream.ts — Streaming de l'activité des sous-agents (harness) vers
 * le chat (LOT 2a, refonte du chat).
 *
 * Problème : le tool `delegate` (extensions/harness-orchestrator) exécute les
 * fonctions de routage dans des sessions Pi TEMPORAIRES dont les événements
 * n'étaient pas remontés au frontend — l'utilisateur ne voyait qu'un aperçu
 * texte throttlé (buildProgressText) sans détail structuré.
 *
 * Solution (spécification validée) :
 *  - le canal WS `pi_event` EXISTANT est réutilisé (aucun nouveau type de
 *    frame) : chaque événement sous-agent est ENVELOPPÉ dans une frame
 *    `{ type:"subagent", source:"subagent", delegateRunId, attempt,
 *       delegateFunction, delegateLabel, model, taskExcerpt, event }` ;
 *  - l'émission est DIRECTE (sans le buffer 40 ms de session.ts qui fusionne
 *    par type) via `rawEmitToSubscribers`, exporté par backend/src/pi/session.ts ;
 *  - `emitSubagentEvent` enveloppe + émet sous try/catch PERMANENT : un échec
 *    de streaming ne doit JAMAIS faire échouer une délégation (no-op si le
 *    canal n'est pas résolvable) ;
 *  - un quota de sécurité borne le débit (20 événements enveloppés/s par
 *    delegateRunId) avec fusion des tool_execution_update consécutifs d'un
 *    même toolCallId et compteur `droppedEvents`.
 *
 * ⚠️ PONT GLOBAL (pourquoi globalThis et pas un import de session.ts) :
 * l'extension harness-orchestrator est chargée par le SDK via jiti avec
 * `moduleCache: false` — un module backend importé depuis l'extension
 * (précédent harness-archive.ts) est donc ré-évalué dans le registre jiti,
 * ce qui crée une DEUXIÈME instance de session.ts si on l'importait
 * statiquement ici. Cette copie aurait son PROPRE Set `eventCallbacks`
 * (vide) → les émissions partiraient dans le vide. On contourne le problème
 * en publiant l'émetteur RÉEL (celui de l'instance ESM native du backend)
 * sur un symbole globalThis, enregistré au chargement de session.ts. Si le
 * pont est absent (tests, hôte inattendu), emitSubagentEvent est un no-op.
 *
 * Les helpers (enveloppe, quota, troncatures, résumés d'outils) sont PURS et
 * testés dans harness-stream.test.ts. Ce module ne dépend ni d'Express ni du
 * logger backend : il reste chargeable par jiti sans effet de bord.
 */

import { randomBytes } from "crypto";

// ── Constantes de la spécification LOT 2a ────────────────

/** Quota de sécurité : max 20 événements enveloppés/s par delegateRunId. */
export const SUBAGENT_MAX_EVENTS_PER_SECOND = 20;
/** Extrait de la tâche dans l'enveloppe (chars). */
export const TASK_EXCERPT_MAX = 80;
/** Output d'un tool_execution_update transmis (chars) — queue de l'aperçu. */
export const UPDATE_TEXT_MAX = 400;
/** Output d'un tool_execution_end transmis (chars). */
export const TOOL_OUTPUT_MAX = 2000;
/** Texte d'un message_end transmis (chars). */
export const MESSAGE_TEXT_MAX = 4000;
/** Thinking d'un message_end transmis (chars). */
export const MESSAGE_THINKING_MAX = 1000;
/** Résumé d'une action (persistance, chars). */
export const ACTION_SUMMARY_MAX = 120;
/** Aperçu de la réponse dans subagent_end (chars). */
export const RESPONSE_PREVIEW_MAX = 500;
/** Nombre max d'actions conservées dans le résumé persisté. */
export const MAX_ACTIONS = 50;

// ── Types publics ─────────────────────────────────────────

/** Champs d'enveloppe communs à tous les événements sous-agent. */
export interface SubagentEventBase {
  /** Identifiant du run de délégation (makeDelegateRunId). */
  delegateRunId: string;
  /** Tentative en cours (1..2 — retry sur timeout d'inactivité uniquement). */
  attempt: number;
  /** Fonction de routage effective : planning/execute/review/integrate. */
  delegateFunction: string;
  /** Libellé humain de la fonction (« Exécution », …). */
  delegateLabel: string;
  /** Label « provider/model » effectif (ou « ? » si inconnu). */
  model: string;
  /** Extrait de la tâche déléguée (≤ TASK_EXCERPT_MAX chars). */
  taskExcerpt: string;
}

/** Enveloppe transmise sur le canal WS pi_event existant. */
export interface SubagentEnvelope extends SubagentEventBase {
  type: "subagent";
  source: "subagent";
  /**
   * Projet auquel CE sous-agent appartient (résolu côté extension via le pont
   * cwd → UUID, ou ctx.projectId). ÉTANCHÉITÉ inter-projets : présent DANS
   * l'enveloppe (et pas seulement sur la frame WS {type:"pi_event",
   * projectId}), il permet au frontend de vérifier la cohérence frame/enveloppe
   * et de filtrer de façon fiable même si le canal est diffusé à un socket
   * abonné à plusieurs projets (multi-onglets / arrière-plan).
   */
  projectId?: string;
  /** Événement SDK brut (ou clone tronqué) du sous-agent. */
  event: unknown;
}

/** Statut de fin de vie d'un délégué (spec LOT 2a). */
export type SubagentEndStatus =
  | "success"
  | "error"
  | "timeout-inactivity"
  | "timeout-global"
  | "aborted";

/** Action d'outils résumée, portée par l'entrée persistée subagent_activity. */
export interface SubagentActionRecord {
  seq: number;
  toolName: string;
  argSummary: string;
  durationMs: number | null;
  isError?: boolean;
  summary: string;
  outputChars: number;
  truncated: boolean;
}

// ── Pont d'émission (globalThis) ─────────────────────────

/** Clé du pont global : l'émetteur brut publié par session.ts (instance ESM native). */
const EMITTER_BRIDGE_KEY = "__piWebHarnessRawEmit__";

/** Signature de rawEmitToSubscribers (session.ts) telle que publiée dans le pont. */
export type RawSubagentEmitter = (event: unknown, projectId: string) => void;

/**
 * Publie l'émetteur brut (rawEmitToSubscribers de session.ts) dans le pont
 * global. Appelé UNE FOIS au chargement de session.ts — l'instance jiti de
 * harness-stream (chargée via l'extension) lit alors le MÊME émetteur que
 * l'instance ESM native du backend (cf. note ⚠️ en tête de fichier).
 */
export function registerSubagentEmitter(fn: RawSubagentEmitter): void {
  (globalThis as any)[EMITTER_BRIDGE_KEY] = fn;
}

/** Lit le pont ; null s'il n'est pas enregistré (no-op garanti côté émission). */
export function resolveSubagentEmitter(): RawSubagentEmitter | null {
  const fn = (globalThis as any)[EMITTER_BRIDGE_KEY];
  return typeof fn === "function" ? (fn as RawSubagentEmitter) : null;
}

// ── Identifiant de délégation ────────────────────────────

/**
 * Identifiant de run de délégation : `d-<epochMs>-<4 aléa>` (hex).
 * Unique par appel du tool delegate ; porte l'enveloppe et permet au
 * frontend de regrouper les événements d'une même délégation.
 */
export function makeDelegateRunId(now: number = Date.now()): string {
  return `d-${now}-${randomBytes(2).toString("hex")}`;
}

// ── Enveloppe + émission ─────────────────────────────────

/**
 * Construit l'enveloppe (pur — testé). Aucune mutation de l'event interne.
 * `projectId` : projet concerné par le sous-agent (emitSubagentEvent le passe
 * toujours) — l'enveloppe est AUTONOME (le frontend peut vérifier que la frame
 * WS qui la transporte est bien celle du même projet).
 */
export function buildSubagentEnvelope(
  base: SubagentEventBase,
  event: unknown,
  projectId?: string,
): SubagentEnvelope {
  return {
    type: "subagent",
    source: "subagent",
    // Étanchéité : le projet d'appartenance est porté DANS l'enveloppe
    // (chaînes vides/null → champ absent, pas de valeur mensongère).
    ...(typeof projectId === "string" && projectId ? { projectId } : {}),
    delegateRunId: String(base?.delegateRunId ?? ""),
    attempt: Number.isFinite(base?.attempt) ? Number(base.attempt) : 1,
    delegateFunction: String(base?.delegateFunction ?? "unknown"),
    delegateLabel: String(base?.delegateLabel ?? base?.delegateFunction ?? "sous-agent"),
    model: String(base?.model ?? "?"),
    taskExcerpt: truncateChars(String(base?.taskExcerpt ?? ""), TASK_EXCERPT_MAX),
    event,
  };
}

/**
 * Émet un événement sous-agent enveloppé vers les abonnés WS du projet.
 *
 * - Enveloppe TOUJOURS (type:"subagent", cf. en tête) ;
 * - try/catch PERMANENT : aucun échec (pont absent, callback abonné qui
 *   jette, event non sérialisable…) ne peut remonter à l'appelant — la
 *   délégation continue quoi qu'il arrive ;
 * - no-op si le pont n'est pas résolvable ou projectId absent.
 *
 * L'émission est DIRECTE (rawEmitToSubscribers) : elle ne passe PAS par le
 * buffer 40 ms de session.ts (qui fusionne les deltas par type — inadapté
 * aux événements structurés hétérogènes).
 */
export function emitSubagentEvent(
  projectId: string,
  base: SubagentEventBase,
  event: unknown,
): void {
  try {
    if (!projectId) return;
    const emit = resolveSubagentEmitter();
    if (!emit) return; // no-op : pont absent (tests, hôte inattendu)
    // Le projectId est passé (1) à l'émetteur → routage WS ciblé par projet
    // (index.ts filtre ws.subscribedProjects) ET (2) DANS l'enveloppe → le
    // frontend peut vérifier la cohérence et filtrer de façon fiable.
    emit(buildSubagentEnvelope(base, event, projectId), projectId);
  } catch {
    // Permanemment silencieux : le streaming est un plus, jamais une dépendance.
  }
}

/**
 * Filtre les entrées `custom` de type subagent_activity du contexte LLM.
 * Pur — utilisé par session.ts dans le wrapper convertToLlm : le résumé
 * d'activité persiste dans la session (survit au rechargement) SANS coût
 * LLM (les détails vivent dans `details`, jamais envoyés au modèle).
 */
export function isSubagentActivityMessage(m: unknown): boolean {
  try {
    const anyM = m as any;
    return anyM?.role === "custom" && anyM?.customType === "subagent_activity";
  } catch {
    return false;
  }
}

export function filterSubagentActivityFromContext(messages: unknown[]): unknown[] {
  try {
    return messages.filter((m) => !isSubagentActivityMessage(m));
  } catch {
    return messages;
  }
}

// ── Normalisation des appels LEGACY au tool de délégation ─────
// Le tool de délégation s'appelait autrefois `delegate_to_expert` (paramètre
// `role`) ; il a été renommé `delegate` (paramètre `function`).
//
// PROBLÈME (mode harness) : une session REPRISE dont l'historique contient
// d'anciens appels `delegate_to_expert` voit le modèle IMITER son propre passé —
// il rappelle `delegate_to_expert` (obsolete) → « Tool delegate_to_expert not
// found », en boucle, et se croit bloqué alors que `delegate` est bien actif.
// Le system prompt ne suffit pas : l'ancrage par l'historique est plus fort.
//
// SOLUTION : au moment où le contexte est envoyé au LLM (wrapper convertToLlm
// de session.ts), on RÉÉCRIT les appels/résultats `delegate_to_expert` en
// `delegate` et on migre `role` → `function`. Pure, sans mutation de l'historique
// persisté ni de l'UI : seul ce que voit le modèle est normalisé.
/** Ancien nom du tool de délégation (avant renommage en `delegate`). */
export const LEGACY_DELEGATE_TOOL_NAME = "delegate_to_expert";
/** Nom courant du tool de délégation (extensions/harness-orchestrator). */
export const DELEGATE_TOOL_NAME = "delegate";

/**
 * Mappe un ancien rôle d'expert vers la fonction de routage v3 correspondante.
 * Aligné sur mapRoleToFunction de l'extension harness-orchestrator.
 */
export function mapLegacyDelegateRoleToFunction(role: unknown): string {
  switch (role) {
    case "architect":
      return "planning";
    case "code-reviewer":
    case "security-reviewer":
      return "review";
    default:
      return "execute";
  }
}

/**
 * Réécrit, dans une liste de messages AgentMessage, toute trace du tool hérité
 * `delegate_to_expert` vers `delegate` :
 *  - appels (content toolCall) : renomme + migre `role`→`function` ;
 *  - résultats (toolResult) : renomme `toolName` + le texte « Tool … not found » ;
 *  - textes/thinking historiques : remplace le nom (l'ancre par imitation).
 *
 * Retourne une NOUVELLE liste (copies superficielles ciblées) — la liste et les
 * objets d'origine ne sont jamais mutés. Idempotent et tolérant aux formes
 * inattendues (ne jette jamais). Le terme est univoque (nom de tool) → le
 * remplacement textuel ne peut pas casser un identifiant métier.
 */
export function normalizeLegacyDelegateToolNames(messages: unknown[]): unknown[] {
  const sub = (s: string) => s.split(LEGACY_DELEGATE_TOOL_NAME).join(DELEGATE_TOOL_NAME);
  try {
    return messages.map((m) => {
      const anyM = m as any;
      if (!anyM || typeof anyM !== "object") return m;
      let next = anyM;

      // toolResult : renommer toolName.
      if (anyM.toolName === LEGACY_DELEGATE_TOOL_NAME) {
        next = { ...next, toolName: DELEGATE_TOOL_NAME };
      }

      // content sous forme de chaîne (rare) : remplacement direct.
      if (typeof anyM.content === "string") {
        if (anyM.content.includes(LEGACY_DELEGATE_TOOL_NAME)) {
          next = { ...next, content: sub(anyM.content) };
        }
        return next;
      }

      if (Array.isArray(anyM.content)) {
        let changed = false;
        const content = anyM.content.map((c: any) => {
          if (!c || typeof c !== "object") return c;

          // toolCall : renommer + migrer role→function.
          if (c.type === "toolCall" && c.name === LEGACY_DELEGATE_TOOL_NAME) {
            changed = true;
            let args = c.arguments;
            if (args && typeof args === "object") {
              args = { ...args };
              if (args.function === undefined && args.role !== undefined) {
                args.function = mapLegacyDelegateRoleToFunction(args.role);
              }
              delete args.role;
            }
            return { ...c, name: DELEGATE_TOOL_NAME, arguments: args };
          }

          // textes / thinking : retirer l'ancre par imitation.
          if (c.type === "text" && typeof c.text === "string" && c.text.includes(LEGACY_DELEGATE_TOOL_NAME)) {
            changed = true;
            return { ...c, text: sub(c.text) };
          }
          if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.includes(LEGACY_DELEGATE_TOOL_NAME)) {
            changed = true;
            return { ...c, thinking: sub(c.thinking) };
          }

          return c;
        });
        if (changed) next = { ...next, content };
      }

      return next;
    });
  } catch {
    return messages;
  }
}

// ── Neutralisation des appels d'outils IMPOSSIBLES (fuite du mode harness) ──
//
// PROBLÈME (audit usage outils) : en mode harness l'orchestrateur n'a que
// `delegate` (+ les cbm_*), les tools d'exécution (bash/edit/read/grep/write/
// find/ls) sont retirés. Quand le modèle les appelle quand même (session
// REPRISE où il a réellement codé par le passé → il imite son historique), le
// SDK renvoie un toolResult d'erreur laconique « Tool bash not found » qui ne
// dit PAS quoi faire à la place → le modèle réessaie en boucle (386 tentatives
// mesurées). Symétriquement, en mode code `delegate` est retiré et son
// « not found » n'oriente pas vers le travail direct.
//
// SOLUTION : au moment où le contexte part au LLM (convertToLlm), on réécrit
// le RÉSULTAT de ces erreurs en message ACTIONNABLE (quel tool appeler à la
// place). On ne touche NI l'historique persisté NI l'UI : seul le contexte LLM
// est modifié — exactement le même mécanisme que
// normalizeLegacyDelegateToolNames (session reprise), étendu à TOUS les outils
// indisponibles.
//
// POURQUOI convertToLlm (et pas beforeToolCall / afterToolCall) : dans
// pi-agent-core (agent-loop.js), le contrôle « Tool … not found » court-
// circuite AVANT le hook beforeToolCall — et n'atteint donc jamais
// afterToolCall. Aucun hook d'exécution ne voit ces erreurs. convertToLlm, lui,
// est appelé avant CHAQUE requête provider : il couvre à la fois l'erreur LIVE
// du tour en cours (le modèle la relit au tour suivant) et les erreurs
// HISTORIQUES d'une session reprise.

/** Tools d'exécution de base retirés en mode harness (sous-ensemble de BASE_TOOLS). */
export const EXECUTION_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/** Détecte l'erreur SDK « Tool X not found » (variantes avec guillemets / Error:). */
export function isToolNotFoundError(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return /tool\s+["'`]?[\w.-]+["'`]?\s+not found/i.test(text);
}

/** Texte joint d'un contenu de message (string, ou blocs {type:"text"}). */
function joinMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    const anyC = c as any;
    if (anyC && typeof anyC === "object" && anyC.type === "text" && typeof anyC.text === "string") {
      out += anyC.text;
    }
  }
  return out;
}

/**
 * Message ACTIONNABLE de remplacement pour un appel d'outil impossible.
 * Trois cas : `delegate` retiré (mode code → travailler directement), tool
 * d'exécution retiré (mode harness → déléguer), outil inconnu/halluciné.
 * Pur — testé.
 */
export function buildUnavailableToolGuidance(toolName: string, activeTools: string[]): string {
  const name = String(toolName ?? "outil");
  const list = activeTools.slice(0, 30).join(", ");
  if (name === DELEGATE_TOOL_NAME) {
    return (
      `⚠️ Le tool « ${name} » n'est PAS disponible dans ce mode (travail direct). ` +
      `Fais le travail toi-même avec les outils actifs (${list}). NE rappelle PAS « ${name} ».`
    );
  }
  if ((EXECUTION_TOOL_NAMES as readonly string[]).includes(name)) {
    return (
      `⚠️ Le tool « ${name} » n'est PAS disponible en mode harness : l'orchestrateur ne code pas. ` +
      `Pour faire exécuter/modifier/explorer du code, appelle le tool \`delegate\` avec ` +
      `function="execute" (implémentation), "planning" (exploration/plan), "review" (audit) ` +
      `ou "integrate" (synthèse). NE rappelle PAS « ${name} ».`
    );
  }
  return (
    `⚠️ Le tool « ${name} » n'existe pas ou n'est pas disponible dans ce mode. ` +
    `Choisis un tool de ta liste d'outils active (${list}). NE rappelle PAS « ${name} ».`
  );
}

/**
 * Réécrit le CONTENU des toolResult d'erreur « Tool X not found » dont l'outil
 * n'est PAS actif, en message pédagogique orientant vers un tool valide. Ne
 * renvoie une nouvelle liste QUE si au moins un message est modifié (sinon la
 * liste d'origine est retournée telle quelle). Jamais de mutation ; ne jette
 * jamais. Si `activeTools` est vide, on ne peut pas décider → aucun changement.
 */
export function neutralizeUnavailableToolErrors(
  messages: unknown[],
  activeTools: string[],
): unknown[] {
  try {
    if (!Array.isArray(messages) || !Array.isArray(activeTools) || activeTools.length === 0) {
      return messages;
    }
    const active = new Set(activeTools);
    let changed = false;
    const out = messages.map((m) => {
      const anyM = m as any;
      if (!anyM || typeof anyM !== "object" || anyM.role !== "toolResult") return m;
      const toolName = String(anyM.toolName ?? "");
      if (!toolName || active.has(toolName)) return m;
      if (!anyM.isError) return m;
      if (!isToolNotFoundError(joinMessageText(anyM.content))) return m;
      changed = true;
      return {
        ...anyM,
        content: [{ type: "text", text: buildUnavailableToolGuidance(toolName, activeTools) }],
      };
    });
    return changed ? out : messages;
  } catch {
    return messages;
  }
}

// ── Garde-fou anti-spam d'exploration (sous-agents) ──────
// Un sous-agent « execute » a enchaîné jusqu'à 138 actions / 524 s avec 0 appel
// cbm_* (audit usage outils) : relectures de fichiers tronqués, grep en chaîne,
// alors que le graphe de code était disponible. La consigne prompt ne suffit
// pas → garde-fou mécanique. On compte les lectures/recherches CONSÉCUTIVES
// sans cbm_* et, au seuil, on injecte un rappel court dans le contexte LLM du
// sous-agent (message custom non affiché, cf. extension harness-orchestrator).

/** Tools d'exploration « ligne par ligne » surveillés par le garde-fou. */
export const EXPLORATION_TOOL_NAMES = ["read", "grep", "ls", "find"] as const;
/** Préfixe des tools du graphe de code (codebase-memory). */
export const CBM_TOOL_PREFIX = "cbm_";
/** Seuil : au-delà de N explorations consécutives sans cbm_*, on rappelle. */
export const EXPLORATION_NUDGE_THRESHOLD = 6;
/** Plafond de rappels injectés par sous-agent (évite le bruit si le modèle ignore). */
export const EXPLORATION_MAX_NUDGES = 3;

export interface ExplorationGuardState {
  /** Appels d'exploration consécutifs sans cbm_*. */
  streak: number;
  /** Rappels déjà injectés (plafonné à EXPLORATION_MAX_NUDGES). */
  nudgesSent: number;
}

export interface ExplorationGuardDecision {
  nextStreak: number;
  nudgesSent: number;
  /** true → injecter le rappel CBM dans le contexte du sous-agent. */
  nudge: boolean;
}

/**
 * Décide s'il faut injecter le rappel CBM après l'appel `toolName`.
 * - cbm_* ou tout autre tool (edit/write/bash/analyze_file…) → reset du streak :
 *   une requête au graphe ou une action de fond casse la série d'exploration ;
 * - read/grep/ls/find → streak+1 ; au seuil (et sous le plafond) → nudge + reset.
 * Pur — testé.
 */
export function decideExplorationNudge(
  toolName: unknown,
  state: ExplorationGuardState,
  opts?: { threshold?: number; maxNudges?: number },
): ExplorationGuardDecision {
  const threshold = Math.max(1, opts?.threshold ?? EXPLORATION_NUDGE_THRESHOLD);
  const maxNudges = Math.max(0, opts?.maxNudges ?? EXPLORATION_MAX_NUDGES);
  const streak = Math.max(0, Math.floor(state?.streak ?? 0));
  const nudgesSent = Math.max(0, Math.floor(state?.nudgesSent ?? 0));
  const name = typeof toolName === "string" ? toolName : "";

  const isCbm = name.startsWith(CBM_TOOL_PREFIX);
  const isExploration = (EXPLORATION_TOOL_NAMES as readonly string[]).includes(name);

  if (isCbm || !isExploration) {
    return { nextStreak: 0, nudgesSent, nudge: false };
  }
  const next = streak + 1;
  if (next >= threshold && nudgesSent < maxNudges) {
    return { nextStreak: 0, nudgesSent: nudgesSent + 1, nudge: true };
  }
  return { nextStreak: next, nudgesSent, nudge: false };
}

/** Rappel court injecté dans le contexte du sous-agent (custom, non affiché). */
export function buildExplorationReminder(): string {
  return (
    "[rappel automatique] Tu enchaînes read/grep/ls/find sans utiliser le graphe de code, " +
    "or ce projet est indexé. AVANT toute nouvelle lecture ou recherche, tente un tool CBM : " +
    "cbm_search (symbole par nom/pattern/sens), cbm_code (code d'un symbole), " +
    "cbm_trace (appelants/appelés), cbm_search_code (texte), cbm_arch (architecture). " +
    "N'utilise read/grep que si le graphe ne peut pas répondre (fichier hors projet, config, script)."
  );
}

// ── Quota de sécurité (pur, horloge injectable pour les tests) ──

export interface SubagentGateAdmission {
  /** true → l'événement peut être émis. */
  admitted: boolean;
  /** true → l'événement a été FONDU dans l'update précédent (même toolCallId). */
  merged: boolean;
}

export interface SubagentEventGate {
  /** Compteur d'événements droppés (quota dépassé) — reporté dans subagent_end. */
  readonly droppedEvents: number;
  /** Déclare un événement avant émission ; n'émet rien lui-même. */
  admit(event: { type?: string; toolCallId?: string }): SubagentGateAdmission;
}

/**
 * Quoi qu'il arrive, au plus `maxPerSecond` événements peuvent passer par
 * fenêtre glissante de 1 s. Au-delà :
 *  - un tool_execution_update consécutif au DERNIER événement admis et pour
 *    le MÊME toolCallId est FONDU (l'aperçu garde la dernière capture — les
 *    updates sont des snapshots progressifs) ;
 *  - tout autre événement est droppé.
 * Chaque refus (fusion ou drop) incrémente `droppedEvents`.
 */
export function createSubagentEventGate(opts?: {
  maxPerSecond?: number;
  now?: () => number;
}): SubagentEventGate {
  const max = Math.max(1, opts?.maxPerSecond ?? SUBAGENT_MAX_EVENTS_PER_SECOND);
  const now = opts?.now ?? Date.now;
  const admittedAt: number[] = [];
  let lastAdmitted: { type?: string; toolCallId?: string } | null = null;
  let dropped = 0;

  return {
    get droppedEvents() {
      return dropped;
    },
    admit(event: { type?: string; toolCallId?: string }): SubagentGateAdmission {
      const t = now();
      // Fenêtre glissante : purge les admissions de plus d'une seconde.
      while (admittedAt.length > 0 && t - admittedAt[0] >= 1000) {
        admittedAt.shift();
      }
      if (admittedAt.length >= max) {
        dropped++;
        const isUpdate = event?.type === "tool_execution_update";
        const sameToolCall =
          isUpdate &&
          lastAdmitted?.type === "tool_execution_update" &&
          lastAdmitted.toolCallId !== undefined &&
          lastAdmitted.toolCallId === event?.toolCallId;
        return { admitted: false, merged: sameToolCall };
      }
      admittedAt.push(t);
      lastAdmitted = { type: event?.type, toolCallId: event?.toolCallId };
      return { admitted: true, merged: false };
    },
  };
}

// ── Troncatures (pur) ────────────────────────────────────

/** Tronque à `max` chars ; `null`/undefined → "". */
export function truncateChars(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max));
}

/** Première ligne non vide, tronquée à `max` chars. */
export function firstLine(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  for (const line of s.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return truncateChars(trimmed, max);
  }
  return "";
}

/** Nombre de lignes non vides d'un output (utilisé par les résumés d'outils). */
export function countLines(value: unknown): number {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!s.trim()) return 0;
  return s.split("\n").filter((l) => l.trim().length > 0).length;
}

// ── Résumés d'outils (alignés sur la spec LOT 2a) ────────

/**
 * Extrait court des arguments d'un tool (≤ ACTION_SUMMARY_MAX chars) — même
 * heuristique de ciblage que formatEventLine de l'extension : path / filePath /
 * file_path / command / pattern, sinon JSON court.
 */
export function summarizeToolArgs(toolName: string, args: any): string {
  try {
    const a = args || {};
    const target =
      (typeof a.path === "string" && a.path) ||
      (typeof a.filePath === "string" && a.filePath) ||
      (typeof a.file_path === "string" && a.file_path) ||
      (typeof a.file === "string" && a.file) ||
      (typeof a.command === "string" && a.command) ||
      (typeof a.pattern === "string" && a.pattern) ||
      (typeof a.query === "string" && a.query) ||
      "";
    const line = `${toolName} ${target}`.trim();
    if (line) return truncateChars(line, ACTION_SUMMARY_MAX);
    return truncateChars(toolName, ACTION_SUMMARY_MAX);
  } catch {
    return truncateChars(toolName, ACTION_SUMMARY_MAX);
  }
}

/** Compte les +/− d'un diff unifié (ignore les en-têtes +++/---). */
function countDiffLines(diff: unknown): { added: number; removed: number } | null {
  if (typeof diff !== "string" || !diff) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Extrait un code de sortie bash d'un output d'erreur du SDK. */
function parseBashExitCode(output: string): number | null {
  const m = output.match(/exited with code (-?\d+)/);
  return m ? Number(m[1]) : null;
}

export interface ToolActionSummaryInput {
  toolName: string;
  args?: any;
  /** Output FINAL du tool (tool_execution_end), peut être vide. */
  output?: string;
  isError?: boolean;
  /** details du résultat (ex. details.diff pour edit, truncation read/bash). */
  details?: any;
}

/**
 * Résumé court d'une action d'outil (≤ ACTION_SUMMARY_MAX chars), aligné sur
 * la spec : read → N lignes ; write → N lignes écrites ; edit → +A/−B via
 * details.diff ; bash → exit N + N lignes ; grep/find/ls → N résultats /
 * fichiers / entrées ; erreur → 1re ligne 120 chars. Pur — testé.
 */
export function summarizeToolAction(input: ToolActionSummaryInput): string {
  const tool = String(input?.toolName ?? "outil");
  const output = typeof input?.output === "string" ? input.output : "";
  try {
    // Erreur → 1re ligne de l'output (120 chars), quelle que soit l'outil.
    // Le résumé TOTAL reste ≤ ACTION_SUMMARY_MAX (spec persistance : summary
    // ≤120 chars) — le préfixe empiète sur le budget de la ligne.
    if (input?.isError) {
      const first = firstLine(output, ACTION_SUMMARY_MAX);
      return truncateChars(first ? `erreur — ${first}` : "erreur", ACTION_SUMMARY_MAX);
    }

    switch (tool) {
      case "read": {
        const lines = countLines(output);
        return lines > 0 ? `${lines} lignes` : "fichier lu (sortie vide)";
      }
      case "write": {
        const content = input?.args?.content;
        const lines = typeof content === "string" && content
          ? content.split("\n").length
          : countLines(output);
        return lines > 0 ? `${lines} lignes écrites` : "fichier écrit";
      }
      case "edit": {
        const diff = countDiffLines(input?.details?.diff);
        if (diff) return `+${diff.added}/−${diff.removed}`;
        return "fichier modifié";
      }
      case "bash": {
        const lines = countLines(output);
        const exit = parseBashExitCode(output);
        return exit !== null ? `exit ${exit} · ${lines} lignes` : `${lines} lignes`;
      }
      case "grep":
        return `${countLines(output)} résultats`;
      case "find":
        return `${countLines(output)} fichiers`;
      case "ls":
        return `${countLines(output)} entrées`;
      default: {
        const first = firstLine(output, ACTION_SUMMARY_MAX);
        return first || tool;
      }
    }
  } catch {
    return tool;
  }
}