import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { inferReasoning, inferVision, inferContextWindow } from "./providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", ".data");
const LIBRARY_FILE = path.join(DATA_DIR, "model-library.json");

// Re-export for convenience
export { inferReasoning } from "./providers.js";
export type { ProviderType, ProviderConfig } from "./providers.js";

// ── Types ────────────────────────────────────────────

export interface RegisteredModel {
  id: string;                  // unique internal ID
  providerId: string;          // references ProviderConfig.id
  modelId: string;             // the model's id on the provider
  name: string;                // display name
  isDefault: boolean;          // default model for modes without a specific model

  // Model capabilities (auto-detected from provider, not user-editable)
  reasoning: boolean;
  vision: boolean;             // supports image input
  contextWindow: number;       // tokens
  maxTokens: number;           // max output tokens

  // Thinking
  thinkingLevel: string;       // off, minimal, low, medium, high
}

export type AgentMode = "code" | "review" | "plan" | "yolo" | "harness";

export interface ModeConfig {
  modelId: string | null;     // RegisteredModel.id to use for this mode (null = default)
}

export interface ProjectModeConfig {
  code: ModeConfig;
  plan: ModeConfig & { enabled: boolean };
  review: ModeConfig & { enabled: boolean; maxReviews: number };
  yolo: ModeConfig & { enabled: boolean; config: {
    model1: { providerId: string; modelId: string } | null;
    model2: { providerId: string; modelId: string } | null;
    planCycles: number;
    codeCycles: number;
    globalCycles: number;
  } };
  harness: ModeConfig & { enabled: boolean; config: HarnessConfig };
}

export interface HarnessAgentConfig {
  role: string;
  description: string;        // what this agent specializes in
  modelId: string | null;
  enabled: boolean;
  systemPrompt?: string;       // override default system prompt
  tools?: string[];            // override default tools
}

export interface HarnessConfig {
  agents: HarnessAgentConfig[];
  synthesize: boolean;         // whether to synthesize final output
  agentTimeout?: number;       // per-agent timeout in seconds (default: 300 = 5min)
  maxTasks?: number;           // safety limit on total tasks (default: 20)
}

// ── Default Agent Pool ───────────────────────────────
// Large pool of pre-configured agents. The architect picks which ones
// to use based on the user's request. Users can toggle agents on/off
// and override system prompts/models.

