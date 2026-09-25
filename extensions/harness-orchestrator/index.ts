/**
 * Harness Orchestrator Extension for Pi-Web
 *
 * Remplace l'ancien HarnessEngine par une approche conversationnelle.
 * L'orchestrator (chef de projet) discute avec l'utilisateur et délègue
 * l'exécution aux fonctions de routage via le tool `delegate`.
 *
 * Le tool crée une session Pi temporaire pour la fonction, exécute la tâche,
 * et retourne le résultat à l'orchestrator.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── P0 observabilité (volet 1/2) : archivage des délégués en échec ──
// Module backend (backend/src/pi/harness-archive.ts) : helpers PURS fs/path,
// SANS dépendance Express — le chargement de l'extension reste inoffensif.
// Conservé dans backend/ (plutôt que copié dans l'extension) car il dépend du
// logger backend ET de la racine projet (.data), et pour que son test reste
// scanné par vitest (backend/vitest.config.ts). Résolu par jiti au chargement.
// - archiveFailedSession : boîte noire (JSONL + meta) en échec uniquement.
// - classifyFailure : filet de classification pour les exceptions non annotées.
import {
  archiveFailedSession,
  classifyFailure,
} from "../../backend/src/pi/harness-archive.js";

// ── P2/P3 : distinction abort UTILISATEUR / abort INTERNE + garde de course ──
// Module backend PUR (backend/src/pi/harness-abort.ts), résolu par jiti comme
// harness-archive. Empêche (P2) qu'un abort interne soit étiqueté
// « abort-utilisateur » et (P3) qu'un rejet de promesse perdante de course
// remonte en unhandledRejection (ce qui tuait le backend).
import {
  abortMessageFor,
  createRaceGuard,
  isAbortInterruption,
  resolveAbortCause,
  swallowRejection,
} from "../../backend/src/pi/harness-abort.js";

// ── Détecteur de SILENCE DE FLUX des sous-agents ─────────────────────────
// Module backend PUR (backend/src/pi/stream-silence.ts) : la liveness d'un run
// n'est plus sa DURÉE mais la production continue d'événements. Tant que le
// flux émet, le compteur de silence se réinitialise → une génération de
// plusieurs heures n'est pas coupée ; seul un silence réel (aucun événement
// pendant le délai configuré, défaut 15 min) arrête proprement le sous-agent.
// Les valeurs (délai de silence + garde-fou de dernier recours) sont lues au
// RUNTIME via le pont `__piWebConcurrency` (l'extension est chargée par jiti).
import {
  DEFAULT_AGENT_HARD_TIMEOUT_MS,
  DEFAULT_STREAM_SILENCE_TIMEOUT_MS,
  StreamSilenceDetector,
  hardTimeoutMessage,
  isHardTimeoutMessage,
  isSilenceTimeoutMessage,
  sanitizeAgentHardTimeoutMs,
  sanitizeStreamSilenceTimeoutMs,
  streamSilenceMessage,
} from "../../backend/src/pi/stream-silence.js";

// ── LOT 2a (refonte chat) : streaming de l'activité des sous-agents ──
// Module backend (backend/src/pi/harness-stream.ts), résolu par jiti comme
// harness-archive. Contient :
// - emitSubagentEvent : enveloppe {type:"subagent", …} + émission DIRECTE via
//   le pont globalThis publié par session.ts (rawEmitToSubscribers) — try/catch
//   permanent, no-op si non résolvable (un échec de streaming ne doit JAMAIS
//   faire échouer une délégation) ;
// - makeDelegateRunId : identifiant `d-<epochMs>-<4 aléa>` par délégation ;
// - createSubagentEventGate : quota de sécurité (≤20 événements enveloppés/s,
//   fusion des tool_execution_update consécutifs d'un même toolCallId,
//   compteur droppedEvents) ;
// - résumés d'outils PURS partagés (summarizeToolAction/summarizeToolArgs,
//   testés côté backend) pour la persistance du résumé d'activité.
import {
  buildExplorationReminder,
  createSubagentEventGate,
  decideExplorationNudge,
  emitSubagentEvent,
  EXPLORATION_NUDGE_THRESHOLD,
  makeDelegateRunId,
  MAX_ACTIONS,
  MESSAGE_TEXT_MAX,
  MESSAGE_THINKING_MAX,
  RESPONSE_PREVIEW_MAX,
  summarizeToolAction,
  summarizeToolArgs,
  TASK_EXCERPT_MAX,
  TOOL_OUTPUT_MAX,
  truncateChars,
  UPDATE_TEXT_MAX,
  type ExplorationGuardState,
  type SubagentActionRecord,
  type SubagentEndStatus,
} from "../../backend/src/pi/harness-stream.js";

// ── Carte du Repo (P1, étude tokens sous-agents) : marqueurs du bloc --------
// Le texte de la carte est produit par le pont globalThis `__cbmRepoMap`
// (publié par l'extension codebase-memory) et enveloppé par ces marqueurs dans
// le prompt système du sous-agent. Le helper pur (backend/src/pi/repo-map.ts)
// expose les mêmes constantes → source unique de vérité.
import {
  REPO_MAP_MARKER_START,
  REPO_MAP_MARKER_END,
} from "../../backend/src/pi/repo-map.js";

// ── Carnet d'exploration (P2, étude tokens sous-agents) ──────────────────────
// Les découvertes des sous-agents (faits/pièges/décisions) sont persistées dans
// un stockage JSONL hors repo (backend/src/pi/exploration-notes.ts) et
// réinjectées d'office au démarrage sous-agent (bloc digest borné ~2000 chars),
// comme la carte P1. Deux tools permettent à l'agent d'écrire et de relire.
import {
  appendExplorationNote,
  buildNotesDigest,
  readExplorationNotes,
  renderNotesList,
  searchExplorationNotes,
  EXPLORATION_NOTES_MARKER_START,
  EXPLORATION_NOTES_MARKER_END,
  NOTE_KIND_LABELS,
} from "../../backend/src/pi/exploration-notes.js";

// ── Annexe de pertinence (P3, prompt caching) : marqueurs du bloc ────────────
// Les éléments VARIABLES par tâche (carte CBM boostée P1 + carnet boosté P2) ne
// doivent PAS vivre dans le prompt système (ils casseraient le cache du préfixe
// cross-délégation). Ils sont regroupés dans une « annexe de pertinence »
// déposée en fin du PREMIER MESSAGE USER, sous ces marqueurs.
const TASK_RELEVANCE_MARKER_START = "<!-- PI_TASK_RELEVANCE -->";
const TASK_RELEVANCE_MARKER_END = "<!-- /PI_TASK_RELEVANCE -->";

// ── Rappel ferme « HARNESS → déléguer » ───────────────
// Problème observé : l'orchestrator tente d'utiliser les tools d'exécution
// directs (bash, edit, read…) — retirés de sa session en mode harness — puis
// « attend qu'ils reviennent » et perd des turns au lieu de déléguer via
// `delegate`. Deux rappels, tous deux limités au mode HARNESS :
//  1. promptGuidelines du tool `delegate` : n'apparaissent que lorsque le tool
//     est actif, c'est-à-dire uniquement en mode harness (backend/src/pi/session.ts
//     exclut `delegate` des autres modes via HARNESS_EXCLUDE).
//  2. Handler before_agent_start : injecte le bloc PI_HARNESS_ROLE en fin de
//     system prompt à CHAQUE turn — même mécanisme que l'injection
//     <!-- PI_PROJECT_CONTEXT --> de backend/src/pi/session.ts.
const HARNESS_ROLE_MARKER_START = "<!-- PI_HARNESS_ROLE -->";
const HARNESS_ROLE_MARKER_END = "<!-- /PI_HARNESS_ROLE -->";
// Bloc nettoyé avant réinjection (idempotence si un turn précédent l'avait posé).
// Les marqueurs ne contiennent aucun caractère spécial regex → concaténation directe.
const HARNESS_ROLE_BLOCK_RE = new RegExp(
  `\\n*${HARNESS_ROLE_MARKER_START}[\\s\\S]*?${HARNESS_ROLE_MARKER_END}\\n*`,
  "g",
);
const HARNESS_ROLE_REMINDER = [
  HARNESS_ROLE_MARKER_START,
  "## ⚠️ HARNESS MODE — ROLE REMINDER (BINDING)",
  "",
  "You are in HARNESS mode (project lead): you DESIGN, you DELEGATE every execution task to sub-agents via the `delegate` tool (execute/planning/review/integrate), then you review results. Execution tools (bash, edit, read, write, grep) are NOT available to you — if a tool is 'not found', that is the signal to DELEGATE, never to wait or retry directly. Never code, edit files, or run commands yourself.",
  "",
  "TOOL NAME (BINDING) : the delegation tool is named EXACTLY `delegate`, with the parameter `function` (planning | execute | review | integrate). There is NO tool named `delegate_to_expert` — it was RENAMED to `delegate`. If your own earlier/persisted messages (resumed session) mention `delegate_to_expert` or a `role` argument, IGNORE that legacy form and call `delegate` with `function`.",
  HARNESS_ROLE_MARKER_END,
].join("\n");

// ── Fonctions de routage ──────────────────────────────

interface FunctionDef {
  name: string;
  emoji: string;
  label: string;
  description: string;
  systemPrompt: string;
  tools: string[];
}

// ── Exploration du code par le graphe CBM ─────────────
// Les tools cbm_* sont enregistrés par l'extension extensions/codebase-memory,
// chargée par le DefaultResourceLoader PAR DÉFAUT du SDK — y compris dans la
// tempSession des délégués (createAgentSession sans resourceLoader). Vérifié
// par expérience : les 8 tools cbm_* sont bien dans le registre de la tempSession.
// Les exposer à TOUS les rôles évite les chaînes coûteuses read/grep : une
// requête au graphe répond à des questions structurelles (qui appelle quoi,
// code d'un symbole, impact d'un diff). setActiveToolsByName ignore
// silencieusement un nom inconnu → aucun risque si l'extension est absente.
const CBM_TOOLS: string[] = [
  "cbm_search",
  "cbm_trace",
  "cbm_code",
  "cbm_search_code",
  "cbm_diff",
  "cbm_arch",
  "cbm_cypher",
  "cbm_schema",
];

// Tools du Carnet d'exploration (P2), exposés à TOUS les rôles. Enregistrés par
// CETTE extension (donc présents dans le registre des tempSessions, comme les
// cbm_*) ; setActiveToolsByName ignore silencieusement un nom inconnu.
const EXPLORATION_TOOLS: string[] = ["exploration_note", "exploration_notes"];

// Consigne commune d'exploration ajoutée au prompt de chaque rôle. Objectif :
// faire basculer le réflexe « lire les fichiers un par un » vers le graphe.
// 
// RÈGLES OPÉRATIONNELLES (pas seulement « privilégie ») : l'audit usage outils
// a montré 0 appel cbm_* sur 298 actions de sous-agents malgré la consigne
// précédente. On formule donc des DÉCLENCHEURS concrets et vérifiables.
const CBM_EXPLORATION_GUIDE = `

## Exploration du code : le graphe AVANT les fichiers (RÈGLE)
Le projet est indexé dans un graphe de code exposé par les tools \`cbm_*\`. Ces tools
répondent en une requête à ce que \`read\`/\`grep\` mettent des dizaines d'appels à trouver.
Règles concrètes :
1. AVANT toute 2e lecture du MÊME fichier : appelle \`cbm_code\` sur le symbole visé
   (une relecture de fichier tronqué est presque toujours remplaçable par un ciblage).
2. AVANT toute recherche de symbole (définition, appelant, appelé) : essaie d'abord
   \`cbm_search\` (nom/pattern/sens) ou \`cbm_trace\` (qui appelle quoi).
3. AVANT un \`grep\` structurel ou récursif : essaie \`cbm_search_code\`.
4. \`cbm_arch\` (architecture), \`cbm_diff\` (impact d'un changement non commité),
   \`cbm_schema\` (schéma du graphe) complètent le jeu.
N'utilise \`read\`/\`grep\`/\`find\`/\`ls\` QUE si le graphe ne peut pas répondre
(fichier hors projet comme Dockerfile/entrypoint.sh, config, script non indexé),
ou si les tools cbm_* ne sont pas disponibles. Si plusieurs \`read\`/\`grep\`
s'enchaînent sans cbm_*, un rappel automatique te sera injecté.`;

// Consigne du Carnet d'exploration (P2), ajoutée au prompt de chaque rôle. Le
// pattern « mémoire hors fenêtre » : écrire les découvertes au fil de l'eau pour
// qu'elles survivent à la session et servent aux sous-agents suivants.
const SCRATCHPAD_GUIDE = `

## Carnet d'exploration : persister les découvertes durables
Tes découvertes vivent au-delà de ta session — écrites dans le carnet du projet
(hors repo), elles sont RÉINJECTÉES aux sous-agents suivants.
- \`exploration_note\` (écriture) : UNE découverte par appel, une ligne, jamais de
dump de code. Natures : \`fact\` (fait confirmé), \`pitfall\` (piège rencontré),
\`decision\` (choix acté). Renseigne \`file\` (fichier:symbole) si pertinent.
- \`exploration_notes\` (lecture/recherche) : relis le carnet AVANT de re-explorer
un sujet déjà traité (« que sait-on déjà ? »).
Écris tôt : commande de build/test qui marche, localisation de symboles,
contraintes non évidentes, pièges. N'écris JAMAIS ce qui est déjà visible dans
les fichiers du repo ni des informations temporaires.`;

const FUNCTIONS: FunctionDef[] = [
  {
    name: "planning",
    emoji: "🗺️",
    label: "Planification",
    description: "Explore le code, prend les décisions techniques, élabore un plan d'exécution.",
    systemPrompt: `## RÔLE : PLANIFICATION

Tu es la fonction de planification. Tu reçois une tâche de l'orchestrator. Tu dois :
1. Explorer le codebase existant (CBM en priorité, puis read/grep/find/ls)
2. Prendre les décisions techniques clés
3. Produire un plan d'exécution clair et structuré

## Règles
- Sois précis et concis
- Liste les fichiers à créer/modifier
- Décris l'approche technique et les dépendances
- N'écris pas de code — c'est le job de la fonction execute` + CBM_EXPLORATION_GUIDE + SCRATCHPAD_GUIDE,
    // read-only : exploration (CBM + fichiers) + analyse de fichiers.
    tools: ["read", "grep", "find", "ls", "analyze_file", ...CBM_TOOLS, ...EXPLORATION_TOOLS],
  },
  {
    name: "execute",
    emoji: "⚙️",
    label: "Exécution",
    description: "Implémente les changements : code, tests, documentation, scripts.",
    systemPrompt: `## RÔLE : EXÉCUTION

Tu implémentes les changements demandés.

Règles :
- Explore d'abord via les tools CBM (cbm_search/cbm_code/cbm_trace) plutôt que lire les fichiers un par un
- Lis ensuite uniquement les fichiers concernés avant de commencer
- Écris du code de qualité production
- Suis les conventions existantes du projet
- Fais des changements atomiques, un fichier à la fois
- Gère les erreurs et edge cases
- Teste tes changements avec bash si applicable` + CBM_EXPLORATION_GUIDE + SCRATCHPAD_GUIDE,
    // écriture/édition + bash + exploration (CBM + fichiers) + analyse + capture UI.
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls", "analyze_file", "web_screenshot", ...CBM_TOOLS, ...EXPLORATION_TOOLS],
  },
  {
    name: "review",
    emoji: "🔍",
    label: "Relecture",
    description: "Relit et audite le code : logique, sécurité, performances, edge cases.",
    systemPrompt: `## RÔLE : RELECTURE

Tu analyses le code pour trouver les problèmes.

Règles :
- Explore d'abord via les tools CBM (cbm_search/cbm_code/cbm_trace/cbm_diff) plutôt que lire les fichiers un par un
- Vérifie la logique, la sécurité, les performances
- Vérifie les edge cases non gérés
- Signale les bugs avec fichier:ligne
- Suggère des corrections concrètes
- Ne modifie PAS le code toi-même` + CBM_EXPLORATION_GUIDE + SCRATCHPAD_GUIDE,
    // read-only STRICT (pas d'edit/write/bash) : exploration, analyse, capture UI.
    tools: ["read", "grep", "find", "ls", "analyze_file", "web_screenshot", ...CBM_TOOLS, ...EXPLORATION_TOOLS],
  },
  {
    name: "integrate",
    emoji: "🧩",
    label: "Intégration",
    description: "Synthétise les résultats des autres fonctions et rédige le rapport final.",
    systemPrompt: `## RÔLE : INTÉGRATION

Tu synthétises les résultats des autres fonctions.

Règles :
- Agrège les plans, implémentations et relectures
- Rédige un rapport final clair et actionnable
- Mets en évidence les décisions, les changements et les risques restants
- Ne modifie PAS le code toi-même — c'est une synthèse` + CBM_EXPLORATION_GUIDE + SCRATCHPAD_GUIDE,
    // read-only : exploration CBM + fichiers + analyse pour vérifier la synthèse.
    tools: ["read", "grep", "find", "ls", "analyze_file", ...CBM_TOOLS, ...EXPLORATION_TOOLS],
  },
];

const FUNCTION_BY_NAME = new Map<string, FunctionDef>(FUNCTIONS.map(f => [f.name, f]));

/**
 * Rétro-compatibilité temporaire : mappe un ancien rôle d'expert vers une
 * fonction de routage. Les anciens appelants utilisaient `role`.
 */
