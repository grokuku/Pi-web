/**
 * Harness Engine v2 — Architecture Pilotée par un Architecte
 *
 * Nouveau flow :
 * 1. L'ARCHITECTE explore le code et produit un PLAN structuré en phases/tâches
 * 2. Chaque tâche est assignée à une fonction (planning/execute/review/integrate) + catégorie routée
 * 3. Les phases s'exécutent séquentiellement ; les tâches dans chaque phase aussi (V1)
 * 4. Chaque agent reçoit UNIQUEMENT sa tâche + les fichiers spécifiés — context minimal
 */

import { createAgentSession, SessionManager, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { emitToSubscribers, getSession } from "./session.js";
import { concurrencyManager } from "./concurrency.js";
import { getDefaultAgent, getProjectRoutingConfig, loadModelLibrary } from "./model-library.js";
import type { HarnessConfig, HarnessAgentConfig } from "./model-library.js";
import { extractSignals, isRoutingEnabled, pickModel, resolveRoute } from "./routing.js";
import type { Route, RoutingFunction, TaskCategory } from "./routing-types.js";
import os from "os";
import { existsSync } from "fs";

// ── Constants ──
const MAX_PHASES = 5;
const MAX_TASKS_TOTAL = 15;

// ── Fonctions du process (routage R4) ────────────────

const FUNCTION_SYSTEM_PROMPTS: Record<RoutingFunction, string> = {
  planning: `## FONCTION : PLANNING

Tu es un agent de planification. Ta mission est d'analyser le contexte, d'explorer le code si nécessaire, et de produire une solution ou un plan d'implémentation clair.

Règles :
- Lis les fichiers de contexte fournis avant de commencer
- Explore le code avec read/grep/find/ls quand c'est nécessaire
- Propose une solution précise, réaliste et alignée avec les conventions du projet
- Anticipe les edge cases et les impacts`,
  execute: `## FONCTION : EXECUTE

Tu es un agent d'implémentation. Ta mission est d'exécuter la tâche assignée en modifiant le code.

Règles :
- Lis TOUS les fichiers spécifiés dans ta tâche avant de commencer
- Écris du code de qualité production
- Suis les conventions existantes du projet
- Fais des changements atomiques, un fichier à la fois
- Gère les erreurs et edge cases
- Teste tes changements avec bash si applicable`,
  review: `## FONCTION : REVIEW

Tu es un agent de relecture. Ta mission est d'analyser le code ou les changements pour en vérifier la qualité.

Règles :
- Vérifie la logique, la sécurité, les performances
- Vérifie les edge cases non gérés
- Signale les bugs avec fichier:ligne
- Suggère des corrections concrètes
- Ne modifie PAS le code toi-même (sauf instruction contraire)`,
  integrate: `## FONCTION : INTEGRATE

Tu es un agent d'intégration. Ta mission est de finaliser et d'assembler les éléments produits.

Règles :
- Lis les fichiers de contexte et les sorties des phases précédentes
- Assemble les changements de façon cohérente
- Exécute les migrations, tests et vérifications de bout en bout nécessaires
- Mets à jour la documentation et finalise la livraison`,
};

const FUNCTION_TOOLS: Record<RoutingFunction, string[]> = {
  planning: ["read", "grep", "find", "ls"],
  execute: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  review: ["read", "grep", "find", "ls", "bash"],
  integrate: ["read", "edit", "write", "bash", "grep", "find", "ls"],
};

const FUNCTION_DESCRIPTIONS: Record<RoutingFunction, string> = {
  planning: "Analyse et conception : explorer le code, concevoir une solution, produire un plan ou un design technique.",
  execute: "Implémentation : écrire ou modifier le code, corriger des bugs, ajouter des fonctionnalités.",
  review: "Relecture et audit : vérifier la qualité, la sécurité, les edge cases, sans modifier le code (sauf mention contraire).",
  integrate: "Intégration et finalisation : assembler les changements, migrations, tests de bout en bout, documentation finale.",
};

/** Normalise une valeur libre (champ `function` du plan) vers une RoutingFunction. */
function normalizeFunction(value: string | undefined): RoutingFunction | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "planning" || v === "plan") return "planning";
  if (v === "execute" || v === "execution" || v === "implement" || v === "implementation") return "execute";
  if (v === "review" || v === "reviewer" || v === "code-review") return "review";
  if (v === "integrate" || v === "integration" || v === "integrator") return "integrate";
  return null;
}

/**
 * Rétro-compatibilité : mappe un rôle d'expert legacy vers une fonction.
 * architect/planner → planning, reviewers → review, tout le reste → execute.
 */
function mapRoleToFunction(role: string | undefined): RoutingFunction {
  const r = (role || "").trim().toLowerCase();
  if (r === "architect" || r === "planner") return "planning";
  if (r === "code-reviewer" || r === "security-reviewer") return "review";
  return normalizeFunction(role) ?? "execute";
}

/** Catégorie de repli quand le routage est désactivé (affichage + fallback modèle). */
function defaultCategoryForFunction(fn: RoutingFunction): TaskCategory {
  switch (fn) {
    case "planning":
      return "complex";
    case "review":
      return "review";
    case "integrate":
      return "standard";
    case "execute":
      return "standard";
  }
}

// ── Types du plan ────────────────────────────────────

interface PlanTask {
  /** Rôle legacy (rétro-compatibilité) — peut aussi contenir une fonction. */
  agent: string;
  /** Nouvelle assignation par fonction du process. */
  function?: RoutingFunction;
  /** Catégorie déduite par le routage (défaut déduit si absente). */
  category?: TaskCategory;
  title: string;
  instruction: string;
  read_files: string[];
}