export const DEFAULT_AGENT_POOL: Omit<HarnessAgentConfig, 'modelId' | 'enabled'>[] = [
  {
    role: "architect",
    description: "Analyse la demande, explore le code, prend les décisions techniques et élabore un plan structuré en phases et tâches. Coordonne le travail des autres agents.",
    systemPrompt: `## RÔLE : ARCHITECTE

Tu es l'architecte d'un système multi-agent. Tu reçois une demande utilisateur et tu dois :
1. Explorer le codebase existant (read, grep, find, ls, cbm_*)
2. Prendre les décisions techniques clés (langage, framework, approche)
3. Produire un plan d'exécution structuré en phases et tâches

## Agents disponibles
Voici les agents que tu peux assigner aux tâches. Tu ne peux utiliser QUE ces rôles.
{AGENT_LIST}

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
          "agent": "role-exact-de-l-agent",
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
- N'assigne des tâches QU'aux agents listés ci-dessus (utilise le rôle exact)
- Chaque instruction doit être COMPLÈTE et AUTO-CONTENUE — l'agent ne voit rien d'autre
- Spécifie les fichiers que chaque agent doit lire pour avoir le contexte nécessaire
- Maximum 5 phases et 15 tâches au total
- Ne t'assigne pas de tâche à toi-même (l'architecte)
- Les phases s'exécutent séquentiellement ; dans chaque phase, les tâches s'exécutent une par une
- Si une tâche dépend d'une phase précédente, mentionne-le dans l'instruction ("les fichiers X et Y ont été créés à la phase précédente")`,
    tools: ["read", "grep", "find", "ls", "cbm_search", "cbm_trace", "cbm_arch", "cbm_code", "cbm_search_code", "cbm_search", "cbm_schema"],
  },
  {
    role: "backend-dev",
    description: "Implémente la logique serveur : API, endpoints, middleware, services, business logic.",
    systemPrompt: `## RÔLE : DÉVELOPPEUR BACKEND

Tu implémentes la logique côté serveur. Tu reçois une tâche spécifique avec des fichiers à lire.

Règles :
- Lis TOUS les fichiers spécifiés dans ta tâche avant de commencer
- Écris du code de qualité production
- Suis les conventions existantes du projet
- Fais des changements atomiques, un fichier à la fois
- Gère les erreurs et edge cases
- Teste tes changements avec bash si applicable`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "frontend-dev",
    description: "Implémente les composants UI, styles, interactions, routing frontend.",
    systemPrompt: `## RÔLE : DÉVELOPPEUR FRONTEND

Tu implémentes l'interface utilisateur. Tu reçois une tâche spécifique avec des fichiers à lire.

Règles :
- Lis TOUS les fichiers spécifiés dans ta tâche avant de commencer
- Suis les patterns et composants existants du projet
- Crée des composants responsive et accessibles
- Gère les états de loading et d'erreur
- Fais des changements atomiques`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "database-engineer",
    description: "Conçoit les schémas, migrations, queries, optimisations de base de données.",
    systemPrompt: `## RÔLE : INGÉNIEUR BASE DE DONNÉES

Tu conçois et implémentes la couche données. Tu reçois une tâche spécifique.

Règles :
- Lis les fichiers de schéma/migration existants
- Suis les patterns de migration existants
- Considère l'indexing et les performances
- Écris des migrations réversibles quand applicable
- Documente les choix de schéma`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "api-designer",
    description: "Conçoit les contrats API, schemas de validation, documentation OpenAPI.",
    systemPrompt: `## RÔLE : DESIGNER D'API

Tu conçois les contrats d'API et les schemas de validation. Tu reçois une tâche spécifique.

Règles :
- Suis les bonnes pratiques REST/RPC du projet
- Designe des interfaces claires et cohérentes
- Inclus les cas d'erreur et codes de retour
- Considère le versioning`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "code-reviewer",
    description: "Review le code produit : logique, sécurité, performances, edge cases, qualité.",
    systemPrompt: `## RÔLE : REVIEWER DE CODE

Tu analyses le code pour trouver les problèmes. Tu reçois une tâche de review spécifique.

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
    description: "Exécute les tests, vérifie les critères d'acceptation, crée des tests manquants.",
    systemPrompt: `## RÔLE : TESTEUR QA

Tu valides que l'implémentation fonctionne correctement. Tu reçois une tâche de validation spécifique.

Règles :
- Exécute les tests existants avec bash
- Vérifie que les critères d'acceptation sont remplis
- Crée des tests manquants si nécessaire
- Signale les régressions et failures`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "test-writer",
    description: "Écrit les tests unitaires, integration, e2e avec un coverage complet.",
    systemPrompt: `## RÔLE : RÉDACTEUR DE TESTS

Tu écris des tests de qualité. Tu reçois une tâche de test spécifique.

Règles :
- Suis les patterns de test existants du projet
- Couvre les edge cases et chemins d'erreur
- Utilise des noms de test explicites
- Mocke proprement les dépendances externes`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "docs-writer",
    description: "Rédige la documentation : README, guides, commentaires de code, API docs.",
    systemPrompt: `## RÔLE : RÉDACTEUR DE DOCUMENTATION

Tu écris une documentation claire et concise. Tu reçois une tâche de documentation spécifique.

Règles :
- Suis le style de documentation existant du projet
- Inclus des exemples de code quand pertinent
- Sois concis — pas de blabla
- Documente le pourquoi, pas juste le quoi`,
    tools: ["read", "edit", "write", "grep", "find", "ls"],
  },
  {
    role: "devops",
    description: "Configure CI/CD, Docker, scripts de déploiement, automatisation.",
    systemPrompt: `## RÔLE : INGÉNIEUR DEVOPS

Tu configures l'infrastructure et l'automatisation. Tu reçois une tâche DevOps spécifique.

Règles :
- Lis les fichiers de config existants
- Suis les patterns existants
- Rends tout reproductible et idempotent
- Inclus la gestion d'erreurs`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
  {
    role: "security-reviewer",
    description: "Audit de sécurité : injection, XSS, CSRF, auth, permissions, secrets exposés.",
    systemPrompt: `## RÔLE : AUDITEUR SÉCURITÉ

Tu audit le code pour les vulnérabilités. Tu reçois une tâche d'audit spécifique.

Règles :
- Vérifie : injection, XSS, CSRF, problèmes d'auth
- Vérifie les secrets exposés et les defaults non sécurisés
- Reporte avec sévérité (CRITICAL/HIGH/MEDIUM/LOW)
- Suggère des corrections spécifiques`,
    tools: ["read", "grep", "find", "ls", "bash"],
  },
  {
    role: "refactoring",
    description: "Refactor le code existant : améliore la structure, élimine la dette technique, sans changer le comportement.",
    systemPrompt: `## RÔLE : SPÉCIALISTE REFACTORING

Tu améliores la structure du code sans changer son comportement. Tu reçois une tâche de refactoring spécifique.

Règles :
- Préserve le comportement existant
- Améliore le nommage, la structure, DRY
- Fais des changements petits et atomiques
- N'introduis pas de nouvelles fonctionnalités`,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  },
];

/** Get default harness agents (all enabled, no model override) */
export function getDefaultHarnessAgents(): HarnessAgentConfig[] {
  return DEFAULT_AGENT_POOL.map(a => ({
    ...a,
    modelId: null,
    enabled: true,
  }));
}

/** Get the default agent pool entry for a role (for system prompts + tools fallback) */
export function getDefaultAgent(role: string): Omit<HarnessAgentConfig, 'modelId' | 'enabled'> | undefined {
  return DEFAULT_AGENT_POOL.find(a => a.role === role);
}

export interface ModelLibrary {
  models: RegisteredModel[];
  defaultModelId: string | null;
  commitModelId: string | null;           // model for AI commit messages (null = use default)
  visionModelId: string | null;           // model for image/file analysis (null = use default or fallback)
  audioModelId: string | null;            // model for audio transcription (null = not configured)
  projectModes: Record<string, ProjectModeConfig>;  // projectId → mode config
  concurrency: {                          // Concurrency Manager config
    maxLLMSlots: number;
    maxAgentSlots: number;
  };
}

// ── Defaults ─────────────────────────────────────────

const DEFAULT_THINKING: Record<string, string> = { code: "medium", plan: "high", review: "medium" };

function createDefaultProjectMode(): ProjectModeConfig {
  return {
    code: { modelId: null },
    plan: { modelId: null, enabled: false },
    review: { modelId: null, enabled: false, maxReviews: 1 },
    yolo: { modelId: null, enabled: false, config: { model1: null, model2: null, planCycles: 2, codeCycles: 2, globalCycles: 1 } },
    harness: { modelId: null, enabled: false,
      config: { agents: [], synthesize: true, agentTimeout: 300, maxTasks: 20 } },
  };
}

function getDefaultLibrary(): ModelLibrary {
  return {
    models: [],
    defaultModelId: null,
    commitModelId: null,
    visionModelId: null,
    audioModelId: null,
    projectModes: {},
    concurrency: { maxLLMSlots: 3, maxAgentSlots: 5 },
  };
}

// ── Persistence ──────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadModelLibrary(): ModelLibrary {
  try {
    ensureDataDir();
    if (existsSync(LIBRARY_FILE)) {
      const data = JSON.parse(readFileSync(LIBRARY_FILE, "utf-8"));
      return migrateLibrary(data);
    }
  } catch (e) {
    console.error("[model-library] Failed to load:", e);
  }
  return getDefaultLibrary();
}

