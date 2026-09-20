# Audit — usage réel des outils par les agents (orchestrateur + sous-agents)

- **Date** : 2026-09-20
- **Périmètre** : Pi-Web, mode harness (`extensions/harness-orchestrator/index.ts`) + sous-agents des 4 fonctions de routage (`planning` / `execute` / `review` / `integrate`).
- **Nature** : rapport factuel, basé sur les données de production et les transcripts réellement présents sur disque. **Aucun fichier de production modifié.**
- **Contexte** : les allowlists viennent d'être corrigées (commit `df43796` puis `081d282`) pour donner les 8 tools CBM (`cbm_*`) aux rôles `execute`/`review`/`integrate`, avec une consigne « privilégie les tools CBM » dans chaque prompt.

---

## 1. Sources de données localisées

| # | Source | Emplacement réel | État | Usage dans l'audit |
|---|--------|------------------|------|--------------------|
| 1 | Sessions principales (orchestrateur) | `~/.pi/agent/sessions/projects/<projectId>/*.jsonl` | ✅ présent | 154 sessions (dont **Pi-Web = `dd5e824c-…`, 13 fichiers**) |
| 2 | Sessions « temp » des sous-agents | `~/.pi/agent/sessions/--projects-<nom>--/*.jsonl` (`SessionManager.create(cwd)` sans dir → chemin par défaut) | ✅ présent | 28 sessions Pi-Web (dont **2 encore vivantes à 12:05**, cf. infra) |
| 3 | Archives « boîte noire » des délégués en échec | `/app/.data/logs/harness/<ts>-<fonction>-<cause>.jsonl` + `.meta.json` | ✅ présent | **4 archives** (1 planning, 3 execute) — seuls transcripts de sous-agents en échec conservés |
| 4 | Résumés d'activité des sous-agents | entrées `custom_message` / `customType:"subagent_activity"` dans la session principale | ✅ présent | **8 entrées** (toutes `execute`) avec la liste complète des actions + erreurs |
| 5 | Journaux backend | `/app/.data/logs/backend-20260919.log`, `backend-20260920.log` | ✅ présent | catégories `ws` uniquement ; **pas de ligne `pi-session`/`harness` de tool calls** (139 + 215 lignes) |
| 6 | Logs CBM | `/app/.data/cbm/logs/projects-Pi-Web-*.log` | ✅ présent | rapports d'indexation seulement (pas de compteur d'appels tools) |
| 7 | Usage modèles | `/app/.data/usage/*.json` | ✅ présent | tokens fournisseur (non utilisé ici) |
| 8 | `.data/` dev (`/projects/Pi-Web/.data/`) | — | ⚠️ quasi vide (agent-keys, projects.json) — **pas de logs** | — |

> **Constat important sur les logs backend** : ils ne journalisent **que** le WebSocket (`114/139` lignes `[ws]`). Il n'existe **aucune** catégorie `console`/`pi-session`/`harness` exploitée pour compter les tool calls côté backend. La seule vraie source d'usage des outils = **les transcripts JSONL du SDK** (sources 1, 2, 3, 4). C'est ce qui a été analysé.