interface PlanPhase {
  name: string;
  tasks: PlanTask[];
}

interface ArchitecturePlan {
  decisions: {
    summary: string;
    tech?: Record<string, string>;
  };
  phases: PlanPhase[];
}

/** Prompt de l'architecte orienté fonctions (R4) — remplace l'assignation par rôles. */
const ARCHITECT_SYSTEM_PROMPT = `## RÔLE : ARCHITECTE

Tu es l'architecte d'un système multi-agent. Tu reçois une demande utilisateur et tu dois :
1. Explorer le codebase existant (read, grep, find, ls, ...)
2. Prendre les décisions techniques clés (langage, framework, approche)
3. Produire un plan d'exécution structuré en phases et tâches

## Fonctions assignables
Voici les fonctions que tu peux assigner aux tâches :
{FUNCTION_LIST}

## Format de sortie OBLIGATOIRE
Tu DOIS terminer ta réponse par un bloc JSON contenant le plan. Format exact :

\`\`\`json
{
  "decisions": {
    "summary": "Résumé concis de l'approche",
    "tech": { "clé": "valeur" }
  },
  "phases": [
    {
      "name": "Nom de la phase",
      "tasks": [
        {
          "function": "planning|execute|review|integrate",
          "title": "Titre court de la tâche",
          "instruction": "Instruction détaillée et AUTO-CONTENUE. L'agent ne verra QUE cette instruction, pas la demande originale ni les autres tâches. Sois précis sur ce qu'il faut faire, quels fichiers créer/modifier, et quelles conventions suivre.",
          "read_files": ["chemin/vers/fichier.ext"]
        }
      ]
    }
  ]
}
\`\`\`

## Règles critiques
- Assigne à chaque tâche une \`function\` parmi les fonctions listées ci-dessus
- Chaque instruction doit être COMPLÈTE et AUTO-CONTENUE — l'agent ne voit rien d'autre
- Spécifie les fichiers que chaque agent doit lire pour avoir le contexte nécessaire
- Maximum 5 phases et 15 tâches au total
- Les phases s'exécutent séquentiellement ; dans chaque phase, les tâches s'exécutent une par une
- Si une tâche dépend d'une phase précédente, mentionne-le dans l'instruction ("les fichiers X et Y ont été créés à la phase précédente")`;

// ── Engine ────────────────────────────────────────────

export class HarnessEngine {
  private config: HarnessConfig;
  private projectId: string;
  private userPrompt: string;
  private conversationHistory: string;
  private steerMessages: string[];
  private harnessModelId: string | null;
  private constructor(
    projectId: string,
    userPrompt: string,
    conversationHistory: string,
    config: HarnessConfig,
    steerMessages: string[],
    harnessModelId: string | null,
  ) {
    this.projectId = projectId;
    this.userPrompt = userPrompt;
    this.conversationHistory = conversationHistory;
    this.config = config;
    this.steerMessages = steerMessages;
    this.harnessModelId = harnessModelId;
  }

  // ── Point d'entrée ──────────────────────────────────