export function saveModelLibrary(library: ModelLibrary): void {
  ensureDataDir();
  writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2));
}

// ── Concurrency config ─────────────────────────────

export function getConcurrencyConfig() {
  const lib = loadModelLibrary();
  return lib.concurrency || { maxLLMSlots: 3, maxAgentSlots: 5 };
}

export async function setConcurrencyConfig(config: { maxLLMSlots?: number; maxAgentSlots?: number }) {
  const lib = loadModelLibrary();
  if (!lib.concurrency) lib.concurrency = { maxLLMSlots: 3, maxAgentSlots: 5 };
  if (config.maxLLMSlots !== undefined && config.maxLLMSlots > 0) lib.concurrency.maxLLMSlots = config.maxLLMSlots;
  if (config.maxAgentSlots !== undefined && config.maxAgentSlots > 0) lib.concurrency.maxAgentSlots = config.maxAgentSlots;
  saveModelLibrary(lib);
  // Sync with the runtime manager
  const { concurrencyManager } = await import("./concurrency.js");
  concurrencyManager.setConfig(lib.concurrency);
  return lib.concurrency;
}

// ── Migration ─────────────────────────────────────────

function migrateLibrary(data: any): ModelLibrary {
  // If it's the old format (has "modes" key), migrate
  if (data.modes && !data.models) {
    return migrateFromOldFormat(data);
  }

  const lib: ModelLibrary = {
    models: (data.models || []).map(migrateModel),
    defaultModelId: data.defaultModelId || null,
    commitModelId: data.commitModelId || null,
    visionModelId: data.visionModelId || null,
    audioModelId: data.audioModelId || null,
    projectModes: {},
    concurrency: data.concurrency || { maxLLMSlots: 3, maxAgentSlots: 5 },
  };

  // Migrate project modes
  if (data.projectModes) {
    for (const [projectId, pm] of Object.entries(data.projectModes)) {
      lib.projectModes[projectId] = migrateProjectMode(pm as any);
    }
  }

  return lib;
}

