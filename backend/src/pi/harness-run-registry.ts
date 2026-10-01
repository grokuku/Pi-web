/**
 * harness-run-registry.ts — REGISTRE des runs de sous-agents en cours
 * (LOT 1 « orchestrateur interactif pendant que les sous-agents travaillent »).
 *
 * PROBLÈME : le tool `delegate` (extensions/harness-orchestrator) crée une
 * `tempSession` SDK par délégation, mais c'était une CLOSURE LOCALE du tool :
 * une fois le tool lancé (bloquant) ou détaché (non bloquant, LOT 2), plus
 * personne ne pouvait l'atteindre pour l'ARRÊTER. Seul un `pi_abort` de SESSION
 * pouvait tuer l'orchestrateur — et avec lui toutes les délégations en vol
 * (BUG-67).
 *
 * SOLUTION : chaque délégation ENREGISTRE un « handle » (runId, projectId,
 * cancel(), steer(text)) dans ce registre, et le DÉSENREGISTRE dans un finally.
 * Le backend (routeur WS `pi_subagent_stop`) lit le registre et appelle le
 * cancel CIBLÉ (un run) ou GLOBAL (tous les runs d'un projet) — sans toucher à
 * la session de l'orchestrateur.
 *
 * ⚠️ PONT GLOBAL (globalThis) — même raison que harness-stream.ts : l'extension
 * harness-orchestrator est chargée par le SDK via jiti (`moduleCache: false`).
 * Un import statique de ce module depuis l'extension créerait une SECONDE
 * instance du module (registre vide côté backend). On publie donc l'instance
 * RÉELLE créée par l'extension sur un symbole globalThis, que le backend lit.
 * `ensureHarnessRunRegistry` garantit de plus un registre UNIQUE PAR PROCESSUS :
 * les chargements multiples de l'extension (une instance par session, dont les
 * tempSessions de délégués) RÉUTILISENT le registre déjà publié au lieu de
 * l'écraser par un registre vide (cf. commentaire de la fonction).
 * Le module lui-même (createRunRegistry + helpers) est PUR et testé dans
 * harness-run-registry.test.ts.
 */

/** Action d'arrêt/direction d'un run, exposée sans dépendre du SDK Pi. */
export interface SubagentRunHandle {
  /** Identifiant de la délégation (makeDelegateRunId). */
  runId: string;
  /** Projet d'appartenance (étanchéité : on n'arrête que les runs du projet). */
  projectId?: string;
  /** Fonction de routage effective (planning/execute/review/integrate). */
  delegateFunction?: string;
  // ── Métadonnées d'affichage (LOT 3/4 : delegate_list et messages de retour) ──
  // Optionnelles : le handle reste valide sans elles (compatibilité), et elles
  // sont renseignées/mutées par l'extension — le registre stocke la référence.
  /** Libellé humain du run (« Exécution », …). */
  label?: string;
  /** Extrait de la tâche déléguée (affichage de liste). */
  taskExcerpt?: string;
  /** Début du run (epoch ms) — sert au « temps écoulé » de delegate_list. */
  startedAt?: number;
  /** Modèle effectif du sous-agent, si connu. */
  model?: string;
  /** Arrête CE run (annulation ciblée). Idempotent, ne jette jamais. */
  cancel(): void;
  /** Dirige CE run (message « steer »). Idempotent, ne jette jamais. */
  steer(text: string): void;
}

/** Registre des runs en cours. */
export interface HarnessRunRegistry {
  register(handle: SubagentRunHandle): void;
  unregister(runId: string): void;
  get(runId: string): SubagentRunHandle | undefined;
  /** Runs en cours (filtrés par projet si fourni). */
  list(projectId?: string): SubagentRunHandle[];
  /**
   * Arrête un run CIBLÉ. Si `projectId` est fourni, le run doit appartenir à ce
   * projet (étanchéité inter-projets) — sinon l'arrêt est refusé. Retourne true
   * si un run a effectivement été annulé.
   */
  cancel(runId: string, projectId?: string): boolean;
  /**
   * Arrête TOUS les runs (du projet si `projectId` fourni). Retourne le nombre
   * de runs annulés. Un échec de cancel d'un run ne bloque jamais les autres.
   */
  cancelAll(projectId?: string): number;
  /** Dirige un run ciblé ; retourne true si le run existe et a été dirigé. */
  steer(runId: string, text: string): boolean;
}