function mapRoleToFunction(role: string): string {
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
 * BUG-68 (porté aux délégués — P0 observabilité volet 1/2) : le SDK transforme
 * une erreur modèle en message assistant VIDE (stopReason:"error" + errorMessage)
 * et prompt() ne reject JAMAIS. On lit donc les métadonnées du DERNIER message
 * assistant pour remonter la VRAIE erreur (au lieu de « n'a produit aucune réponse »).
 * Seul le DERNIER assistant compte : un turn réussi après des erreurs antérieures
 * signifie que le retry implicite du SDK a fonctionné.
 */
function detectModelErrorMessage(messages: any[]): string | null {
  try {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      const failed =
        m.stopReason === "error" ||
        (typeof m.errorMessage === "string" && m.errorMessage.length > 0);
      return failed ? (m.errorMessage || `stopReason=${m.stopReason ?? "inconnu"}`) : null;
    }
  } catch {}
  return null;
}

/** Label "provider/model" effectif de la session (diagnosticable dans les erreurs). */
function getSessionModelLabel(tempSession: any): string {
  try {
    const model = (tempSession as any)?.model;
    return `${model?.provider ?? "?"}/${model?.id ?? "?"}`;
  } catch {
    return "?";
  }
}

// ── Pont GLOBAL du limiteur de concurrence LLM ────────────────────────────
// L'extension est chargée par jiti avec `moduleCache: false` : importer
// `backend/src/pi/concurrency.js` depuis ici créerait une SECONDE instance du
// singleton concurrencyManager (limiteur inopérant, slots non comptés par le
// backend). Le backend publie donc son instance RÉELLE sur globalThis
// (`__piWebConcurrency`), exactement comme les ponts `__cbmRepoMap`,
// `__piWebResolveProjectIdByCwd__` et `__piWebHarnessRawEmit__`.
const CONCURRENCY_BRIDGE_KEY = "__piWebConcurrency";

interface LLMConcurrencyBridge {
  acquireLLMSlot(slotKey: string, label: string, providerId?: string): Promise<void>;
  releaseLLMSlot(slotKey: string): void;
  getEffectiveLLMLimit(providerId: string): number;
  // Lecture runtime de la config du détecteur de silence (optionnel : un pont
  // ancien/partiel retombe sur les défauts du module stream-silence).
  getStreamSilenceTimeoutMs?(): number;
  getAgentHardTimeoutMs?(): number;
}

/**
 * Résout la config du détecteur de silence au RUNTIME (pont globalThis) — un
 * changement de réglage s'applique à la délégation suivante sans redémarrage.
 * Valeur illisible/invalide → repli sur les défauts du module (jamais d'échec).
 */
function resolveStreamSilenceConfig(): { silenceTimeoutMs: number; hardTimeoutMs: number } {
  const b = getConcurrencyBridge();
  let silenceTimeoutMs: unknown = DEFAULT_STREAM_SILENCE_TIMEOUT_MS;
  let hardTimeoutMs: unknown = DEFAULT_AGENT_HARD_TIMEOUT_MS;
  try {
    if (typeof b?.getStreamSilenceTimeoutMs === "function") silenceTimeoutMs = b.getStreamSilenceTimeoutMs();
    if (typeof b?.getAgentHardTimeoutMs === "function") hardTimeoutMs = b.getAgentHardTimeoutMs();
  } catch {}
  return {
    silenceTimeoutMs: sanitizeStreamSilenceTimeoutMs(silenceTimeoutMs),
    hardTimeoutMs: sanitizeAgentHardTimeoutMs(hardTimeoutMs),
  };
}

// Repli sûr : si le pont est absent (tests, hôte inattendu), on ne bloque PAS
// la délégation — on exécute sans slot et on journalise UNE fois.
let concurrencyBridgeMissingLogged = false;
function getConcurrencyBridge(): LLMConcurrencyBridge | null {
  const b = (globalThis as any)[CONCURRENCY_BRIDGE_KEY];
  if (b && typeof b.acquireLLMSlot === "function" && typeof b.releaseLLMSlot === "function") {
    return b as LLMConcurrencyBridge;
  }
  if (!concurrencyBridgeMissingLogged) {
    concurrencyBridgeMissingLogged = true;
    console.warn(
      "[harness-orchestrator] pont de concurrence absent (globalThis.__piWebConcurrency) — " +
      "délégations exécutées SANS limite de concurrence LLM",
    );
  }
  return null;
}

// Compteur monotone : slotKey unique par appel de sous-agent (jamais partagé).
let subagentSlotSeq = 0;

// ── Pont global : abort UTILISATEUR vs abort INTERNE (P2) ─────────────────
// Le backend publie `__piWebWasSessionAbortedByUser__(projectId)` (session.ts) :
// true UNIQUEMENT si le dernier abort subi par la session du projet vient d'un
// abandon utilisateur explicite (bouton ABORT → abortPi). Un abort interne
// (timeout de session, shutdown, switchMode, reloadModelRegistry) laisse le
// marqueur à false. Prudence : sans pont (tests, hôte inattendu), on suppose un
// abort interne — jamais de faux « abort-utilisateur ».
const USER_ABORT_BRIDGE_KEY = "__piWebWasSessionAbortedByUser__";

function isUserInitiatedAbort(projectId: string | null): boolean {
  if (!projectId) return false;
  try {
    const bridge = (globalThis as any)[USER_ABORT_BRIDGE_KEY];
    if (typeof bridge === "function") return bridge(projectId) === true;
  } catch {}
  return false;
}

/**
 * Extrait le TEXTE joint d'une liste de blocs content SDK (résultat ou
 * partialResult d'un tool). Les blocs non textuels (images…) sont ignorés.
 */
function extractTextFromContent(content: any): string {
  try {
    if (!Array.isArray(content)) return "";
    return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
  } catch {
    return "";
  }
}

/**
 * Message explicite pour un échec modèle — provider/modèle inclus (BUG-68).
 */
function formatModelErrorMessage(errorMessage: string, modelLabel: string, funcLabel: string): string {
  return `❌ Erreur modèle : ${errorMessage} (délégué ${funcLabel} sur ${modelLabel})`;
}

/**
 * Statut de fin de vie (LOT 2a) dérivé de la cause d'archivage P0.
 * Factorisé : le finally interne et les retours du catch externe doivent
 * annoncer le MÊME statut pour une même cause.
 */
function statusFromCause(cause: string | null, success: boolean): SubagentEndStatus {
  if (success) return "success";
  switch (cause) {
    case "timeout-inactivite":
      return "timeout-inactivity";
    case "timeout-global":
      return "timeout-global";
    // P2 : une interruption reste « aborted » quel que soit son motif ; seul le
    // libellé de cause (abort-utilisateur vs abort-session) les distingue.
    case "abort-utilisateur":
    case "abort-session":
      return "aborted";
    default:
      return "error";
  }
}

/**
 * Collecte la réponse partielle d'une session d'expert (messages assistant déjà produits).
 * Utilisée pour récupérer le travail d'un expert interrompu par un abort (BUG-67)
 * ou par un timeout (inactivité / global) — le travail partiel n'est pas perdu.
 * BUG-68 (P0 volet 1/2) : si aucun texte n'a été produit mais que le modèle a
 * échoué (stopReason:"error" + errorMessage), retourne l'erreur explicite au
 * lieu d'une chaîne vide — les messages de timeout/abort deviennent diagnosables.
 */
function collectExpertResponse(tempSession: any): string {
  try {
    const messages: any[] = tempSession?.messages || [];
    const text = messages
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "")
      .filter((t: string) => t.length > 0)
      .join("\n\n");
    if (text.length > 0) return text;
    const modelError = detectModelErrorMessage(messages);
    if (modelError) {
      return `⚠️ Erreur modèle (aucun texte produit) : ${modelError} — modèle ${getSessionModelLabel(tempSession)}`;
    }
    return "";
  } catch {
    return "";
  }
}

