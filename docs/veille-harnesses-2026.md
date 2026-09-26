# Veille 2026 — Comparatif exhaustif des harnesses d'agents de code

> **Statut** : document de veille (recherche documentaire, pas une spécification).
> **Périmètre** : les harnesses d'agents de code (open source et propriétaires), le marché 2026, notre harness **Pi-Web**, et une feuille de route de rattrapage.
> **Langue** : français, ton factuel.
> **Règle de sourcing** : toute affirmation est rattachée à une des 12 docs archivées listées ci-dessous. Quand une information n'y figure pas, elle est marquée **« non documenté dans les sources »** — aucune invention.

## Sources utilisées (bibliothèque locale du librarian)

Les 12 documents archivés dans `/app/.data/docs/tools/` (bibliothèque partagée du Libraire Pi-Web) :

| Doc archivée | Origine | Sujet |
|---|---|---|
| `coding-agent-harnesses-comparison-2026` | gist asermax / coding-agents-comparison.md | Tableau comparatif large (type, interface, open source, forces, faiblesses) |
| `top-10-agent-harnesses-open-closed-2026` | explainx.ai | Top 10 closed + top 10 open sources, les 4 fonctions d'un harness, DeepSeek Harness, Muse Code, Beam |
| `opencode-agents` | opencode.ai/docs/agents | Système d'agents OpenCode : primaires/subagents, permissions par outil, config |
| `harness-comparison-pi-aider-opencode-2026` | thoughts.jock.pl (Pawel Jozefiak) | Comparatif vécu Claude Code / Codex CLI / Aider / OpenCode / Pi / Cursor + benchmarks |
| `claude-code-steering-primitives` | claude.com blog | 7 méthodes de pilotage Claude Code, chargement et compaction |
| `claude-code-hooks-subagents-skills` | dev.to / ofox.ai | 25 événements de hooks, subagents isolés, skills |
| `open-source-coding-agents-cline-roo-kilo-aider` | baeseokjae.github.io | Cline / Roo Code / Kilo Code / Aider : modes, git, MCP, prix |
| `deepseek-harness` | github.com/deepseek-ai/deepseek-harness | DeepSeek Harness (dsh), everything-is-a-plugin, Cordis, MIT |
| `llm-model-routing-routellm-openrouter-notdiamond` | nomadx.ae | Routage de modèles : RouteLLM / OpenRouter / Not Diamond |
| `llm-routing-complexity-cost-policies` | openlegion.ai | Routage par complexité/coût, routage structurel vs dynamique, sécurité des routeurs |
| `laya-system1-decision-engine` | laya.convaiinnovations.com | Moteur de décision « System 1 » non autorégressif (33 ms), routing multilingue |
| `jevlike-open-jev-reimplementation` | github.com/vinnylarouge/jevlike | Réimplémentation ouverte d'un modèle « Jev-like » (option-attention + softmax) |

**Code Pi-Web de référence** (pour la section 5) : `backend/src/pi/routing.ts`, `backend/src/pi/routing-types.ts`, `backend/src/pi/harness-stream.ts`, `backend/src/pi/harness-archive.ts`, `backend/src/pi/concurrency.ts`, `backend/src/pi/image-budget.ts`, `backend/src/mcp/stdio-server.mjs`, `extensions/harness-orchestrator/index.ts`, `extensions/compaction-checkpoint/index.ts`, `frontend/src/components/Chat/{SubAgentBlock,ParallelSubAgents}.tsx`, `docs/routing-design.md`, `docs/logs-backend.md`, `ROADMAP.md`.

---

## 1. Qu'est-ce qu'un harness ?

### 1.1 Définition courte

Un **harness** est la couche d'orchestration qui enveloppe un modèle dans une boucle d'exécution : il donne au modèle une tâche et des outils, capture ce qu'il en fait, vérifie que le résultat satisfait l'objectif, puis décide de réessayer ou de s'arrêter (`top-10-agent-harnesses-open-closed-2026`). Le modèle raisonne ; le harness décide comment ce raisonnement est **exécuté, contrôlé et réinjecté**.

Formulation complémentaire (`harness-comparison-pi-aider-opencode-2026`) : un LLM ne fait que générer du texte. Le harness expose des *tool calls* structurés que le modèle peut émettre en texte, les intercepte, les exécute en code réel, ajoute le résultat à l'historique, puis relance le modèle. Le cœur de ce cycle fait « environ 60-75 lignes de Python » ; **toute la complexité est dans le réglage** : quels outils on donne au modèle, comment ils sont décrits, et ce que dit le system prompt.

### 1.2 Les fonctions qu'un harness assure

Les sources convergent sur **quatre à six composants** :

| Fonction | Contenu | Source |
|---|---|---|
| **Boucle d'agent** | Enchaîner modèle → outil → résultat → modèle, jusqu'à un stop | `top-10-*`, `harness-comparison-*` |
| **Définition de tâche** | Traduire une intention en prompt + outils + contraintes | `top-10-*` |
| **Gestion du contexte / compaction** | Ce qui entre dans la fenêtre, ce qui est résumé, ce qui est ré-injecté | `claude-code-steering-primitives` |
| **Exécution des outils** | Intercepter et exécuter les tool calls (fichiers, shell, git, MCP) | `harness-comparison-*` |
| **Vérification** | Tests, lint, review, check de conformité du résultat | `claude-code-hooks-subagents-skills` |
| **Isolation** | Sous-agents à contexte séparé, sandbox, worktrees | `top-10-*`, `claude-code-steering-primitives` |
| **Gestion d'échec** | Retry, retry implicite du SDK, escalade, reprise | `top-10-*` (`failure handling`) |

### 1.3 Deux catégories à ne pas confondre

`harness-comparison-pi-aider-opencode-2026` distingue explicitement :

- **Coding tools** (pair programmers) : on dirige chaque étape ; l'outil exécute très bien cette étape, commit, et attend. Exemples : **Aider** (le plus clair), **Codex CLI** (penche de ce côté), **Cline**.
- **Agent orchestrators** : on donne un objectif et l'outil exécute de façon autonome sur plusieurs étapes/fichiers/décisions. **Claude Code** est bâti pour ça ; **Devin** en est la version extrême ; **Pi** y entre si on construit le harness dessus.

Juger les deux sur le même axe produit du bruit. **Pi** est décrit comme « coding tool + primitives harness » — c'est précisément notre base.

---

## 2. Grille d'axes d'évaluation (9 axes)

| # | Axe | Question directrice | Ce qu'on observe |
|---|---|---|---|
| 1 | **Modèle d'orchestration** | Qui décide du plan ? | Planner central vs workers distribués vs modes (Plan/Act, Build/Plan, Architect/Code) ; orchestrateur qui délègue |
| 2 | **Isolation des sous-agents** | Contexte séparé + retour résumé ? | Contexte dédié, seul le résumé remonte, parallélisme, profondeur, worktrees |
| 3 | **Extensibilité** | Que peut-on brancher sans forker ? | Hooks, skills, plugins, MCP, extensions, SDK |
| 4 | **Politique d'outils** | Qui autorise quoi ? | Allowlists par rôle, permissions par outil (allow/ask/deny), gating humain, blocage déterministe |
| 5 | **Gestion du contexte** | Que garde-t-on ? | Compaction, ré-injection, mémoire persistante, chargement progressif (skills), chargement paresseux |
| 6 | **Portabilité modèle** | Combien de fournisseurs ? | Provider-agnostic vs lock-in constructeur ; couche de traduction ; modes locaux (Ollama) |
| 7 | **Interface** | Où travaille l'humain ? | CLI/TUI, IDE, web, desktop, API/RPC, multi-surface |
| 8 | **État de session** | Que survit à la fermeture ? | Éphémère, persistant, reprise, export, arborescence de sessions |
| 9 | **Sécurité, observabilité et coût** | Peut-on faire confiance et mesurer ? | Sandbox, gating destructif, logs, traces, budget, routage économique, coût par tâche |