function migrateFromOldFormat(data: any): ModelLibrary {
  const lib: ModelLibrary = { models: [], defaultModelId: null, commitModelId: null, visionModelId: null, audioModelId: null, projectModes: {}, concurrency: { maxLLMSlots: 3, maxAgentSlots: 5 } };

  // Collect all unique models from all modes
  const seenIds = new Set<string>();
  for (const modeConfig of Object.values(data.modes || {})) {
    const mc = modeConfig as any;
    for (const entry of (mc?.models || [])) {
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        lib.models.push(migrateModel({
          ...entry,
          // Old format stored provider as a string, need to figure out providerId
          providerId: entry.provider || "ollama",
        }));
      }
    }
  }

  // Set first model as default
  if (lib.models.length > 0) {
    lib.defaultModelId = lib.models[0].id;
  }

  return lib;
}

function migrateModel(m: any): RegisteredModel {
  return {
    id: m.id || makeModelId(m.providerId || m.provider || "unknown", m.modelId || ""),
    providerId: m.providerId || m.provider || "unknown",
    modelId: m.modelId || m.name || "",
    name: m.name || m.modelId || "",
    isDefault: m.isDefault || false,
    reasoning: m.reasoning ?? inferReasoning(m.modelId || m.name || "", m.family),
    vision: m.vision ?? inferVision(m.modelId || m.name || "", m.family),
    contextWindow: m.contextWindow || inferContextWindow(m.modelId || m.name || "", m.family),
    maxTokens: m.maxTokens || 16384,
    thinkingLevel: m.thinkingLevel || "medium",
  };
}

