# Note de conception — Routage par complexité/signaux (remplacement du système d'experts HARNESS)

> **Statut** : proposition de conception (pas d'implémentation)
> **Périmètre** : mode HARNESS de Pi-Web
> **Inspiration** : NVIDIA NeMo Switchyard (Apache 2.0, Rust) — transposition des concepts en TypeScript, **sans dépendance Rust**
> **Fichiers de référence lus** : `backend/src/pi/providers.ts`, `backend/src/pi/model-library.ts`, `backend/src/pi/session.ts`, `backend/src/pi/harness-engine.ts`, `extensions/harness-orchestrator/index.ts`, `frontend/src/components/Header/ModelQuickSwitch.tsx`, `frontend/src/components/Modals/{SettingsModal,ModelLibraryModal,HarnessConfigModal}.tsx`, `backend/src/routes/{model-library,pi-settings}.ts`

## 1. Problème

### 1.1 Constat : les « experts » sont de la fausse spécialisation

Le système actuel de HARNESS repose sur un pool de 12 rôles d'« experts » : `architect`, `backend-dev`, `frontend-dev`, `database-engineer`, `api-designer`, `code-reviewer`, `qa-tester`, `test-writer`, `docs-writer`, `devops`, `security-reviewer`, `refactoring`.

Ce pool existe **en double** (trois sources de vérité qui dérivent) :

| Localisation | Contenu |
|---|---|
| `backend/src/pi/model-library.ts` (`DEFAULT_AGENT_POOL`) | 12 entrées `role`, `description`, `systemPrompt`, `tools` |
| `extensions/harness-orchestrator/index.ts` (`EXPERTS`) | les mêmes 12 rôles, dupliqués |
| `frontend/src/components/Modals/HarnessConfigModal.tsx` (`DEFAULT_HARNESS_AGENTS`) | les mêmes 12 rôles, metadata UI |

La seule vraie différence entre « backend-dev » et « frontend-dev » est **un `systemPrompt` et une liste d'outils** (souvent identiques). Côté modèle, `harness-engine.ts` (`runSingleAgent`) confirme que tous les experts retombent en pratique sur le **même modèle**.

### 1.2 Ce qu'on gagne à retirer la notion d'expert

1. **Honnêteté architecturale** — on ne prétend plus avoir 12 « spécialistes » alors qu'on a 1 modèle + N personas.
2. **Cohérence** — fin de la duplication `DEFAULT_AGENT_POOL` / `EXPERTS` / `DEFAULT_HARNESS_AGENTS`.
3. **Clarté de la config** — l'utilisateur configure 3-4 catégories de tâches, pas 12 agents.
4. **Routage réellement utile** — on choisit un modèle adapté à la complexité/au risque (impact mesurable : coût, latence, qualité).
5. **Le gate de relecture reste une fonction distincte** (point non négociable).

## 2. Modèle proposé — deux axes orthogonaux

Il faut séparer **ce qu'on fait** (le process) et **avec quoi on le fait** (la ressource).

### 2.1 Axe 1 — La FONCTION (process)

| Fonction | Rôle | Outils (déjà dans session.ts) |
|---|---|---|
| `plan` | Explorer, analyser, décider, produire un plan | `PLAN_TOOLS` + `cbm_*` |
| `execute` | Implémenter, corriger, écrire | `BASE_TOOLS` |
| `review` | Relire avec un **contexte séparé** (yeux neufs) | `REVIEW_TOOLS` |
| `integrate` | Synthétiser/consolider | (`HarnessConfig.synthesize`) |

### 2.2 Axe 2 — Le MODÈLE (ressource)

Un `RegisteredModel` (déjà défini dans `model-library.ts`), choisi par le routeur selon la tâche, la complexité et les signaux.

### 2.3 Pourquoi ne pas les confondre

- Le process (plan → execute → review → integrate) doit rester stable ; le modèle doit pouvoir changer sans toucher au process.
- Le gate `review` est une **fonction** (process) qui exige un contexte séparé ; son modèle est une ressource configurable indépendamment.

## 3. Le routage

### 3.1 Notion de « route »

Une **route** = `(tâche, complexité, signaux) → (fonction, catégorie, modèle cible)`.

```ts
// À terme dans backend/src/pi/routing.ts (fichier à créer)
type FunctionName = "plan" | "execute" | "review" | "integrate";
type TaskCategory = "trivial" | "standard" | "complex" | "review";

interface Route {
  category: TaskCategory;
  function: FunctionName;
  modelId: string | null;      // null = fallback default
  confidence: number;          // 0..1
  riskScore: number;           // 0..1 (déclenche le gate review)
  reason: string;              // trace pour logs/UI
}

interface Signals {
  toolErrorRate: number;          // 0..1
  spinning: boolean;
  exploringRatio: number;         // 0..1
  recentProductionIntensity: number; // 0..1
  riskKeywords: boolean;
  changedFiles: number;
  diffSize: number;
  contextUsage: number;
}
```

### 3.2 Briques (transposition Switchyard)

#### a) Triage / classifieur — « LLM-as-classifier »

1. **Classifieur heuristique** (par défaut, gratuit) : regex + taille de demande + mots à risque + état du dépôt.
2. **Classifieur LLM** (optionnel, si un modèle cheap est configuré) : `completeSimple` court (température basse, maxTokens ~100) renvoie `{category, risk, confidence}`.

**Règle de fusion** : si le classifieur LLM renvoie une confiance < `confidence_threshold` (défaut 0.6), on retombe sur l'heuristique ou sur `standard` (fail-safe).

#### b) Stage-router adapté à Pi-Web

Les signaux sont déjà présents dans `session.ts` (via `activeToolCalls` et les événements `tool_execution_*`) — rien à réinventer côté capture :

| Signal | Source | Effet de routage |
|---|---|---|
| `toolErrorRate` | `event.isError` des `tool_execution_end` | élevé → modèle **capable** |
| `spinning` | répétition du même tool sans progrès | `true` → **capable** + bascule `plan` |
| `exploringRatio` | ratio `read/grep/find/ls/cbm_*` | élevé → **capable** |
| `recentProductionIntensity` | ratio `edit/write/bash` récents | élevé → **efficient** |
| `riskKeywords` | `auth`, `security`, `migration`, `schema`, `secret`, `password`, `SQL`… | élevé → **capable** + gate `review` |
| `changedFiles` / `diffSize` | `git.getChangedFiles` / `getGitDiff` | élevé → **capable** + gate `review` |
| `contextUsage` | `getContextUsage` | proche de la fenêtre → favorise **efficient** |

**Score continu (tanh en [0,1])** :

```
capabilityScore = tanh(w1·toolErrorRate + w2·spinning + w3·exploringRatio
                       - w4·recentProductionIntensity + w5·riskScore)
```

- élevé → modèle **capable** ; bas → modèle **efficient**.
- Poids `w1..w5` configurables, défauts conservateurs.
- Si `confidence < confidence_threshold` → catégorie `standard` / modèle par défaut.

#### c) Gate de relecture (fonction distincte, contexte séparé)

- **Déclenchement** : `riskScore ≥ reviewRiskThreshold` (défaut 0.5) OU catégorie `review` explicite.
- **Exécution** : session temporaire **neuve**, sans historique (yeux neufs), comme la Phase 1 de `runAutoReviewCycle`.
- **Modèle** : celui configuré pour la catégorie `review`, indépendant des modèles d'exécution.

## 4. Catégories de tâches

| Catégorie | Fonction | Modèle par défaut | Déclenchement |
|---|---|---|---|
| `trivial` (rapide) | `execute` | **efficient** | demande courte, mono-fichier, pas de risque, `diffSize` nul |
| `standard` (exécution) | `execute` | **default** | cas nominal, 1-3 fichiers, risque faible |
| `complex` (plan) | `plan` puis `execute` | **capable** | multi-fichiers, architecture, exploration forte, erreurs répétées |
| `review` (relecture) | `review` | **capable** dédié | `riskScore ≥ seuil`, demande explicite, `security/migration` |

**Principe de défaut** : si aucune config, tout retombe sur le modèle **default** (comportement actuel).

## 5. Mapping sur l'architecture actuelle

### 5.1 Ce qu'on réutilise (inchangé)

- `providers.ts` + `sync-providers.js` (registry de modèles, inférence capabilities)
- `model-library.ts` (`RegisteredModel`, `getModel`, `getDefaultModel`, `getModeModel`, `makeModelId`)
- sessions temporaires (`harness-engine.ts` `runSingleAgent`, `harness-orchestrator`)
- gate review (`session.ts` `runAutoReviewCycle`)
- concurrence/timeouts (`withSessionTimeout`, `concurrencyManager`)

### 5.2 Ce qu'on ajoute

**Nouveau fichier : `backend/src/pi/routing.ts`** — la couche de routage pure (séparation routing/providers) :

```
routing.ts
├── types (FunctionName, TaskCategory, Route, Signals, RoutingConfig)
├── extractSignals(session, projectId): Signals
├── heuristicClassifier(request, signals): Route
├── llmClassifier(request, runtime): Route | null
├── resolveRoute(request, config, session): Route
└── pickModel(route, library): RegisteredModel | null
```

### 5.3 Points d'intégration précis

1. **`model-library.ts`** — remplacer le pool d'experts par `RoutingConfig` :
   ```ts
   interface CategoryConfig { modelId: string | null; }
   interface RoutingConfig {
     trivial: CategoryConfig;
     standard: CategoryConfig;
     complex: CategoryConfig;
     review: CategoryConfig;
     reviewRiskThreshold: number;      // défaut 0.5
     confidenceThreshold: number;      // défaut 0.6
     classifierModelId: string | null; // modèle cheap optionnel
   }
   ```
   `ProjectModeConfig.harness` passe de `{ config: HarnessConfig }` à `{ routing: RoutingConfig }` (avec migration).
2. **`session.ts`** — `sendPrompt` appelle `resolveRoute()` avant `session.prompt()`, puis applique la route (généralisation de `applyModeToSession`). `MODE_IDENTITIES`/`MODE_INSTRUCTIONS` deviennent des instructions de **fonctions**. `triggerAutoReviewIfNeeded` se déclenche sur `route.riskScore ≥ threshold`.
3. **`harness-engine.ts`** — `runArchitect` assigne des **fonctions** (`plan`/`execute`/`review`) avec une **catégorie** déduite. `runAgentTask` remplace `agentConfig.role` par `functionName` + `category`. `runSingleAgent` utilise `pickModel(route)`.
4. **`extensions/harness-orchestrator/index.ts`** — supprimer `EXPERTS` (12 personas) au profit d'une table `FUNCTIONS` (4 entrées). Le tool `delegate_to_expert` devient `delegate` avec `{ function, task, context }`.
5. **Routes API** (`model-library.ts`) — `PUT /projects/:projectId/mode` accepte `{ mode: "harness", routing: RoutingConfig }`. Ajouter `GET /api/routing/decision` (debug).
6. **Frontend** — `HarnessConfigModal.tsx` remplacé par `RoutingConfigModal.tsx` (4 catégories + seuils + classifieur optionnel).

## 6. Modèle de configuration (settings frontend)

Dans **Settings → HARNESS** (nouveau panneau « Routing »), 4 lignes de catégories + seuils :

```
⚡ Rapide / trivial     [ efficient (fallback: default) ]
🛠  Standard / exécution [ default model            ]
🧠 Complexe / plan      [ capable model            ]
🔍 Relecture (gate)     [ capable dédié            ]
Seuil de risque review  [ 0.5 ]
Seuil de confiance      [ 0.6 ]
Classifieur LLM (cheap) [ (aucun / modèle)        ]
```

Défauts : `modelId` null → fallback default ; classifieur LLM off par défaut ; seuils masqués en mode avancé.

## 7. Migration progressive

| Étape | Contenu | Risque | Critère de sortie |
|---|---|---|---|
| 0. Préparation | Créer `routing.ts` (types + extractSignals + heuristique), sans branchement | Nul | Signaux corrects sur sessions de test |
| 1. Config rétro-compatible | Ajouter `RoutingConfig` sans supprimer `HarnessConfig`, migration auto | Faible | Anciens fichiers se migrent sans erreur |
| 2. Routage orchestrator v3 | `delegate_to_expert` route en interne par fonction+catégorie | Moyen | Tâche complexe → modèle capable, triviale → efficient |
| 3. Routage sendPrompt | `resolveRoute` avant chaque prompt ; gate review sur `riskScore` | Moyen | Comportement identique cas nominaux |
| 4. Remplacement UI | `RoutingConfigModal` remplace `HarnessConfigModal` | Moyen | L'utilisateur configure 4 modèles max |
| 5. Nettoyage | Supprimer `DEFAULT_AGENT_POOL`, `EXPERTS`, `DEFAULT_HARNESS_AGENTS` | Faible | Grep : plus aucune référence aux rôles |
| 6. Observabilité | `GET /api/routing/decision` + logs structurés | Nul | Décision visible dans l'UI |

**Garde-fou** : feature flag `ROUTING_ENABLED` pour revenir à l'ancien comportement.

## 8. Limites et points de vigilance

1. **Fiabilité du triage** — atténuation : `confidence_threshold` + fallback `standard` + asymétrie de coût (préférer sur-router vers `capable`).
2. **Mis-routing asymétrique** — `complex → efficient` dégrade la qualité ; `trivial → capable` ne coûte que de l'argent. Biais conservateur vers `capable`.
3. **Coût du classifieur LLM** — off par défaut, maxTokens bas, cache par empreinte, fast-path heuristique.
4. **Stage-router à froid** — sans historique, retomber sur classifieur heuristique + `standard`/`complex` selon la taille.
5. **Signaux bruités** — pondérations faibles, fenêtre glissante, décroissance temporelle.
6. **Gate review imparfait** — mots-clés de risque **toujours** déclencheurs (pas de seuil), `/review` forcé possible.
7. **Adéquation modèle/tâche** — réutiliser `compactToFit` et le fallback vision existants.
8. **Pas de modèle cheap disponible** — fonctionner en heuristique pure (défaut).