À quoi s'ajoutent deux méta-critères pour le tableau : **licence / open source** et **maturité / adoption (★)**.

---

## 3. Tableau comparatif large

> Légende : **OS** = open source ; « nd » = non documenté dans les sources. Les ★ sont ceux cités par les docs à leur date de rédaction ; ils vieillissent vite.

| Harness | Orchestration | Isolation sous-agents | Extensibilité | Politique d'outils | Contexte | Portabilité modèle | Interface | Session | Sécurité / observabilité | Licence | Maturité / ★ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Code** | Orchestrateur central + Agent Teams, `/loop` | Oui : contexte isolé, seul le résumé revient, jusqu'à 5 niveaux | Très forte : 7 primitives, hooks (25 événements), skills, plugins, MCP | Permissions + hooks bloquants (PreToolUse exit 2), managed settings | Compaction + ré-injection CLAUDE.md/rules/skills, budget de skills | Lock-in Anthropic (modèle) | Terminal / IDE / Desktop / Web | Persistante, CLAUDE.md projet | Pas de sandbox ; forte observabilité | Non (extensions ouvertes) | Référence ; ~114 k★ |
| **OpenCode** | 2 agents primaires (Build/Plan) + 3 subagents | Oui : sessions enfants, navigation parent/enfant | Moyenne : config JSON/Markdown, MCP local/remote, `opencode agent create` | Permissions par outil (allow/ask/deny) + glob par commande bash | Compaction (agent caché), pas de mémoire projet type CLAUDE.md (compatibilité CLAUDE.md annoncée en commentaire) | Provider-agnostic (75+ / models.dev) | TUI, Desktop beta, client/serveur | Sessions + sessions enfants | Pas de sandbox ; LSP intégré | MIT | ~72 k★ |
| **Codex CLI** | Coding tool → agent émergent ; cloud containers | nd (isolation par conteneur cloud OpenAI) | Moyenne (nd détaillé) | nd | Cohérence limitée au-delà de 3-4 étapes | Lock-in OpenAI (GPT-5.4) | Terminal + desktop (ChatGPT Work) | Cloud, reprenable | Sandbox cloud OpenAI ; pas de guidage local fin | Non (CLI open source selon la doc) | ~67 k★ |
| **Aider** | Pair programmer, pas orchestrateur | Non | Moyenne (MODES Architect/Editor) | nd (pas de gating documenté) | Repo map + git-native, 4,2× moins de tokens | 75+ providers, local Ollama | Terminal | Git comme journal (chaque édit = commit) | **Pas de sandbox** | Apache 2.0 | ~43 k★, 15 Md tokens/sem |
| **Cline** | Plan/Act, approbation à chaque étape | nd | MCP complet, Playwright | **Approbation humaine par défaut** (édits + shell) | nd | BYOK multi-provider + Ollama | VS Code + JetBrains | nd | Audit trail, adapté environnements régulés | Apache 2.0 | 58 k★+, 5 M installs |
| **Roo Code** | Multi-modes (Code/Architect/Ask/Debug/Orchestrator) | Boomerang Tasks (sous-agents parallèles) | MCP limité | Permissions par mode + modèle par mode | Gestion agressive de la fenêtre | BYOK + Ollama | VS Code (+ bridge JetBrains non maintenu) | nd | nd | Apache 2.0 | **Arrêté le 15 mai 2026** ; 23,8 k★ |
| **Kilo Code** | Multi-modes hérités de Roo + Orchestrator | Boomerang Tasks | MCP complet + autocomplete inline | Permissions par mode | nd | BYOK ou modèle managé, Ollama | VS Code | nd | Cloud Agents $5/h | Apache 2.0 | 8 M$ levés, 1,5 M users |
| **Cursor** | IDE supervisé, agent mode ; cloud agents (v3) | `/worktree`, Agent Tabs, cloud VMs isolées | Faible (extension) | Supervisé, ne décide pas seul en ambiguïté | Tuning système agressif (77 %→93 % même modèle) | Multi-provider (qualité variable) | IDE (fork VS Code) + CLI | nd | SOC 2 ; pas de sandbox local documentée | Non | Acquis par SpaceX 60 Md$ (doc `top-10-*`) |
| **Windsurf** | IDE + agent Cascade | nd | Faible | nd | « Flow state », reprise où on s'est arrêté | Codeium (qualité en retrait) | IDE (fork VS Code) | nd | nd | Non | Consolidé sous Cognition (doc `top-10-*`) |
| **GitHub Copilot** | Coding agent autonome → PR ; custom agents | nd | Custom agents, skills, MCP, Copilot Memory, SDK | Politiques entreprise, admin | Copilot Memory | Choix de modèles (OpenAI/Anthropic/Google) | IDE, CLI, Chat, GitHub | nd | Enterprise-grade admin | Non | Très large distribution |
| **DeepSeek Harness (dsh)** | Modèle/outils/boucle = plugins remplaçables | Sessions plugin ; sandbox remplaçable | **Everything-is-a-plugin** (Cordis) | nd (permissions plugin) | Persistance plugin | Modèle remplaçable | Web UI (défaut `:3080`) + npm | Persistance plugin | Sandbox = plugin ; developer preview à casses de compatibilité | MIT | 135 k★ en 4 jours (août 2026), v0.1 |
| **Muse Code (Meta)** | Terminal + subagents persistants + workflows multi-agents | Parallélisme en **worktrees Git isolés** | SDK developer preview | nd | Journalise chaque appel/tool **avant** exécution (reprise crash-safe) | Muse Spark 1.2 (lock-in) | Terminal | Persistante « crash-safe » | nd | Non (closed) | Beta août 2026 → out of beta sept. 2026 ; Terminal-Bench 2.1 82,9 % |
| **Pi (base Pi-Web)** | Primitives : à construire | **Non par défaut** (à construire) | **Très forte** : extensions TS, skills, packages, SDK/RPC | Non par défaut (pas de popups) | Tree-structure + context engineering manuel | 15+ providers | TUI, RPC, SDK, print/JSON | Tree-structured, export | Non par défaut ; DIY | MIT | SDK `@earendil-works/pi-coding-agent` (base v0.85.1) |
| **Pi-Web (nous)** | 4 fonctions (planning/execute/review/integrate), orchestrateur qui délègue | **Oui** : sessions temporaires isolées, seul le retour remonte + **streaming live** | Forte : extensions + CBM + MCP read-only | Allowlists par fonction ; **pas de gating humain** (choix assumé, cf. §5.2) | Compaction + checkpoint ; image-budget | Provider-agnostic (providers Pi) | **Web complète** + MCP stdio | Sessions Pi + historique UI | **Pas de sandbox d'exécution** (le container l'est ; choix assumé), logs + boîtes noires délégués | MIT (Pi et Pi-Web) | 0.2.1-beta |
| **OpenHands** | Plateforme autonomie | Docker sandbox | Moyenne | nd | nd | LLM-agnostic | GUI, CLI, headless, Action GitHub | nd | **Docker isolation**, recherche | Apache 2.0 | Recherche active |
| **Goose (Block)** | Agent généraliste, extensible | nd | Extensions installables (écosystème) | nd | nd | Multi-provider | CLI / app | nd | nd | Apache 2.0 | ~41 k★ |
| **SWE-agent** | Framework recherche (bug fixing) | nd | Faible | nd | nd | LLM-agnostic | CLI, GitHub Action | nd | Pas de sandbox | MIT | Top SWE-bench open source |
| **Devin** | Autonomie longue durée | Cloud sandbox, shell, browser | Faible | nd | nd | SWE-1.7 | Web + API | Cloud | Sandbox cloud | Non | Core 20 $/mois + 2,25 $/ACU ; 13,86 % (2023, obsolète) |
| **Factory Droid** | Plateforme d'agents spécialisés | nd | Moyenne | Config par droid | nd | Vendor-agnostic | IDE, web, CLI, Slack/Teams, PM | nd | Entreprise | Non | Enterprise |
| **Amazon Q Developer** | Agent lié à AWS | nd | nd | IAM/permissions AWS | nd | AWS | IDE, CLI | nd | Intégré AWS | Non | Enterprise |
| **Replit Agent** | Cloud sandbox tout-en-un | Sandbox cloud Replit | nd | nd | nd | nd | Navigateur | Cloud | Sandbox cloud | Non | Faible friction |
| **Google Antigravity** | CLI + subagents parallèles | Subagents natifs | Plugins | nd | nd | Google | CLI (`agy`) | nd | **Sandbox réel** (`nsjail` Linux, `sandbox-exec` macOS) | Non | Remplace Gemini CLI |
| **Gemini CLI** | CLI | nd | MCP | nd | 1 M tokens, 60 req/min, 1000/j | Google | CLI | nd | nd | Licence non documentée | ~96 k★, gratuit |
| **Zed** | Agent mode natif (Rust) | nd | Agent natif + MCP externe | nd | nd | Multi | Éditeur | nd | nd | Open source | Latence réduite |
| **Continue.dev** | IDE-agnostique | nd | Core partagé | nd | nd | Multi | VS Code/JetBrains et autres | nd | nd | Licence non documentée | Équipes multi-IDE |
| **OpenClaw** | Assistant généraliste (hors coding) | nd | Registry de « claws » | nd | nd | Multi | Messagerie (Telegram, Signal, WhatsApp) | nd | nd | Licence non documentée | 247 k★ en quelques mois |

