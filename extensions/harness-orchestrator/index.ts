/**
 * Harness Orchestrator Extension for Pi-Web
 *
 * Remplace l'ancien HarnessEngine par une approche conversationnelle.
 * L'orchestrator (chef de projet) discute avec l'utilisateur et délègue
 * l'exécution aux experts via le tool `delegate_to_expert`.
 *
 * Le tool crée une session Pi temporaire pour l'expert, exécute la tâche,
 * et retourne le résultat à l'orchestrator.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Experts ─────────────────────────────────────────────

interface ExpertDef {
  role: string;
  emoji: string;
  label: string;
  description: string;
  systemPrompt: string;
  tools: string[];
}

const EXPERTS: ExpertDef[] = [
  {
    role: "architect",
    emoji: "🏗",
    label: "Architecte",
    description: "Explore le code, prend les décisions techniques, élabore un plan d'exécution.",
    systemPrompt: `## RÔLE : ARCHITECTE

Tu es l'architecte. Tu reçois une tâche de l'orchestrator. Tu dois :
1. Explorer le codebase existant (read, grep, find, ls, cbm_*)
2. Prendre les décisions techniques clés
3. Produire un plan d'exécution clair et structuré

## Règles
- Sois précis et concis
- Liste les fichiers à créer/modifier
- Décris l'approche technique et les dépendances
- N'écris pas de code — c'est le job des développeurs`,
    tools: ["read", "grep", "find", "ls", "cbm_search", "cbm_trace", "cbm_arch", "cbm_code", "cbm_search_code", "cbm_schema"],
  },
  {
    role: "backend-dev",
    emoji: "⚙️",
    label: "Développeur Backend",
    description: "Implémente la logique serveur : API, endpoints, middleware, services.",
    systemPrompt: `## RÔLE : DÉVELOPPEUR BACKEND

Tu implémentes la logique côté serveur.

Règles :
- Lis les fichiers concernés avant de commencer
- Écris du code de qualité production
- Suis les conventions existantes du projet
- Fais des changements atomiques, un fichier à la fois
- Gère les erreurs et edge cases
- Teste tes changements avec bash si applicable`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "frontend-dev",
    emoji: "🎨",
    label: "Développeur Frontend",
    description: "Implémente les composants UI, styles, interactions, routing.",
    systemPrompt: `## RÔLE : DÉVELOPPEUR FRONTEND

Tu implémentes l'interface utilisateur.

Règles :
- Lis les fichiers concernés avant de commencer
- Suis les patterns et composants existants
- Crée des composants responsive et accessibles
- Gère les états de loading et d'erreur
- Fais des changements atomiques`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "database-engineer",
    emoji: "🗄️",
    label: "Ingénieur Base de Données",
    description: "Conçoit les schémas, migrations, queries, optimisations.",
    systemPrompt: `## RÔLE : INGÉNIEUR BASE DE DONNÉES

Tu conçois et implémentes la couche données.

Règles :
- Lis les fichiers de schéma/migration existants
- Suis les patterns de migration existants
- Considère l'indexing et les performances
- Écris des migrations réversibles quand applicable`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "api-designer",
    emoji: "🔌",
    label: "Designer d'API",
    description: "Conçoit les contrats API, schemas de validation, documentation.",
    systemPrompt: `## RÔLE : DESIGNER D'API

Tu conçois les contrats d'API et les schemas de validation.

Règles :
- Suis les bonnes pratiques REST/RPC du projet
- Designe des interfaces claires et cohérentes
- Inclus les cas d'erreur et codes de retour
- Considère le versioning`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "code-reviewer",
    emoji: "🔍",
    label: "Reviewer de Code",
    description: "Review le code : logique, sécurité, performances, edge cases.",
    systemPrompt: `## RÔLE : REVIEWER DE CODE

Tu analyses le code pour trouver les problèmes.

Règles :
- Vérifie la logique, la sécurité, les performances
- Vérifie les edge cases non gérés
- Signale les bugs avec fichier:ligne
- Suggère des corrections concrètes
- Ne modifie PAS le code toi-même`,
    tools: ["read", "grep", "find", "ls", "bash"],
  },
  {
    role: "qa-tester",
    emoji: "🧪",
    label: "Testeur QA",
    description: "Exécute les tests, vérifie les critères d'acceptation.",
    systemPrompt: `## RÔLE : TESTEUR QA

Tu valides que l'implémentation fonctionne correctement.

Règles :
- Exécute les tests existants avec bash
- Vérifie que les critères d'acceptation sont remplis
- Crée des tests manquants si nécessaire
- Signale les régressions et failures`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "test-writer",
    emoji: "✅",
    label: "Rédacteur de Tests",
    description: "Écrit les tests unitaires, integration, e2e.",
    systemPrompt: `## RÔLE : RÉDACTEUR DE TESTS

Tu écris des tests de qualité.

Règles :
- Suis les patterns de test existants du projet
- Couvre les edge cases et chemins d'erreur
- Utilise des noms de test explicites
- Mocke proprement les dépendances externes`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "docs-writer",
    emoji: "📝",
    label: "Rédacteur de Documentation",
    description: "Rédige la documentation : README, guides, API docs.",
    systemPrompt: `## RÔLE : RÉDACTEUR DE DOCUMENTATION

Tu écris une documentation claire et concise.

Règles :
- Suis le style de documentation existant
- Inclus des exemples de code quand pertinent
- Sois concis — pas de blabla
- Documente le pourquoi, pas juste le quoi`,
    tools: ["read", "edit", "write", "grep", "find", "ls"],
  },
  {
    role: "devops",
    emoji: "🚀",
    label: "Ingénieur DevOps",
    description: "Configure CI/CD, Docker, scripts de déploiement.",
    systemPrompt: `## RÔLE : INGÉNIEUR DEVOPS

Tu configures l'infrastructure et l'automatisation.

Règles :
- Lis les fichiers de config existants
- Suis les patterns existants
- Rends tout reproductible et idempotent
- Inclus la gestion d'erreurs`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "security-reviewer",
    emoji: "🔒",
    label: "Auditeur Sécurité",
    description: "Audit de sécurité : injection, XSS, CSRF, auth, secrets.",
    systemPrompt: `## RÔLE : AUDITEUR SÉCURITÉ

Tu audit le code pour les vulnérabilités.

Règles :
- Vérifie : injection, XSS, CSRF, problèmes d'auth
- Vérifie les secrets exposés et les defaults non sécurisés
- Reporte avec sévérité (CRITICAL/HIGH/MEDIUM/LOW)
- Suggère des corrections spécifiques`,
    tools: ["read", "grep", "find", "ls", "bash"],
  },
  {
    role: "refactoring",
    emoji: "♻️",
    label: "Spécialiste Refactoring",
    description: "Refactor le code : améliore la structure, élimine la dette technique.",
    systemPrompt: `## RÔLE : SPÉCIALISTE REFACTORING

Tu améliores la structure du code sans changer son comportement.

Règles :
- Préserve le comportement existant
- Améliore le nommage, la structure, DRY
- Fais des changements petits et atomiques
- N'introduis pas de nouvelles fonctionnalités`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
];

const EXPERT_BY_ROLE = new Map(EXPERTS.map(e => [e.role, e]));

/**
 * Collecte la réponse partielle d'une session d'expert (messages assistant déjà produits).
 * Utilisée pour récupérer le travail d'un expert interrompu par un abort (BUG-67).
 */