function migrateProjectMode(pm: any): ProjectModeConfig {
  const d = createDefaultProjectMode();
  return {
    code: { modelId: pm?.code?.modelId ?? d.code.modelId },
    plan: {
      modelId: pm?.plan?.modelId ?? d.plan.modelId,
      enabled: pm?.plan?.enabled ?? d.plan.enabled,
    },
    review: {
      modelId: pm?.review?.modelId ?? d.review.modelId,
      enabled: pm?.review?.enabled ?? d.review.enabled,
      maxReviews: pm?.review?.maxReviews ?? d.review.maxReviews,
    },
    yolo: {
      modelId: pm?.yolo?.modelId ?? d.yolo.modelId,
      enabled: pm?.yolo?.enabled ?? d.yolo.enabled,
      config: {
        model1: pm?.yolo?.config?.model1 ?? null,
        model2: pm?.yolo?.config?.model2 ?? null,
        planCycles: pm?.yolo?.config?.planCycles ?? 2,
        codeCycles: pm?.yolo?.config?.codeCycles ?? 2,
        globalCycles: pm?.yolo?.config?.globalCycles ?? 1,
      },
    },
    harness: {
      modelId: pm?.harness?.modelId ?? d.harness.modelId,
      enabled: pm?.harness?.enabled ?? d.harness.enabled,
      config: {
        agents: pm?.harness?.config?.agents ?? [],
        synthesize: pm?.harness?.config?.synthesize ?? true,
        agentTimeout: pm?.harness?.config?.agentTimeout ?? 300,
        maxTasks: pm?.harness?.config?.maxTasks ?? 20,
      },
    },
  };
}

// ── Helpers ───────────────────────────────────────────

export function makeModelId(providerId: string, modelId: string): string {
  return `${providerId}__${modelId}`.replace(/[^a-zA-Z0-9_\-:]/g, "_");
}

export function getModel(library: ModelLibrary, modelId: string): RegisteredModel | undefined {
  return library.models.find((m) => m.id === modelId);
}

export function getDefaultModel(library: ModelLibrary): RegisteredModel | undefined {
  if (library.defaultModelId) {
    const m = library.models.find((m) => m.id === library.defaultModelId);
    if (m) return m;
  }
  // Fall back to first model
  return library.models[0];
}

export function getCommitModel(library: ModelLibrary): RegisteredModel | undefined {
  if (library.commitModelId) {
    const m = library.models.find((m) => m.id === library.commitModelId);
    if (m) return m;
  }
  return getDefaultModel(library);
}

export function getModeModel(library: ModelLibrary, projectId: string, mode: AgentMode): RegisteredModel | undefined {
  const pm = library.projectModes[projectId] || createDefaultProjectMode();
  const modeConfig = pm[mode];
  const modelId = modeConfig?.modelId;
  if (modelId) {
    const m = library.models.find((m) => m.id === modelId);
    if (m) return m;
  }
  // Fall back to default model
  return getDefaultModel(library);
}

export function getProjectModeConfig(library: ModelLibrary, projectId: string): ProjectModeConfig {
  return library.projectModes[projectId] || createDefaultProjectMode();
}

// ── CRUD ──────────────────────────────────────────────

export function addModel(entry: Omit<RegisteredModel, "id">): ModelLibrary {
  const library = loadModelLibrary();
  const id = makeModelId(entry.providerId, entry.modelId);
  const idx = library.models.findIndex((m) => m.id === id);
  const model: RegisteredModel = { ...entry, id };

  if (idx >= 0) {
    library.models[idx] = model;
  } else {
    library.models.push(model);
  }

  // If this is the first model or marked as default, set it as default
  if (model.isDefault || library.models.length === 1) {
    library.models.forEach((m) => (m.isDefault = m.id === id));
    library.defaultModelId = id;
  }

  saveModelLibrary(library);
  return library;
}

export function addModels(entries: Omit<RegisteredModel, "id">[]): ModelLibrary {
  let library = loadModelLibrary();
  for (const entry of entries) {
    const id = makeModelId(entry.providerId, entry.modelId);
    const idx = library.models.findIndex((m) => m.id === id);
    const model: RegisteredModel = { ...entry, id };
    if (idx >= 0) {
      library.models[idx] = model;
    } else {
      library.models.push(model);
    }
    if (model.isDefault || library.models.length === 1) {
      library.models.forEach((m) => (m.isDefault = m.id === id));
      library.defaultModelId = id;
    }
  }
  saveModelLibrary(library);
  return library;
}

export function updateModel(id: string, updates: Partial<RegisteredModel>): ModelLibrary {
  const library = loadModelLibrary();
  const idx = library.models.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error(`Model not found: ${id}`);

  library.models[idx] = { ...library.models[idx], ...updates };

  // If setting as default, unset others
  if (updates.isDefault) {
    library.models.forEach((m) => (m.isDefault = m.id === id));
    library.defaultModelId = id;
  }

  saveModelLibrary(library);
  return library;
}