**Cas particuliers** : **Beam / Agentbeam** n'est *pas* un harness (il ne définit pas de tâche, ne gère pas de contexte, n'exécute pas d'outils, ne vérifie pas) — c'est une couche de sécurité/monitoring qui observe et signale, jamais ne bloque (AGPL-3.0, 6★). **Laya** et **Jevlike** ne sont pas des harnesses non plus : ce sont des modèles de décision « System 1 » (section 7).

---

## 4. Fiches détaillées

### 4.1 Claude Code (Anthropic, propriétaire + extensions ouvertes)

**Fonctionnement.** L'implémentation de référence. Terminal-first, orchestrateur central avec `/loop` pour les cycles de retry autonomes, délégation à des subagents, hooks sur événements de cycle de vie, et `CLAUDE.md` comme fichier de mémoire projet relu à chaque session. Le modèle de permission — demander avant écriture de fichier et commande shell sauf confiance explicite — a fixé le patron UX que la plupart des concurrents copient (`top-10-*`).

**Les 7 primitives de pilotage** (`claude-code-steering-primitives`) : CLAUDE.md (racine toujours chargée, sous-dossier à la demande), rules (dont path-scoped), skills, subagents, hooks, output styles, append system prompt. Chaque méthode trade le **coût en contexte** contre l'**autorité** ; CLAUDE.md est mémoïsé et relu après compaction, les rules ré-injectées, les skills ré-injectés dans un **budget partagé** (les plus anciens jetés d'abord), les output styles jamais compactés.

**Subagents.** `claude-code-hooks-subagents-skills` : nom, description et liste d'outils chargés au démarrage ; le corps ne vient qu'à l'invocation via l'outil Agent. Le sous-agent tourne dans un **contexte neuf** ; **seul le message final (résumé + métadonnées) revient** dans la session principale. Ils peuvent se **imbriquer jusqu'à 5 niveaux** et des workflows dynamiques orchestrent « des dizaines à des centaines d'agents d'arrière-plan ». Champs notables : `tools`/`disallowedTools`, `model`, `permissionMode`, `skills` (préchargement), `memory` (user/project/local), `isolation: worktree`, `maxTurns`. Il existe des **forked subagents** expérimentaux qui héritent de l'historique complet.

**Hooks.** 25 événements de cycle de vie, dont **bloquants** : `UserPromptSubmit` (bloque/modifie le prompt), `PreToolUse` (point de contrôle sécurité), `PermissionRequest` (auto-approuve/refuse), `Stop`/`SubagentStop` (force la continuation), `PreCompact` (sauvegarde le transcript). Types : command, http, mcp_tool, prompt, agent. Codes de sortie : `0` succès, `2` blocage (stderr transmis à Claude), `1` erreur non bloquante. Les hooks ont un **coût contexte faible** car ils vivent hors fenêtre. Point doctrinal majeur : « quand quelque chose ne doit absolument pas arriver, une instruction est le mauvais outil — il faut un hook ou une permission » ; `managed settings` sont le seul garde-fou déterministe non contournable au niveau organisation.

**Forces.** Couverture la plus complète des primitives ; cohérence de contexte sur de longues chaînes ; infrastructure pensée pour l'autonomie non surveillée (`harness-comparison-*`). Terminal-Bench 2.0 : configuration « Claude Mythos » à **92,1 %** contre 77,3 % pour Codex CLI.

**Faiblesses.** Perte de contexte au-delà de ~2 h de session ; interface terminal-only avec courbe d'apprentissage ; **consommation de tokens 3-4× supérieure à Codex CLI** ; lock-in Anthropic et politique de facturation qui interdit aux harnesses tiers de tirer sur l'abonnement Max ; pas de sandbox (`coding-agent-harnesses-comparison-2026`).

**Transposable chez nous.** (a) le triptyque **instruction / hook / permission** (l'instruction ne garde rien, le hook bloque) ; (b) le **retour résumé seul** du sous-agent ; (c) les **allowlists d'outils par rôle** (déjà en place) ; (d) le **budget partagé des skills** à l'invocation.

### 4.2 OpenCode (sst, MIT)

**Fonctionnement.** Harness open source le plus « par défaut » en 2026 : TUI, app desktop (beta), architecture **client/serveur** (pilotage distant), LSP auto-chargé, 75+ intégrations de providers (`top-10-*`, `harness-comparison-*`).

**Agents** (`opencode-agents`) : **2 agents primaires** — **Build** (tous les outils) et **Plan** (file edits et bash par défaut en `ask`) — et **3 subagents** : **General** (tous les outils sauf todo, peut modifier des fichiers), **Explore** (read-only codebase rapide), **Scout** (read-only docs externes/dépendances, clone dans un cache géré). Trois agents système cachés : compaction, title, summary. Les subagents sont invocables automatiquement ou par `@mention` ; les sessions enfants se naviguent (`session_child_first`, cycle, `session_parent`).

**Politique d'outils.** Le champ historique `tools` est **déprécié** au profit de `permission` : chaque clé (`read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `todowrite`, `webfetch`, `websearch`, `lsp`, `skill`, `question`, `doom_loop`) vaut `allow`/`ask`/`deny`. Les clés sensibles acceptent un **objet glob → action**, y compris par commande bash (`"git push": "ask"`, `"grep *": "allow"`, ordre = dernière règle gagnante). `permission.task` contrôle quels subagents un agent peut invoquer (en `deny`, le subagent disparaît de la description de l'outil Task). Config en `opencode.json` ou en Markdown (`.opencode/agents/`, `~/.config/opencode/agents/`).