**Deux layouts de sessions coexistent** (à retenir) :
- `sessions/projects/<projectId>/` → sessions **principales persistantes** (orchestrateur) ;
- `sessions/--projects-<nom>--/` → sessions **temp des sous-agents** créées par `SessionManager.create(cwd)` dans le délégué (supprimées en cas de succès, archivées en cas d'échec).

---

## 2. Chiffres clés

### 2.1 Orchestrateur Pi-Web (session persistante `dd5e824c`)

Total sur 13 fichiers : **5 450 tool calls**.

| Outil | Appels | | Outil | Appels |
|---|---:|---|---|---:|
| `bash` | 2 152 | | `cbm_code` | 61 |
| `read` | 1 259 | | `cbm_search` | 47 |
| `edit` | 795 | | `memory_store` | 42 |
| `delegate` | 274 | | `firecrawl_scrape` | 42 |
| `grep` | 170 | | `librarian_search` | 62 |
| `delegate_to_expert` (legacy) | 128 | | `cbm_cypher` | 22 |
| `cbm_search_code` | 91 | | `web_screenshot` | 2 |
| `ls` | 71 | | `preview_html` | 2 |
| `analyze_file` | 62 | | … | |

- **Tools CBM : 245 / 5 450 = 4,5 %** des appels de l'orchestrateur (à comparer aux 2 152 `bash` + 1 259 `read`).
- Tous les 8 tools `cbm_*` sont présents, mais `cbm_trace` (5) et `cbm_schema` (2) sont quasi ignorés.
- Répartition des délégations : `execute` 208, `review` 56, `planning` 6, `integrate` **0** ; anciens rôles legacy encore massifs (`backend-dev` 88, `frontend-dev` 19…).
- **51 occurrences de « Tool … not found »** dans le seul fichier `2026-08-22T09-48-45-901Z_01a028df-…jsonl`.

À l'échelle de **tous les projets** (154 sessions) : **26 300 tool calls**, CBM = 2 212 (**8,4 %**), `bash` 7 707, `read` 5 690, `edit` 3 887, `delegate` 1 285 + `delegate_to_expert` 1 164. Délégation par nouvelle fonction : `execute` 1 002, `review` 172, `planning` 86, **`integrate` 4**.

### 2.2 Sous-agents

| Population | Sessions | Tool calls | Dont CBM |
|---|---:|---:|---:|
| Sessions « temp » Pi-Web (`--projects-Pi-Web--`) | 28 | 7 911 | **1** (`cbm_arch`) |
| ↳ dont sous-agents récents (≥ 2026-09-18, tous projets) | 8 | 458 | **1** |
| Résumés `subagent_activity` (8 délégués `execute`) | 8 | 298 actions | **0** |
| Archives harness (délégués en échec) | 4 | 99 | **0** |

**Top outils des sous-agents** (résumés `subagent_activity`, 8 délégués) :
`bash:160`, `read:93`, `edit:30`, `grep:10`, `find:3`, `file:1` (inconnu → erreur), `ls:1`, `write:1` — **zéro `cbm_*`**.

Les 8 délégués `execute` ont duré **1 825 s cumulées** (jusqu'à **524 s** pour un seul) pour ~37 actions en moyenne (jusqu'à **138 actions**).

### 2.3 Outils disponibles JAMAIS utilisés par les sous-agents

Dans l'allowlist des sous-agents, **7 des 8 tools CBM ne sont jamais appelés** :
`cbm_search`, `cbm_trace`, `cbm_code`, `cbm_search_code`, `cbm_diff`, `cbm_cypher`, `cbm_schema` (seul `cbm_arch` apparaît **1 fois**).
Tools hors allowlist sous-agent (donc indisponibles) et de fait inutilisés : `memory_*`, `librarian_*`, `open_preview`, `preview_html`, `log_commit_note`, recherche web (`firecrawl_*`/`librarian_search`).

> Côté orchestrateur, **tous** les outils du registre sont utilisés au moins une fois — le problème n'est donc pas l'inexistence d'un outil, mais sa **sous-utilisation** (CBM, `analyze_file`) ou son **mauvais ciblage** (bash/read).

---

## 3. Trois problèmes majeurs

### 🔴 Problème 1 — Fuite du mode harness : l'orchestrateur tente en boucle les tools d'exécution qui lui sont retirés
En mode harness, `applyModeToSession` active `HARNESS_TOOLS = []` (aucun tool de base) ; `bash/edit/read/grep/write` sont donc **désactivés** et seul `delegate` (+ CBM + customTools) est disponible. Pourtant :

| Tool « not found » | Occurrences (toutes sessions) |
|---|---:|
| `bash` | **155** |
| `edit` | **97** |
| `read` | **78** |
| `grep` | **45** |
| `write` | **11** |
| **Sous-total fuite exécution** | **386** |
| `delegate` / `delegate_to_expert` | 52 / 30 |
| **Total « Tool … not found »** | **540** |

- Dans la seule session principale Pi-Web : `2026-08-22T09-48-45-901Z_…jsonl` → **20× bash**, **14× delegate**, **8× delegate_to_expert**, 6× edit, 4× read, 4× grep…
- Le prompt dit pourtant : *« Execution tools … are NOT available to you — if a tool is 'not found', that is the signal to DELEGATE, never to wait or retry directly. »* Le modèle **ne respecte pas** la consigne.
- **Cause** : (1) historique persistant où l'orchestrateur a *réellement* codé (modes non-harness) → il imite son passé ; (2) description d'erreur du SDK peu discriminante ; (3) `delegate_to_expert` legacy encore présent dans l'historique (30 « not found » malgré la normalisation). Le commentaire du code confirme : *« sans ça le modèle imite son propre passé et rappelle un tool inexistant (mode harness bloqué) »*.
- **Impact** : un tour LLM gaspillé par tentative (≈ 386 tours), latence et tokens, et risque d'**abandon** d'une tâche harness faute de savoir déléguer.
- **Où** : `backend/src/pi/session.ts` (HARNESS_TOOLS/HARNESS_EXCLUDE, `normalizeLegacyDelegateToolNames`) + `extensions/harness-orchestrator/index.ts` (promptGuidelines).

### 🔴 Problème 2 — Les sous-agents n'utilisent pas les tools CBM, malgré la correction d'allowlist et la consigne prompt
- 8 délégués `execute` récents (Sep 19–20) : **298 actions, 0 `cbm_*`**.
- Sessions temp Pi-Web : **1 seul `cbm_arch` sur 7 911 tool calls**.
- Les 4 archives d'échec (dont un `execute` de **1 800 s** en `timeout-global`) : **0 `cbm_*`** — le sous-agent *parle* de CBM (grep de `cbm_*` dans les fichiers) mais **ne l'appelle jamais**.
- **Preuve post-fix** (déploiement `extensions/` et `dist/` le 2026-09-20 10:14) : les 2 sessions temp encore vivantes à 12:05 (tâche « veille » et tâche « audit » — cette dernière étant l'audit lui-même) totalisent **1 `cbm_arch`** et ~45 `bash`/`read`.
- **Cause** : la consigne CBM est **noyée** dans un long prompt ; la description des tools CBM (`extensions/codebase-memory/index.ts`) décrit le graphe mais pas *quand* préférer CBM à `read` ; l'historique/les conventions de l'agent favorisent `read`+`grep` ; sur des tâches « explorer des fichiers non indexés » (Dockerfile, entrypoint.sh), CBM n'aide pas, mais sur du code indexé il aurait dû être utilisé.
- **Impact** : explosions d'actions (jusqu'à **138 actions / 524 s** pour une tâche), `read` tronqués à 50 KB relus plusieurs fois (cf. `read extensions/harness-orchestrator/index.ts` puis `read … index.ts` encore et encore dans les actions #1/#3), tokens gaspillés.

### 🔴 Problème 3 — Outils manquants chez les sous-agents : pas de web, pas de mémoire, pas de libraire
La tempSession des délégués est créée via `createAgentSession` **sans `customTools`** → elle ne dispose que des tools d'extension (`cbm_*`, `analyze_file`, `web_screenshot`) filtrés par l'allowlist. Contrairement à l'orchestrateur, les sous-agents **n'ont pas** : `memory_store/search/delete`, `librarian_search/archive`, `open_preview`/`preview_html`, `log_commit_note`, et **aucune recherche web** (`firecrawl_*`/`librarian_search`).

Conséquences observées :
- La tâche « veille » a dû être **compensée manuellement par l'utilisateur** : *« IMPORTANT : tu n'as PAS d'accès web (l'outil de recherche web n'est pas disponible chez les sous-agents). Toute la matière est … »* (prompt de la session `--projects-Pi-Web--/2026-09-20T12-05-28-849Z_01a0beb5-0291-…jsonl`).
- Les sous-agents ne peuvent ni consulter ni enrichir la mémoire partagée → re-découverte, perte de connaissance entre délégations.
- **Cause** : choix d'isolation (pas de `customTools` sur la tempSession) ; allowlist harness-orchestrator volontairement réduite.
- **Impact** : tâches bloquées ou dégradées, contournements manuels, incohérence orchestrateur/sous-agents.

---

## 4. Analyse détaillée par catégorie

### (a) Explorations inefficaces (`read`/`grep`/`ls` au lieu de CBM)
- 8 délégués `execute` : `bash:160` + `read:93` + `grep:10` + `ls:1` + `find:3` = **267 actions fichiers** pour **0 `cbm_*`**.
- Exemple type (résumé `subagent_activity`, délégué `d-1789892418417-5da6`, **138 actions / 524 s**) : `read` répété 4× sur le même `ChatView.tsx` (899 l. puis 465, 471, 264 l.) — un `cbm_code` ciblé sur le symbole aurait remplacé la relecture.
- Les `read` sont **tronqués à 50 000 chars** (`outputChars:50062`, `truncated:true`) → le modèle relit en plusieurs passes.
- Ratio global orchestrateur : CBM ne représente que **4,5 %** des appels Pi-Web alors que `read`+`bash`+`grep` = 65 %.

### (b) Erreurs d'outil / paramètres / retries
- **540 « Tool … not found »** (dont 386 = tools d'exécution en harness) — cf. Problème 1.
- **Noms de tools hallucinés** confirmés dans les actions : `file` (« Tool file not found », action seq 3 du délégué `d-1789891912131-d5d0`), `write_file`, `task`, `tail`, `head`, `git`, `edits`, `show_prompt`, `cbm_search_graph`, `search_code`, et une chaîne corrompue enregistrée comme nom d'outil : `cbm_search_query_fallback: cbm_code peer, use read instead<tool_call>bash`.
- **Erreurs d'édition `oldText`** (params) : ex. `« Could not find edits[0] … The oldText must match exactly including all whitespace and newlines. »` et `« Found 2 occurrences of edits[1] … Each oldText must be unique. »` — `edit` cumule **576 erreurs** (tous orchestrateurs) et **173** côté sous-agents Pi-Web.
- **Erreurs `bash`** : 573 (tous orchestrateurs) / 242 (sous-agents Pi-Web), souvent `wc/cat` sur mauvais chemin (`wc: components/ChatView.tsx: No such file…`) → chemins devinés plutôt que résolus.
- Le `powershell` est bloqué sur Linux, mais apparaît quand même (`powershell:17`, `17` erreurs) — garde côté exécution, pas côté activation.

### (c) Abandons / contournements
- Contournement documenté pour l'absence de web (Problème 3) : l'opérateur réécrit la tâche pour interdire l'outil manquant.
- Le prompt harness doit explicitement rappeler *« si un tool est 'not found', c'est le signal de DÉLÉGUER »* : c'est un pansement à un comportement défaillant, pas une garantie.
- Le placeholder `Tool X not found` (15 occurrences) montre des exemples/templates recopiés littéralement.

### (d) Outils sous-utilisés malgré leur intérêt
- `cbm_trace` (5/26 300 chez les orchestrateurs ; 0 chez les sous-agents) : « qui appelle quoi » — exactement le besoin des revues.
- `cbm_diff` (27) : analyse d'impact d'un changement non commité — sous-employé en review.
- `analyze_file` (220/26 300) et `web_screenshot` (133) : très faible part alors qu'ils couvrent analyse de pièces jointes et vérification UI.
- `integrate` : **4 délégations** seulement (0,3 % des nouvelles fonctions) — la synthèse finale est quasi toujours faite par l'orchestrateur lui-même.

---

## 5. Recommandations priorisées

| # | Prio | Action | Détail / fichier cible |
|---|------|--------|------------------------|
| 1 | **S** | **Rendre l'erreur « tool not found » auto-routante en harness** | Intercepter le résultat d'un tool désactivé et réinjecter un message système court : *« `bash` est désactivé en harness — appelle `delegate(function:"execute")`. »* Sinon le modèle retente. Cible : `extensions/harness-orchestrator/index.ts` (promptGuidelines) + `backend/src/pi/session.ts`. |
| 2 | **S** | **Normaliser/éliminer `delegate_to_expert` de l'historique** | 30 « not found » : étendre `normalizeLegacyDelegateToolNames` aux *toolResult* et aux messages assistant persistés, ou ajouter un alias runtime `delegate_to_expert → delegate`. |
| 3 | **S** | **Forcer les tools CBM par défaut quand ils existent** | Ajouter aux prompts une règle opérationnelle chiffrée : *« Avant tout 2e `read` sur un fichier, tente `cbm_code` ; avant tout `grep` structurel, tente `cbm_search`/`cbm_trace` »*, et **retirer `grep` de l'allowlist `execute`** (ou le marquer « dernier recours ») pour casser le réflexe. |
| 4 | **M** | **Garde-fou anti-spam d'exploration** | Compter les `read`/`grep` consécutifs par sous-agent ; au-delà de N sans `cbm_*`, injecter un rappel (« utilise le graphe »). Réutiliser le compteur `actionCount` déjà présent (`subagent_activity`). |
| 5 | **M** | **Exposer les outils manquants aux sous-agents** | Passer `customTools` (memory_*, librarian_search, preview) à la tempSession des délégués via `createAgentSession` dans `extensions/harness-orchestrator/index.ts`, ou au minimum autoriser `librarian_search` en **lecture** (contexte local) pour `planning`/`review`/`integrate`. |
| 6 | **M** | **Ouvrir la recherche web (ou un substitut local) selon le rôle** | La tâche « veille » prouve le besoin. Ajouter `librarian_search`/un tool web read-only à `planning`/`review`, avec quota. |
| 7 | **M** | **Renforcer `edit`** | 576 + 173 erreurs `oldText` : ajouter un tool `edit` plus tolérant (ancrage par symbole via `cbm_code`) ou améliorer la description (obligation d'inclure un contexte unique). |
| 8 | **M** | **Instrumenter les tool calls côté backend** | Les logs ne montrent rien hors `[ws]` : ajouter une catégorie `pi-tools` (nom, rôle, durée, isError) pour des métriques sans reparser les JSONL. |
| 9 | **L** | **Dédupliquer l'allowlist depuis une source unique** | Les listes `CBM_TOOLS` (extension) et `HARNESS_TOOLS`/`HARNESS_EXCLUDE` (backend) sont dispersées → risque de divergence (cf. `cbm_search_graph`, `search_code`). Une constante partagée évite les noms fantômes. |
| 10 | **L** | **Promouvoir `integrate` et `planning`** | `integrate` quasi jamais utilisé : rendre la synthèse finale obligatoire pour les tâches complexes (workflow plan → execute → review → integrate) et mesurer l'adoption. |

---

## 6. Exemples cités (fichiers / sessions réels)

1. **Fuite harness** — `~/.pi/agent/sessions/projects/dd5e824c-bc11-41fa-9b81-c2914774a954/2026-08-22T09-48-45-901Z_01a028df-6bcd-7ae2-960c-6755640726e7.jsonl` : 51 « Tool not found » (20 bash, 14 delegate, 8 delegate_to_expert, 6 edit, 4 read, 4 grep…). Total global : 540.
2. **Sous-agent 0 CBM** — `/app/.data/logs/harness/20260919-195911-execute-timeout-global.jsonl` + `.meta.json` : `function:"execute"`, `durationMs:1800691` (~30 min), `eventCount:64746` → 54 événements, outils = `bash/read/ls/grep/find`, **0 `cbm_*`**.
3. **Action hallucinée** — résumé `subagent_activity` `d-1789891912131-d5d0` : action `seq:3`, `toolName:"file"`, `isError:true`, `summary:"erreur — Tool file not found"`.
4. **Exploration redondante** — résumé `subagent_activity` `d-1789892418417-5da6` : 4 `read` sur le même `ChatView.tsx` (899/465/471/264 lignes, `truncated:true`), `actionCount:138`, `durationMs:524490`.
5. **Contournement outil manquant** — `~/.pi/agent/sessions/--projects-Pi-Web--/2026-09-20T12-05-28-849Z_01a0beb5-0291-74e6-9662-9bd07b4af9e0.jsonl` (sous-agent « veille ») : prompt *« tu n'as PAS d'accès web (l'outil de recherche web n'est pas disponible chez les sous-agents) »* ; outils réellement appelés : `bash:9`, `read:11`, `cbm_arch:1`, `grep:1`.
6. **Nom d'outil corrompu** — session principale Pi-Web : un toolCall enregistré sous `cbm_search_query_fallback: cbm_code peer, use read instead<tool_call>bash` (puis « Tool … not found »).
7. **Erreur d'édition** — session principale Pi-Web : `« Could not find edits[0] in …/AddProjectModal.tsx. The oldText must match exactly… »` (répété).

---

## 7. Limites de l'audit

- Les sessions principales sont **persistantes et mixtes** (un même fichier contient plusieurs modes, normal *et* harness). Les compteurs `bash`/`read` de l'orchestrateur ne sont donc **pas** tous imputables au mode harness ; en revanche, les **erreurs « not found »** (386 tools d'exécution) sont, elles, la preuve directe de tentatives en mode harness.
- Les sous-agents en **succès** voient leur session temp **supprimée** : l'échantillon « complet » le plus fiable = les 8 résumés `subagent_activity` + les 4 archives d'échec + les 2 temp encore vivantes (12:05). Les grands volumes « temp Pi-Web » (7 911 calls) incluent des sessions historiques hors harness.
- Les logs backend n'offrent pas de comptage de tools ; tout repose sur le parsing des JSONL du SDK.