// ── Helpers de routage (appel API HTTP locale) ─────────

const PI_WEB_URL = process.env.PI_WEB_URL || "http://localhost:3000";

/**
 * Résout l'identifiant projet Pi-Web à partir du cwd courant.
 *
 * 1. Pont GLOBAL `__piWebResolveProjectIdByCwd__` publié par le backend
 *    (session.ts) : l'extension tourne dans le MÊME process que le backend
 *    (chargée par jiti) → résolution SYNCHRONE et fiable, indépendante d'un
 *    match de cwd exact par HTTP. C'est ce qui garantit que les events
 *    sous-agents sont routés vers les sockets abonnés au VRAI projectId (UUID)
 *    — sans ce pont, un cwd non strictement égal retombait sur le NOM DE
 *    DOSSIER (aucun socket abonné → streaming invisible).
 * 2. Repli HTTP /api/projects (même logique qu'avant).
 * 3. Dernier recours : nom du dossier.
 */
async function resolveProjectId(cwd: string): Promise<string> {
  const fallback = cwd.split("/").pop() || "";
  // 1. Pont global (même process que le backend) — prioritaire.
  try {
    const bridge = (globalThis as any).__piWebResolveProjectIdByCwd__;
    if (typeof bridge === "function") {
      const pid = bridge(cwd);
      if (typeof pid === "string" && pid) return pid;
    }
  } catch {}
  // 2. HTTP /api/projects.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${PI_WEB_URL}/api/projects`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return fallback;

    const projects = await res.json();
    const project = Array.isArray(projects)
      ? projects.find((p: any) => p.cwd === cwd)
      : null;
    return project?.id || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Appelle la route debug du backend pour obtenir la décision de routage
 * (fonction + modèle conseillés). Retourne null si l'appel échoue afin que
 * l'extension reste robuste hors-ligne.
 */
async function resolveRoutingDecision(
  cwd: string,
  request: string,
): Promise<{ function?: string; modelId?: string; thinkingLevel?: string } | null> {
  try {
    const projectId = await resolveProjectId(cwd);
    const url = new URL(`${PI_WEB_URL}/api/routing/decision`);
    url.searchParams.set("projectId", projectId);
    url.searchParams.set("request", request);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const data = await res.json();

    // ── Kill switch : le backend renvoie déjà `route: null` quand le routage
    // est coupé (global ou config projet/mode). On défend en profondeur : même
    // si un backend plus ancien renvoyait une route, on l'ignore et on retombe
    // sur le modèle par défaut (ctx.model) sans casser la délégation.
    if (data?.routingEnabled === false || data?.configEnabled === false) {
      return null;
    }
    if (!data?.route) return null;

    return {
      function: data.route.function,
      modelId: data?.modelId ?? data.route.modelId ?? undefined,
      // Niveau de réflexion de la catégorie (peut être null/absent → le
      // sous-agent garde le thinking par défaut du SDK, comportement actuel).
      thinkingLevel: data?.thinkingLevel ?? undefined,
    };
  } catch (e: any) {
    console.warn(`[harness-orchestrator] Route /api/routing/decision indisponible : ${e?.message || e}`);
    return null;
  }
}

/**
 * Sanitise un id de modèle comme le fait makeModelId() de
 * backend/src/pi/model-library.ts (même regex).
 *
 * La bibliothèque Pi-Web stocke les ids composites sous forme SANITISÉE
 * (ex. "qwen3.8-flash-next" → "qwen3_8-flash-next"), alors que le registry
 * du SDK garde l'id d'origine (avec les points). On duplique ici la regex
 * pour rester autonome (l'extension n'importe PAS model-library.ts, couplé au
 * backend Express) ; toute évolution de makeModelId doit être répercutée ici.
 */
function sanitizeModelId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-:]/g, "_");
}

/**
 * Résout un modelId "providerId__modelId" (format bibliothèque Pi-Web) vers
 * un modèle du registry exposé par le SDK de l'extension.
 *
 * Le modelId reçu est SANITISÉ (ex. "qwen3_8-flash-next") alors que le
 * registry garde l'id d'origine (ex. "qwen3.8-flash-next"). On tente d'abord
 * la résolution directe (ids sans caractères sanitisés), puis un matching
 * tolérant : on itère les modèles du provider et on retourne celui dont l'id
 * SANITISÉ correspond au modelPart. Si rien ne matche → null (le fallback
 * ctx.model reste inchangé).
 */
async function resolveRoutingModel(ctx: any, modelId: string | undefined): Promise<any | null> {
  if (!modelId) return null;

  const separatorIndex = modelId.indexOf("__");
  if (separatorIndex <= 0) return null;

  const providerId = modelId.slice(0, separatorIndex);
  const modelPart = modelId.slice(separatorIndex + 2);
  if (!providerId || !modelPart) return null;

  try {
    await ctx.modelRegistry?.refresh?.();
  } catch {}

  // 1) Résolution directe (comportement actuel) — couvre les ids sans
  //    caractères sanitisés (ex. "qwen3.8:27b" : les deux-points sont
  //    CONSERVÉS par la regex, donc pas de sanitisation).
  const direct = ctx.modelRegistry?.find?.(providerId, modelPart);
  if (direct) return direct;

  // 2) Matching tolérant : le modelPart est l'id SANITISÉ (ex.
  //    "qwen3_8-flash-next"). On cherche dans le registry le modèle du
  //    provider dont l'id, une fois sanitisé, correspond exactement.
  const models = ctx.modelRegistry?.getAll?.() ?? [];
  for (const m of models) {
    if (m?.provider !== providerId) continue;
    if (sanitizeModelId(m.id) === modelPart) return m;
  }

  return null;
}

// ── Tool parameter schema (plain JSON Schema) ──────────

const delegateParams = {
  type: "object" as const,
  properties: {
    function: {
      type: "string",
      enum: FUNCTIONS.map(f => f.name),
      description: "Fonction à déléguer. Valeurs possibles : " +
        FUNCTIONS.map(f => `"${f.name}" (${f.label})`).join(", "),
    },
    task: {
      type: "string",
      description: "La tâche à exécuter par la fonction. Doit être précise et auto-contenue.",
    },
    context: {
      type: "string",
      description: "Contexte additionnel (fichiers à lire, décisions précédentes, etc.). Optionnel.",
    },
  },
  required: ["function", "task"],
};

// ── Schémas des tools du Carnet d'exploration (P2) ─────

const explorationNoteParams = {
  type: "object" as const,
  properties: {
    kind: {
      type: "string",
      enum: ["fact", "pitfall", "decision"],
      description:
        "Nature de la note : 'fact' (fait confirmé), 'pitfall' (piège rencontré), 'decision' (choix technique acté).",
    },
    text: {
      type: "string",
      description:
        "La découverte en UNE ligne, factuelle et concise (jamais de dump de code ni de contenu déjà visible dans les fichiers).",
    },
    file: {
      type: "string",
      description: "Localisation optionnelle 'fichier' ou 'fichier:symbole' concernée par la note.",
    },
    task: {
      type: "string",
      description: "Extrait court de la tâche qui a produit la note (contexte). Optionnel.",
    },
  },
  required: ["kind", "text"],
};

const explorationNotesParams = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description:
        "Filtre plein texte optionnel (insensible à la casse) sur le texte et le fichier des notes. Omis = toutes les notes.",
    },
    limit: {
      type: "number",
      description: "Nombre maximum de notes renvoyées (défaut : 20).",
    },
  },
  required: [],
};