export function removeModel(id: string): ModelLibrary {
  const library = loadModelLibrary();
  library.models = library.models.filter((m) => m.id !== id);

  // If we removed the default model, pick a new default
  if (library.defaultModelId === id) {
    library.defaultModelId = library.models[0]?.id || null;
    if (library.defaultModelId && library.models.length > 0) {
      library.models[0].isDefault = true;
    }
  }

  // Clean up project mode references
  for (const projectId of Object.keys(library.projectModes)) {
    const pm = library.projectModes[projectId];
    if (pm.code.modelId === id) pm.code.modelId = null;
    if (pm.plan.modelId === id) pm.plan.modelId = null;
    if (pm.review.modelId === id) pm.review.modelId = null;
  }

  saveModelLibrary(library);
  return library;
}

export function setDefaultModel(id: string): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.models.find((m) => m.id === id)) throw new Error(`Model not found: ${id}`);
  library.defaultModelId = id;
  library.models.forEach((m) => (m.isDefault = m.id === id));
  saveModelLibrary(library);
  return library;
}

export function setProjectModeModel(projectId: string, mode: AgentMode, modelId: string | null): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  (library.projectModes[projectId] as any)[mode].modelId = modelId;
  saveModelLibrary(library);
  return library;
}

export function setProjectModeEnabled(projectId: string, mode: "plan" | "review" | "yolo" | "harness", enabled: boolean): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  (library.projectModes[projectId] as any)[mode].enabled = enabled;
  saveModelLibrary(library);
  return library;
}

export function setProjectModeMaxReviews(projectId: string, maxReviews: number): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  library.projectModes[projectId].review.maxReviews = maxReviews;
  saveModelLibrary(library);
  return library;
}

/** Persist YOLO configuration */
export function setProjectModeYoloConfig(
  projectId: string,
  config: {
    model1?: { providerId: string; modelId: string } | null;
    model2?: { providerId: string; modelId: string } | null;
    planCycles?: number;
    codeCycles?: number;
    globalCycles?: number;
  }
): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  const yolo = (library.projectModes[projectId] as any).yolo;
  if (!yolo.config) yolo.config = {};
  if (config.model1 !== undefined) yolo.config.model1 = config.model1;
  if (config.model2 !== undefined) yolo.config.model2 = config.model2;
  if (config.planCycles !== undefined) yolo.config.planCycles = Math.max(1, Math.min(10, config.planCycles));
  if (config.codeCycles !== undefined) yolo.config.codeCycles = Math.max(1, Math.min(10, config.codeCycles));
  if (config.globalCycles !== undefined) yolo.config.globalCycles = Math.max(1, Math.min(5, config.globalCycles));
  saveModelLibrary(library);
  return library;
}

export function setProjectModeHarnessConfig(
  projectId: string,
  config: {
    agents?: { role: string; description?: string; modelId: string | null; enabled: boolean; systemPrompt?: string; tools?: string[] }[];
    synthesize?: boolean;
    agentTimeout?: number;
    maxTasks?: number;
  }
): ModelLibrary {
  const library = loadModelLibrary();
  if (!library.projectModes[projectId]) {
    library.projectModes[projectId] = createDefaultProjectMode();
  }
  const harness = (library.projectModes[projectId] as any).harness;
  if (!harness.config) harness.config = { agents: [], synthesize: true, agentTimeout: 300, maxTasks: 20 };
  if (config.agents !== undefined) harness.config.agents = config.agents;
  if (config.synthesize !== undefined) harness.config.synthesize = config.synthesize;
  if (config.agentTimeout !== undefined) harness.config.agentTimeout = config.agentTimeout;
  if (config.maxTasks !== undefined) harness.config.maxTasks = Math.max(1, Math.min(50, config.maxTasks));
  saveModelLibrary(library);
  return library;
}

/** Clean up project mode configs for deleted projects */
export function cleanupProjectModes(projectId: string): void {
  const library = loadModelLibrary();
  delete library.projectModes[projectId];
  saveModelLibrary(library);
}