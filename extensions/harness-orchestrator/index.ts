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

const FUNCTIONS: FunctionDef[] = [
  {
    name: "planning",
    emoji: "🗺️",
    label: "Planification",
    description: "Explore le code, prend les décisions techniques, élabore un plan d'exécution.",
    systemPrompt: `## RÔLE : PLANIFICATION

Tu es la fonction de planification. Tu reçois une tâche de l'orchestrator. Tu dois :
1. Explorer le codebase existant (read, grep, find, ls, cbm_*)
2. Prendre les décisions techniques clés
3. Produire un plan d'exécution clair et structuré

## Règles
- Sois précis et concis
- Liste les fichiers à créer/modifier
- Décris l'approche technique et les dépendances
- N'écris pas de code — c'est le job de la fonction execute`,
    tools: ["read", "grep", "find", "ls", "cbm_search", "cbm_trace", "cbm_arch", "cbm_code", "cbm_search_code", "cbm_schema"],
  },
  {
    name: "execute",
    emoji: "⚙️",
    label: "Exécution",
    description: "Implémente les changements : code, tests, documentation, scripts.",
    systemPrompt: `## RÔLE : EXÉCUTION

Tu implémentes les changements demandés.

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
    name: "review",
    emoji: "🔍",
    label: "Relecture",
    description: "Relit et audite le code : logique, sécurité, performances, edge cases.",
    systemPrompt: `## RÔLE : RELECTURE

Tu analyses le code pour trouver les problèmes.

Règles :
- Vérifie la logique, la sécurité, les performances
- Vérifie les edge cases non gérés
- Signale les bugs avec fichier:ligne
- Suggère des corrections concrètes
- Ne modifie PAS le code toi-même`,
    tools: ["read", "grep", "find", "ls"],
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
- Ne modifie PAS le code toi-même — c'est une synthèse`,
    tools: ["read", "grep", "find", "ls"],
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
 * Collecte la réponse partielle d'une session d'expert (messages assistant déjà produits).
 * Utilisée pour récupérer le travail d'un expert interrompu par un abort (BUG-67)
 * ou par un timeout (inactivité / global) — le travail partiel n'est pas perdu.
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

// ── Helpers de routage (appel API HTTP locale) ─────────

const PI_WEB_URL = process.env.PI_WEB_URL || "http://localhost:3000";

/**
 * Résout l'identifiant projet Pi-Web à partir du cwd courant.
 * Le routeur attend un projectId (UUID) ; on le retrouve via /api/projects.
 * En cas d'échec (backend hors-ligne), on retombe sur le nom du dossier.
 */
async function resolveProjectId(cwd: string): Promise<string> {
  const fallback = cwd.split("/").pop() || "";
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
): Promise<{ function?: string; modelId?: string } | null> {
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
    return {
      function: data?.route?.function,
      modelId: data?.modelId ?? data?.route?.modelId ?? undefined,
    };
  } catch (e: any) {
    console.warn(`[harness-orchestrator] Route /api/routing/decision indisponible : ${e?.message || e}`);
    return null;
  }
}

/**
 * Résout un modelId "providerId__modelId" (format bibliothèque Pi-Web) vers
 * un modèle du registry exposé par le SDK de l'extension.
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

  const model = ctx.modelRegistry?.find?.(providerId, modelPart);
  return model ?? null;
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

      if (!task.trim()) {
        return {
          content: [{
            type: "text" as const,
            text: "❌ Tâche manquante. Fournissez une tâche précise à déléguer.",
          }],
          details: undefined,
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
            details: undefined,
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
          details: undefined,
        };
      }

      const requestedFunc = FUNCTION_BY_NAME.get(functionName)!;
      console.log(`[harness-orchestrator] Délégation à ${requestedFunc.label} (${functionName}): ${task.slice(0, 80)}...`);

      try {
        // Créer une session temporaire pour la fonction
        const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
        const { existsSync, unlinkSync } = await import("fs");

        const cwd = ctx.cwd || process.cwd();

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

        // Modèle conseillé par le routeur (sinon fallback ctx.model plus bas).
        const routingModel = await resolveRoutingModel(ctx, routing?.modelId);

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
          // Set le modèle — priorité au modèle conseillé par le routeur,
          // puis héritage de la session principale.
          if (routingModel) {
            await tempSession.setModel(routingModel);
          } else if (ctx.model) {
            await tempSession.setModel(ctx.model);
          }

          // Restreindre les outils de la fonction
          if (effectiveFunc.tools.length > 0) {
            (tempSession as any).setActiveToolsByName(effectiveFunc.tools);
          }

          // Set le system prompt APRÈS setActiveToolsByName (sinon écrasé)
          // Préserver le "Current working directory:" du SDK en l'ajoutant après le prompt de la fonction
          const cwdLine = (tempSession as any)._baseSystemPrompt?.match(/Current working directory: (.+)/)?.[0] || "";
          const systemPromptWithCwd = effectiveFunc.systemPrompt + (cwdLine ? `\n\n${cwdLine}` : "");
          (tempSession as any)._baseSystemPrompt = systemPromptWithCwd;
          (tempSession as any).agent.state.systemPrompt = systemPromptWithCwd;

          // Construire le prompt de la fonction
          let functionPrompt = task;
          if (context) {
            functionPrompt = `## Contexte\n\n${context}\n\n## Tâche\n\n${task}`;
          }

          // ── BUG-59 (porté de la v2 vers la v3) : timeout à activité + retry ──
          // L'ancien timeout FIXE de 300s couvrait TOUT le cycle prompt() (boucle agent
          // complète : LLM → tool calls → LLM → ...). Une fonction qui lit des fichiers ou
          // lance bash itère facilement au-delà de 300s → elle était tuée alors qu'elle
          // travaillait activement.
          // Désormais :
          //  - INACTIVITY_TIMEOUT_MS : le timer d'inactivité se reset à chaque event reçu
          //    de la session temp (text_delta, tool_execution_start, tool_execution_end,
          //    message_update, etc.). Tant que la fonction travaille, elle n'est pas tuée.
          //  - GLOBAL_MAX_TIMEOUT_MS : timeout global max (safety net) qui ne se reset
          //    JAMAIS, pour empêcher une fonction de tourner indéfiniment.
          //  - Retry (1 retry = 2 attempts max) sur timeout d'inactivité UNIQUEMENT.
          const INACTIVITY_TIMEOUT_MS = 300_000;   // 5 min sans activité → timeout
          const GLOBAL_MAX_TIMEOUT_MS = 1_800_000; // 30 min au total (safety net)
          const MAX_ATTEMPTS = 2;                  // 1 retry sur timeout d'inactivité

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

          // Callback de reset du timer d'inactivité — connecté au subscribe ci-dessous
          let resetInactivityFn: (() => void) | null = null;
          // Subscription aux events de la session temp : chaque event prouve que la
          // fonction travaille → reset du timer. Les events sont AUSSI forwardés vers le
          // frontend via onUpdate (tool_execution_update) pour montrer l'activité en temps
          // réel (BUG-67 : plus de silence pendant une délégation).
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
                  `Fonction ${effectiveFunction} inactive depuis ${INACTIVITY_TIMEOUT_MS / 1000}s — timeout d'inactivité`
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
                  `Fonction ${effectiveFunction} a dépassé le timeout global de ${GLOBAL_MAX_TIMEOUT_MS / 1000}s`
                ));
              }, GLOBAL_MAX_TIMEOUT_MS);
            });

            // Abort signal de l'orchestrator → abort la fonction aussi (message clair)
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
              if (msg.includes("abort de l'orchestrator")) {
                const partial = collectExpertResponse(tempSession);
                if (partial) {
                  console.log(`[harness-orchestrator] Fonction ${effectiveFunction} interrompue mais ${partial.length} chars récupérés`);
                  throw new Error(`Délégation interrompue par l'utilisateur (abort de l'orchestrator). Travail récupéré (${partial.length} chars) :\n\n${partial.slice(0, 2000)}`);
                }
              }
              // Timeout global : l'abort de la session temp est déjà déclenché —
              // on attend qu'il se termine (le dernier message assistant partiel
              // atterrit dans l'historique) puis on le collecte avant de rejeter
              // (pas de retry sur le timeout global).
              if (msg.includes("timeout global")) {
                try { await tempSession.waitForIdle(); } catch {}
                const partial = collectExpertResponse(tempSession);
                console.warn(`[harness-orchestrator] Fonction ${effectiveFunction}: timeout global — ${partial.length} chars récupérés`);
                throw timeoutError("timeout global", partial);
              }
              // Retry UNIQUEMENT sur timeout d'inactivité.
              // Pas de retry sur abort signal ni sur les erreurs modèle.
              if (msg.includes("inactivité") || msg.includes("inactivity") || msg.includes("Inactivity")) {
                console.warn(`[harness-orchestrator] Fonction ${effectiveFunction}: timeout d'inactivité — ${msg}`);
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
              console.log(`[harness-orchestrator] Fonction ${effectiveFunction} a timeouté (attempt ${attempt}/${MAX_ATTEMPTS}). Retry en cours...`);
              // BUG-70 : l'abort du 1er attempt est asynchrone — attendre que la run
              // soit vraiment terminée (et tous les event listeners settle) sinon le
              // 2e prompt() jette "Agent is already processing a prompt".
              // waitForIdle() résout quand la run et les listeners ont fini.
              try { await tempSession.waitForIdle(); } catch {}
            } else {
              console.error(`[harness-orchestrator] Fonction ${effectiveFunction} a timeouté définitivement après ${MAX_ATTEMPTS} attempts.`);
            }
          }
          if (!succeeded) {
            // Récupération partielle au timeout : attendre que l'abort de la
            // session temp soit terminé (le dernier message assistant partiel
            // atterrit dans l'historique) puis le collecter pour l'orchestrator.
            try { await tempSession.waitForIdle(); } catch {}
            const partial = collectExpertResponse(tempSession);
            console.warn(`[harness-orchestrator] Fonction ${effectiveFunction} a timeouté définitivement — ${partial.length} chars récupérés`);
            throw timeoutError("timeout d'inactivité", partial);
          }

          // Collecter la réponse
          const messages: any[] = (tempSession as any).messages || [];
          const assistantTexts = messages
            .filter((m: any) => m.role === "assistant")
            .map((m: any) => m.content?.map((c: any) => c.text || "").join("") || "")
            .filter((t: string) => t.length > 0);
          const fullResponse = assistantTexts.join("\n\n");

          console.log(`[harness-orchestrator] ${effectiveFunc.label} terminé: ${fullResponse.length} chars`);

          return {
            content: [{
              type: "text" as const,
              text: fullResponse || `${effectiveFunc.label} n'a produit aucune réponse.`,
            }],
            details: undefined,
          };
        } finally {
          // Cleanup session
          if (tempUnsub) tempUnsub();
          try { (tempSession as any).dispose?.(); } catch {}
          try {
            if (typeof tempSessionFile === "string" && existsSync(tempSessionFile)) unlinkSync(tempSessionFile);
          } catch {}
        }
      } catch (err: any) {
        console.error(`[harness-orchestrator] Erreur ${functionName}:`, err.message);
        // Les erreurs de timeout sont déjà pré-formatées avec l'extrait du travail
        // partiel récupéré (préfixe "❌") → renvoyées telles quelles à l'orchestrator.
        if (typeof err?.message === "string" && err.message.startsWith("❌")) {
          return {
            content: [{
              type: "text" as const,
              text: err.message,
            }],
            details: undefined,
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: `❌ ${requestedFunc.label} a échoué : ${err.message}`,
          }],
          details: undefined,
        };
      }
    },
  });
}
