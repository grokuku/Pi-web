/**
 * Harness Engine — Multi-Agent Orchestration
 *
 * Prend un prompt utilisateur + une config d'équipe, et orchestre
 * N agents séquentiellement. Chaque agent :
 * - Reçoit sa propre session Pi SDK temporaire
 * - A son propre rôle (system prompt), modèle, et outils
 * - Reçoit l'output du précédent agent comme contexte
 * - Produit un artefact (plan, code, review)
 *
 * L'orchestrator gère l'ordre d'exécution, les dépendances,
 * et synthétise le résultat final.
 */

import { createAgentSession, SessionManager, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { emitToSubscribers, getSession } from "./session.js";
import { concurrencyManager } from "./concurrency.js";
import { loadModelLibrary, getModeModel } from "./model-library.js";
import type { HarnessConfig, HarnessAgentConfig } from "./model-library.js";
import path from "path";
import os from "os";
import { existsSync, mkdirSync } from "fs";

// ── Default prompts ───────────────────────────────────

const DEFAULT_SYSTEM_PROMPTS: Record<string, string> = {
  architect: `## RÔLE : ARCHITECTE SYSTÈME

Tu es un architecte système. Analyse la demande et produit un PLAN détaillé.

Règles :
- Utilise read/grep/find pour explorer le code existant
- Ne JAMAIS écrire de code — seulement planifier
- Décompose en étapes claires avec chemins de fichiers
- Considère les edge cases, la sécurité, les performances
- Format : liste de fichiers à modifier + description des changements`,

  developer: `## RÔLE : DÉVELOPPEUR

Tu es un développeur. Implémente le plan fourni en écrivant du code.

Règles :
- Utilise read, edit, write, bash pour implémenter
- Écris du code de qualité production
- Fais des changements atomiques, un fichier à la fois
- Gère les erreurs et edge cases
- Exécute les tests si applicable`,

  reviewer: `## RÔLE : REVIEWER

Tu es un reviewer. Analyse le code/plan fourni et trouve les problèmes.

Règles :
- Vérifie la logique, la sécurité, les performances
- Vérifie les edge cases non gérés
- Signale les bugs avec fichier:ligne
- Suggère des corrections concrètes
- Ne modifie PAS le code toi-même (sauf si explicite)`,

  qa: `## RÔLE : QA TESTER

Tu es un testeur QA. Valide que le code fourni fonctionne.

Règles :
- Exécute les tests existants avec bash
- Vérifie que toutes les ACs sont couvertes
- Crée des tests manquants si nécessaire
- Signale les régressions`,
};

// ── Engine ────────────────────────────────────────────

export class HarnessEngine {
  private config: HarnessConfig;
  private projectId: string;
  private userPrompt: string;
  private availableModels: any[];

  private constructor(
    projectId: string,
    userPrompt: string,
    config: HarnessConfig,
    availableModels: any[],
  ) {
    this.projectId = projectId;
    this.userPrompt = userPrompt;
    this.config = config;
    this.availableModels = availableModels;
  }

  /**
   * Lance un cycle harness avec les agents configurés.
   * Exécution séquentielle : chaque agent reçoit l'output du précédent.
   */
  static async run(
    projectId: string,
    userPrompt: string,
    config: HarnessConfig,
  ): Promise<string> {
    const library = loadModelLibrary();

    // Collecter les modèles disponibles
    const registry = getModelRegistry();
    const availableModels = registry.getAvailable();

    const engine = new HarnessEngine(projectId, userPrompt, config, availableModels);

    // Sélectionner les agents activés
    const activeAgents = config.agents.filter(a => a.enabled);
    if (activeAgents.length === 0) {
      emitToSubscribers({
        type: "tool_execution_start",
        toolCallId: "harness-no-agents",
        toolName: "harness",
        args: {},
      } as any, projectId);
      emitToSubscribers({
        type: "tool_execution_end",
        toolCallId: "harness-no-agents",
        toolName: "harness",
        result: { content: [{ type: "text", text: "⚠ Aucun agent configuré pour le Harness. Configure des agents dans Settings → Harness." }] },
        isError: false,
      } as any, projectId);
      return "No agents configured";
    }

    // Émettre le début du cycle
    emitToSubscribers({
      type: "agent_start",
      message: { role: "assistant" },
      _harness: true,
      _phase: "orchestrating",
      _agentCount: activeAgents.length,
    } as any, projectId);

    let previousOutput = userPrompt;
    const artifacts: { role: string; output: string }[] = [];

    for (let round = 0; round < config.maxRounds; round++) {
      for (const agent of activeAgents) {
        const agentLabel = `harness-${agent.role}-r${round}`;

        emitToSubscribers({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: `\n\n**🏗 Étape : ${agent.role.toUpperCase()} (round ${round + 1}/${config.maxRounds})**\n\n`,
          },
        } as any, projectId);

        const output = await engine.runAgent(agent, previousOutput, agentLabel, round);
        artifacts.push({ role: agent.role, output });
        previousOutput = output;
      }
    }

    // Synthèse finale
    let finalOutput = previousOutput;
    if (config.synthesize && artifacts.length > 1) {
      finalOutput = await engine.synthesize(artifacts);
    }

    // Émettre la fin
    emitToSubscribers({
      type: "agent_end",
      _harness: true,
      _phase: "done",
      _artifacts: artifacts.map(a => `${a.role}: ${a.output.slice(0, 100)}...`),
    } as any, projectId);

    return finalOutput;
  }

  /**
   * Exécute un agent unique dans une session temporaire.
   */
  private async runAgent(
    agent: HarnessAgentConfig,
    context: string,
    label: string,
    round: number,
  ): Promise<string> {
    const cwd = getSession(this.projectId)?.cwd || os.homedir();
    let tempSession: AgentSession | null = null;
    let tempSessionFile: string | undefined;

    try {
      // Acquire agent slot
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

      // Appliquer le modèle spécifique à l'agent si configuré
      if (agent.modelId) {
        const model = getModelRegistry().find(
          agent.modelId.split("__")[0],
          agent.modelId.split("__")[1],
        );
        if (model) await tempSession.setModel(model);
      }

      // Système prompt du rôle (ou générique)
      const systemPrompt = agent.systemPrompt || DEFAULT_SYSTEM_PROMPTS[agent.role] || `## RÔLE : ${agent.role.toUpperCase()}\n\nAnalyse la demande et fournis ton expertise.`;

      // Restreindre les outils si spécifié
      if (agent.tools && agent.tools.length > 0) {
        (tempSession as any).setActiveToolsByName(agent.tools);
      }

      (tempSession as any).agent.state.systemPrompt = systemPrompt;

      // Prompter l'agent avec le contexte
      const prompt = round > 0
        ? `Contexte (output du précédent agent) :\n\n${context.slice(0, 30000)}\n\n---\n\nApplique ton expertise selon ton rôle. Produis le meilleur résultat possible.`
        : `${this.userPrompt}\n\n---\n\n${context.slice(0, 5000) === this.userPrompt ? "" : `\nContexte additionnel :\n${context.slice(0, 30000)}`}\n\nApplique ton expertise selon ton rôle.`;

      // Émettre tool_execution pour le suivi
      emitToSubscribers({
        type: "tool_execution_start",
        toolCallId: label,
        toolName: `harness-${agent.role}`,
        args: { role: agent.role, round },
      } as any, this.projectId);

      // Émettre un text_delta pour informer l'utilisateur
      emitToSubscribers({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: `\n\n**[${agent.role.toUpperCase()}]** Consultation en cours...\n\n`,
        },
      } as any, this.projectId);

      await tempSession.prompt(prompt, {});

      // Collecter la réponse
      const messages: any[] = tempSession.messages || [];
      const assistantMessages = messages
        .filter((m: any) => m.role === "assistant")
        .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "");
      const fullResponse = assistantMessages.join("\n\n");

      emitToSubscribers({
        type: "tool_execution_end",
        toolCallId: label,
        toolName: `harness-${agent.role}`,
        result: { content: [{ type: "text", text: `${agent.role.toUpperCase()} terminé (${(fullResponse.length / 1000).toFixed(1)}K tokens)` }] },
        isError: false,
      } as any, this.projectId);

      return fullResponse || `[${agent.role} n'a produit aucune réponse]`;
    } catch (err: any) {
      console.error(`[harness] Agent ${agent.role} error:`, err.message);
      emitToSubscribers({
        type: "tool_execution_end",
        toolCallId: label,
        toolName: `harness-${agent.role}`,
        result: { content: [{ type: "text", text: `❌ ${agent.role} a échoué : ${err.message}` }] },
        isError: true,
      } as any, this.projectId);
      return `[Error: ${agent.role} failed — ${err.message}]`;
    } finally {
      concurrencyManager.releaseAgentSlot(this.projectId);
      if (tempSession) {
        try { (tempSession as any).dispose?.(); } catch {}
      }
      if (tempSessionFile) {
        try {
          const { unlinkSync, readdirSync, rmdirSync } = await import("fs");
          if (existsSync(tempSessionFile)) unlinkSync(tempSessionFile);
          const dir = tempSessionFile.replace(/\/[^/]+\.json$/, "");
          if (existsSync(dir)) {
            try {
              const files = readdirSync(dir);
              for (const f of files) unlinkSync(path.join(dir, f));
              rmdirSync(dir);
            } catch {}
          }
        } catch {}
      }
    }
  }

  /**
   * Synthétise les artefacts de tous les agents en un résultat final.
   */
  private async synthesize(artifacts: { role: string; output: string }[]): Promise<string> {
    const lines = artifacts.map(a => `=== ${a.role.toUpperCase()} ===\n${a.output.slice(0, 5000)}`);
    const summary = lines.join("\n\n---\n\n");

    return `## Résultat Harness\n\n${artifacts.map(a => `### ${a.role.toUpperCase()}\n${a.output}`).join("\n\n")}\n\n---\n*Généré par Harness Engine avec ${artifacts.length} agents, ${this.config.maxRounds} round(s).*`;
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