/**
 * Crée un registre VIDE. Les handles sont stockés par runId (Map) — l'ordre
 * d'itération est l'ordre d'insertion (déterministe pour les tests).
 */
export function createRunRegistry(): HarnessRunRegistry {
  const handles = new Map<string, SubagentRunHandle>();

  const belongs = (handle: SubagentRunHandle, projectId?: string): boolean =>
    !projectId || handle.projectId === projectId;

  return {
    register(handle: SubagentRunHandle): void {
      if (!handle || typeof handle.runId !== "string" || !handle.runId) return;
      handles.set(handle.runId, handle);
    },
    unregister(runId: string): void {
      handles.delete(runId);
    },
    get(runId: string): SubagentRunHandle | undefined {
      return handles.get(runId);
    },
    list(projectId?: string): SubagentRunHandle[] {
      const all = [...handles.values()];
      return projectId ? all.filter((h) => belongs(h, projectId)) : all;
    },
    cancel(runId: string, projectId?: string): boolean {
      const handle = handles.get(runId);
      if (!handle || !belongs(handle, projectId)) return false;
      try {
        handle.cancel();
      } catch {
        // Un cancel défaillant ne doit jamais remonter (arrêt best-effort).
      }
      return true;
    },
    cancelAll(projectId?: string): number {
      let count = 0;
      for (const handle of handles.values()) {
        if (!belongs(handle, projectId)) continue;
        try {
          handle.cancel();
        } catch {
          // idem : best-effort, on continue les autres runs.
        }
        count++;
      }
      return count;
    },
    steer(runId: string, text: string): boolean {
      const handle = handles.get(runId);
      if (!handle) return false;
      try {
        handle.steer(text);
      } catch {
        return false;
      }
      return true;
    },
  };
}

// ── Pont d'arrêt (globalThis) ────────────────────────────

/** Clé du pont global : le registre créé par l'extension (instance jiti). */
const RUN_REGISTRY_BRIDGE_KEY = "__piWebHarnessRunRegistry__";

/**
 * Publie le registre dans le pont global. Appelé au chargement de l'extension
 * harness-orchestrator ; le backend (instance ESM native) lit alors le MÊME
 * registre via resolveHarnessRunRegistry().
 */
export function registerHarnessRunRegistry(registry: HarnessRunRegistry): void {
  (globalThis as any)[RUN_REGISTRY_BRIDGE_KEY] = registry;
}

/** Lit le pont ; null s'il n'est pas enregistré (pas d'extension chargée). */
export function resolveHarnessRunRegistry(): HarnessRunRegistry | null {
  const reg = (globalThis as any)[RUN_REGISTRY_BRIDGE_KEY];
  if (reg && typeof reg.cancel === "function" && typeof reg.cancelAll === "function") {
    return reg as HarnessRunRegistry;
  }
  return null;
}

/**
 * Récupère le registre PARTAGÉ du processus, ou le crée/publie s'il n'existe
 * pas encore, et le retourne. À utiliser par l'extension À LA PLACE de
 * createRunRegistry + registerHarnessRunRegistry.
 *
 * POURQUOI : le SDK charge les extensions via jiti (`moduleCache: false`) — y
 * compris dans CHAQUE tempSession de délégué (preuve empirique : les tools
 * cbm_* y sont présents). Chaque chargement ré-évalue ce module : avec
 * `createRunRegistry()` + publication systématique, la tempSession publiée en
 * DERNIER écraserait le pont global par son registre VIDE → le backend
 * (pi_subagent_stop) lirait un registre sans runs et le bouton Stop ciblé de
 * l'UI ne ferait plus rien. Ici, la PREMIÈRE instance publie ; toutes les
 * suivantes RÉUTILISENT la même instance (registre unique du processus), donc
 * les runs enregistrés par la session de l'orchestrateur restent visibles du
 * backend et des autres sessions. L'étanchéité inter-projets reste assurée par
 * les filtres projectId du registre (list/cancel/cancelAll).
 *
 * PURE vis-à-vis du pont global — testée dans harness-run-registry.test.ts.
 */
export function ensureHarnessRunRegistry(): HarnessRunRegistry {
  const existing = resolveHarnessRunRegistry();
  if (existing) return existing;
  const registry = createRunRegistry();
  registerHarnessRunRegistry(registry);
  return registry;
}