function collectExpertResponse(tempSession: any): string {
  try {
    const messages: any[] = tempSession?.messages || [];
    return messages
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "")
      .filter((t: string) => t.length > 0)
      .join("\n\n");
  } catch {
    return "";
  }
}

// ── Tool parameter schema (plain JSON Schema) ──────────

const delegateParams = {
  type: "object" as const,
  properties: {
    role: {
      type: "string",
      description: "Rôle de l'expert à déléguer. Valeurs possibles : " +
        EXPERTS.map(e => `"${e.role}" (${e.label})`).join(", "),
    },
    task: {
      type: "string",
      description: "La tâche à exécuter par l'expert. Doit être précise et auto-contenue.",
    },
    context: {
      type: "string",
      description: "Contexte additionnel (fichiers à lire, décisions précédentes, etc.). Optionnel.",
    },
  },
  required: ["role", "task"],
};

// ── Extension ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  console.log("[harness-orchestrator] Extension loaded");

  pi.registerTool({
    name: "delegate_to_expert",
    label: "Delegate to Expert",
    description:
      "Délègue une tâche à un expert spécialisé (architecte, développeur, reviewer, etc.). " +
      "L'expert exécute la tâche dans une session isolée et retourne son résultat. " +
      "Utilise ce tool pour TOUTE tâche d'exécution : code, debug, review, tests, plan, doc. " +
      "Ne code JAMAIS toi-même — délègue toujours.",
    promptSnippet: "Déléguer une tâche à un expert spécialisé",
    promptGuidelines: [
      "Utilise delegate_to_expert pour TOUTE tâche d'exécution (code, debug, review, tests, plan, doc).",
      "Pour une tâche simple → délègue directement à l'expert approprié.",
      "Pour une tâche complexe → délègue d'abord à l'architecte pour un plan, puis aux experts.",
      "Ne code JAMAIS toi-même. Tu es un chef de projet, pas un développeur.",
      "Réponds directement aux questions simples sans déléguer.",
      "L'expert reçoit uniquement la tâche et le contexte que tu fournis — sois précis.",
    ],
    parameters: delegateParams,
    async execute(
      _toolCallId: string,
      params: { role: string; task: string; context?: string },
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ): Promise<{ content: { type: "text"; text: string }[] }> {
      // onUpdate permet de forwarder l'activité de l'expert vers le frontend
      // (tool_execution_update) — fini le silence pendant une délégation (BUG-67).
      const emitProgress = (text: string) => {
        try {
          onUpdate?.({ content: [{ type: "text", text }] });
        } catch {}
      };
      const { role, task, context } = params;
      const expert = EXPERT_BY_ROLE.get(role);

      if (!expert) {
        const validRoles = EXPERTS.map(e => e.role).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: `❌ Rôle d'expert inconnu : "${role}". Rôles valides : ${validRoles}`,
          }],
        };
      }

      console.log(`[harness-orchestrator] Délégation à ${expert.label} (${role}): ${task.slice(0, 80)}...`);

      try {
        // Créer une session temporaire pour l'expert
        const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
        const { join } = await import("path");
        const { homedir } = await import("os");
        const { existsSync, mkdirSync, unlinkSync } = await import("fs");

        const cwd = ctx.cwd || process.cwd();
        const agentDir = join(homedir(), ".pi", "agent");

        const tempSessionManager = SessionManager.create(cwd);
        const tempSessionFile = tempSessionManager.getSessionFile();

        // SDK 0.80+: modelRuntime remplace authStorage + modelRegistry.
        // Si on ne passe rien, le SDK crée un ModelRuntime par défaut (~/.pi/agent/auth.json).
        const result = await createAgentSession({
          cwd,
          sessionManager: tempSessionManager,
        });
        const tempSession = result.session;

        // Déclaré ici (try externe) car `let` dans un bloc try n'est pas visible
        // dans le finally du même try (portées de bloc séparées en JS/TS).
        let tempUnsub: (() => void) | null = null;

        try {
          // Set le modèle — hériter de la session principale
          if (ctx.model) {
            await tempSession.setModel(ctx.model);
          }

          // Restreindre les outils de l'expert
          if (expert.tools.length > 0) {
            (tempSession as any).setActiveToolsByName(expert.tools);
          }

          // Set le system prompt APRÈS setActiveToolsByName (sinon écrasé)
          // Préserver le "Current working directory:" du SDK en l'ajoutant après le prompt de l'expert
          const cwdLine = (tempSession as any)._baseSystemPrompt?.match(/Current working directory: (.+)/)?.[0] || "";
          const systemPromptWithCwd = expert.systemPrompt + (cwdLine ? `\n\n${cwdLine}` : "");
          (tempSession as any)._baseSystemPrompt = systemPromptWithCwd;
          (tempSession as any).agent.state.systemPrompt = systemPromptWithCwd;

          // Construire le prompt de l'expert
          let expertPrompt = task;
          if (context) {
            expertPrompt = `## Contexte\n\n${context}\n\n## Tâche\n\n${task}`;
          }

          // ── BUG-59 (porté de la v2 vers la v3) : timeout à activité + retry ──
          // L'ancien timeout FIXE de 300s couvrait TOUT le cycle prompt() (boucle agent
          // complète : LLM → tool calls → LLM → ...). Un expert qui lit des fichiers ou
          // lance bash itère facilement au-delà de 300s → il était tué alors qu'il
          // travaillait activement.
          // Désormais :
          //  - INACTIVITY_TIMEOUT_MS : le timer d'inactivité se reset à chaque event reçu
          //    de la session temp (text_delta, tool_execution_start, tool_execution_end,
          //    message_update, etc.). Tant que l'expert travaille, il n'est pas tué.
          //  - GLOBAL_MAX_TIMEOUT_MS : timeout global max (safety net) qui ne se reset
          //    JAMAIS, pour empêcher un expert de tourner indéfiniment.
          //  - Retry (1 retry = 2 attempts max) sur timeout d'inactivité UNIQUEMENT.
          const INACTIVITY_TIMEOUT_MS = 300_000;   // 5 min sans activité → timeout
          const GLOBAL_MAX_TIMEOUT_MS = 1_800_000; // 30 min au total (safety net)
          const MAX_ATTEMPTS = 2;                  // 1 retry sur timeout d'inactivité

          // Callback de reset du timer d'inactivité — connecté au subscribe ci-dessous
          let resetInactivityFn: (() => void) | null = null;
          // Subscription aux events de la session temp : chaque event prouve que l'expert
          // travaille → reset du timer. Les events sont AUSSI forwardés vers le frontend
          // via onUpdate (tool_execution_update) pour montrer l'activité en temps réel
          // (BUG-67 : plus de silence pendant une délégation).
          tempUnsub = tempSession.subscribe((event: any) => {
            if (resetInactivityFn) resetInactivityFn();
            // Forward l'activité vers le frontend (tool_execution_update)
            try {
              if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
                emitProgress(event.assistantMessageEvent.delta || "");
              } else if (event?.type === "tool_execution_start") {
                emitProgress(`\n⚙️ ${event.toolName || "outil"} → ${JSON.stringify(event.args || {}).slice(0, 120)}`);
              } else if (event?.type === "tool_execution_end") {
                emitProgress(`\n✅ ${event.toolName || "outil"} terminé`);
              }
            } catch {}
          });

          /**
           * Exécute prompt() avec timeout d'inactivité + timeout global + abort signal.
           * Retourne true si succès, false si timeout d'inactivité (pour retry).
           * Throw sur abort signal ou erreurs modèle (pas de retry).
           */
          const runPromptWithTimeouts = async (): Promise<boolean> => {
            // Si le signal est déjà aborté avant le lancement, ne pas relancer un prompt
            if (signal?.aborted) {
              throw new Error("Délégation interrompue par l'utilisateur (abort de l'orchestrator)");
            }

            let inactivityTimer: ReturnType<typeof setTimeout>;
            let globalTimer: ReturnType<typeof setTimeout>;
            let rejectTimeout: ((err: Error) => void) | null = null;
            let abortHandler: (() => void) | null = null;

            const resetInactivity = () => {
              clearTimeout(inactivityTimer!);
              inactivityTimer = setTimeout(() => {
                (tempSession as any).abort?.().catch(() => {});
                rejectTimeout?.(new Error(
                  `Expert ${role} inactif depuis ${INACTIVITY_TIMEOUT_MS / 1000}s — timeout d'inactivité`
                ));
              }, INACTIVITY_TIMEOUT_MS);
            };

            // Connecter le reset au subscription handler de la session temp
            resetInactivityFn = resetInactivity;

            const timeoutPromise = new Promise<void>((_, reject) => {
              rejectTimeout = reject;
              resetInactivity();
              // Timeout global max (safety net — ne se reset jamais)
              globalTimer = setTimeout(() => {
                (tempSession as any).abort?.().catch(() => {});
                reject(new Error(
                  `Expert ${role} a dépassé le timeout global de ${GLOBAL_MAX_TIMEOUT_MS / 1000}s`
                ));
              }, GLOBAL_MAX_TIMEOUT_MS);
            });

            // Abort signal de l'orchestrator → abort l'expert aussi (message clair)
            const abortPromise = signal
              ? new Promise<void>((_, reject) => {
                  abortHandler = () => {
                    (tempSession as any).abort?.().catch(() => {});
                    reject(new Error("Délégation interrompue par l'utilisateur (abort de l'orchestrator)"));
                  };
                  signal.addEventListener("abort", abortHandler);
                })
              : new Promise<void>(() => {}); // jamais résout si pas de signal

            try {
              await Promise.race([
                tempSession.prompt(expertPrompt, {}),
                timeoutPromise,
                abortPromise,
              ]);
              return true;
            } catch (err: any) {
              const msg = err.message || "";
              // BUG-67 : si l'orchestrator a été aborté pendant que l'expert travaillait,
              // on tente de récupérer ce que l'expert a déjà produit avant de rendre la main.
              // Le travail est souvent terminé (fichiers modifiés) — seule la réponse finale manque.
              if (msg.includes("abort de l'orchestrator")) {
                const partial = collectExpertResponse(tempSession);
                if (partial) {
                  console.log(`[harness-orchestrator] Expert ${role} interrompu mais ${partial.length} chars récupérés`);
                  throw new Error(`Délégation interrompue par l'utilisateur (abort de l'orchestrator). Travail récupéré (${partial.length} chars) :\n\n${partial.slice(0, 2000)}`);
                }
              }
              // Retry UNIQUEMENT sur timeout d'inactivité.
              // Pas de retry sur abort signal ni sur les erreurs modèle.
              if (msg.includes("inactivité") || msg.includes("inactivity") || msg.includes("Inactivity")) {
                console.warn(`[harness-orchestrator] Expert ${role}: timeout d'inactivité — ${msg}`);
                return false; // signal pour retry
              }
              throw err; // autre erreur → propagate
            } finally {
              clearTimeout(inactivityTimer!);
              clearTimeout(globalTimer!);
              if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
              resetInactivityFn = null; // déconnecter le callback
            }
          };

          // Exécution avec retry (1 retry sur timeout d'inactivité uniquement)
          let succeeded = false;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const ok = await runPromptWithTimeouts();
            if (ok) {
              succeeded = true;
              break;
            }
            // Timeout d'inactivité — retry si possible
            if (attempt < MAX_ATTEMPTS) {
              console.log(`[harness-orchestrator] Expert ${role} a timeouté (attempt ${attempt}/${MAX_ATTEMPTS}). Retry en cours...`);
            } else {
              console.error(`[harness-orchestrator] Expert ${role} a timeouté définitivement après ${MAX_ATTEMPTS} attempts.`);
            }
          }
          if (!succeeded) {
            throw new Error(`Expert ${role} a timeouté après ${MAX_ATTEMPTS} attempts (inactivité > ${INACTIVITY_TIMEOUT_MS / 1000}s)`);
          }

          // Collecter la réponse
          const messages: any[] = (tempSession as any).messages || [];
          const assistantTexts = messages
            .filter((m: any) => m.role === "assistant")
            .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "")
            .filter((t: string) => t.length > 0);
          const fullResponse = assistantTexts.join("\n\n");

          console.log(`[harness-orchestrator] ${expert.label} terminé: ${fullResponse.length} chars`);

          return {
            content: [{
              type: "text" as const,
              text: fullResponse || `${expert.label} n'a produit aucune réponse.`,
            }],
          };
        } finally {
          // Cleanup session
          if (tempUnsub) tempUnsub();
          try { (tempSession as any).dispose?.(); } catch {}
          try {
            if (existsSync(tempSessionFile)) unlinkSync(tempSessionFile);
          } catch {}
        }
      } catch (err: any) {
        console.error(`[harness-orchestrator] Erreur ${role}:`, err.message);
        return {
          content: [{
            type: "text" as const,
            text: `❌ ${expert.label} a échoué : ${err.message}`,
          }],
        };
      }
    },
  });
}