  /**
   * Lance un cycle harness :
   * 1. Architecte explore le code et produit un plan
   * 2. Les phases/tâches s'exécutent séquentiellement
   * 3. Synthèse finale
   */
  static async run(
    projectId: string,
    userPrompt: string,
    config: HarnessConfig,
    steerMessages?: string[],
    conversationHistory?: string,
    harnessModelId?: string | null,
  ): Promise<string> {
    const engine = new HarnessEngine(projectId, userPrompt, conversationHistory || "", config, steerMessages || [], harnessModelId ?? null);

    const activeAgents = config.agents.filter(a => a.enabled);
    if (activeAgents.length === 0) {
      engine.emitText("\n\n⚠ **Aucun agent activé.** Active des agents dans la config Harness.\n\n");
      return "No agents configured";
    }

    // Signal de début
    const messageId = `harness-${Date.now()}`;
    emitToSubscribers({ type: "message_start", message: { id: messageId, role: "assistant" } } as any, projectId);
    emitToSubscribers({ type: "agent_start", message: { role: "assistant" }, _harness: true } as any, projectId);

    try {
      // ── Phase 1 : Architecte planifie ──
      engine.emitText(`\n\n**🏗 PHASE D'ARCHITECTURE**\n\nL'architecte explore le code et élabore un plan...\n\n`);
      const plan = await engine.runArchitect(activeAgents);
      if (!plan) {
        engine.emitText(`\n\n❌ **L'architecte n'a pas pu produire un plan valide.**\n\n`);
        emitToSubscribers({
          type: "message_end",
          message: { id: messageId, role: "assistant", usage: { input: 0, output: 0, cost: { total: 0 } } },
        } as any, projectId);
        return "Plan generation failed";
      }

      // Afficher les décisions de l'architecte
      engine.emitText(`\n\n**📋 DÉCISIONS DE L'ARCHITECTE**\n\n${plan.decisions.summary}\n\n`);
      if (plan.decisions.tech) {
        const techLines = Object.entries(plan.decisions.tech).map(([k, v]) => `- **${k}** : ${v}`).join("\n");
        engine.emitText(`${techLines}\n\n`);
      }

      // Afficher le plan au user
      const phaseSummary = plan.phases.map((p, i) =>
        `**Phase ${i + 1} : ${p.name}**  \n${p.tasks.map(t => `  → _${t.title}_ (${t.function ?? t.agent})`).join("\n")}`
      ).join("\n\n");
      engine.emitText(`**📐 PLAN D'EXÉCUTION**\n\n${phaseSummary}\n\n`);

      // ── Phase 2 : Exécution des phases ──
      const artifacts: { phase: string; task: string; agent: string; output: string }[] = [];
      let taskCount = 0;
      const maxTasks = config.maxTasks || 20;

      for (let pi = 0; pi < plan.phases.length; pi++) {
        const phase = plan.phases[pi];

        // Vérifier l'abort
        if (engine.isAborted()) break;

        engine.emitText(`\n\n---\n## 🔷 Phase ${pi + 1} : ${phase.name}\n\n`);

        for (let ti = 0; ti < phase.tasks.length; ti++) {
          const task = phase.tasks[ti];

          // Vérifier l'abort
          if (engine.isAborted()) {
            engine.emitText(`\n\n_🛑 Harness interrompu par l'utilisateur_\n\n`);
            break;
          }

          // Limite de sécurité
          taskCount++;
          if (taskCount > maxTasks) {
            engine.emitText(`\n\n_⚠️ Limite de ${maxTasks} tâches atteinte — exécution arrêtée_\n\n`);
            break;
          }

          // Sélectionner l'agent par fonction (rétro-compatibilité rôle conservée)
          const selection = engine.selectAgentForTask(activeAgents, task);
          if (!selection) {
            engine.emitText(`\n\n⚠️ **Aucun agent disponible** pour la tâche "${task.title}". Tâche ignorée.\n\n`);
            continue;
          }

          const { agent: agentConfig, functionName } = selection;
          const routing = engine.resolveTaskRouting(task, agentConfig);

          engine.emitText(`\n### 🔸 ${task.title}\n**Fonction :** ${functionName}  \n**Catégorie :** ${routing.category}  \n**Agent :** ${agentConfig.role}  \n\n`);

          // Ajouter les steer messages au début de l'instruction si disponibles
          let taskInstruction = task.instruction;
          while (engine.steerMessages.length > 0) {
            const steer = engine.steerMessages.shift()!;
            taskInstruction += `\n\n---\n**💬 Complément utilisateur :**\n${steer}`;
          }

          const output = await engine.runAgentTask(
            agentConfig,
            taskInstruction,
            task.read_files || [],
            plan.decisions,
            `task-${pi}-${ti}`,
            functionName,
            routing.route,
          );

          artifacts.push({
            phase: phase.name,
            task: task.title,
            agent: functionName,
            output,
          });
        }

        if (engine.isAborted()) break;
      }

      // ── Phase 3 : Synthèse ──
      let finalOutput = engine.formatFinalResult(artifacts, plan);

      // Émettre le rapport final dans le chat avant de cloturer le message
      engine.emitText(`\n\n---\n${finalOutput}\n`);

      emitToSubscribers({
        type: "message_end",
        message: { id: messageId, role: "assistant", usage: { input: 0, output: 0, cost: { total: 0 } } },
      } as any, projectId);

      return finalOutput;

    } catch (err: any) {
      engine.emitText(`\n\n❌ **Erreur inattendue :** ${err.message}\n\n`);
      emitToSubscribers({
        type: "message_end",
        message: { id: messageId, role: "assistant", usage: { input: 0, output: 0, cost: { total: 0 } } },
      } as any, projectId);
      return `[Harness] Erreur : ${err.message}`;
    } finally {
      emitToSubscribers({ type: "agent_end", _harness: true, _phase: "done" } as any, projectId);
    }
  }

  // ── Architecte ──────────────────────────────────────

  /**
   * Exécute l'agent architecte : explore le code, prend des décisions,
   * produit un plan JSON structuré.
   */
  private async runArchitect(activeAgents: HarnessAgentConfig[]): Promise<ArchitecturePlan | null> {
    const architect = activeAgents.find(a => a.role === "architect")
      ?? activeAgents.find(a => mapRoleToFunction(a.role) === "planning")
      ?? activeAgents[0]; // fallback : premier agent comme planner

    // Construire la liste des fonctions assignables pour l'architecte
    const functionListStr = (Object.keys(FUNCTION_DESCRIPTIONS) as RoutingFunction[])
      .map(fn => `- **${fn}** : ${FUNCTION_DESCRIPTIONS[fn]}`)
      .join("\n");

    // Prompt orienté fonctions (R4) — n'utilise plus les rôles d'experts
    const architectPrompt = ARCHITECT_SYSTEM_PROMPT.replace("{FUNCTION_LIST}", functionListStr);

    // Outils pour l'architecte (read-only + exploration)
    const poolEntry = getDefaultAgent(architect.role);
    const tools = architect.tools || poolEntry?.tools || ["read", "grep", "find", "ls"];

    // Concaténer l'historique de conversation au prompt de l'architecte
    let archUserPrompt = `\n\n## Demande utilisateur\n\n${this.userPrompt}`;
    if (this.conversationHistory) {
      // Limiter à 8000 chars pour éviter de saturer
      const history = this.conversationHistory.slice(0, 8000);
      archUserPrompt += `\n\n## Historique de la discussion\n\nVoici les messages récents de la conversation (pour contexte) :\n\n${history}\n\n---`;
    }
    archUserPrompt += `\n\n## Règles\n- Explore le codebase avant de décider\n- Produis un plan réaliste et précis\n- Maximum ${MAX_PHASES} phases et ${MAX_TASKS_TOTAL} tâches\n- Termine par un bloc JSON valide (\`\`\`json ... \`\`\`)\n- Assigne à chaque tâche une \`function\` parmi : planning, execute, review, integrate`;

    // L'architecte est la fonction planning : son modèle suit la catégorie complex
    // (ou la chaîne legacy si le routage est désactivé).
    const architectRoute: Route | null = isRoutingEnabled()
      ? (() => {
          const routingConfig = getProjectRoutingConfig(loadModelLibrary(), this.projectId);
          const route = resolveRoute(this.userPrompt, routingConfig, extractSignals());
          return { ...route, function: "planning", category: "complex" };
        })()
      : null;

    // Exécuter l'architecte
    const response = await this.runSingleAgent(
      architect,
      architectPrompt,
      tools,
      archUserPrompt,
      "architect",
      "planning",
      architectRoute,
    );

    if (!response) {
      console.error("[harness] Architect returned empty response");
      this.emitText("\n\n⚠️ **L'architecte n'a pas produit de réponse.** Vérifie que le modèle LLM est accessible.\n\n");
      return null;
    }

    // Si l'agent a retourné une erreur (timeout, session, model), l'afficher
    const errorMatch = response.match(/^\[Error:\s*([^\]]*)\](.*)/s);
    if (errorMatch) {
      const errDetail = (errorMatch[1] + errorMatch[2]).trim();
      this.emitText(`\n\n⚠️ **L'architecte a rencontré une erreur :** ${errDetail}\n\n`);
      return null;
    }