**Forces.** Provider-agnostic ; TUI soignée ; client/serveur permet de piloter à distance ; permission par outil très fine ; modèle, température, `steps` (max d'itérations), prompt par agent.

**Faiblesses.** Projet plus jeune, écosystème plus petit ; TUI-first ; pas de mémoire projet persistante type CLAUDE.md dans la doc (une compatibilité CLAUDE.md est signalée par un commentaire tiers) ; pas de sandbox ; pas d'Agent Teams.

**Transposable.** Le **modèle de permission par outil** (objet glob → allow/ask/deny, spécifique aux commandes bash) est une référence factuelle : chez nous l'absence de gating est un **choix assumé** (cf. §6.2), pas un manque à combler. La distinction **primary vs subagent** et la **navigation dans les sessions enfants** valident notre design.

### 4.3 Codex CLI (OpenAI, ~67 k★)

**Fonctionnement.** Terminal, open source, bundlé avec ChatGPT Plus/Pro, sur GPT-5.4 (`harness-comparison-*`). Tourne dans des **conteneurs cloud gérés par OpenAI** : on peut lancer une tâche et se déconnecter, elle continue. SWE-bench 77,3 %, proche de Claude Code (80,8 %), à **3-4× moins de tokens**.

**Forces.** Qualité de code excellente sur tâches contenues (apps iOS/macOS/web) ; efficacité tokens ; exécution cloud détachée ; déjà « gratuit » pour les abonnés ChatGPT.

**Faiblesses.** « Froid » comme agent : l'exécution d'étapes isolées est propre mais la cohérence se perd vers l'étape 3-4 ; se répète, demande des clarifications inutiles, rate des dépendances. Moins de cohérence longue que Claude Code.

**Transposable.** Le **modèle d'exécution cloud détachée** intéresse notre roadmap (tâches longues sans garder le processus local), mais n'est pas dans nos sources pour d'autres détails.

### 4.4 Aider (Apache 2.0, ~43 k★)

**Fonctionnement.** Pair programmer **git-native** en terminal. On apporte son modèle (75+ providers, local Ollama inclus), Aider enveloppe avec une exécution git : **chaque édit devient un commit** avec message généré. `repo map` donne une compréhension structurelle ; auto-lint et tests après chaque changement, auto-correction (`harness-comparison-*`, `open-source-*`).

**Forces.** Efficacité tokens **4,2× meilleure que Claude Code** ; modèle **Architect/Editor** qui sépare le planning (modèle fort) de l'édition (modèle cheap) ; journal git auditable, réversible, `bisect`/`cherry-pick` possibles ; 15 Md tokens/semaine en production ; coût $10-30/mois d'API à usage modéré.

**Faiblesses.** Terminal-only, pas de GUI ni d'extension IDE ; orchestrateur faible (pas de coordination de sous-agents sur 40 fichiers) ; MCP limité ; **pas de sandbox**.

**Transposable.** Le **gate git par défaut** (commit atomique par édit) et la **séparation Architect/Editor** (deux modèles pour planifier vs exécuter) sont deux idées à faible coût pour améliorer l'auditabilité et l'économie de Pi-Web.

### 4.5 Cline (Apache 2.0, 58 k★+, 5 M installs)

**Fonctionnement.** Extension VS Code (+ JetBrains natif) qui transforme l'éditeur en hôte de harness. Workflow **Plan/Act** : l'agent planifie puis **attend l'approbation du développeur à chaque étape** — chaque écriture, commande terminal, action navigateur (Playwright) est montrée avant exécution (`open-source-*`).

**Forces.** Modèle d'approbation pas-à-pas, le plus conservateur du marché ; adapté aux environnements régulés (audit trail exigé) ; MCP complet ; BYOK multi-provider + Ollama ; plus large base communautaire des agents VS Code.

**Faiblesses.** Moins autonome par défaut ; `git auto-commit` non ; pas d'autocomplete inline (contrairement à Kilo Code).

**Transposable.** Le **gating humain par défaut** est une **différence assumée** : Pi-Web l'écarte par décision utilisateur (cf. §6.2). Cline montre qu'un harness peut rester utile et adopté avec cette contrainte — c'est une option de conception, pas une obligation.

### 4.6 Kilo Code (Apache 2.0) — et l'obsolescence de Roo Code

**Roo Code (note d'obsolescence).** Fork communautaire de Cline qui a divergé pour aller plus vite : **modes personnalisés** (Code, Architect, Ask, Debug, Orchestrator), gestion agressive du contexte, **Boomerang Tasks** (un agent parent spawne des sous-agents spécialisés en parallèle), **modèle par mode** (router Opus sur Code, Gemini Flash sur Ask pour couper les coûts). 23,8 k★ et 1,55 M installs. **Le développement est arrêté (shutdown annoncé le 15 mai 2026)** : plus de patchs de sécurité, plus de support de nouveaux providers, plus de correctifs. Ne pas choisir pour un nouveau projet ; migrer vers Kilo Code (`open-source-*`).

**Kilo Code.** Successeur direct : combine la stabilité/communauté de Cline avec l'architecture multi-modes de Roo, plus des ajouts — **autocomplete inline**, **Orchestrator mode** abouti, **Cloud Agents à 5 $/h** pour l'exécution longue sans machine locale. Levée **8 M$**, **1,5 M users**. Tarifs : extension gratuite BYOK, Pro 20 $/mois, Team 99 $/mois. VS Code uniquement.

**Forces.** Ensemble fonctionnel le plus large des agents VS Code open source ; continuité de migration depuis Roo ; cloud agents.

**Faiblesses.** VS Code only ; pas d'auto-commit git ; dépend d'un écosystème de forks.

**Transposable.** Le **modèle par mode** (routage économique par rôle) recoupe notre routage par catégorie. Les **Cloud Agents** recoupent l'idée d'exécution détachée.

### 4.7 Cursor (propriétaire, IDE)

**Fonctionnement.** IDE natif (fork VS Code) : tab completion, chat codebase-aware, édition inline/multi-fichiers, **Composer**, `@mentions`. Cursor 3 (avril 2026) ajoute cloud agents sur VMs isolées, `/worktree`, agents self-hosted, **Agent Tabs parallèles** ; **30 % des PR internes de Cursor** seraient générées par des agents (`harness-comparison-*`).

**Forces.** Meilleure expérience supervisée au clavier ; **tuning de harness obsessionnel** : des personnes à plein temps réécrivent system prompts et descriptions d'outils à chaque nouveau modèle. Résultat mesuré : même Opus, **77 % dans Claude Code vs 93 % dans Cursor** (16 points imputables au harness seul) ; CORE-Bench 42 % avec scaffold minimal → 78 % dans Claude Code.

**Faiblesses.** Pas un harness autonome : laissé sans surveillance, il **stalle à la première décision ambiguë** — choix de design assumé (« pour développeurs présents »). Dépendance VS Code ; coût à l'échelle ; Cursor ne publie pas de SWE-bench (CursorBench propriétaire à 61,3 %).

**Transposable.** La leçon **« le tuning du harness vaut jusqu'à 16-40 points »** justifie d'investir sur les descriptions d'outils et les prompts système de nos 4 fonctions plutôt que de changer de modèle.

### 4.8 Windsurf (propriétaire, IDE)

**Fonctionnement.** IDE (fork VS Code) avec l'agent **Cascade**. Se distingue historiquement par le **« flow state »** (humain + IA synchronisés), l'édition multi-fichiers, les commandes terminal, MCP, le linter auto-fix, la preview/déploiement et **Supercomplete**. Reprend là où on s'est arrêté (`coding-agent-harnesses-comparison-2026`). Consolidé sous **Cognition** après la vague d'acquisitions 2025 (`top-10-*`).

**Forces.** Bon tier gratuit ; paradigme flow state ; preview & deploy intégrés.

**Faiblesses.** Écosystème plus petit que Cursor ; qualité des modèles Codeium parfois en retrait ; **non documenté dans les sources** pour l'isolation/sécurité.

**Transposable.** Peu : c'est un IDE supervisé, pas un orchestrateur. Retenir l'idée de **reprise du contexte après interruption**.

### 4.9 GitHub Copilot (propriétaire)

**Fonctionnement.** Suite : complétion, chat, **coding agent autonome qui crée/met à jour des PR**, review de code, CLI, **custom agents**, **agent skills**, **MCP**, **Copilot Memory**, Spark (constructeur d'app) (`coding-agent-harnesses-comparison-2026`). Côté `top-10-*` : un **SDK** (Python, TypeScript, Go, .NET) permet de construire des agents custom sur la même infrastructure, avec intégration native GitHub Actions et workflows de PR. Choix de modèles OpenAI/Anthropic/Google et administration entreprise.

**Forces.** Distribution maximale ; intégration GitHub profonde (PR, issues, actions) ; admin/politiques entreprise ; agents et skills personnalisables.

**Faiblesses.** Coding agent plus jeune et moins mature que Claude Code ; expérience fragmentée entre surfaces ; tarification entreprise ; certaines fonctions réservées aux tiers supérieurs.

**Transposable.** L'idée de **skills de harness** et d'un **SDK d'agents** pour standardiser des configurations par équipe. Notre serveur MCP read-only est un embryon de cette surface.

### 4.10 DeepSeek Harness / `dsh` (DeepSeek AI, MIT)

**Fonctionnement.** Harness open source **« everything-is-a-plugin »**, construit sur **Cordis** (design décrit dans *A Programming Paradigm for Spatiotemporal Composability*). **Le modèle, les outils, les sessions, la boucle, le sandbox, la persistance et la Web UI sont chacun des plugins remplaçables** (`deepseek-harness`, `top-10-*`). Lancement : `npx @deepseek-ai/dsh web` → Web UI sur `http://127.0.0.1:3080` ; ou depuis les sources (`pnpm`). Licence MIT.

**Forces.** Architecture radicalement composable (plugin-first) ; **135 000★ en quatre jours** (mi-août 2026) — le signal d'adoption le plus fort de la catégorie ; sandbox remplaçable ; Web UI par défaut ; écosystème de plugins (`topic dsh-plugin`).

**Faiblesses.** **Developer preview** avec **casses de compatibilité annoncées** ; trop récent pour être recommandé en production ; surface de sécurité à valider (notice de sécurité séparée) ; qualité des plugins non documentée dans nos sources.

**Transposable.** L'architecture **plugin-first** est une cible de moyen terme pour Pi-Web : rendre remplaçables boucle, outils et persistance sans toucher au cœur (dsh rend même le sandbox remplaçable, ce qui n'est pas retenu chez nous — cf. §6.2). À court terme, elle valide notre stratégie d'extensions locales.

### 4.11 Muse Code (Meta, propriétaire)

**Fonctionnement.** Agent de code terminal de Meta Superintelligence Labs, sur le modèle **Muse Spark 1.2** (annoncé en beta le 5-6 août 2026, **sorti de beta le 1er sept. 2026**). Il fait tourner des **subagents d'arrière-plan persistants**, distribue les gros travaux à des **subagents parallèles dans des worktrees Git isolés**, et **journalise chaque appel de modèle et chaque exécution d'outil avant de l'exécuter** pour une reprise sûre après crash. La sortie de beta ajoute **messagerie inter-sessions**, un **moteur de workflows multi-agents**, un **SDK developer preview** et des forfaits (`top-10-*`).

**Forces.** Journalisation avant exécution = reprise crash-safe explicite ; parallélisme par worktree (isolation forte) ; messagerie inter-sessions ; sur Terminal-Bench 2.1, **82,9 %** (derrière Claude Code Opus 5 à 86,7 %, devant Codex et Grok Build).

**Faiblesses.** Lock-in Muse Spark 1.2 ; pas de sandbox documenté ; modèle et écosystème très nouveaux ; **non documenté dans les sources** pour l'extensibilité et les permissions.

**Transposable.** Deux idées fortes : **isolation par worktree Git** pour nos sous-agents parallèles, et **journalisation avant exécution** pour la reprise. Notre `harness-archive.ts` est déjà une brique dans cette direction (archivage post-échec) ; il manque l'écriture *a priori*.

### 4.12 Rubrique « autres acteurs »

| Acteur | Ce que disent les sources | Transposable |
|---|---|---|
| **Goose (Block)** | Apache 2.0, agent généraliste MCP-based (~41 k★). Architecture où les capacités sont des **extensions installables**, « plus proche d'un écosystème de plugins que d'un agent monolithique ». Intégré à Buzz (chat + forge Git de Block). | Modèle d'extensions installables |
| **OpenHands (ex-OpenDevin)** | Apache 2.0, plateforme « AI software engineer » : **Docker sandboxing**, édition de fichiers, shell, navigateur, recherche, GitHub Action, headless, **LLM-agnostic**. Setup plus lourd, GUI moins polie, lent car sandbox. | Le **sandbox Docker** — référence factuelle du marché, non retenue pour Pi-Web (cf. §6.2) |
| **SWE-agent** | MIT, framework de recherche : correction autonome de bugs, création de PR, optimisé SWE-bench, repo cloning, bash. **Top performer SWE-bench open source**, mais périmètre étroit (patch/bug fixing). | Discipline de benchmark et de vérification |
| **Crush (Charm)** | Cité comme acteur « moins documenté ». Détails **non documentés dans les sources**. | — |
| **Amp (Sourcegraph)** | Cité, détails **non documentés dans les sources**. | — |
| **Plandex** | Cité, détails **non documentés dans les sources**. | — |
| **Gemini CLI (Google)** | ~96 k★, gratuit avec compte Google : **60 req/min, 1000/jour, fenêtre de 1 M tokens**, fort sur le frontend. **Remplacé par Antigravity** comme surface principale (`top-10-*`). Licence **non documentée dans les sources**. | Levier de coût / fallback |
| **Qwen Code** | Cité, détails **non documentés dans les sources**. | — |
| **Zed** | Éditeur open source avec agent mode **natif dans le cœur Rust** (pas une extension), latence de round-trip réduite ; compatible outillage MCP externe. | Intégration profonde plutôt que plugin |
| **Continue.dev** | IDE-agnostique : cœur partagé VS Code/JetBrains/autres ; « ne pas laisser le choix du harness dicter le choix de l'IDE ». | Portabilité d'IDE |
| **Void** | Cité, détails **non documentés dans les sources**. | — |
| **Antigravity (Google)** | CLI agentique `agy`, **sandbox réel** (`nsjail` Linux, `sandbox-exec` macOS), plugins, **subagents parallèles natifs**. Remplace Gemini CLI. | Le **parallélisme natif** (subagents) ; le sandbox OS reste factuel, non retenu pour Pi-Web (cf. §6.2) |
| **Devin (Cognition)** | Autonomie longue, cloud sandbox, shell Linux, navigateur ; Core 20 $/mois + 2,25 $/ACU. La référence 13,86 % date de 2023 et est obsolète. | Autonomie longue + sandbox cloud |
| **Factory Droid** | Plateforme d'agents spécialisés configurables par workflow (review, migration, incident), multi-interface (IDE/web/CLI/Slack/PM), sécurisée entreprise, vendor-agnostic. | Config d'agents scoped par équipe |
| **Amazon Q Developer** | Agent AWS : intégration IAM/CloudFormation/Lambda ; faible hors AWS. | Intégration écosystème verticale |
| **Replit Agent** | Navigateur, zéro setup ; tout l'exécution (code, deps, deploy) dans le **sandbox cloud Replit**. | Friction minimale, sandbox managé |
| **Kimi CLI / Kimi Work (Moonshot)** | Outillage ouvert autour de la famille Kimi, variante desktop avec WebBridge et coordination **swarm**. | Coordination swarm |
| **OpenClaw** | Assistant personnel local-first (pas un harness de code) : boucle tool-calling reliée à Telegram/Signal/WhatsApp, registry de milliers de « claws ». **247 k★** — preuve que le pattern harness généralise hors du code. | Généralisation du pattern |
| **Beam / Agentbeam** | **Pas un harness** : collecteur local-first de hooks qui scanne commandes risquées, fuites de credentials, opérations destructives, et scanne hors-ligne les `SKILL.md`/config MCP. **N'bloque jamais**, observe et signale (AGPL-3.0). | Couche d'observabilité sécurité |

---

## 5. Notre harness Pi-Web

### 5.1 Fonctionnement réel

Pi-Web est un harness **web-first** construit sur le SDK Pi (`@earendil-works/pi-coding-agent`, base 0.85.1 en MIT), décrit par un comparatif externe comme « coding tool + primitives harness » : Pi fournit les primitives, nous fournissons le produit.

| Brique | Implémentation réelle | Fichier de référence |
|---|---|---|
| **Orchestrateur** | En mode HARNESS, l'orchestrateur ne code pas : il conçoit et **délègue toute exécution** via le tool `delegate`. Les outils d'exécution (bash, edit, read, write, grep) lui sont retirés (`HARNESS_EXCLUDE = ["delegate"]`) ; un outil « not found » est le signal de déléguer. | `extensions/harness-orchestrator/index.ts`, `backend/src/pi/session.ts` |
| **4 fonctions** | `planning` (exploration, décisions, plan), `execute` (implémentation), `review` (relecture/audit), `integrate` (synthèse, rapport final). Chacune a **emoji, label, description, system prompt dédié et allowlist d'outils**. | `extensions/harness-orchestrator/index.ts` |
| **Allowlists par fonction** | `planning` : read/grep/find/ls/analyze_file + 8 `cbm_*`. `execute` : + edit/write/bash/web_screenshot. `review` : read-only strict (pas d'edit/write/bash) + analyze_file/web_screenshot + CBM. `integrate` : read-only + analyze_file + CBM. | idem |
| **Tool `delegate`** | Paramètre `function` (planning/execute/review/integrate) + tâche. Il crée une **session Pi temporaire**, y injecte le system prompt et l'allowlist de la fonction, exécute, puis détruit la session. Rétro-compatibilité `role` → fonction via `mapRoleToFunction`. | `extensions/harness-orchestrator/index.ts` |
| **Sous-agents visibles en direct** | Chaque événement du sous-agent est enveloppé dans une frame `{type:"subagent", source:"subagent", delegateRunId, delegateFunction, delegateLabel, model, taskExcerpt, event}` émise sur le canal WS `pi_event` existant, en **émission directe** (sans le buffer 40 ms de la session principale). Quota de sécurité 20 événements/s par `delegateRunId`, fusion des `tool_execution_update` consécutifs, compteur `droppedEvents`. | `backend/src/pi/harness-stream.ts`, `session.ts` (`rawEmitToSubscribers`) |
| **Vue en colonnes pour le parallèle** | Le frontend réutilise `SubAgentBlock` pour une vue en colonnes à largeurs égales (`ParallelSubAgents.tsx`) ; au-delà d'un plafond, les colonnes s'empilent verticalement ; défilement horizontal forcé plutôt que colonnes illisibles. | `frontend/src/components/Chat/{SubAgentBlock,ParallelSubAgents}.tsx` |
| **Graphe de code CBM** | 8 tools (`cbm_search`, `cbm_trace`, `cbm_code`, `cbm_search_code`, `cbm_diff`, `cbm_arch`, `cbm_cypher`, `cbm_schema`) donnés à **toutes les fonctions**, avec une consigne d'exploration commune pour remplacer les chaînes `read`/`grep`. Client MCP stdio maison vers le binaire `codebase-memory-mcp`. | `extensions/codebase-memory/index.ts`, `backend/src/pi/cbm-stdio.ts` |
| **Routage** | Couche pure `(demande + signaux) → (fonction, catégorie, modèle)`. Catégories `trivial`/`standard`/`complex`/`review` ; classifieur **heuristique** gratuit (mots-clés de risque/complexité, taille de demande, diff, erreurs d'outil, spinning, exploration, usage contexte) + classifieur **LLM optionnel** (confiance < 0,6 → repli heuristique). Un `riskScore ≥ 0,5` **force la fonction review** (gate). | `backend/src/pi/routing.ts`, `routing-types.ts` |
| **Compaction + checkpoint** | À l'approche de la compaction, l'extension extrait les informations clés des messages qui vont disparaître et conserve le résumé complet en checkpoint (SQLite `~/.unipi/memory/<projet>/memory.db`, repli JSON). Après compaction, un prompt caché demande au LLM de vérifier que le résumé n'a rien perdu. Option de mode review « corriger / lister seulement ». | `extensions/compaction-checkpoint/index.ts`, `docs/routing-design.md`, `ROADMAP.md` |
| **Image-budget** | Filtre les images du contexte modèle : les images générées par l'agent (rôle `toolResult`/`assistant`) ne sont **jamais** ré-injectées ; seules celles du **dernier message user** porteur d'images sont conservées. Rien n'est supprimé de l'UI ni de la session persistée. | `backend/src/pi/image-budget.ts` |
| **Limiteur de concurrence** | Un seul pool : **LLM slots** limités **par provider** (avec override `providerMaxLLMSlots[providerId]`). Files par provider, timeout de file configurable, `slotKey` unique par appel (fix BUG-59 : les agents harness ne partagent plus le slot de la session principale). | `backend/src/pi/concurrency.ts` |
| **Observabilité** | Logs fichier `.data/logs/backend-YYYYMMDD.log` (une ligne par événement, catégories `ws`, `pi-session`, `harness`, `crash`…), dumps de crash `crash-*.json`, et **boîtes noires des délégués** : en cas d'**échec**, la session JSONL du délégué est archivée dans `.data/logs/harness/` avec un `.meta.json` (contexte de l'échec) ; en succès elle est supprimée. Rétention 7 jours. | `docs/logs-backend.md`, `backend/src/pi/harness-archive.ts` |
| **MCP (pilotage externe)** | Serveur MCP stdio **read-only**, process découplé du backend, qui appelle l'API REST Pi-Web avec une agent key. **7 tools** : `pi.list_projects`, `pi.get_project`, `pi.read_file`, `pi.list_files`, `pi.run_git_status`, `pi.list_sessions`, `pi.get_session_status`. Les tools d'écriture sont prévus « plus tard, derrière un flag explicite ». | `backend/src/mcp/stdio-server.mjs` |
| **UI web** | UI complète React/Tailwind/Vite : chat, streaming, colonnes de sous-agents, paramètres, model library, terminal, graphe CBM 3D, gestion de projets. | `frontend/src/` |
| **Extensions** | `harness-orchestrator`, `codebase-memory`, `file-analyzer`, `web-screenshot`, `compaction-checkpoint`. | `extensions/` |

### 5.2 Tableau AVANTAGES / FAIBLESSES / ÉCARTS

| Thème | Avantages Pi-Web | Faiblesses / écarts vs les meilleurs |
|---|---|---|
| **Orchestration** | Orchestrateur qui ne code jamais et délègue tout ; 4 fonctions stables (process) séparées du modèle (ressource) ; routage par catégorie + gate review automatique sur `riskScore`. | Pas d'Agent Teams ni de workflows multi-agents persistants comme Claude Code/Muse Code ; le routage émet une **décision unique avant le run** et n'escalade pas en cours de route (pas de cascade). |
| **Isolation / sous-agents** | **Point fort différenciant** : sessions temporaires isolées, allowlists par fonction, **retour résumé** + **streaming live**. Claude Code ne remonte que le résumé final ; nous montrons la vie du sous-agent en direct et en colonnes. | Pas de parallélisme documenté/plafonné au niveau du harness (les délégués partagent la limite LLM par provider) ; pas d'isolation **worktree Git** (Muse Code) ; pas de profondeur d'imbrication (Claude Code : 5). |
| **Extensibilité** | Extensions locales riches (CBM, compaction, file-analyzer, web-screenshot) ; MCP stdio read-only ; SDK Pi (extensions TS, skills, packages). | **PAS de hooks utilisateur** (25 événements chez Claude Code) ; **PAS de skills** (chargement progressif) ; pas de plugins packagés/distribuables ; MCP en écriture absent. |
| **Politique d'outils** | Allowlists par fonction (read-only strict pour review/integrate ; execute seul a bash/edit/write) ; gate review automatique ; **pas de gating humain : choix assumé** (décision utilisateur du 02/09/2026, le container est déjà la sandbox). | Pas d'allow/ask/deny par outil ni de PreToolUse bloquant : les autres harnesses en ont (Cline, OpenCode, Claude Code), c'est une **différence assumée, pas un manque à combler**. À couvrir par un garde-fou automatique silencieux sur les 4 zones hors container (cf. §6.2). |
| **Gestion du contexte** | Compaction + checkpoint persistant + prompt de vérification post-compaction ; image-budget (jamais d'erreur 400 « 60 images ») ; arborescence de sessions Pi. | Pas de chargement progressif type skills ; pas de mémoire projet persistante inter-sessions type CLAUDE.md (**envisagée** dans le ROADMAP, non livrée) ; pas de budget de ré-injection par composant. |
| **Portabilité modèle** | Provider-agnostic (providers Pi), bibliothèque de modèles par catégorie, classifieur LLM optionnel, limiteur par provider. | Compatibilité de facturation : un utilisateur d'abonnement Claude/Gemini ne peut pas l'utiliser dans un harness tiers (contrainte constructeur, pas nôtre) ; pas de routage cascade (cheap → escalade sur échec). |
| **Interface** | **UI web complète** (différenciateur : la plupart sont TUI/IDE) ; MCP pour pilotage externe ; colonnes de sous-agents ; graphe CBM 3D. | Pas de CLI/TUI local ; **pas de reprise de session UI explicite** (l'état de session Pi existe mais l'expérience « reprendre où on s'est arrêté, choisir une session » n'est pas documentée comme feature UI aboutie) ; pas d'export de session. |
| **Sécurité** | read-only strict pour review/integrate ; MCP read-only ; auth agent-key ; durcissements XSS/CSP ; `verifyClient` WS durci. | **Pas de sandbox d'exécution : choix assumé** (décision utilisateur du 02/09/2026 — Pi-Web tourne déjà dans un container, redéploiement en cas de casse). Restent factuels : `docker-compose.yml` en `privileged: true` (BUG-49 toléré) ; pas de scan de commandes risquées ni de blocage déterministe, ce que le garde-fou silencieux de §6.2 vient couvrir pour les zones hors container. |
| **Observabilité / coût** | Logs fichier structurés, dumps de crash, boîtes noires des délégués, quota de streaming, compteur `droppedEvents`. | Pas de coût par sous-agent affiché dans l'UI ; pas de budget par agent/par tâche (budget caps) ; pas de traces OTel-like ; pas de dashboard de consommation. |

### 5.3 Écarts explicitement manquants (checklist)

**Écartés par décision utilisateur du 02/09/2026** (ce ne sont plus des écarts à combler, mais des choix assumés) :

- **Gating humain** sur outils destructifs — **écarté**, pas reporté. Argument (1) : friction de confirmation refusée (« à chaque fois je me suis retrouvé à devoir confirmer des actions alors que moi je veux juste que la tâche soit faite »). Argument (2) : le container Pi-Web est déjà la sandbox (« s'il casse quelque chose, pas grave, je redéploie le container »). Les autres harnesses le proposent (Cline par défaut, OpenCode allow/ask/deny, Claude Code PreToolUse exit 2 + managed settings) : différence assumée.
- **Sandbox d'exécution** — **écartée** pour la même raison : Pi-Web tourne déjà dans un container. Les références marché restent factuelles (OpenHands Docker, Antigravity `nsjail`/`sandbox-exec`, Devin/Codex/Replit cloud, dsh sandbox-plugin) mais ne constituent pas une cible pour nous. Le besoin résiduel se limite aux zones que le container ne protège pas (cf. §6.2, garde-fous automatiques silencieux).

**Manques à combler** :

1. **Hooks utilisateur** — absents (Claude Code : 25 événements dont 5 bloquants)
2. **Skills** à chargement progressif — absents (Claude Code, OpenCode `skill`, Copilot agent skills).
3. **Reprise de session UI / export** — non documentée comme feature aboutie (Pi offre les sessions structurées ; Muse Code la reprise crash-safe ; OpenCode la navigation parent/enfant).
4. **Isolation worktree Git** pour le parallèle — absente (Muse Code).
5. **Routage cascade + budget par agent** — absents (RouteLLM/OpenRouter ; OpenLegion `daily_budget`).
6. **Plugins distribuables** (packaging/publish) — absents (dsh everything-is-a-plugin ; Goose extensions ; OpenClaw claws).

---

## 6. Synthèse

### 6.1 Les 5 grands enseignements du marché

1. **Le harness compte autant que le modèle.** Même Opus : **77 % dans Claude Code vs 93 % dans Cursor** (16 points) ; CORE-Bench 42 % en scaffold minimal vs 78 % dans Claude Code ; selon les études, l'effet harness va de **5 à 40 points** selon le modèle et le type de tâche (`harness-comparison-*`). Investir dans les prompts système et les descriptions d'outils est un levier direct de qualité.
2. **Le marché s'est scindé en deux catégories.** Coding tools (Aider, Codex CLI, Cline) vs agent orchestrators (Claude Code, Devin, Pi-Web si abouti). Les IDEs supervisés (Cursor, Windsurf) ne sont **pas** des harnesses autonomes : ils stallent à la première ambiguïté. Se comparer à la bonne catégorie évite de mauvaises décisions.
3. **L'isolation des sous-agents + retour résumé est le pattern qui scale.** Claude Code : contexte neuf, seul le résumé revient, imbrication jusqu'à 5 niveaux, workflows à centaines d'agents. Muse Code : worktrees Git isolés. OpenCode : sessions enfants navigables. DeepSeek : sessions plugin. Notre base est alignée — et notre **streaming live** va plus loin que le résumé seul.
4. **L'instruction ne protège de rien ; le déterministe protège.** Claude Code est catégorique : « quand quelque chose ne doit absolument pas arriver, une instruction est le mauvais outil » — il faut un hook ou une permission, et les managed settings pour l'organisation. Corollaire : la vraie surface de personnalisation fiable, ce sont les **hooks** (déterministes) et les **skills** (procédures à chargement progressif, budget partagé), pas le CLAUDE.md toujours chargé.
5. **Sécurité et économie deviennent des axes de premier plan.** Le sandbox est rare (OpenHands, Antigravity, Devin, Codex cloud, Replit, dsh-plugin) alors que la plupart des harnesses n'en ont pas. Et le routage de modèles coupe **60-75 % des coûts** (RouteLLM : 40 % d'appels au modèle fort en moins pour <5 % de dégradation), tandis que la sécurité des routeurs (déflation/inflation de complexité, sondage) devient un sujet à part entière.

### 6.2 Recommandations pour Pi-Web (priorisées)

> Effort : **S** ≈ quelques jours, **M** ≈ 1-2 semaines, **L** ≈ un mois+. Gain attendu : sécurité, coût, qualité, adoption.
> Les entrées marquées **ÉCARTÉ** sont des décisions explicites qui ne figurent pas dans le décompte des recommandations.

| Prio | Recommandation | Quoi (concrètement) | Pourquoi | Effort | Gain attendu |
|---|---|---|---|---|---|
| **ÉCARTÉ** | ~~Gating humain sur outils destructifs~~ | **Non retenu — décision utilisateur du 02/09/2026**, et non reporté. Arguments exacts : (1) « le gating humain ne me plaît pas : à chaque fois je me suis retrouvé à devoir confirmer des actions alors que moi je veux juste que la tâche soit faite » ; (2) « on est déjà dans une sandbox — Pi-Web tourne dans un container, c'est une sandbox en soi ; s'il casse quelque chose, pas grave, je redéploie le container ». | Décision utilisateur du 02/09/2026. Les autres harnesses en ont (Cline, OpenCode, Claude Code) : différence assumée, pas un manque. | — | — |
| **ÉCARTÉ** | ~~Sandbox d'exécution~~ | **Non retenue — décision utilisateur du 02/09/2026** pour la même raison : le container Pi-Web est déjà la sandbox. Les références marché (OpenHands Docker, Antigravity `nsjail`, Devin/Codex/Replit cloud, dsh sandbox-plugin) restent factuelles. | Décision utilisateur du 02/09/2026. Le container absorbe les dégâts internes ; un redéploiement suffit. | — | — |
| **P0** | **Garde-fous automatiques silencieux** | **Automatique et silencieux** : jamais de confirmation, jamais de blocage de tâche. Cible uniquement les **4 zones que le container ne protège pas** : (a) le dépôt git monté `/projects/Pi-Web` (un `rm -rf` y est définitif) ; (b) les credentials (`.data/agent-keys.json`, tokens) ; (c) les volumes persistants `.data` (sessions, `model-library.json`, réglages — ils survivent au rebuild) ; (d) l'extérieur (push GitHub, NAS `hlf-data3`, appels LLM payants). Détection à l'exécution + journalisation/alerte + refus ciblé de la commande concernée, sans jamais demander d'accord. | Le container n'est pas la frontière de tout : le dépôt monté et les volumes `.data` **survivent au rebuild**, les credentials ne sont pas restaurés par un redéploiement, et les effets externes (push, NAS, facturation) sont irréversibles. Protège la blast radius réelle **sans introduire la friction refusée**. | **M** | Sécurité ciblée sans friction ; protège ce qu'un redéploiement ne restaure pas |
| **P1** | **Hooks utilisateur / cycle de vie** | Exposer 6-8 événements utiles dans un premier temps (`before_prompt`, `before_tool`, `after_tool`, `before_compact`, `subagent_end`, `session_start`) avec handlers commande/HTTP, code de sortie bloquant. | Rend l'automatisation **déterministe** (lint, sauvegarde pré-compaction, blocage) ; c'est la brique qui manque pour l'écosystème ; prépare les plugins. | **M** | Extensibilité, intégrations, sécurité |
| **P1** | **Skills à chargement progressif** | Dossier de skills `nom + description` chargé au démarrage, corps chargé à l'invocation, **budget partagé** avec éviction des plus anciens (modèle Claude Code) ; ré-injection après compaction. | Réutilise nos procédures (déploiement, review, migration) sans coût de contexte permanent ; complète nos prompts de fonction qui sont aujourd'hui statiques. | **M** | Coût contexte, réutilisabilité, cohérence |
| **P1** | **Routage cascade + budget par agent** | Passer du routage « décision unique » à une **escalade** : cheap d'abord, escalade sur échec/faible confiance ; plafond de tokens/$ par délégué et par tâche ; exposer le coût par sous-agent dans l'UI. | Le routage coupe 60-75 % des coûts ; nos signaux (`toolErrorRate`, `spinning`) sont déjà captés ; évite l'explosion d'un run multi-agents. | **M** | Coût, fiabilité, observabilité |
| **P2** | **Reprise de session UI + export** | Écran de sessions (lister, reprendre, archiver), export JSON/Markdown de la conversation et des boîtes noires ; réutiliser `pi_start`/replay déjà durci (BUG-83/84/85). | Le marché en fait un standard (Muse Code crash-safe, OpenCode navigation parent/enfant, Pi tree-structured) ; répond au « reprendre où on s'est arrêté ». | **M** | UX, adoption, audit |
| **P2** | **Isolation worktree Git pour le parallèle** | Donner à chaque délégué `execute` un worktree Git (branche dédiée) fusionnable, comme Muse Code ; à défaut, un répertoire de travail isolé. | Évite les collisions d'écriture entre sous-agents parallèles ; rend le résultat reviewable et fusionnable ; complète notre vue en colonnes. | **M** | Fiabilité du parallèle, audit |
| **P2** | **Plugins distribuables** | Packager nos extensions locales (`harness-orchestrator`, `codebase-memory`, …) avec un manifeste versionné et un dépôt, à l'image de dsh (`dsh-plugin`) ou Goose (extensions). | Transforme des extensions maison en écosystème ; aligne Pi-Web sur la direction plugin-first du marché (dsh, Goose, OpenClaw). | **M/L** | Extensibilité, adoption, différenciation |

**Ordre d'attaque conseillé** : P0 garde-fous automatiques silencieux → P1 hooks → P1 skills → P1 routage cascade/budget → P2 reprise de session → P2 worktrees → P2 packaging. *(Le gating humain et la sandbox d'exécution sont écartés par décision utilisateur du 02/09/2026 — cf. lignes ÉCARTÉ.)*

---

## 7. Annexe — routage de modèles et modèles de décision (contexte)

Ces éléments ne sont pas des harnesses, mais éclairent deux axes de la grille (portabilité et coût) et une piste d'amélioration de notre triage.

### 7.1 Routage de modèles

- **Deux familles** (`llm-model-routing-routellm-openrouter-notdiamond`) : routeurs **ML appris** (RouteLLM, Not Diamond) qui optimisent qualité/prix, et **agrégateurs** (OpenRouter) qui routent sur des signaux de config (prix, latence, dispo, fallback).
- **Chiffres** : le routage seul coupe **60-75 %** des coûts ; RouteLLM revendique jusqu'à **85 %** ; RouteLLM (LMSYS, juin 2024) : **40 % d'appels au modèle fort en moins avec <5 % de dégradation** sur MT-Bench. OpenRouter : 200+ endpoints, marge 5-10 %. LiteLLM OSS (Apache 2.0) : fallback/retry/load-balancing/coût.
- **Piège** : le routage d'une requête difficile vers un modèle cheap est une fausse économie — un tool call cassé propage l'échec (`llm-model-routing-*`, `llm-routing-*`).
- **Quatre architectures** (`llm-routing-complexity-cost-policies`) : classifieur de complexité, **cascade** (cheap puis escalade), **routage structurel** (modèle par rôle, décidé à la conception, zéro attaque adversariale), fallback/load-balancing. Pour des agents à sorties structurées, le routage structurel est souvent préférable au dynamique.
- **Sécurité des routeurs** : déflation de complexité, inflation de complexité (attaque en coût), sondage de frontière de décision. Contre-mesures : routage structurel, log de toutes les décisions, rate limits par utilisateur.

**Lien avec Pi-Web** : notre routage est aujourd'hui un classifieur (heuristique + LLM optionnel) à décision unique — proche du « routage structurel par catégorie » par ses allowlists, mais sans cascade ni budget. La littérature recommande de **mesurer la qualité après routage** (taux de tool calls valides) plutôt que de se fier à un benchmark conversationnel.

### 7.2 Modèles de décision « System 1 »

- **Jev (TypeSafe AI)** : modèle non autorégressif qui prend un texte + N options et renvoie une probabilité par option en **un seul passage** (RLCD) ; ~150 ms, **0,042 $/M tokens d'entrée** (`laya-system1-decision-engine`).
- **Laya (ConvAI Innovations)** : famille open-weight Apache 2.0, trois primitives — `choice`, `score`, `noul` (P(true)) ; **32,8 ms** sur un GPU unique (7,2 ms/question en batch), **100+ langues** via routage par script Unicode (<2 % d'overhead). ECE 0,081 vs 0,246 pour Jev. **Limites honnêtes** : dégradation au-delà de 20 options, ~0,35 en zéro-shot (nécessite du fine-tuning), calibration de température à ajuster.
- **Jevlike** : réimplémentation indépendante ouverte (MIT) du *shape* (texte + options → probabilité par option) via une tête d'**option-attention + softmax** ; ~98 % sur menus synthétiques, 26-29 % sur Wikispeedia, ~100× plus rapide qu'un petit décodeur en un passage.

**Lien avec Pi-Web** : un modèle System 1 pourrait servir de **classifieur de triage** (catégorie/risque/confiance) à coût quasi nul et latence sub-35 ms, à la place de notre classifieur LLM optionnel — avec la mise en garde sur la calibration et la limite de 20 options. **Non documenté dans les sources** : une intégration de Laya/Jevlike dans un harness existant.

---

*Fin du document. Toute donnée non sourcée est explicitement marquée « non documenté dans les sources ».*