// ── Extension ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  console.log("[harness-orchestrator] Extension loaded");

  // ── Rappel FERME en fin de system prompt, à chaque turn, en mode HARNESS ──
  // Même mécanisme que l'injection <!-- PI_PROJECT_CONTEXT --> de session.ts,
  // côté extension : le handler reçoit le prompt assemblé du tour et peut le
  // remplacer (override valable pour ce turn uniquement — pas d'accumulation dans
  // _baseSystemPrompt). Le bloc est retiré/réinjecté à chaque fois (idempotent).
  // GATE : détection du mode harness par la signature fiable (présence de
  // `delegate` dans les outils ACTIFS — cf. getEffectiveActiveMode dans
  // backend/src/pi/session.ts), avec fallback sur le marqueur de mode
  // <!-- PI_MODE:HARNESS --> injecté par applyModeToSession. En mode code/YOLO,
  // les tools d'exécution directs sont légitimes → RIEN n'est injecté.
  pi.on("before_agent_start", (event, ctx) => {
    try {
      const prompt = event.systemPrompt || "";
      const selectedTools: string[] = event.systemPromptOptions?.selectedTools ?? [];
      const isHarnessMode =
        selectedTools.includes("delegate") || prompt.includes("<!-- PI_MODE:HARNESS -->");
      if (!isHarnessMode) return undefined;
      const base = prompt.replace(HARNESS_ROLE_BLOCK_RE, "\n").trimEnd();
      return { systemPrompt: `${base}\n\n${HARNESS_ROLE_REMINDER}\n` };
    } catch {
      return undefined; // en cas d'erreur, ne pas casser le tour de l'agent
    }
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Délègue une tâche à une fonction de routage (planning, execute, review, integrate). " +
      "La fonction exécute la tâche dans une session isolée et retourne son résultat. " +
      "Utilise ce tool pour TOUTE tâche d'exécution : code, debug, review, tests, plan, doc. " +
      "Ne code JAMAIS toi-même — délègue toujours.",
    promptSnippet: "Déléguer une tâche à une fonction de routage",
    promptGuidelines: [
      // Rappel ferme (EN, harmonisé avec le bloc PI_HARNESS_ROLE). Ces guidelines
      // n'apparaissent que quand delegate est actif, donc uniquement en mode harness.
      "You are in HARNESS mode (project lead): you DESIGN, you DELEGATE every execution task to sub-agents via the `delegate` tool (execute/planning/review/integrate). Execution tools (bash, edit, read, write, grep) are NOT available to you — if a tool is 'not found', that is the signal to DELEGATE, never to wait or retry directly.",
      "Le tool de délégation s'appelle EXACTEMENT `delegate` (paramètre `function`). `delegate_to_expert` n'existe plus (renommé) : ignore toute trace héritée de ce nom dans l'historique.",
      "Utilise delegate pour TOUTE tâche d'exécution (code, debug, review, tests, plan, doc).",
      "Pour une tâche simple → délègue directement à la fonction execute.",
      "Pour une tâche complexe → délègue d'abord à planning pour un plan, puis à execute.",
      "Pour une relecture ou un audit → délègue à review.",
      "Pour la synthèse finale → délègue à integrate.",
      "Ne code JAMAIS toi-même. Tu es un chef de projet, pas un développeur.",
      "Réponds directement aux questions simples sans déléguer.",
      "La fonction reçoit uniquement la tâche et le contexte que tu fournis — sois précis.",
    ],
    parameters: delegateParams,
    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
      // onUpdate permet de forwarder l'activité de la fonction vers le frontend
      // (tool_execution_update) — fini le silence pendant une délégation (BUG-67).
      const emitProgress = (text: string) => {
        try {
          onUpdate?.({ content: [{ type: "text", text }] });
        } catch {}
      };
      const task = typeof params.task === "string" ? params.task : "";
      const context = typeof params.context === "string" ? params.context : undefined;

      // ── Identité + horodatage de la délégation (LOT 2a) ──
      // Générés au PLUS TÔT pour que TOUS les retours du tool — y compris les
      // erreurs de validation — portent un `details` structuré rattachable :
      // le frontend relie le run de sous-agent EXACTEMENT via
      // details.delegateRunId (le FIFO par args.function reste un secours).
      const delegateRunId = makeDelegateRunId();
      const delegateStartedAt = Date.now();

      /** Détails structurés du RETOUR du tool `delegate` (portés par le toolCall). */
      const buildDetails = (
        status: SubagentEndStatus,
        delegateFunction: string,
        actions: number = 0,
      ) => ({
        delegateRunId,
        delegateFunction,
        status,
        durationMs: Date.now() - delegateStartedAt,
        actionCount: actions,
      });

      if (!task.trim()) {
        return {
          content: [{
            type: "text" as const,
            text: "❌ Tâche manquante. Fournissez une tâche précise à déléguer.",
          }],
          details: buildDetails("error", typeof params.function === "string" ? params.function : ""),
        };
      }

      // Fonction demandée par l'appelant (ou mapping legacy role → fonction).
      let functionName: string | undefined;
      if (params.function) {
        if (!FUNCTION_BY_NAME.has(params.function)) {
          const validFunctions = FUNCTIONS.map(f => f.name).join(", ");
          return {
            content: [{
              type: "text" as const,
              text: `❌ Fonction inconnue : "${params.function}". Fonctions valides : ${validFunctions}`,
            }],
            details: buildDetails("error", typeof params.function === "string" ? params.function : ""),
          };
        }
        functionName = params.function;
      } else if (params.role) {
        functionName = mapRoleToFunction(params.role);
      }

      if (!functionName) {
        const validFunctions = FUNCTIONS.map(f => f.name).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: `❌ Fonction manquante. Utilisez ` +
              `"function" avec l'une des valeurs suivantes : ${validFunctions}`,
          }],
          details: buildDetails("error", ""),
        };
      }

      const requestedFunc = FUNCTION_BY_NAME.get(functionName)!;
      console.log(`[harness-orchestrator] Délégation à ${requestedFunc.label} (${functionName}): ${task.slice(0, 80)}...`);

      // ── P0 observabilité (volet 1/2) : état d'issue de la délégation ──
      // pendingSessionFile : fichier de session du délégué tant qu'il n'a pas
      // été traité (archivé en échec / supprimé en succès). Permet au catch
      // externe d'archiver la boîte noire si l'échec survient AVANT le try
      // interne (ex. createAgentSession) — le finally interne le met à null.
      // (delegateRunId et delegateStartedAt sont déclarés au plus tôt, ci-dessus.)
      let pendingSessionFile: string | null = null;

      // ── LOT 2a (refonte chat) : état du streaming sous-agent ──
      // Déclaré AVANT le try externe : visible du finally interne ET du catch
      // externe — subagent_end doit être émis dans TOUS les chemins de fin de
      // vie (succès/échec/timeout/abort), y compris un échec survenu avant la
      // création de la tempSession. Les compteurs eventCount/thinkingChars/
      // attemptsMade/usedModelLabel, préalablement déclarés dans le try
      // externe, sont remontés ici pour être partagés par les deux chemins.
      // (delegateRunId est déclaré au plus tôt, ci-dessus.)
      const taskExcerpt = truncateChars(task, TASK_EXCERPT_MAX);
      // Throttle partagé : 1 update max toutes les ~2s — utilisé par l'aperçu
      // texte existant (emitThrottled) ET par le forward structuré LOT 2a.
      const EMIT_THROTTLE_MS = 2_000;
      // Quota de sécurité : ≤20 événements enveloppés/s, fusion des
      // tool_execution_update consécutifs d'un même toolCallId, droppedEvents.
      const subagentGate = createSubagentEventGate();
      // projectId du projet cible : ExtensionContext du SDK n'expose PAS de
      // projectId (types 0.85.1) — fallback documenté = résolution HTTP
      // /api/projects par cwd (resolveProjectId, déjà utilisée pour le
      // routage). null → toutes les émissions LOT 2a deviennent des no-ops
      // silencieux (une délégation ne dépend JAMAIS du streaming).
      // Réglé au plus tôt (avant le try externe) pour que subagent_end — émis
      // TOUJOURS, y compris en cas d'échec de création de la tempSession — et
      // la persistance disposent du projectId dans TOUS les chemins.
      const cwd = ctx?.cwd || process.cwd();
      let subagentProjectId: string | null = null;
      try {
        subagentProjectId =
          typeof ctx?.projectId === "string" && ctx.projectId
            ? ctx.projectId
            : await resolveProjectId(cwd);
      } catch {
        subagentProjectId = null;
      }
      // Fonction effective (peut être re-classée par le routeur backend).
      let subagentFuncName = functionName || "unknown";
      let subagentFuncLabel = requestedFunc.label;
      // Modèle effectif (mis à jour après setModel ; "?" tant qu'inconnu).
      let usedModelLabel = "?";
      // Tentatives réellement jouées (1..2) — portée par chaque event enveloppé.
      let attemptsMade = 0;
      // Compteurs d'événements du sous-agent (aussi consommés par la meta
      // d'archivage P0 du finally interne).
      let eventCount = 0;   // nb total d'events reçus du sous-agent
      let thinkingChars = 0; // chars de réflexion accumulés (text_delta)
      let actionCount = 0;  // nb de tool_execution_start du sous-agent
      // Actions d'outils résumées (persistance subagent_activity, ≤ MAX_ACTIONS,
      // premiers conservés — ordre chronologique stable).
      const subagentActions: SubagentActionRecord[] = [];
      // Outils actuellement en cours (args capturés au start pour le résumé).
      const openToolActions = new Map<string, {
        seq: number;
        toolName: string;
        args: any;
        startedAt: number;
        output: string;
      }>();
      // tool_execution_update en attente de flush (throttle 2s — EMIT_THROTTLE_MS
      // réutilisé ; fusion : le dernier snapshot d'un même toolCallId remplace
      // le précédent — ce sont des captures progressives du même output).
      const pendingUpdates = new Map<string, any>();
      let updateFlushTimer: ReturnType<typeof setTimeout> | null = null;
      // subagent_end émis UNE seule fois (helper commun finally + catch externe).
      let subagentEndEmitted = false;

      /** Construit les champs d'enveloppe communs de la délégation. */
      const subagentBase = () => ({
        delegateRunId,
        attempt: attemptsMade || 1,
        delegateFunction: subagentFuncName,
        delegateLabel: subagentFuncLabel,
        model: usedModelLabel,
        taskExcerpt,
      });

      /**
       * Émet un événement enveloppé {type:"subagent", …} vers le canal WS
       * pi_event (émission DIRECTE, hors buffer 40 ms de session.ts).
       * Hors quota → drop/fusion silencieux (compté par le gate) ; no-op si
       * le projectId n'a pas pu être résolu. Ne JAMAIS laisser remonter.
       */
      const emitWrapped = (event: unknown): void => {
        try {
          if (!subagentProjectId) return;
          if (!subagentGate.admit(event as any).admitted) return;
          emitSubagentEvent(subagentProjectId, subagentBase(), event);
        } catch {
          // silencieux : le streaming est un plus, jamais une dépendance
        }
      };

      /** Flush (trailing throttle 2s) des tool_execution_update en attente. */
      const flushPendingUpdates = (): void => {
        updateFlushTimer = null;
        if (pendingUpdates.size === 0) return;
        const updates = [...pendingUpdates.values()];
        pendingUpdates.clear();
        for (const upd of updates) {
          const text = extractTextFromContent(upd?.partialResult?.content);
          emitWrapped({
            type: "tool_execution_update",
            toolCallId: upd?.toolCallId,
            toolName: upd?.toolName,
            // Queue tronquée ~400 chars (UPDATE_TEXT_MAX) + longueur réelle.
            partialResult: { content: [{ type: "text", text: truncateChars(text, UPDATE_TEXT_MAX) }] },
            outputChars: text.length,
          });
        }
      };

      /** Enregistre un tool_execution_start (pour le résumé persisté). */
      const recordToolStart = (event: any): void => {
        openToolActions.set(event?.toolCallId, {
          seq: ++actionCount,
          toolName: event?.toolName || "outil",
          args: event?.args,
          startedAt: Date.now(),
          output: "",
        });
      };

      /** Clôture l'action ouverte correspondant à un tool_execution_end. */
      const closeToolAction = (event: any): void => {
        const open = openToolActions.get(event?.toolCallId);
        if (!open) return;
        openToolActions.delete(event.toolCallId);
        // Cap ≤50 actions (premiers conservés, ordre chronologique).
        if (subagentActions.length >= MAX_ACTIONS) return;
        const output = extractTextFromContent(event?.result?.content);
        subagentActions.push({
          seq: open.seq,
          toolName: open.toolName,
          argSummary: summarizeToolArgs(open.toolName, open.args),
          durationMs: Date.now() - open.startedAt,
          isError: !!event?.isError,
          summary: summarizeToolAction({
            toolName: open.toolName,
            args: open.args,
            output,
            isError: !!event?.isError,
            details: event?.result?.details,
          }),
          outputChars: output.length,
          truncated: output.length > TOOL_OUTPUT_MAX,
        });
      };

      /**
       * Forward STRUCTURÉ d'un event du sous-agent vers le chat (LOT 2a).
       * Seuls : tool_execution_start (tel quel), tool_execution_update
       * (throttlé 2s, queue ~400 chars), tool_execution_end (output ≤2000
       * chars + longueur réelle), message_end assistant (texte ≤4000,
       * thinking ≤1000, flags truncated + usage). JAMAIS les deltas
       * (message_update/message_start) ni les events internes
       * (agent_start/agent_end) — cf. spec LOT 2a.
       */
      const forwardStructuredEvent = (event: any): void => {
        try {
          switch (event?.type) {
            case "tool_execution_start": {
              recordToolStart(event);
              emitWrapped(event); // tel quel (spec)
              break;
            }
            case "tool_execution_update": {
              // Fusion : le dernier snapshot d'un même toolCallId remplace
              // l'attente (captures progressives d'un même output).
              pendingUpdates.set(event.toolCallId, event);
              const open = openToolActions.get(event.toolCallId);
              if (open) open.output = extractTextFromContent(event.partialResult?.content);
              // Trailing throttle 2s (EMIT_THROTTLE_MS réutilisé).
              if (!updateFlushTimer) {
                const timer = setTimeout(flushPendingUpdates, EMIT_THROTTLE_MS);
                timer.unref?.();
                updateFlushTimer = timer;
              }
              break;
            }
            case "tool_execution_end": {
              // L'end remplace tout update en attente du même tool (snapshot
              // final plus riche) et clôture l'action du résumé persisté.
              pendingUpdates.delete(event.toolCallId);
              closeToolAction(event);
              emitWrapped(buildToolEndEvent(event));
              break;
            }
            case "message_end": {
              // Uniquement les messages ASSISTANT du sous-agent (réponse +
              // réflexion) ; les autres rôles sont couverts par les events
              // tool_* ou ignorés.
              if (event?.message?.role === "assistant") {
                emitWrapped(buildMessageEndEvent(event));
              }
              break;
            }
            default:
              // message_update/message_start (deltas), agent_start/agent_end
              // internes, turn_*/model_select… : JAMAIS forwardés (spec).
              break;
          }
        } catch {
          // Le forward structuré ne doit jamais casser l'aperçu existant.
        }
      };

      /** Clone tronqué d'un tool_execution_end (output ≤2000 chars). */
      const buildToolEndEvent = (event: any): any => {
        const output = extractTextFromContent(event?.result?.content);
        const clone: any = {
          type: "tool_execution_end",
          toolCallId: event?.toolCallId,
          toolName: event?.toolName,
          isError: !!event?.isError,
          // shape SDK conservée (result.content[]) — texte tronqué à 2000 chars.
          result: { content: [{ type: "text", text: truncateChars(output, TOOL_OUTPUT_MAX) }] },
          // Longueur réelle + flag de troncature pour le frontend (LOT 2b).
          outputChars: output.length,
          outputTruncated: output.length > TOOL_OUTPUT_MAX,
        };
        // details (diff d'edit, truncation read/bash…) conservés si compacts —
        // le résumé +A/−B de l'UI en dépend.
        try {
          const details = event?.result?.details;
          if (details && JSON.stringify(details).length <= 4000) clone.details = details;
        } catch {}
        return clone;
      };

      /** Clone tronqué d'un message_end assistant (texte ≤4000, thinking ≤1000). */
      const buildMessageEndEvent = (event: any): any => {
        const m = event?.message || {};
        let text = "";
        let thinking = "";
        try {
          for (const block of m.content || []) {
            if (block?.type === "text" && typeof block.text === "string") text += block.text;
            else if (block?.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
          }
        } catch {}
        return {
          type: "message_end",
          message: {
            role: "assistant",
            id: m.id,
            stopReason: m.stopReason,
            errorMessage: m.errorMessage,
            ...(m.usage ? { usage: m.usage } : {}),
            content: [
              ...(text ? [{ type: "text", text: truncateChars(text, MESSAGE_TEXT_MAX) }] : []),
              ...(thinking ? [{ type: "thinking", thinking: truncateChars(thinking, MESSAGE_THINKING_MAX) }] : []),
            ],
          },
          textChars: text.length,
          textTruncated: text.length > MESSAGE_TEXT_MAX,
          thinkingChars: thinking.length,
          thinkingTruncated: thinking.length > MESSAGE_THINKING_MAX,
        };
      };

      /**
       * Persiste le résumé d'activité dans la session PRINCIPALE (une seule
       * entrée custom subagent_activity, display:false) via la route interne
       * /api/harness/activity (précédent : inject-to-chat de web-screenshot).
       * Fire-and-forget : un échec ne fait JAMAIS échouer la délégation.
       */
      const persistSubagentActivity = (info: {
        status: SubagentEndStatus;
        cause: string | null;
        errorMessage: string | null;
        responsePreview: string;
      }): void => {
        try {
          const body = JSON.stringify({
            // projectId peut être null → la route re-résout par cwd.
            projectId: subagentProjectId,
            cwd: ctx?.cwd || process.cwd(),
            activity: {
              delegateRunId,
              function: subagentFuncName,
              label: subagentFuncLabel,
              model: usedModelLabel,
              status: info.status,
              attempts: attemptsMade,
              durationMs: Date.now() - delegateStartedAt,
              actionCount,
              eventCount,
              thinkingChars,
              cause: info.cause,
              errorMessage: info.errorMessage,
              actions: subagentActions.slice(0, MAX_ACTIONS),
              responsePreview: truncateChars(info.responsePreview, RESPONSE_PREVIEW_MAX),
            },
          });
          void fetch(`${PI_WEB_URL}/api/harness/activity`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(3000),
          }).catch(() => {
            // fire-and-forget : l'injection est un plus, jamais une nécessité
          });
        } catch {
          // silencieux : ne JAMAIS casser la délégation
        }
      };

      /**
       * FIN DE VIE du sous-agent (LOT 2a) : subagent_end émis TOUJOURS
       * (succès/échec/timeout/abort) — appelé depuis le finally interne ET le
       * catch externe via ce helper commun, AVANT l'archivage/unlink (le
       * fichier de session reste lisible). Idempotent. L'événement terminal
       * est HORS quota (la fin de vie doit toujours passer) ; la persistance
       * du résumé est fire-and-forget.
       */
      const emitSubagentEnd = (info: {
        status: SubagentEndStatus;
        cause: string | null;
        errorMessage: string | null;
        responsePreview: string;
      }): void => {
        if (subagentEndEmitted) return;
        subagentEndEmitted = true;
        try {
          // Clôturer les actions restées ouvertes (tool interrompu par un
          // timeout/abort — pas de tool_execution_end reçu).
          const nowMs = Date.now();
          for (const [toolCallId, open] of openToolActions) {
            if (subagentActions.length >= MAX_ACTIONS) break;
            subagentActions.push({
              seq: open.seq,
              toolName: open.toolName,
              argSummary: summarizeToolArgs(open.toolName, open.args),
              durationMs: nowMs - open.startedAt,
              isError: info.status !== "success",
              summary: "(interrompu)",
              outputChars: open.output.length,
              truncated: false,
            });
            openToolActions.delete(toolCallId);
          }

          const endEvent = {
            type: "subagent_end" as const,
            status: info.status,
            attemptsMade,
            durationMs: Date.now() - delegateStartedAt,
            actionCount,
            eventCount,
            thinkingChars,
            model: usedModelLabel,
            cause: info.cause,
            // Cap défensif : un timeoutError peut embarquer 2000 chars de
            // travail partiel — on borne pour protéger la frame WS.
            errorMessage: info.errorMessage ? truncateChars(info.errorMessage, 2000) : null,
            // Aperçu de la réponse du sous-agent, tronqué à 500 chars.
            responsePreview: truncateChars(info.responsePreview, RESPONSE_PREVIEW_MAX),
            droppedEvents: subagentGate.droppedEvents,
          };
          try {
            if (subagentProjectId) {
              emitSubagentEvent(subagentProjectId, subagentBase(), endEvent);
            }
          } catch {}
          persistSubagentActivity(info);
        } catch (e: any) {
          // Aucun échec de fin de vie ne peut se propager à la délégation.
          console.warn(`[harness-orchestrator] subagent_end incomplet : ${e?.message || e}`);
        }
      };

      // ── P0 observabilité (volet 1/2) : suivi de l'issue, déclaré AVANT le
      // try externe pour rester visible de son catch (le statut exact est porté
      // par les `details` du retour du tool). success = réponse valide retournée
      // au tool (fichier de session supprimé) ; tout autre chemin = ÉCHEC →
      // archivage boîte noire (.data/logs/harness/).
      let success = false;
      let archiveCause: string | null = null;
      let archiveErrorMessage: string | undefined = undefined;

      try {
        // Créer une session temporaire pour la fonction
        const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
        const { existsSync, unlinkSync } = await import("fs");

        // (cwd est résolu dans le bloc d'état LOT 2a, avant le try externe.)

        // Résolution de la route conseillée par le backend (fonction + modèle).
        // L'extension est autonome : toute logique partagée passe par l'API HTTP
        // locale (localhost, déjà autorisée par api-auth).
        const routing = await resolveRoutingDecision(cwd, task);

        // Le choix EXPLICITE de l'orchestrator PRIME sur le routeur backend.
        // Le routeur ne sert que de fallback quand aucune fonction valide n'est
        // demandée (il fournit aussi la recommandation de modèle). Sans cette
        // priorité, une demande « execute » re-classée « planning » par le triage
        // perdrait l'accès en écriture et ne produirait qu'un plan.
        let effectiveFunction = functionName;
        if (!effectiveFunction || !FUNCTION_BY_NAME.has(effectiveFunction)) {
          if (routing?.function && FUNCTION_BY_NAME.has(routing.function)) {
            effectiveFunction = routing.function;
          }
        }
        if (!effectiveFunction) effectiveFunction = "execute";
        const effectiveFunc = FUNCTION_BY_NAME.get(effectiveFunction)!;
        if (effectiveFunction !== functionName) {
          console.log(`[harness-orchestrator] Route backend : ${functionName} → ${effectiveFunction}`);
        }
        // LOT 2a : la fonction effective (re-classée ou non par le routeur) est
        // portée par chaque enveloppe {type:"subagent", …} et le résumé persisté.
        subagentFuncName = effectiveFunction;
        subagentFuncLabel = effectiveFunc.label;

        // Modèle conseillé par le routeur (sinon fallback ctx.model plus bas).
        const routingModel = await resolveRoutingModel(ctx, routing?.modelId);

        const tempSessionManager = SessionManager.create(cwd);
        const tempSessionFile = tempSessionManager.getSessionFile();
        // P0 : le fichier de session existe désormais (boîte noire potentielle).
        // (getSessionFile peut retourner undefined selon le SDK — on ne prend
        // que les strings, le catch externe archivera sinon "rien à archiver".)
        pendingSessionFile = typeof tempSessionFile === "string" ? tempSessionFile : null;

        // SDK 0.80+: modelRuntime remplace authStorage + modelRegistry.
        // Si on ne passe rien, le SDK crée un ModelRuntime par défaut (~/.pi/agent/auth.json).
        const result = await createAgentSession({
          cwd,
          sessionManager: tempSessionManager,
        });
        const tempSession = result.session;

        // ── LOT 2a : début du streaming (projectId déjà résolu avant le try
        // externe — cf. bloc d'état LOT 2a) ──
        // Modèle connu à la création (le setModel effectif, plus bas, mettra
        // usedModelLabel à jour avant le premier event forwardé).
        usedModelLabel = getSessionModelLabel(tempSession);
        // subagent_start : le delegateFunction/delegateLabel/model/taskExcerpt
        // sont portés par l'ENVELOPPE (cf. harness-stream.buildSubagentEnvelope) ;
        // l'event interne ne porte que le marqueur de début de vie. Enveloppé
        // dans le même try/catch permanent (no-op si projectId null).
        emitWrapped({ type: "subagent_start" });

        // ── FIX A : les sous-agents doivent connaître les providers custom ──
        // La tempSession est créée avec un ModelRuntime par défaut qui charge
        // ~/.pi/agent/models.json : les providers custom y sont connus comme
        // built-ins, MAIS getRegisteredProviderIds() ne liste que les providers
        // enregistrés DYNAMIQUEMENT (extension / registre partagé) — il renvoie
        // [] ici, ce qui rendait la boucle du fix 5f8ffd6 inopérante (0 provider
        // ré-enregistré) et setModel(qwen3.8-flash-next) jetait
        // « No API key for provider_x/qwen3.8-flash-next ».
        // On itère donc les VRAIS providers connus du runtime de la tempSession
        // via ModelRuntime.getProviders() (API SDK 0.85.1, inclut les built-ins
        // de models.json) et on ré-enregistre chacun dans ce même runtime.
        // Convention de clé = backend/src/pi/session.ts l.1811 : clé existante
        // résolue via getAuth(), sinon sentinelle "ollama" — les serveurs locaux
        // (llama.cpp, ollama…) ignorent la clé mais checkAuth() de setModel
        // exige une clé configurée. Un provider qui échoue ne bloque pas les
        // autres (try/catch par provider).
        const tempRuntime = tempSession.modelRuntime;
        const realProviders = tempRuntime.getProviders();
        for (const provider of realProviders) {
          const pid = provider.id;
          try {
            // Clé existante résolue via getAuth sur un modèle du provider
            // (undefined → sentinelle, exactement comme session.ts l.1811).
            const providerModels = provider.getModels();
            const existingAuth = providerModels[0]
              ? await tempRuntime.getAuth(providerModels[0])
              : undefined;
            const existingApiKey: string | undefined = existingAuth?.auth?.apiKey;
            const providerApi: any = (providerModels[0] as any)?.api || "openai-completions";
            tempRuntime.registerProvider(pid, {
              name: provider.name,
              baseUrl: provider.baseUrl,
              api: providerApi,
              apiKey: existingApiKey || "ollama",
              models: providerModels.map((m) => ({
                id: m.id,
                name: m.name || m.id,
                api: m.api || providerApi,
                reasoning: m.reasoning ?? false,
                input: m.input || ["text"],
                contextWindow: m.contextWindow ?? 128000,
                maxTokens: m.maxTokens ?? 16384,
                cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              })),
            });
            console.log(`[harness-orchestrator] Provider ré-enregistré dans la tempSession : ${pid} (clé ${existingApiKey ? "existante" : "sentinelle"})`);
          } catch (e: any) {
            console.warn(`[harness-orchestrator] Échec ré-enregistrement provider ${pid} :`, e?.message || e);
          }
        }

        // Déclaré ici (try externe) car `let` dans un bloc try n'est pas visible
        // dans le finally du même try (portées de bloc séparées en JS/TS).
        let tempUnsub: (() => void) | null = null;
        // Timer de silence du sous-agent — déclaré ici (try externe) pour la même
        // raison que tempUnsub : visible depuis le finally de cleanup.
        let silenceTimer: ReturnType<typeof setInterval> | null = null;

        // ── P0 observabilité (volet 1/2) : success/archiveCause/archiveErrorMessage
        // sont déclarés AVANT le try externe (visibles de son catch) ; ici, les
        // compteurs d'événements et la dernière activité du sous-agent.
        // attemptsMade / usedModelLabel / eventCount / thinkingChars : remontés
        // au niveau execute() (LOT 2a) pour être partagés avec le catch externe
        // (subagent_end) — visibles du finally interne comme avant.
        let lastEventAt = Date.now();     // horodatage du dernier event reçu
        let lastEventSummary: string | null = null; // extrait du dernier event (meta P0)

        try {
          // Set le modèle — priorité au modèle conseillé par le routeur,
          // puis héritage de la session principale. Les logs de debug
          // temporaires (diagnostic de la chaîne qwen/deepseek, résolu) ont été
          // retirés ; le modèle effectif est tracé une seule fois ci-dessous,
          // au niveau info — pas de bruit à chaque tour.
          if (routingModel) {
            await tempSession.setModel(routingModel);
          } else if (ctx.model) {
            await tempSession.setModel(ctx.model);
          }
          // Niveau de réflexion de la catégorie de routage : appliqué à la
          // tempSession (le modèle l'est déjà ci-dessus). Absent → comportement
          // actuel inchangé (thinking par défaut du SDK). En cas de kill switch,
          // resolveRoutingDecision a déjà renvoyé null : rien n'est appliqué.
          if (routing?.thinkingLevel) {
            try {
              tempSession.setThinkingLevel(routing.thinkingLevel as any);
            } catch (e: any) {
              console.warn(`[harness-orchestrator] Thinking level ignoré (${routing.thinkingLevel}) : ${e?.message || e}`);
            }
          }
          // P0 : mémoriser le modèle/provider effectifs pour la meta d'archivage
          usedModelLabel = getSessionModelLabel(tempSession);
          console.log(`[harness-orchestrator] Modèle effectif ${effectiveFunc.label} : ${usedModelLabel}`);

          // Restreindre les outils de la fonction
          if (effectiveFunc.tools.length > 0) {
            (tempSession as any).setActiveToolsByName(effectiveFunc.tools);
          }

          // ── Vérification d'allowlist (point B) : les tools cbm_* demandés par
          // le rôle sont-ils RÉELLEMENT actifs dans la tempSession ? Le SDK
          // ignore silencieusement un nom inconnu de setActiveToolsByName ; si
          // l'extension codebase-memory n'était pas chargée ici, le sous-agent
          // n'aurait AUCUN tool de graphe et ne pourrait pas respecter la
          // consigne. On le loggue au lieu de le supposer.
          try {
            const activeNames: string[] =
              (tempSession as any).getActiveToolNames?.() ?? [];
            const requestedCbm = CBM_TOOLS.filter((t) => effectiveFunc.tools.includes(t));
            const missingCbm = requestedCbm.filter((t) => !activeNames.includes(t));
            if (missingCbm.length > 0) {
              console.warn(
                `[harness-orchestrator] Sous-agent ${effectiveFunc.label} : tools CBM absents du registre ` +
                `(${missingCbm.join(", ")}) — le graphe est indisponible dans la tempSession`,
              );
            } else if (requestedCbm.length > 0) {
              console.log(
                `[harness-orchestrator] Sous-agent ${effectiveFunc.label} : ${requestedCbm.length} tools CBM actifs ` +
                `(${requestedCbm.join(", ")})`,
              );
            }
          } catch {}

          // Set le system prompt APRÈS setActiveToolsByName (sinon écrasé)
          // Préserver le "Current working directory:" du SDK en l'ajoutant après le prompt de la fonction
          const cwdLine = (tempSession as any)._baseSystemPrompt?.match(/Current working directory: (.+)/)?.[0] || "";

          // ── Carte du Repo automatique (P1, étude tokens sous-agents) ──
          // Le sous-agent démarre à contexte VIDE : on lui injecte d'office une
          // vue compacte du graphe CBM (fichiers + hubs + routes) pour qu'il VOIE
          // la structure sans avoir à décider d'appeler cbm_*. Le texte est rendu
          // et borné (~4000 chars) par le helper pur backend/src/pi/repo-map.ts ;
          // l'extraction du graphe est cachée 5 min côté extension codebase-memory.
          //
          // P3 (prompt caching) : le bloc est désormais rendu en mode "stable"
          // (rank stable) → il ne dépend PAS de la tâche, donc le préfixe système
          // reste identique pour un couple (projet, rôle) et passe au cache
          // cross-délégation. La version boostée par la tâche vit dans l'annexe
          // du premier message user (cf. plus bas).
          // try/catch PERMANENT : l'absence de carte (graphe non indexé, binaire
          // absent, pont non publié…) ne doit JAMAIS empêcher le démarrage du
          // sous-agent — au pire il démarre comme avant.
          let repoMapBlock = "";
          try {
            const buildRepoMapStable = (globalThis as any).__cbmRepoMap;
            if (typeof buildRepoMapStable === "function") {
              const mapText = await buildRepoMapStable(cwd);
              if (typeof mapText === "string" && mapText.trim()) {
                repoMapBlock = `\n\n${REPO_MAP_MARKER_START}\n${mapText.trim()}\n${REPO_MAP_MARKER_END}`;
              }
            }
          } catch (e: any) {
            console.warn(`[harness-orchestrator] Carte du repo indisponible (${effectiveFunc.label}) : ${e?.message || e}`);
          }

          // ── Carnet d'exploration (P2) : préfixe STABLE + annexe boostée (P3) ──
          // Même logique que la carte P1 : on réinjecte d'office les découvertes
          // durables des sessions précédentes (faits/pièges/décisions), bornées à
          // ~2000 chars par le helper backend/src/pi/exploration-notes.ts.
          //  - préfixe système : classement "stable" (récence seule) → identique
          //    pour un même (projet, rôle) quelle que soit la tâche ;
          //  - annexe boostée par la tâche : recalculée en "task" pour l'annexe du
          //    premier message user (les notes citées passent devant).
          // try/catch PERMANENT : un carnet illisible ne doit JAMAIS bloquer le
          // démarrage du sous-agent.
          let explorationNotesBlock = "";
          let notesAnnex = ""; // partie boostée par la tâche → message user
          try {
            if (subagentProjectId) {
              const notes = readExplorationNotes(subagentProjectId);
              const digestStable = buildNotesDigest(notes, { rank: "stable" });
              if (digestStable.trim()) {
                explorationNotesBlock = `\n\n${EXPLORATION_NOTES_MARKER_START}\n${digestStable.trim()}\n${EXPLORATION_NOTES_MARKER_END}`;
              }
              const digestBoosted = buildNotesDigest(notes, { task, context: context || "", rank: "task" });
              if (digestBoosted.trim()) notesAnnex = digestBoosted.trim();
            }
          } catch (e: any) {
            console.warn(`[harness-orchestrator] Carnet d'exploration indisponible (${effectiveFunc.label}) : ${e?.message || e}`);
          }

          // Préfixe SYSTÈME stable (P3) : rôle + carte stable + carnet stable + cwd.
          // Ces quatre blocs n'ont AUCUNE dépendance à la tâche → la totalité du
          // prompt système est identique pour un couple (projet, rôle) et reste
          // cachable entre deux délégations du même rôle.
          const systemPromptWithCwd =
            effectiveFunc.systemPrompt + repoMapBlock + explorationNotesBlock + (cwdLine ? `\n\n${cwdLine}` : "");
          (tempSession as any)._baseSystemPrompt = systemPromptWithCwd;
          (tempSession as any).agent.state.systemPrompt = systemPromptWithCwd;

          // ── Annexe de pertinence (P3) → PREMIER MESSAGE USER ──────────────
          // Les éléments VARIABLES par tâche (carte CBM boostée P1 + carnet
          // boosté P2) sont sortis du prompt système : ils vivent dans une
          // « annexe de pertinence » en fin du premier message user. Ils
          // n'invalident donc jamais le préfixe système cachable.
          let taskRelevance = "";
          try {
            const annexParts: string[] = [];
            const buildRepoMapAnnex = (globalThis as any).__cbmRepoMapAnnex;
            if (typeof buildRepoMapAnnex === "function") {
              const annexMap = await buildRepoMapAnnex(cwd, task, context || "");
              if (typeof annexMap === "string" && annexMap.trim()) {
                annexParts.push(`### Carte du repo — pertinence pour la tâche\n${annexMap.trim()}`);
              }
            }
            if (notesAnnex) {
              annexParts.push(`### Carnet d'exploration — pertinence pour la tâche\n${notesAnnex}`);
            }
            if (annexParts.length > 0) {
              taskRelevance = `\n\n${TASK_RELEVANCE_MARKER_START}\n${annexParts.join("\n\n")}\n${TASK_RELEVANCE_MARKER_END}`;
            }
          } catch (e: any) {
            console.warn(`[harness-orchestrator] Annexe de pertinence indisponible (${effectiveFunc.label}) : ${e?.message || e}`);
          }

          // Construire le prompt de la fonction (premier message user) : la tâche
          // d'abord, puis l'annexe de pertinence variable.
          let functionPrompt = task;
          if (context) {
            functionPrompt = `## Contexte\n\n${context}\n\n## Tâche\n\n${task}`;
          }
          functionPrompt += taskRelevance;

          // ── DÉTECTEUR DE SILENCE DE FLUX (remplace l'ancien timeout fixe) ──
          // La liveness d'un sous-agent n'est PLUS sa DURÉE mais le fait qu'il
          // PRODUISE encore des événements. Tant que le flux émet (text_delta,
          // tool_execution_start/end, message_update…), le compteur de silence
          // est réinitialisé → une génération de PLUSIEURS HEURES n'est jamais
          // coupée. Seul un SILENCE RÉEL (aucun événement pendant le délai
          // configuré, défaut 15 min) arrête proprement la délégation.
          //  - Plus AUCUN plafond de durée fixe : le garde-fou de dernier
          //    recours est OPTIONNEL et DÉSACTIVÉ par défaut (0).
          //  - Retry (1 retry = 2 attempts max) sur silence de flux uniquement.
          //  - Un sous-agent EN ATTENTE de slot LLM n'émet rien : le détecteur
          //    est mis en pause pendant cette attente légitime (cf. plus bas).
          const MAX_ATTEMPTS = 2;                  // 1 retry sur silence de flux

          // Récupération partielle au timeout : les erreurs de timeout sont
          // pré-formatées (préfixe "❌") avec un extrait du travail déjà produit
          // par le sous-agent (collectExpertResponse, tronqué à ~2000 chars).
          // Le catch externe renvoie ces messages tels quels à l'orchestrator —
          // un timeout ne jette plus 100% de l'avancement du sous-agent.
          const timeoutError = (cause: string, partial: string): Error => {
            let text = `❌ ${requestedFunc.label} a échoué (${cause})`;
            if (partial) {
              text += ` — extrait de l'avancement du sous-agent :\n\n${partial.slice(0, 2000)}`;
            }
            return new Error(text);
          };

          // Callback de reset du compteur de silence — connecté au subscribe ci-dessous
          let resetSilenceFn: (() => void) | null = null;

          // ── Streaming d'avancement du sous-agent (BUG-67) ───────────────────
          // À chaque event du sous-agent, on émet un partialResult MULTI-LIGNES
          // (aperçu tail -f côté UI), THROTTLÉ à 1 update / ~2s max :
          //   ligne 1 : "sous-agent X · N events · dernière activité il y a Ys"
          //   suivantes : les 8 derniers événements significatifs (tool calls,
          //   réflexion) avec leur âge relatif.
          // (EMIT_THROTTLE_MS est déclaré au niveau execute() — partagé avec
          // le forward structuré LOT 2a.)
          const SILENCE_AFTER_MS = 30_000;  // sous-agent muet si >30s sans event
          const SILENCE_TICK_MS = 10_000;   // timer périodique de détection de silence
          let lastEmitAt = 0;               // horodatage du dernier update émis
          const recentEvents: { at: number; label: string }[] = []; // 8 derniers events

          // ── Garde-fou anti-spam d'exploration (point B) ───────────────
          // L'audit a montré des sous-agents enchaînant jusqu'à 138 actions
          // read/grep/ls/find SANS jamais appeler un tool cbm_* alors que le
          // graphe était disponible. Au-delà de N explorations consécutives
          // (decideExplorationNudge), on injecte un rappel court dans le
          // contexte LLM de la tempSession : message custom NON affiché
          // (display:false) et sans déclencher de nouveau tour (triggerTurn:false)
          // → il est déposé à la fin du tour courant (tool results déjà posés)
          // et lu au tour suivant. Aucune interruption du streaming ni de la
          // boucle de l'agent ; rien n'est affiché côté UI (le forward structuré
          // ne transmet que les tool_* et les message_end ASSISTANT).
          let explorationGuard: ExplorationGuardState = { streak: 0, nudgesSent: 0 };
          const maybeNudgeCbmExploration = (toolName: unknown): void => {
            const decision = decideExplorationNudge(toolName, explorationGuard);
            explorationGuard = { streak: decision.nextStreak, nudgesSent: decision.nudgesSent };
            if (!decision.nudge) return;
            try {
              void tempSession
                .sendCustomMessage(
                  {
                    customType: "cbm_exploration_nudge",
                    content: buildExplorationReminder(),
                    display: false,
                  },
                  { triggerTurn: false },
                )
                .catch(() => {});
              console.log(
                `[harness-orchestrator] Sous-agent ${effectiveFunc.label} : rappel CBM injecté ` +
                `(${decision.nudgesSent}) après ${EXPLORATION_NUDGE_THRESHOLD} explorations sans cbm_*`,
              );
            } catch {}
          };

          // Réduit un event à une ligne courte (ou null si non significatif).
          // text_delta est agrégé via thinkingChars plutôt que ligne par ligne.
          const formatEventLine = (event: any): string | null => {
            if (event?.type === "tool_execution_start") {
              const tool = event.toolName || "outil";
              const args: any = event.args || {};
              const target =
                (typeof args.path === "string" && args.path) ||
                (typeof args.filePath === "string" && args.filePath) ||
                (typeof args.file_path === "string" && args.file_path) ||
                (typeof args.command === "string" && args.command) ||
                (typeof args.pattern === "string" && args.pattern) || "";
              return `${tool} ${target}`.trim().slice(0, 80);
            }
            if (event?.type === "message_update" &&
                event.assistantMessageEvent?.type === "text_delta") {
              thinkingChars += (event.assistantMessageEvent.delta || "").length;
              return null; // agrégé dans l'en-tête, pas de ligne dédiée
            }
            return null;
          };

          // Construit le texte multi-lignes affiché par l'aperçu tail -f de l'UI.
          const buildProgressText = (): string => {
            const silentFor = Math.round((Date.now() - lastEventAt) / 1000);
            const lines: string[] = [];
            let header = `sous-agent ${effectiveFunc.label} · ${eventCount} events` +
              ` · dernière activité il y a ${silentFor}s`;
            if (thinkingChars > 0) header += ` · ${thinkingChars} chars de réflexion`;
            if (silentFor * 1000 > SILENCE_AFTER_MS) {
              header += ` — aucune activité depuis ${silentFor}s, attente du modèle...`;
            }
            lines.push(header);
            const now = Date.now();
            for (const e of recentEvents) {
              lines.push(`  il y a ${Math.round((now - e.at) / 1000)}s · ${e.label}`);
            }
            return lines.join("\n");
          };

          // Émet l'update (throttlé sauf si force=true).
          const emitThrottled = (force = false) => {
            const now = Date.now();
            if (!force && now - lastEmitAt < EMIT_THROTTLE_MS) return;
            lastEmitAt = now;
            emitProgress(buildProgressText());
          };

          // Timer périodique : rend le silence visible — même sans nouvel event,
          // l'update signale que le sous-agent est muet (vs "ça bosse").
          silenceTimer = setInterval(() => {
            if (Date.now() - lastEventAt > SILENCE_AFTER_MS) {
              try { emitThrottled(true); } catch {}
            }
          }, SILENCE_TICK_MS);

          // Subscription aux events de la session temp : chaque event prouve que la
          // fonction travaille → reset du timer. Les events alimentent AUSSI le
          // partialResult streamé vers le frontend (tool_execution_update).
          tempUnsub = tempSession.subscribe((event: any) => {
            if (resetSilenceFn) resetSilenceFn();
            try {
              eventCount++;
              lastEventAt = Date.now();
              // Point B : compteur d'exploration (read/grep/ls/find sans cbm_*).
              if (event?.type === "tool_execution_start") {
                maybeNudgeCbmExploration(event.toolName);
              }
              const line = formatEventLine(event);
              // P0 : extrait court du dernier event pour la meta d'archivage
              lastEventSummary = line || event?.type || "inconnu";
              if (line) {
                recentEvents.push({ at: Date.now(), label: line });
                if (recentEvents.length > 8) recentEvents.shift();
                emitThrottled(true); // event significatif → update immédiat
              } else {
                emitThrottled(false);
              }
              // ── LOT 2a : forward STRUCTURÉ vers le chat (canal pi_event) ──
              // tool_execution_start/update/end + message_end assistant,
              // enveloppés {type:"subagent", …} avec throttle/quota — les
              // deltas et les events internes ne sont JAMAIS forwardés.
              // L'aperçu texte existant ci-dessus est conservé tel quel.
              forwardStructuredEvent(event);
            } catch {}
          });

          // Premier update immédiat pour que l'UI quitte l'état "silencieux".
          emitProgress(`sous-agent ${effectiveFunc.label} lancé...`);

          /**
           * Exécute prompt() avec DÉTECTEUR DE SILENCE DE FLUX + abort signal.
           * Retourne true si succès, false si silence de flux (pour retry).
           * Throw sur abort signal ou erreurs modèle (pas de retry).
           */
          const runPromptWithTimeouts = async (): Promise<boolean> => {
            // P2 : cause d'abandon dérivée d'une PREUVE (marqueur backend), pas
            // du message. Un abort interne ne doit jamais devenir
            // « abort-utilisateur ».
            const abortCause = () =>
              resolveAbortCause(isUserInitiatedAbort(subagentProjectId));

            // Si le signal est déjà aborté avant le lancement, ne pas relancer un prompt
            if (signal?.aborted) {
              // P0 : abort sans travail → échec, boîte noire à archiver
              archiveCause = abortCause();
              throw new Error(abortMessageFor(archiveCause));
            }

            // Valeurs lues au RUNTIME via le pont (un changement de réglage
            // s'applique dès la délégation suivante, sans redémarrage).
            const silenceCfg = resolveStreamSilenceConfig();
            // Le détecteur est propre à CHAQUE tentative (retry = nouveau compteur).
            const detector = new StreamSilenceDetector({
              silenceTimeoutMs: silenceCfg.silenceTimeoutMs,
              hardTimeoutMs: silenceCfg.hardTimeoutMs,
            });

            // P3 : garde de course — aucun callback de timer ne doit rejeter
            // après la fin de la course (finish() est posé en finally).
            const raceGuard = createRaceGuard();
            let detectorTimer: ReturnType<typeof setInterval> | null = null;
            let rejectTimeout: ((err: Error) => void) | null = null;
            let abortHandler: (() => void) | null = null;
            let warnedOnce = false;

            // Chaque événement reçu de la tempSession prouve que le flux vit →
            // il réinitialise le compteur de silence (cf. subscribe plus haut).
            resetSilenceFn = () => detector.touch();

            const timeoutPromise = new Promise<void>((_, reject) => {
              rejectTimeout = reject;
              // Vérification périodique (aucun timer par event : le compteur
              // est une simple horloge, réinitialisée par touch()).
              detectorTimer = setInterval(() => {
                const verdict = detector.evaluate();
                if (verdict.status === "silence") {
                  raceGuard.guard(() => {
                    (tempSession as any).abort?.().catch(() => {});
                    reject(new Error(streamSilenceMessage(effectiveFunction, verdict.silentMs)));
                  });
                } else if (verdict.status === "hard-timeout") {
                  raceGuard.guard(() => {
                    (tempSession as any).abort?.().catch(() => {});
                    reject(new Error(hardTimeoutMessage(effectiveFunction, verdict.elapsedMs)));
                  });
                } else if (verdict.status === "warning") {
                  // Alerte progressive : distingue « long mais vivant » de « bloqué ».
                  if (!warnedOnce) {
                    warnedOnce = true;
                    console.warn(
                      `[harness-orchestrator] Fonction ${effectiveFunction} silencieuse depuis ` +
                      `${Math.round(verdict.silentMs / 1000)}s (seuil d'arrêt : ${Math.round(silenceCfg.silenceTimeoutMs / 1000)}s)`,
                    );
                  }
                }
              }, SILENCE_TICK_MS);
              (detectorTimer as any)?.unref?.();
            });
            // P3 : une promesse perdante de la course ne doit JAMAIS produire de
            // rejet non géré (sinon le handler unhandledRejection tue le process).
            swallowRejection(timeoutPromise);

            // Abort signal de l'orchestrator → abort la fonction aussi (message clair)
            const abortPromise = signal
              ? new Promise<void>((_, reject) => {
                  abortHandler = () => {
                    raceGuard.guard(() => {
                      (tempSession as any).abort?.().catch(() => {});
                      reject(new Error(abortMessageFor(abortCause())));
                    });
                  };
                  signal.addEventListener("abort", abortHandler);
                })
              : new Promise<void>(() => {}); // jamais résout si pas de signal
            // P3 : idem — la promesse d'abort perdante est neutralisée.
            swallowRejection(abortPromise);

            // ── Phase 2 : slot LLM par provider pour l'appel du sous-agent ──
            // Le provider est résolu APRÈS le setModel (tempSession.model), donc
            // c'est bien le provider réellement appelé. ANTI-DEADLOCK : le
            // sous-agent ne dispose PAS du tool `delegate` → il ne sous-délègue
            // jamais, donc le slot n'est jamais conservé pendant l'attente d'une
            // sous-délégation. Libération garantie dans le finally ci-dessous.
            // ⚠️ Un sous-agent EN ATTENTE de slot n'émet AUCUN événement : sans
            // pause, le détecteur de silence le tuerait à tort. On neutralise
            // donc le compteur pendant toute attente légitime sans flux.
            const bridge = getConcurrencyBridge();
            const subagentProvider = (tempSession as any)?.model?.provider ?? "__default__";
            let subagentSlotKey: string | null = null;
            if (bridge) {
              subagentSlotKey =
                `${subagentProvider}::${subagentProjectId ?? "unknown"}::subagent::${++subagentSlotSeq}`;
              detector.pause();
              try {
                await bridge.acquireLLMSlot(
                  subagentSlotKey,
                  `subagent:${effectiveFunction}`,
                  subagentProvider,
                );
              } finally {
                detector.resume();
              }
            }

            try {
              await Promise.race([
                tempSession.prompt(functionPrompt, {}),
                timeoutPromise,
                abortPromise,
              ]);
              return true;
            } catch (err: any) {
              const msg = err.message || "";
              // BUG-67 : si l'orchestrator a été aborté pendant que la fonction travaillait,
              // on tente de récupérer ce que la fonction a déjà produit avant de rendre la main.
              // Le travail est souvent terminé (fichiers modifiés) — seule la réponse finale manque.
              if (isAbortInterruption(msg)) {
                // P0 : interruption → échec (avec ou sans travail récupéré),
                // boîte noire à archiver dans tous les cas.
                // P2 : étiquette EXACTE — « abort-utilisateur » seulement sur
                // preuve d'un abandon utilisateur, sinon « abort-session ».
                const cause = abortCause();
                archiveCause = cause;
                const partial = collectExpertResponse(tempSession);
                // P5 : motif COURT dans l'UI/archive. Le partiel est affiché UNE
                // SEULE fois (responsePreview collecté au finally) — l'embarquer
                // aussi dans errorMessage produisait un triple affichage.
                archiveErrorMessage = `${abortMessageFor(cause)} (récupéré : ${partial.length} chars)`;
                if (partial) {
                  console.log(`[harness-orchestrator] Fonction ${effectiveFunction} interrompue mais ${partial.length} chars récupérés`);
                  // Le partiel reste utile à l'orchestrator (résultat du tool) :
                  // joint au message d'erreur levé, mais SANS repasser par
                  // archiveErrorMessage (déjà fixé court ci-dessus).
                  throw new Error(`${archiveErrorMessage}\n\n${partial.slice(0, 2000)}`);
                }
                throw new Error(archiveErrorMessage);
              }
              // Timeout global : l'abort de la session temp est déjà déclenché —
              // on attend qu'il se termine (le dernier message assistant partiel
              // atterrit dans l'historique) puis on le collecte avant de rejeter
              // Garde-fou de dernier recours (OPTIONNEL, désactivé par défaut) :
              // pas de retry → échec définitif.
              if (isHardTimeoutMessage(msg)) {
                // P0 : pas de retry sur le garde-fou global → échec définitif.
                archiveCause = "timeout-global";
                try { await tempSession.waitForIdle(); } catch {}
                const partial = collectExpertResponse(tempSession);
                console.warn(`[harness-orchestrator] Fonction ${effectiveFunction}: garde-fou de dernier recours — ${partial.length} chars récupérés`);
                // P5 : errorMessage court, le partiel vit dans responsePreview.
                archiveErrorMessage = `${requestedFunc.label} a échoué (garde-fou de dernier recours) (récupéré : ${partial.length} chars)`;
                throw timeoutError("garde-fou de dernier recours", partial);
              }
              // Retry UNIQUEMENT sur silence de flux (le flux peut reprendre).
              // Pas de retry sur abort signal ni sur les erreurs modèle.
              if (isSilenceTimeoutMessage(msg)) {
                console.warn(`[harness-orchestrator] Fonction ${effectiveFunction}: silence de flux — ${msg}`);
                return false; // signal pour retry
              }
              throw err; // autre erreur → propagate
            } finally {
              // Phase 2 : TOUJOURS libérer le slot (succès, exception, abort,
              // silence de flux/garde-fou). Un échec de libération ne doit pas
              // masquer l'issue réelle de la délégation.
              if (bridge && subagentSlotKey) bridge.releaseLLMSlot(subagentSlotKey);
              // P3 : marquer la course terminée AVANT de couper les timers — un
              // callback de timer déjà en file ne peut plus rejeter.
              raceGuard.finish();
              if (detectorTimer) clearInterval(detectorTimer);
              if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
              resetSilenceFn = null; // déconnecter le callback
            }
          };

          // Exécution avec retry (1 retry sur silence de flux uniquement)
          let succeeded = false;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            attemptsMade = attempt; // P0 : tentatives réellement jouées (meta d'archivage)
            const ok = await runPromptWithTimeouts();
            if (ok) {
              succeeded = true;
              break;
            }
            // Silence de flux — retry si possible
            if (attempt < MAX_ATTEMPTS) {
              console.log(`[harness-orchestrator] Fonction ${effectiveFunction} a été arrêtée (silence de flux, attempt ${attempt}/${MAX_ATTEMPTS}). Retry en cours...`);
              // BUG-70 : l'abort du 1er attempt est asynchrone — attendre que la run
              // soit vraiment terminée (et tous les event listeners settle) sinon le
              // 2e prompt() jette "Agent is already processing a prompt".
              // waitForIdle() résout quand la run et les listeners ont fini.
              try { await tempSession.waitForIdle(); } catch {}
            } else {
              console.error(`[harness-orchestrator] Fonction ${effectiveFunction} arrêtée définitivement (silence de flux) après ${MAX_ATTEMPTS} attempts.`);
            }
          }
          if (!succeeded) {
            // P0 : silence de flux épuisé (2 attempts) → échec définitif,
            // cause explicite pour l'archivage de la boîte noire.
            archiveCause = "timeout-inactivite";
            // Récupération partielle au silence : attendre que l'abort de la
            // session temp soit terminé (le dernier message assistant partiel
            // atterrit dans l'historique) puis le collecter pour l'orchestrator.
            try { await tempSession.waitForIdle(); } catch {}
            const partial = collectExpertResponse(tempSession);
            console.warn(`[harness-orchestrator] Fonction ${effectiveFunction} arrêtée définitivement (silence de flux) — ${partial.length} chars récupérés`);
            // P5 : errorMessage court, le partiel vit dans responsePreview.
            archiveErrorMessage = `${requestedFunc.label} a échoué (flux silencieux) (récupéré : ${partial.length} chars)`;
            throw timeoutError("flux silencieux", partial);
          }

          // Collecter la réponse
          const messages: any[] = (tempSession as any).messages || [];
          const assistantTexts = messages
            .filter((m: any) => m.role === "assistant")
            .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "")
            .filter((t: string) => t.length > 0);
          const fullResponse = assistantTexts.join("\n\n");

          // ── BUG-68 (porté aux délégués — P0 observabilité volet 1/2) : le SDK
          // transforme une erreur modèle en message assistant VIDE
          // (stopReason:"error" + errorMessage) et prompt() ne reject JAMAIS.
          // On remonte la VRAIE erreur au lieu du générique « n'a produit aucune
          // réponse ». Ce retour explicite est un ÉCHEC (success reste false) →
          // le finally archive la boîte noire (cause : erreur-modele).
          const modelError = detectModelErrorMessage(messages);
          if (modelError) {
            archiveCause = "erreur-modele";
            archiveErrorMessage = modelError;
            console.error(`[harness-orchestrator] ${effectiveFunc.label} : erreur modèle — ${modelError} (modèle ${usedModelLabel})`);
            const partialNote = fullResponse
              ? `\n\nTravail partiel récupéré avant l'erreur :\n\n${fullResponse.slice(0, 2000)}`
              : "";
            return {
              content: [{
                type: "text" as const,
                text: formatModelErrorMessage(modelError, usedModelLabel, effectiveFunc.label) + partialNote,
              }],
              details: buildDetails("error", subagentFuncName, actionCount),
            };
          }

          // Réponse vide SANS erreur modèle explicite : échec aussi — c'était le
          // seul cas qui passait inaperçu (message générique sans cause). La
          // boîte noire est archivée pour permettre le diagnostic post-mortem.
          if (!fullResponse.trim()) {
            archiveCause = "reponse-vide";
            archiveErrorMessage = "Aucun message assistant produit (sans stopReason error)";
            console.error(`[harness-orchestrator] ${effectiveFunc.label} : réponse vide (modèle ${usedModelLabel})`);
            return {
              content: [{
                type: "text" as const,
                text: `❌ ${effectiveFunc.label} n'a produit aucune réponse. ` +
                  `Session archivée dans .data/logs/harness/ (cause : réponse vide).`,
              }],
              details: buildDetails("error", subagentFuncName, actionCount),
            };
          }

          console.log(`[harness-orchestrator] ${effectiveFunc.label} terminé: ${fullResponse.length} chars`);

          // SUCCÈS : le finally supprimera le fichier de session (pas de pollution).
          success = true;
          return {
            content: [{
              type: "text" as const,
              text: fullResponse,
            }],
            details: buildDetails("success", subagentFuncName, actionCount),
          };
        } catch (e: any) {
          // P0 volet 1/2 : annoter la cause d'échec AVANT le finally (le catch
          // externe traite l'erreur APRÈS que le finally ait archivé). Le filet
          // classifyFailure couvre les exceptions non annotées en amont.
          if (!archiveCause) {
            archiveCause = classifyFailure(e?.message || String(e));
          }
          if (!archiveErrorMessage) {
            archiveErrorMessage = e?.message || String(e);
          }
          throw e; // le catch externe conserve le comportement d'origine
        } finally {
          // Cleanup session
          if (silenceTimer) clearInterval(silenceTimer); // arrêter le timer de détection de silence
          // LOT 2a : arrêter le throttle des updates structurés (aucun flush
          // ne doit passer après subagent_end).
          if (updateFlushTimer) {
            clearTimeout(updateFlushTimer);
            updateFlushTimer = null;
          }
          // ── LOT 2a : subagent_end TOUJOURS (succès/échec/timeout/abort) ──
          // Émis AVANT l'archivage/unlink (le fichier de session reste lisible)
          // et pendant que tempSession est encore vivante (responsePreview).
          // Helper commun idempotent : le catch externe ne ré-émettra pas.
          emitSubagentEnd({
            status: statusFromCause(archiveCause, success),
            cause: archiveCause || (success ? null : "erreur-exception"),
            errorMessage: archiveErrorMessage ?? null,
            responsePreview: collectExpertResponse(tempSession),
          });
          if (tempUnsub) tempUnsub();
          try { (tempSession as any).dispose?.(); } catch {}
          // ── P0 volet 1/2 : boîte noire du délégué ──
          // SUCCÈS → suppression (comme avant, pas de pollution).
          // ÉCHEC  → archivage JSONL + meta dans .data/logs/harness/
          //          (rétention 7 jours, cause/tentatives/events/modèle/durée).
          // L'archivage est best-effort : une erreur I/O ne masque jamais
          // l'issue réelle de la délégation.
          try {
            if (typeof tempSessionFile === "string" && existsSync(tempSessionFile)) {
              if (success) {
                unlinkSync(tempSessionFile);
              } else {
                const archivePath = archiveFailedSession(tempSessionFile, {
                  functionName: effectiveFunction,
                  cause: archiveCause || "erreur-exception",
                  attempts: attemptsMade,
                  eventCount,
                  lastEventAt,
                  model: usedModelLabel,
                  durationMs: Date.now() - delegateStartedAt,
                  lastEventExcerpt: lastEventSummary || "(aucun événement)",
                  errorMessage: archiveErrorMessage,
                });
                if (archivePath) {
                  console.log(`[harness-orchestrator] Session déléguée en échec archivée : ${archivePath}`);
                }
              }
            }
          } catch (e: any) {
            console.warn(`[harness-orchestrator] Nettoyage/archivage de la session déléguée impossible : ${e?.message || e}`);
          }
          // Fichier traité (archivé ou supprimé) : le catch externe n'a plus rien à faire.
          pendingSessionFile = null;
        }
      } catch (err: any) {
        console.error(`[harness-orchestrator] Erreur ${functionName}:`, err.message);
        // ── LOT 2a : subagent_end pour un échec AVANT le try interne (ex.
        // createAgentSession, ré-enregistrement des providers) — le finally
        // interne n'a pas tourné, donc rien n'a encore été émis (helper
        // idempotent : sans effet si le finally interne a déjà émis).
        emitSubagentEnd({
          status: "error",
          cause: "erreur-sdk",
          errorMessage: err?.message || String(err),
          responsePreview: "",
        });
        // ── P0 volet 1/2 : échec AVANT le try interne (ex. createAgentSession,
        // ré-enregistrement des providers) → la boîte noire n'a pas encore été
        // traitée par le finally interne. On l'archive ici ; sinon c'est le
        // finally interne qui l'a déjà fait (pendingSessionFile === null).
        if (pendingSessionFile) {
          try {
            const archivePath = archiveFailedSession(pendingSessionFile, {
              functionName: functionName || "unknown",
              cause: "erreur-sdk",
              attempts: 0,
              eventCount: 0,
              lastEventAt: null,
              model: "?",
              durationMs: Date.now() - delegateStartedAt,
              lastEventExcerpt: "(échec avant tout événement du sous-agent)",
              errorMessage: err?.message || String(err),
            });
            if (archivePath) {
              console.log(`[harness-orchestrator] Session déléguée en échec (création) archivée : ${archivePath}`);
            }
          } catch {}
          pendingSessionFile = null;
        }
        // Les erreurs de timeout sont déjà pré-formatées avec l'extrait du travail
        // partiel récupéré (préfixe "❌") → renvoyées telles quelles à l'orchestrator.
        if (typeof err?.message === "string" && err.message.startsWith("❌")) {
          return {
            content: [{
              type: "text" as const,
              text: err.message,
            }],
            details: buildDetails(statusFromCause(archiveCause, false), subagentFuncName, actionCount),
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: `❌ ${requestedFunc.label} a échoué : ${err.message}`,
          }],
          details: buildDetails(statusFromCause(archiveCause, false), subagentFuncName, actionCount),
        };
      }
    },
  });

  // ── Tools du Carnet d'exploration (P2) ─────────────────────────────────────
  // Enregistrés dans CETTE extension : présents dans le registre des sessions
  // principales ET des tempSessions (mêmes règles que delegate/cbm_*). Le
  // projectId est résolu depuis ctx.cwd (repli nom de dossier) — le stockage
  // reste INDEXÉ PAR PROJET sous .data/harness-notes/<projectId>/.

  // exploration_note : écrit une découverte durable dans le carnet du projet.
  pi.registerTool({
    name: "exploration_note",
    label: "Exploration Note",
    description:
      "Écrit une découverte DURABLE dans le carnet d'exploration du projet (stockage hors repo, " +
      "réinjecté aux sous-agents suivants). Utilise ce tool pour un fait confirmé, un piège " +
      "rencontré ou une décision actée que la prochaine session ne devrait pas avoir à redécouvrir " +
      "(commande de build/test qui marche, localisation d'un symbole, contrainte non évidente). " +
      "UNE découverte par appel, une ligne, sans dump de code.",
    promptSnippet: "Persister une découverte durable (fait, piège, décision) hors session",
    promptGuidelines: [
      "Use exploration_note as soon as you confirm a durable fact, hit a pitfall, or settle a decision — do not wait until the end of the task.",
      "One discovery per call, one line, no code dumps and nothing already visible in the repository files.",
      "Prefer exploration_notes to the same discovery re-explored next session.",
    ],
    parameters: explorationNoteParams,
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: any,
    ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
      try {
        const cwd = ctx?.cwd || process.cwd();
        const projectId = await resolveProjectId(cwd);
        const note = appendExplorationNote(projectId, {
          kind: typeof params?.kind === "string" ? params.kind : "fact",
          text: typeof params?.text === "string" ? params.text : "",
          file: typeof params?.file === "string" ? params.file : undefined,
          task: typeof params?.task === "string" ? params.task : undefined,
        });
        if (!note) {
          return {
            content: [{ type: "text" as const, text: "❌ Note ignorée : le texte est vide." }],
            details: {},
          };
        }
        const loc = note.file ? ` (${note.file})` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Note [${NOTE_KIND_LABELS[note.kind]}] enregistrée dans le carnet du projet${loc} : ${note.text}`,
            },
          ],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [
            { type: "text" as const, text: `❌ Échec de l'écriture de la note : ${e?.message || e}` },
          ],
          details: {},
        };
      }
    },
  });

  // exploration_notes : relit/recherche les découvertes persistées du projet.
  pi.registerTool({
    name: "exploration_notes",
    label: "Exploration Notes",
    description:
      "Relit ou recherche le carnet d'exploration du projet (découvertes persistées hors session). " +
      "Utilise ce tool AVANT de ré-explorer un sujet déjà traité par une session précédente " +
      "(« que sait-on déjà ? »), ou pour retrouver une commande/contrainte non évidente.",
    promptSnippet: "Relire/rechercher les découvertes persistées du projet",
    promptGuidelines: [
      "Use exploration_notes before re-exploring a topic a previous session may already have covered.",
      "Pass a 'query' to search by keyword, or omit it to list the most recent notes.",
    ],
    parameters: explorationNotesParams,
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: any,
    ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
      try {
        const cwd = ctx?.cwd || process.cwd();
        const projectId = await resolveProjectId(cwd);
        const query = typeof params?.query === "string" ? params.query : "";
        const limit = typeof params?.limit === "number" ? params.limit : undefined;
        const notes = query
          ? searchExplorationNotes(projectId, query)
          : readExplorationNotes(projectId);
        return {
          content: [
            {
              type: "text" as const,
              text: renderNotesList(notes, { query: query || undefined, limit }),
            },
          ],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [
            { type: "text" as const, text: `❌ Échec de la lecture du carnet : ${e?.message || e}` },
          ],
          details: {},
        };
      }
    },
  });
}
