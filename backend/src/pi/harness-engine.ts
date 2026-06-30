/**
 * Harness Engine v2 — Architecture Pilotée par un Architecte
 *
 * Nouveau flow :
 * 1. L'ARCHITECTE explore le code et produit un PLAN structuré en phases/tâches
 * 2. Chaque tâche est assignée à un agent spécialisé (backend, frontend, review, etc.)
 * 3. Les phases s'exécutent séquentiellement ; les tâches dans chaque phase aussi (V1)
 * 4. Chaque agent reçoit UNIQUEMENT sa tâche + les fichiers spécifiés — context minimal
 */

import { createAgentSession, SessionManager, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { emitToSubscribers, getSession } from "./session.js";
import { concurrencyManager } from "./concurrency.js";
import { getDefaultAgent, loadModelLibrary } from "./model-library.js";
import type { HarnessConfig, HarnessAgentConfig } from "./model-library.js";
import os from "os";
import { existsSync } from "fs";

// ── Constants ──
const MAX_PHASES = 5;
const MAX_TASKS_TOTAL = 15;

// ── Types du plan ────────────────────────────────────

interface PlanTask {
  agent: string;
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
        `**Phase ${i + 1} : ${p.name}**  \n${p.tasks.map(t => `  → _${t.title}_ (${t.agent})`).join("\n")}`
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

          // Trouver l'agent par rôle
          const agentConfig = activeAgents.find(a => a.role === task.agent);
          if (!agentConfig) {
            engine.emitText(`\n\n⚠️ **Agent "${task.agent}" introuvable** dans la config. Tâche ignorée.\n\n`);
            continue;
          }

          engine.emitText(`\n### 🔸 ${task.title}\n**Agent :** ${task.agent}  \n\n`);

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
          );

          artifacts.push({
            phase: phase.name,
            task: task.title,
            agent: task.agent,
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
      ?? activeAgents[0]; // fallback : premier agent comme planner

    // Construire la liste des agents disponibles pour l'architecte
    const agentListStr = activeAgents
      .filter(a => a.role !== "architect") // l'architecte ne s'assigne pas de tâche à lui-même
      .map(a => `- **${a.role}** : ${a.description || "Agent spécialisé"}`)
      .join("\n");

    // Prompt spécial pour l'architecte
    const poolEntry = getDefaultAgent(architect.role);
    const basePrompt = architect.systemPrompt || poolEntry?.systemPrompt
      || `## RÔLE : ${architect.role.toUpperCase()}\n\nAnalyse la demande et produit un plan.`;

    const architectPrompt = basePrompt.replace("{AGENT_LIST}", agentListStr || "Aucun agent disponible.");

    // Outils pour l'architecte (read-only + exploration)
    const tools = architect.tools || poolEntry?.tools || ["read", "grep", "find", "ls"];

    // Concaténer l'historique de conversation au prompt de l'architecte
    let archUserPrompt = `\n\n## Demande utilisateur\n\n${this.userPrompt}`;
    if (this.conversationHistory) {
      // Limiter à 8000 chars pour éviter de saturer
      const history = this.conversationHistory.slice(0, 8000);
      archUserPrompt += `\n\n## Historique de la discussion\n\nVoici les messages récents de la conversation (pour contexte) :\n\n${history}\n\n---`;
    }
    archUserPrompt += `\n\n## Règles\n- Explore le codebase avant de décider\n- Produis un plan réaliste et précis\n- Maximum ${MAX_PHASES} phases et ${MAX_TASKS_TOTAL} tâches\n- Termine par un bloc JSON valide (\`\`\`json ... \`\`\`)\n- N'assigne des tâches qu'aux agents listés ci-dessus`;

    // Exécuter l'architecte
    const response = await this.runSingleAgent(
      architect,
      architectPrompt,
      tools,
      archUserPrompt,
      "architect",
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

    // Pattern 1 : ```json ... ```
    const matchJsonBlock = response.match(/```json\s*([\s\S]*?)```/);
    if (matchJsonBlock) jsonStr = matchJsonBlock[1].trim();

    // Pattern 2 : ``` ... ``` (sans lang)
    if (!jsonStr) {
      const matchAnyBlock = response.match(/```\s*([\s\S]*?)```/);
      if (matchAnyBlock) jsonStr = matchAnyBlock[1].trim();
    }

    // Pattern 3 : premier { ... } avec accolades équilibrées
    if (!jsonStr) {
      const start = response.indexOf("{");
      if (start !== -1) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < response.length; i++) {
          if (response[i] === "{") depth++;
          else if (response[i] === "}") {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
        if (end !== -1) jsonStr = response.slice(start, end);
      }
    }

    if (!jsonStr) {
      console.error("[harness] No JSON found in architect response");
      // Afficher un extrait de la réponse pour debug
      const snippet = response.replace(/\n/g, " ").slice(0, 150);
      this.emitText(`\n\n⚠️ **L'architecte n'a pas produit un plan JSON valide.**\n\nDébut de sa réponse :\n\`${snippet}...\`\n\n`);
      return null;
    }

    // Tentative de parsing
    try {
      const parsed = JSON.parse(jsonStr);
      return this.validatePlan(parsed, activeAgents);
    } catch (e: any) {
      console.error("[harness] Failed to parse architect JSON:", e.message);
      this.emitText(`\n\n⚠️ **Erreur de parsing du plan JSON :** ${e.message}\n\n`);
      return null;
    }
  }

  /** Valide la structure du plan et ajoute les defaults */
  private validatePlan(parsed: any, activeAgents: HarnessAgentConfig[]): ArchitecturePlan | null {
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.decisions?.summary) return null;
    if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) return null;

    const validRoles = new Set(activeAgents.map(a => a.role));
    // L'architecte lui-même n'est pas dans les tâches, mais le validateur
    // doit accepter les rôles des agents disponibles (sauf architecte)

    const phases: PlanPhase[] = [];
    for (const phase of parsed.phases.slice(0, MAX_PHASES)) {
      if (!phase.name || !Array.isArray(phase.tasks)) continue;
      const tasks: PlanTask[] = [];
      for (const task of phase.tasks.slice(0, MAX_TASKS_TOTAL)) {
        if (!task.agent || !task.instruction) continue;
        // Vérifier que l'agent assigné existe
        if (!validRoles.has(task.agent)) {
          console.warn(`[harness] Task assigns unknown agent "${task.agent}" — skipping`);
          continue;
        }
        tasks.push({
          agent: task.agent,
          title: task.title || task.agent,
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
  ): Promise<string> {
    const cwd = getSession(this.projectId)?.cwd || os.homedir();

    // Contexte compressé : décisions de l'architecte + fichiers à lire + instruction
    const readFilesBlock = readFiles.length > 0
      ? `\n## Fichiers de contexte à lire avant de commencer\n${readFiles.map(f => `- \`${f}\``).join("\n")}\n\nPrends le temps de les lire avec read() pour comprendre le contexte existant.`
      : "";

    const techBlock = architectDecisions.tech && Object.keys(architectDecisions.tech).length > 0
      ? `\n## Décisions techniques (définies par l'architecte)\n${Object.entries(architectDecisions.tech).map(([k, v]) => `- **${k}** : ${v}`).join("\n")}`
      : "";

    const steerBlock = ""; // déjà injecté dans taskInstruction

    const fullPrompt = [
      `## Contexte du projet\n${architectDecisions.summary}`,
      techBlock,
      `\n## Ta tâche\n${taskInstruction}`,
      readFilesBlock,
      `\n---\nExécute ta tâche en utilisant les outils à ta disposition.`,
    ].filter(Boolean).join("\n");

    const poolEntry = getDefaultAgent(agent.role);
    const systemPrompt = agent.systemPrompt || poolEntry?.systemPrompt
      || `## RÔLE : ${agent.role.toUpperCase()}\n\nExécute la tâche assignée avec ton expertise.`;
    const tools = agent.tools || poolEntry?.tools || ["read", "edit", "write", "bash", "grep", "find", "ls"];

    return this.runSingleAgent(agent, systemPrompt, tools, fullPrompt, label);
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
  ): Promise<string> {
    const cwd = getSession(this.projectId)?.cwd || os.homedir();
    let tempSession: AgentSession | null = null;
    let tempSessionFile: string | undefined;
    let tempUnsub: (() => void) | null = null;

    try {
      await concurrencyManager.acquireAgentSlot(this.projectId, label);

      const tempSessionManager = SessionManager.create(cwd);
      tempSessionFile = tempSessionManager.getSessionFile();
      const result = await createAgentSession({
        cwd,
        sessionManager: tempSessionManager,
        authStorage: getAuthStorage(),
        modelRegistry: getModelRegistry(),
      });
      tempSession = result.session;

      // Modèle : priorité au modèle spécifique de l'agent, puis au modèle du mode Harness,
      // puis à la session principale, puis aux fallbacks.
      // BUG-58: la session temporaire doit hériter d'un modèle qui fonctionne.
      let modelSet = false;
      console.log(`[harness] Agent ${agent.role}: recherche modèle (agent.modelId=${agent.modelId}, harnessModelId=${this.harnessModelId})`);
      if (agent.modelId) {
        const parts = agent.modelId.split("__");
        const model = getModelRegistry().find(parts[0], parts[1] || "");
        if (model) { await tempSession.setModel(model); modelSet = true; console.log(`[harness] Agent ${agent.role}: modèle set via agent.modelId → ${model.provider}/${model.id}`); }
        else console.warn(`[harness] Agent ${agent.role}: modelId=${agent.modelId} non trouvé dans le registry`);
      } else if (this.harnessModelId) {
        // Modèle configuré pour le mode HARNESS dans le ModelQuickSwitch
        const parts = this.harnessModelId.split("__");
        const model = getModelRegistry().find(parts[0], parts.slice(1).join("__") || "");
        if (model) { await tempSession.setModel(model); modelSet = true; console.log(`[harness] Agent ${agent.role}: modèle set via harnessModelId → ${model.provider}/${model.id}`); }
        else console.warn(`[harness] harnessModelId=${this.harnessModelId} non trouvé dans le registry`);
      } else {
        // Hériter du modèle de la session principale (qui marche)
        const mainSession = getSession(this.projectId);
        const mainModel = (mainSession?.session as any)?.model;
        if (mainModel) {
          await tempSession.setModel(mainModel); modelSet = true;
          console.log(`[harness] Agent ${agent.role}: hérite du modèle de la session principale: ${mainModel.provider}/${mainModel.id}`);
        } else {
          console.warn(`[harness] Agent ${agent.role}: pas de modèle sur la session principale, fallback...`);
          // Derniers fallbacks : defaultModelId puis premier dispo
          const lib = loadModelLibrary();
          const defaultModelId = lib.defaultModelId;
          if (defaultModelId) {
            const parts = defaultModelId.split("__");
            const model = getModelRegistry().find(parts[0], parts.slice(1).join("__") || "");
            if (model) { await tempSession.setModel(model); modelSet = true; console.log(`[harness] Agent ${agent.role}: modèle set via defaultModelId → ${model.provider}/${model.id}`); }
          }
          if (!modelSet) {
            const available = getModelRegistry().getAvailable();
            console.log(`[harness] Agent ${agent.role}: getAvailable() retourne ${available.length} modèles`);
            if (available.length > 0) {
              await tempSession.setModel(available[0]); modelSet = true; console.log(`[harness] Agent ${agent.role}: modèle set via available[0] → ${available[0].provider}/${available[0].id}`);
            }
          }
        }
      }
      if (!modelSet) {
        console.error(`[harness] Agent ${agent.role}: AUCUN MODÈLE trouvé — prompt() ne fera rien`);
      }
      // Vérifier que le modèle est bien sur la session
      const sessionModel = (tempSession as any).model;
      console.log(`[harness] Agent ${agent.role}: tempSession.model = ${sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "NULL"}`);

      // Appliquer le system prompt
      // IMPORTANT: il faut setter _baseSystemPrompt car le SDK reset
      // agent.state.systemPrompt à _baseSystemPrompt avant chaque prompt().
      // Si on set seulement agent.state.systemPrompt, ça sera écrasé.
      (tempSession as any)._baseSystemPrompt = systemPrompt;
      (tempSession as any).agent.state.systemPrompt = systemPrompt;

      // Restreindre les outils
      if (tools.length > 0) {
        (tempSession as any).setActiveToolsByName(tools);
      }

      // Forward des events vers le frontend
      // FILTRER message_start/message_end de la session temp pour ne pas
      // écraser le assistantId du frontend (le harness gère ses propres message_start/end)
      tempUnsub = tempSession.subscribe((event: any) => {
        if (event.type === "message_start" || event.type === "message_end") return;
        emitToSubscribers({ ...event, _harness: true, _harnessAgent: agent.role } as any, this.projectId);
      });

      // Émettre tool_execution_start pour le suivi
      emitToSubscribers({
        type: "tool_execution_start",
        toolCallId: `harness-${label}`,
        toolName: `harness-${agent.role}`,
        args: { role: agent.role, task: label },
      } as any, this.projectId);

      // Appel LLM avec timeout
      await concurrencyManager.acquireLLMSlot(this.projectId, label);
      let llmTimer: ReturnType<typeof setTimeout>;
      const timeoutMs = (this.config.agentTimeout || 300) * 1000;
      const llmTimeout = new Promise<void>((_, reject) => {
        llmTimer = setTimeout(() => {
          tempSession!.abort().catch(() => {});
          reject(new Error(`[harness-${agent.role}] Timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });

      try {
        console.log(`[harness] Agent ${agent.role}: appel prompt() (prompt length=${prompt.length})...`);
        await Promise.race([tempSession.prompt(prompt, {}), llmTimeout]);
        console.log(`[harness] Agent ${agent.role}: prompt() résolu sans erreur`);
      } finally {
        clearTimeout(llmTimer!);
        concurrencyManager.releaseLLMSlot(this.projectId);
      }

      // Collecter la réponse
      const messages: any[] = tempSession.messages || [];
      console.log(`[harness] Agent ${agent.role}: ${messages.length} messages au total (${messages.filter(m => m.role === "assistant").length} assistant)`);
      // Debug: afficher le contenu brut des messages assistant
      for (const m of messages.filter((mm: any) => mm.role === "assistant")) {
        const contentTypes = m.content?.map((c: any) => c.type || typeof c) || [];
        const textLen = m.content?.map((c: any) => (c.text || "").length).reduce((a: number, b: number) => a + b, 0) || 0;
        console.log(`[harness] Agent ${agent.role}: assistant msg content types=[${contentTypes}] textLen=${textLen}`);
        if (textLen === 0) {
          console.log(`[harness] Agent ${agent.role}: content brut=`, JSON.stringify(m.content?.slice(0, 500)));
        }
      }
      const assistantMessages = messages
        .filter((m: any) => m.role === "assistant")
        .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "");
      const fullResponse = assistantMessages.join("\n\n");

      emitToSubscribers({
        type: "tool_execution_end",
        toolCallId: `harness-${label}`,
        toolName: `harness-${agent.role}`,
        result: { content: [{ type: "text", text: `${agent.role.toUpperCase()} : ${(fullResponse.length / 1024).toFixed(1)}K tokens` }] },
        isError: false,
      } as any, this.projectId);

      return fullResponse || `[${agent.role} n'a produit aucune réponse]`;

    } catch (err: any) {
      console.error(`[harness] Agent ${agent.role} error:`, err.message);
      emitToSubscribers({
        type: "tool_execution_end",
        toolCallId: `harness-${label}`,
        toolName: `harness-${agent.role}`,
        result: { content: [{ type: "text", text: `❌ ${agent.role} a échoué : ${err.message}` }] },
        isError: true,
      } as any, this.projectId);
      return `[Error: ${agent.role} failed — ${err.message}]`;
    } finally {
      concurrencyManager.releaseAgentSlot(this.projectId);
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
let _authStorage: any = null;

export function setModelRegistry(registry: ModelRegistry): void {
  _modelRegistry = registry;
}

export function getModelRegistry(): ModelRegistry {
  if (!_modelRegistry) throw new Error("HarnessEngine: ModelRegistry not set. Call setModelRegistry() first.");
  return _modelRegistry;
}

export function setAuthStorage(storage: any): void {
  _authStorage = storage;
}

export function getAuthStorage(): any {
  if (!_authStorage) throw new Error("HarnessEngine: AuthStorage not set. Call setAuthStorage() first.");
  return _authStorage;
}