    // Extraire et parser le JSON du plan
    return this.extractAndParsePlan(response, activeAgents);
  }

  /**
   * Extrait le JSON du plan depuis la réponse de l'architecte.
   * Essaie plusieurs patterns, avec retry si échec.
   */
  private extractAndParsePlan(response: string, activeAgents: HarnessAgentConfig[]): ArchitecturePlan | null {
    let jsonStr: string | null = null;

    // Pattern 1 : ```json ... ``` (lazy — peut s'arrêter trop tôt si backticks dans le JSON)
    const matchJsonBlock = response.match(/```json\s*([\s\S]*?)```/);
    if (matchJsonBlock) jsonStr = matchJsonBlock[1].trim();

    // Pattern 2 : ``` ... ``` (sans lang)
    if (!jsonStr) {
      const matchAnyBlock = response.match(/```\s*([\s\S]*?)```/);
      if (matchAnyBlock) jsonStr = matchAnyBlock[1].trim();
    }

    // Pattern 3 : premier { ... dernier } — capture le JSON complet même si
    // les blocs de code sont mal fermés ou si le JSON contient des backticks.
    // C'est le fallback le plus robuste pour les réponses longues des LLM.
    if (!jsonStr) {
      const firstBrace = response.indexOf("{");
      const lastBrace = response.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = response.slice(firstBrace, lastBrace + 1);
      }
    }

    if (!jsonStr) {
      console.error("[harness] No JSON found in architect response");
      const snippet = response.replace(/\n/g, " ").slice(0, 150);
      this.emitText(`\n\n⚠️ **L'architecte n'a pas produit un plan JSON valide.**\n\nDébut de sa réponse :\n\`${snippet}...\`\n\n`);
      return null;
    }

    // Tentative de parsing
    try {
      const parsed = JSON.parse(jsonStr);
      return this.validatePlan(parsed, activeAgents);
    } catch (e: any) {
      console.error(`[harness] Failed to parse architect JSON (attempt 1, len=${jsonStr.length}): ${e.message}`);
      // Log un extrait autour de la position d'erreur
      const pos = parseInt(e.message.match(/position (\d+)/)?.[1] || "0");
      if (pos > 0) {
        const around = jsonStr.slice(Math.max(0, pos - 80), pos + 80);
        console.error(`[harness] JSON autour de pos ${pos}: ...${JSON.stringify(around)}...`);
      }

      // Si le pattern 1 ou 2 a capturé trop peu (regex lazy),
      // réessayer avec le pattern 3 (premier { au dernier })
      const firstBrace = response.indexOf("{");
      const lastBrace = response.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const fullJson = response.slice(firstBrace, lastBrace + 1);
        if (fullJson.length > jsonStr.length) {
          console.log(`[harness] Retry avec extraction complète: ${jsonStr.length} → ${fullJson.length} chars`);
          try {
            const parsed = JSON.parse(fullJson);
            console.log(`[harness] JSON parsé avec succès après extraction complète (${fullJson.length} chars)`);
            return this.validatePlan(parsed, activeAgents);
          } catch (e2: any) {
            console.error(`[harness] Full extraction also failed: ${e2.message}`);
            jsonStr = fullJson; // Utiliser le JSON complet pour la réparation
          }
        }
      }

      // Tentative de réparation : problèmes courants des LLM avec JSON
      try {
        const repaired = jsonStr
          // 1. Newlines littéraux dans les strings → \\n
          .replace(/:\s*"([^"]*)\n([^"]*)"/g, (_m, p1, p2) => `: "${p1}\\n${p2}"`)
          // 2. Virgules trailing avant } ou ]
          .replace(/,\s*([\]}])/g, "$1")
          // 3. Guillemets courbes → guillemets droits
          .replace(/[\u201c\u201d]/g, '"')
          // 4. Apostrophes courbes dans les strings
          .replace(/\u2019/g, "'");
        const parsed = JSON.parse(repaired);
        console.log(`[harness] JSON réparé avec succès après ${repaired.length} chars`);
        return this.validatePlan(parsed, activeAgents);
      } catch (e2: any) {
        console.error(`[harness] JSON repair also failed: ${e2.message}`);
        this.emitText(`\n\n⚠️ **Erreur de parsing du plan JSON :** ${e.message}\nL'architecte a produit ${jsonStr.length} chars de JSON mais celui-ci est malformé.\n\n`);
        return null;
      }
    }
  }

  /** Valide la structure du plan et ajoute les defaults */
  private validatePlan(parsed: any, activeAgents: HarnessAgentConfig[]): ArchitecturePlan | null {
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.decisions?.summary) return null;
    if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) return null;

    const validRoles = new Set(activeAgents.map(a => a.role));

    const phases: PlanPhase[] = [];
    for (const phase of parsed.phases.slice(0, MAX_PHASES)) {
      if (!phase.name || !Array.isArray(phase.tasks)) continue;
      const tasks: PlanTask[] = [];
      for (const task of phase.tasks.slice(0, MAX_TASKS_TOTAL)) {
        if (!task.instruction) continue;

        // Nouveau format R4 : la tâche porte une `function`.
        const requestedFunction = normalizeFunction(task.function) ?? normalizeFunction(task.agent);
        // Rétro-compatibilité : `agent` reste un rôle d'expert legacy.
        const legacyRole = typeof task.agent === "string" && validRoles.has(task.agent) ? task.agent : undefined;

        if (!requestedFunction && !legacyRole) {
          console.warn(`[harness] Task assigns unknown agent/function "${task.agent ?? task.function}" — skipping`);
          continue;
        }

        const functionName = requestedFunction ?? mapRoleToFunction(legacyRole!);

        tasks.push({
          agent: legacyRole ?? task.agent ?? functionName,
          function: functionName,
          title: task.title || legacyRole || functionName,
          instruction: task.instruction,
          read_files: Array.isArray(task.read_files) ? task.read_files : [],
        });
      }
      if (tasks.length > 0) {
        phases.push({ name: phase.name, tasks });
      }
    }

    if (phases.length === 0) return null;

    return {
      decisions: {
        summary: parsed.decisions.summary,
        tech: parsed.decisions.tech || {},
      },
      phases,
    };
  }

  // ── Routage R4 des tâches ───────────────────────────

  /** Sélectionne l'agent actif pour une tâche, en privilégiant la fonction (R4) puis le rôle legacy. */
  private selectAgentForTask(
    activeAgents: HarnessAgentConfig[],
    task: PlanTask,
  ): { agent: HarnessAgentConfig; functionName: RoutingFunction } | null {
    if (activeAgents.length === 0) return null;

    // Nouveau format R4 : la `function` est prioritaire (même si `agent` legacy est aussi présent).
    const requestedFunction = normalizeFunction(task.function) ?? normalizeFunction(task.agent);
    if (requestedFunction) {
      const byFunction = activeAgents.find(a => mapRoleToFunction(a.role) === requestedFunction);
      return { agent: byFunction ?? activeAgents[0], functionName: requestedFunction };
    }

    // Rétro-compatibilité : l'architecte a assigné un rôle d'expert exact.
    const byRole = activeAgents.find(a => a.role === task.agent);
    if (byRole) {
      return { agent: byRole, functionName: mapRoleToFunction(byRole.role) };
    }

    // Fallback : premier agent actif.
    return { agent: activeAgents[0], functionName: mapRoleToFunction(activeAgents[0].role) };
  }

  /** Résout la fonction + la catégorie d'une tâche (routage R4) et la route de modèle associée. */
  private resolveTaskRouting(
    task: PlanTask,
    agent: HarnessAgentConfig,
  ): { functionName: RoutingFunction; category: TaskCategory; route: Route | null } {
    const requestedFunction = normalizeFunction(task.function) ?? normalizeFunction(task.agent);
    const functionName = requestedFunction ?? mapRoleToFunction(agent.role);

    if (!isRoutingEnabled()) {
      return { functionName, category: defaultCategoryForFunction(functionName), route: null };
    }

    const routingConfig = getProjectRoutingConfig(loadModelLibrary(), this.projectId);
    const route = resolveRoute(task.instruction, routingConfig, extractSignals());
    return {
      functionName,
      category: route.category,
      route: { ...route, function: functionName },
    };
  }

  // ── Exécution d'une tâche ───────────────────────────

  /**
   * Exécute une tâche unique confiée à un agent.
   * L'agent reçoit CONTEXTE MINIMAL : instruction + fichiers à lire + décisions architecte.
   */
  private async runAgentTask(
    agent: HarnessAgentConfig,
    taskInstruction: string,
    readFiles: string[],
    architectDecisions: { summary: string; tech?: Record<string, string> },
    label: string,
    functionName: RoutingFunction,
    route: Route | null,
  ): Promise<string> {
    const cwd = getSession(this.projectId)?.cwd || os.homedir();

    // Contexte compressé : décisions de l'architecte + fichiers à lire + instruction
    const readFilesBlock = readFiles.length > 0
      ? `\n## Fichiers de contexte à lire avant de commencer\n${readFiles.map(f => `- \`${f}\``).join("\n")}\n\nPrends le temps de les lire avec read() pour comprendre le contexte existant.`
      : "";

    const techBlock = architectDecisions.tech && Object.keys(architectDecisions.tech).length > 0
      ? `\n## Décisions techniques (définies par l'architecte)\n${Object.entries(architectDecisions.tech).map(([k, v]) => `- **${k}** : ${v}`).join("\n")}`
      : "";

    const fullPrompt = [
      `## Contexte du projet\n${architectDecisions.summary}`,
      techBlock,
      `\n## Ta tâche\n${taskInstruction}`,
      readFilesBlock,
      `\n---\nExécute ta tâche en utilisant les outils à ta disposition.`,
    ].filter(Boolean).join("\n");

    // R4 : le system prompt et les outils viennent de la fonction, plus du rôle.
    const systemPrompt = FUNCTION_SYSTEM_PROMPTS[functionName]
      || `## FONCTION : ${functionName.toUpperCase()}\n\nExécute la tâche assignée avec rigueur.`;
    const tools = FUNCTION_TOOLS[functionName] || agent.tools || ["read", "edit", "write", "bash", "grep", "find", "ls"];

    return this.runSingleAgent(agent, systemPrompt, tools, fullPrompt, label, functionName, route);
  }

  // ── Agent unique (mutualisé) ────────────────────────

  /**
   * Crée une session Pi temporaire pour un agent, exécute le prompt,
   * collecte la réponse, nettoie.
   */
  private async runSingleAgent(
    agent: HarnessAgentConfig,
    systemPrompt: string,
    tools: string[],
    prompt: string,
    label: string,
    functionName: RoutingFunction,
    route: Route | null,
  ): Promise<string> {
    const cwd = getSession(this.projectId)?.cwd || os.homedir();
    let tempSession: AgentSession | null = null;
    let tempSessionFile: string | undefined;
    let tempUnsub: (() => void) | null = null;

    // BUG-59 : slotKey unique par agent pour éviter la réentrance par projectId
    const agentSlotKey = `${this.projectId}::harness-${label}`;
    const llmSlotKey = `${this.projectId}::harness-llm-${label}`;

    try {
      await concurrencyManager.acquireAgentSlot(agentSlotKey, label);

      const tempSessionManager = SessionManager.create(cwd);
      tempSessionFile = tempSessionManager.getSessionFile();
      const result = await createAgentSession({
        cwd,
        sessionManager: tempSessionManager,
        modelRuntime: getModelRuntime(),
      });
      tempSession = result.session;

      // Modèle : R4 → routage par fonction/catégorie via pickModel(resolveRoute(...)).
      // Fallback legacy : agent.modelId → harnessModelId → session principale → default.
      let modelSet = false;
      console.log(`[harness] ${functionName}: recherche modèle (routing=${route ? "on" : "off"}, agent.modelId=${agent.modelId}, harnessModelId=${this.harnessModelId})`);
      if (route) {
        const routingConfig = getProjectRoutingConfig(loadModelLibrary(), this.projectId);
        const target = pickModel(route, routingConfig, loadModelLibrary());
        if (target) {
          const model = getModelRegistry().find(target.providerId, target.modelId);
          if (model) {
            await tempSession.setModel(model);
            modelSet = true;
            console.log(`[harness] ${functionName}: modèle set via routing (${route.category}/${route.function}) → ${model.provider}/${model.id}`);
          } else {
            console.warn(`[harness] ${functionName}: modèle routing ${target.providerId}/${target.modelId} introuvable dans le registry`);
          }
        } else {
          console.warn(`[harness] ${functionName}: pickModel n'a pas trouvé de modèle (bibliothèque vide ?)`);
        }
      }
      if (!modelSet) {
        if (agent.modelId) {
          const parts = agent.modelId.split("__");
          const model = getModelRegistry().find(parts[0], parts[1] || "");
          if (model) { await tempSession.setModel(model); modelSet = true; console.log(`[harness] ${functionName}: modèle set via agent.modelId → ${model.provider}/${model.id}`); }
          else console.warn(`[harness] ${functionName}: modelId=${agent.modelId} non trouvé dans le registry`);
        } else if (this.harnessModelId) {
          // Modèle configuré pour le mode HARNESS dans le ModelQuickSwitch
          const parts = this.harnessModelId.split("__");
          const model = getModelRegistry().find(parts[0], parts.slice(1).join("__") || "");
          if (model) { await tempSession.setModel(model); modelSet = true; console.log(`[harness] ${functionName}: modèle set via harnessModelId → ${model.provider}/${model.id}`); }
          else console.warn(`[harness] harnessModelId=${this.harnessModelId} non trouvé dans le registry`);
        } else {
          // Hériter du modèle de la session principale (qui marche)
          const mainSession = getSession(this.projectId);
          const mainModel = (mainSession?.session as any)?.model;
          if (mainModel) {
            await tempSession.setModel(mainModel); modelSet = true;
            console.log(`[harness] ${functionName}: hérite du modèle de la session principale: ${mainModel.provider}/${mainModel.id}`);
          } else {
            console.warn(`[harness] ${functionName}: pas de modèle sur la session principale, fallback...`);
            // Derniers fallbacks : defaultModelId puis premier dispo
            const lib = loadModelLibrary();
            const defaultModelId = lib.defaultModelId;
            if (defaultModelId) {
              const parts = defaultModelId.split("__");
              const model = getModelRegistry().find(parts[0], parts.slice(1).join("__") || "");
              if (model) { await tempSession.setModel(model); modelSet = true; console.log(`[harness] ${functionName}: modèle set via defaultModelId → ${model.provider}/${model.id}`); }
            }
            if (!modelSet) {
              const available = getModelRegistry().getAvailable();
              console.log(`[harness] ${functionName}: getAvailable() retourne ${available.length} modèles`);
              if (available.length > 0) {
                await tempSession.setModel(available[0]); modelSet = true; console.log(`[harness] ${functionName}: modèle set via available[0] → ${available[0].provider}/${available[0].id}`);
              }
            }
          }
        }
      }
      if (!modelSet) {
        console.error(`[harness] ${functionName}: AUCUN MODÈLE trouvé — prompt() ne fera rien`);
      }
      // Vérifier que le modèle est bien sur la session
      const sessionModel = (tempSession as any).model;
      console.log(`[harness] ${functionName}: tempSession.model = ${sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "NULL"}`);

      // Restreindre les outils — IMPORTANT : faire AVANT de setter le system prompt
      // car setActiveToolsByName() appelle _rebuildSystemPrompt() qui écrase _baseSystemPrompt.
      if (tools.length > 0) {
        (tempSession as any).setActiveToolsByName(tools);
      }

      // Appliquer le system prompt — APRÈS setActiveToolsByName pour ne pas être écrasé.
      // Le SDK reset agent.state.systemPrompt à _baseSystemPrompt avant chaque prompt(),
      // donc il faut setter _baseSystemPrompt (la source de vérité du SDK).
      (tempSession as any)._baseSystemPrompt = systemPrompt;
      (tempSession as any).agent.state.systemPrompt = systemPrompt;

      // Forward des events vers le frontend + reset du timer d'inactivité
      // FILTRER message_start/message_end de la session temp pour ne pas
      // écraser le assistantId du frontend (le harness gère ses propres message_start/end)
      let resetInactivityTimer: (() => void) | null = null;
      tempUnsub = tempSession.subscribe((event: any) => {
        // Chaque event reçu prouve que l'agent travaille → reset du timer d'inactivité
        if (resetInactivityTimer) resetInactivityTimer();
        if (event.type === "message_start" || event.type === "message_end") return;
        emitToSubscribers({ ...event, _harness: true, _harnessAgent: functionName } as any, this.projectId);
      });

      // Émettre tool_execution_start pour le suivi
      emitToSubscribers({
        type: "tool_execution_start",
        toolCallId: `harness-${label}`,
        toolName: `harness-${functionName}`,
        args: { function: functionName, role: agent.role, task: label },
      } as any, this.projectId);

      // Vérifier le system prompt juste avant prompt()
      const sp = (tempSession as any)._baseSystemPrompt || "";
      console.log(`[harness] ${functionName}: _baseSystemPrompt length=${sp.length}, preview=${sp.slice(0, 100)}`);
      console.log(`[harness] ${functionName}: agent.state.systemPrompt length=${(tempSession as any).agent.state.systemPrompt?.length || 0}`);

      // BUG-59 : timeout à activité (inactivity) + timeout global max de sécurité
      // Le timer d'inactivité se reset à chaque event reçu (text_delta, tool_execution_start, etc.).
      // Tant que l'agent travaille, il n'est pas tué. Il est tué seulement s'il n'y a
      // plus d'activité pendant agentTimeout secondes (défaut: 600s = 10min).
      // Un timeout global max (agentMaxTimeout, défault: 1800s = 30min) empêche un agent
      // de tourner indéfiniment même s'il émet des events régulièrement.
      const inactivityTimeoutMs = (this.config.agentTimeout || 600) * 1000;
      const globalMaxTimeoutMs = (this.config.agentMaxTimeout || 1800) * 1000;

      /**
       * Exécute prompt() avec timeout d'inactivité + timeout global.
       * Retourne true si succès, false si timeout (pour retry).
       */
      const runPromptWithTimeouts = async (): Promise<boolean> => {
        // Capture non-null pour les callbacks (tempSession est non-null ici)
        const session = tempSession!;
        await concurrencyManager.acquireLLMSlot(llmSlotKey, label);

        let inactivityTimer: ReturnType<typeof setTimeout>;
        let globalTimer: ReturnType<typeof setTimeout>;
        let rejectTimeout: ((err: Error) => void) | null = null;

        const resetInactivity = () => {
          clearTimeout(inactivityTimer!);
          inactivityTimer = setTimeout(() => {
            session.abort().catch(() => {});
            rejectTimeout?.(new Error(
              `[harness-${functionName}] Inactivity timeout after ${inactivityTimeoutMs / 1000}s without activity`
            ));
          }, inactivityTimeoutMs);
        };

        // Connecter le reset au subscription handler
        resetInactivityTimer = resetInactivity;

        const timeoutPromise = new Promise<void>((_, reject) => {
          rejectTimeout = reject;
          // Démarrer le timer d'inactivité
          resetInactivity();
          // Timeout global max (safety net — ne se reset jamais)
          globalTimer = setTimeout(() => {
            session.abort().catch(() => {});
            reject(new Error(
              `[harness-${functionName}] Global timeout after ${globalMaxTimeoutMs / 1000}s`
            ));
          }, globalMaxTimeoutMs);
        });

        try {
          console.log(`[harness] ${functionName}: appel prompt() (prompt length=${prompt.length}, inactivity=${inactivityTimeoutMs / 1000}s, global=${globalMaxTimeoutMs / 1000}s)...`);
          await Promise.race([session.prompt(prompt, {}), timeoutPromise]);
          console.log(`[harness] ${functionName}: prompt() résolu sans erreur`);
          return true;
        } catch (err: any) {
          const msg = err.message || "";
          const isTimeout = msg.includes("timeout") || msg.includes("Timed out") || msg.includes("Inactivity") || msg.includes("Global timeout");
          if (isTimeout) {
            console.warn(`[harness] ${functionName}: timeout — ${msg}`);
            return false; // signal pour retry
          }
          throw err; // autre erreur → propagate
        } finally {
          clearTimeout(inactivityTimer!);
          clearTimeout(globalTimer!);
          resetInactivityTimer = null; // déconnecter le callback
          concurrencyManager.releaseLLMSlot(llmSlotKey);
        }
      };

      // Exécution avec retry (1 retry sur timeout)
      const maxAttempts = 2;
      let succeeded = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const ok = await runPromptWithTimeouts();
        if (ok) {
          succeeded = true;
          break;
        }
        // Timeout — retry si possible
        if (attempt < maxAttempts) {
          this.emitText(`\n\n⏱️ **${functionName} a timeouté (attempt ${attempt}/${maxAttempts}). Retry en cours...**\n\n`);
          console.log(`[harness] ${functionName}: retry attempt ${attempt + 1}/${maxAttempts}`);
          // BUG-70 : l'abort du 1er attempt est asynchrone — attendre que la run
          // soit vraiment terminée (et tous les event listeners settle) sinon le
          // 2e prompt() jette "Agent is already processing a prompt".
          // waitForIdle() résout quand la run et les listeners ont fini.
          try { await tempSession!.waitForIdle(); } catch {}
        } else {
          this.emitText(`\n\n❌ **${functionName} a timeouté définitivement après ${maxAttempts} attempts.**\n\n`);
        }
      }
      if (!succeeded) {
        throw new Error(`[harness-${functionName}] Timed out after ${maxAttempts} attempts (inactivity=${inactivityTimeoutMs / 1000}s)`);
      }

      // Collecter la réponse
      const messages: any[] = tempSession.messages || [];
      console.log(`[harness] ${functionName}: ${messages.length} messages au total (${messages.filter(m => m.role === "assistant").length} assistant)`);
      // Debug: afficher le contenu brut des messages assistant
      for (const m of messages.filter((mm: any) => mm.role === "assistant")) {
        const contentTypes = m.content?.map((c: any) => c.type || typeof c) || [];
        const textLen = m.content?.map((c: any) => (c.text || "").length).reduce((a: number, b: number) => a + b, 0) || 0;
        console.log(`[harness] ${functionName}: assistant msg content types=[${contentTypes}] textLen=${textLen}`);
        if (textLen === 0) {
          // Logger l'objet complet pour voir stopReason, thinking, errorMessage, etc.
          const { content, ...rest } = m;
          console.log(`[harness] ${functionName}: message complet (sans content)=`, JSON.stringify(rest).slice(0, 800));
          console.log(`[harness] ${functionName}: thinking length=${m.thinking?.length || 0}`);
        }
      }
      const assistantMessages = messages
        .filter((m: any) => m.role === "assistant")
        .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "");
      const fullResponse = assistantMessages.join("\n\n");

      emitToSubscribers({
        type: "tool_execution_end",
        toolCallId: `harness-${label}`,
        toolName: `harness-${functionName}`,
        result: { content: [{ type: "text", text: `${functionName.toUpperCase()} : ${(fullResponse.length / 1024).toFixed(1)}K tokens` }] },
        isError: false,
      } as any, this.projectId);

      return fullResponse || `[${functionName} n'a produit aucune réponse]`;

    } catch (err: any) {
      console.error(`[harness] ${functionName} error:`, err.message);
      emitToSubscribers({
        type: "tool_execution_end",
        toolCallId: `harness-${label}`,
        toolName: `harness-${functionName}`,
        result: { content: [{ type: "text", text: `❌ ${functionName} a échoué : ${err.message}` }] },
        isError: true,
      } as any, this.projectId);
      return `[Error: ${functionName} failed — ${err.message}]`;
    } finally {
      concurrencyManager.releaseAgentSlot(agentSlotKey);
      if (tempUnsub) tempUnsub();
      if (tempSession) {
        try { (tempSession as any).dispose?.(); } catch {}
      }
      if (tempSessionFile) {
        try { if (existsSync(tempSessionFile)) await import("fs").then(fs => fs.unlinkSync(tempSessionFile!)); } catch {}
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────

  private isAborted(): boolean {
    const state = getSession(this.projectId);
    return state?.harnessAborted === true;
  }

  private emitText(text: string): void {
    emitToSubscribers({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: text },
    } as any, this.projectId);
  }

  /** Formate le résultat final avec ou sans synthèse LLM */
  private formatFinalResult(
    artifacts: { phase: string; task: string; agent: string; output: string }[],
    plan: ArchitecturePlan,
  ): string {
    if (!this.config.synthesize || artifacts.length <= 1) {
      // Pas de synthèse : on concatène simplement
      return artifacts.map(a =>
        `## ${a.task} (${a.agent})\n${a.output}`
      ).join("\n\n---\n\n");
    }

    // Synthèse structurée (concaténation propre, pas d'appel LLM supplémentaire)
    const lines: string[] = [];
    lines.push(`# Résultat Harness\n`);
    lines.push(`**Demande :** ${this.userPrompt.slice(0, 200)}${this.userPrompt.length > 200 ? "..." : ""}\n`);
    lines.push(`**Plan :** ${plan.decisions.summary}\n`);
    lines.push(`---\n`);

    // Grouper par phase
    const currentPhases = plan.phases.map(p => p.name);
    for (const phaseName of currentPhases) {
      const phaseArtifacts = artifacts.filter(a => a.phase === phaseName);
      if (phaseArtifacts.length === 0) continue;
      lines.push(`## 🔷 ${phaseName}\n`);
      for (const art of phaseArtifacts) {
        lines.push(`### ${art.task} (${art.agent})\n`);
        lines.push(art.output);
        lines.push(`\n`);
      }
    }

    lines.push(`---\n*Généré par Harness Engine v2 — ${artifacts.length} tâche(s) exécutée(s)*`);

    return lines.join("\n");
  }
}

// ── Registry helpers (injectés depuis session.ts) ─────

let _modelRegistry: ModelRegistry | null = null;
let _modelRuntime: ModelRuntime | null = null;

export function setModelRegistry(registry: ModelRegistry): void {
  _modelRegistry = registry;
}

export function getModelRegistry(): ModelRegistry {
  if (!_modelRegistry) throw new Error("HarnessEngine: ModelRegistry not set. Call setModelRegistry() first.");
  return _modelRegistry;
}

export function setModelRuntime(runtime: ModelRuntime): void {
  _modelRuntime = runtime;
}

export function getModelRuntime(): ModelRuntime {
  if (!_modelRuntime) throw new Error("HarnessEngine: ModelRuntime not set. Call setModelRuntime() first.");
  return _modelRuntime;
}
