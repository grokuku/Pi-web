# Pi-Web — Suivi du projet

## 🔴 Bugs à corriger

### Tolérés (phase de dev)

#### BUG-36: Race condition potentielle dans le project manager (lectures non protégées)
- **Fichier :** `backend/src/projects/manager.ts`
- **Sévérité :** 🟢 Basse
- **Description :** Les fonctions de lecture (`getAllProjects`, `getProject`, `getProjectByName`) n'utilisent pas le mutex, contrairement aux fonctions d'écriture. Risque faible car `writeFileSync` est généralement atomique. Rendre ces fonctions async casserait trop d'appelants.
- **Statut :** Accepté — risque acceptable.

#### BUG-49: `docker-compose.yml` — `privileged: true` (sécurité)
- **Fichier :** `docker-compose.yml`
- **Sévérité :** 🟡 Moyenne (sécurité)
- **Statut :** Toléré — non bloquant, phase de dev. Nécessaire pour les montages CIFS.
- **Description :** Le conteneur tourne en mode `privileged` — accès complet à tous les devices du host.

#### BUG-50: `ALLOWED_ORIGINS=*` et `WS_ALLOWED_ORIGINS=*` (sécurité)
- **Fichier :** `docker-compose.yml`
- **Sévérité :** 🔴 Haute (sécurité — en production)
- **Statut :** Toléré — non bloquant, phase de dev. À configurer avant toute exposition internet.
- **Description :** Les deux variables à `*` désactivent toutes les protections CORS et WebSocket.

### Bugs connus non bloquants

#### BUG-03: `reapplyAllSessions()` non awaité
- **Fichier :** `backend/src/routes/model-library.ts`
- **Sévérité :** 🟢 Basse
- **Statut :** Acceptable — le `.catch()` est présent. La réapplication est intentionnellement fire-and-forget.

#### BUG-14: `gitWithAuth` ne restaure pas l'URL en cas d'erreur non-auth
- **Fichier :** `backend/src/projects/git.ts`
- **Sévérité :** 🟡 Moyenne
- **Statut :** Risque faible — `gitWithAuth` ne modifie l'URL que s'il réussit à la lire d'abord.

#### BUG-19: `useChatHistory` instancié par-instance
- **Fichier :** `frontend/src/components/Chat/ChatView.tsx`
- **Sévérité :** 🟢 Basse
- **Statut :** En pratique, une seule instance de ChatView est active à la fois.

#### BUG-23: `MAX_VISIBLE_GROUPS` limite le rendu mais pas le state
- **Fichier :** `frontend/src/components/Chat/ChatView.tsx`
- **Sévérité :** 🟢 Basse (performance)
- **Statut :** Acceptable pour des conversations normales. Envisager la virtualisation si besoin.

---

## ✅ Bugs corrigés (historique)

| # | Sévérité | Description | Date fix |
|---|----------|-------------|----------|
| 01 | 🟡 | Route `POST /:id/git/sync` dupliquée | 2026-06-29 |
| 02 | 🟡 | `syncToModelsJson()` sans `await` | 2026-06-29 |
| 04 | 🟡 | Nettoyage cache attachments cassé | 2026-06-29 |
| 05+34+35 | 🟡 | `require()` en ESM (3 fichiers) | 2026-06-29 |
| 06+32 | 🟡 | `removeModel()` cleanup incomplet (yolo/harness/vision/audio/commit) | 2026-06-29 |
| 07+33 | 🟡 | `deleteProvider()` cleanup incomplet (yolo/harness/vision/audio) | 2026-06-29 |
| 08 | 🟡 | `tool_execution_end` force `isStreaming = true` | 2026-06-23 |
| 09+10 | 🟢 | Fichiers backup / test.db dans le repo | 2026-06-23 |
| 11 | 🟡 | `unhandledRejection` ne termine pas | 2026-06-29 |
| 12 | 🔴 | API Keys agent exposées sans auth | 2026-06-23 |
| 13 | 🟡 | `setGitIdentity` écrit dans le config global | 2026-06-29 |
| 15 | 🟡 | Fuite credentials dans les logs | 2026-06-29 |
| 16 | 🟢 | BroadcastChannel utilise `setPanels` au lieu de `savePanels` | 2026-06-29 |
| 17 | 🟢 | ~~Switch de projet pendant streaming sans confirmation~~ **REVERT** — bloque le travail multi-projet | 2026-06-30 |
| 18 | 🟡 | 3 listeners `pi_event` séparés dans ChatView | 2026-06-29 |
| 20 | 🟢 | Manque d'espaces `===` dans GroupedMessages | 2026-06-29 |
| 21 | 🟡 | Race condition `/new` + `pi_history` | 2026-06-29 |
| 22 | 🟡 | Pas de limite de taille pour localStorage | 2026-06-29 |
| 24 | 🟢 | `showProjectSwitch` / `pendingProject` code mort | 2026-06-29 (via BUG-17) |
| 25+26 | 🟡 | `isPathAllowed` vulnérable + ALLOWED_ROOTS hardcoded | 2026-06-29 |
| 27 | 🟢 | `gitInit` pas de tracking upstream | 2026-06-29 |
| 28 | 🔴 | Command injection dans `pi-settings.ts` | 2026-06-23 |
| 29 | 🔴 | Aucune auth sur la majorité des routes API | 2026-06-23 |
| 30 | 🟡 | `process.exit(0)` sans auth | 2026-06-23 |
| 31 | 🟡 | Route `PUT /reorder` injoignable | 2026-06-29 |
| 37 | 🟢 | `gitClone` utilise deux méthodes différentes | 2026-06-29 |
| 38 | 🟢 | `rmdirSync` deprecated dans `smb.ts` | 2026-06-29 |
| 39 | 🔴 | `session.prompt()` sans timeout | 2026-06-28 |
| 40 | 🟡 | Auto-review ne se déclenche qu'une fois | 2026-06-28 |
| 41 | 🟡 | Impossible de savoir si streaming actif | 2026-06-28 |
| 42 | 🔴 | Stall detector reset `isStreaming` à 60s | 2026-06-29 |
| 43 | 🟡 | CBM perd le mapping après restart | 2026-06-29 |
| 44 | 🟡 | Images ignorées si le modèle n'a pas la vision | 2026-06-29 |
| 45 | 🟡 | ~~Aucun avertissement avant interruption de stream~~ **REVERT** — le steer doit rester possible | 2026-06-30 |
| 46 | 🟢 | Code de sérialisation dupliqué dans `index.ts` | 2026-06-29 |
| 47 | 🟢 | `_ws_reconnect` jamais émis | 2026-06-29 |
| 48 | 🟢 | Conflit de routes API CBM proxy | 2026-06-29 |
| 58 | 🔴 | Harness : session temporaire sans modèle valide → échec immédiat | 2026-06-30 (system prompt fixé + extraction JSON robuste) |
| 59 | 🔴 | Harness v2 + extension v3 : timeout global sur `prompt()` tue les experts actifs (fix porté sur harness-orchestrator : timeout à activité + retry) + bug de réentrance concurrency + pas de timeout sur files d'attente + fix `cbm_code` (`qualified_name` requis par le serveur MCP CBM) | 2026-06-30 |
| 60 | 🟡 | Extension codebase-memory : 4 tools CBM corrigés — cbm_trace (`trace_path` au lieu de `trace_call_path`), cbm_search_code (`pattern` requis au lieu de `query`), cbm_search (`label` string au lieu de `labels` array, ignoré par le serveur), cbm_diff (fallback git local — `detect_changes` inexistant sur le serveur MCP CBM) | 2026-08-01 |

---

## 🟡 Bugs mineurs / améliorations

- **[?] Bouton download sur les fichiers** — Implémenté mais pas testé en conditions réelles (Docker).
- **[?] Extension compaction-checkpoint** — Pas testé en conditions réelles.
- **[?] Historique chat disparait avec 3 panneaux visibles** — `LayoutRenderer.tsx` monte tous les panneaux en permanence (`display:none`). Le state React devrait être préservé, mais des conditions de re-render rares peuvent encore causer le bug.
- **[?] Conflits raccourcis clavier avec le navigateur** — Ctrl+L/T/O sont interceptés par le navigateur. Pistes : `Ctrl+Shift+T` pour thinking, `Ctrl+Shift+O` pour outils, `Ctrl+Shift+L` pour settings.

---

## 💡 Idées pour plus tard

### UX / Frontend

- **Presets de modèles** — Sauvegarder/recharger des configurations complètes de modèles (codeModel, planModel, reviewModel, visionModel, audioModel, commitModel, thinking).
- **Export / Import de config complète** — Exporter toute la configuration en un fichier JSON.
- **Pieces jointes multiples** — À vérifier côté frontend.
- ✅ **Timestamps absolus sur les messages** — Fait.
- ✅ **Onglet Analysis Models dans Settings** — Fait (vision, audio, commit).
- ✅ **Refonte du rendu Thinking + Tools** — Fait (ThinkingBlock, ToolTimeline).
- ✅ **ModelQuickSwitch : tri alphabetique** — Fait.
- ✅ **Thinking : titre sticky au scroll** — Fait.
- ✅ **Paramètre global "Think expand"** — Fait.
- ✅ **Auto-scroll des messages** — Fait (seuil 50px, MutationObserver fallback).
- ✅ **Chart.js pour les graphiques** — Fait (UsageStatsModal).
- ✅ **Onglet Raccourcis clavier dans Settings** — Fait.
- ✅ **Badge outil → expand individuel** — Fait.
- ✅ **Indicateur connexion texte** — Fait.
- ✅ **Provider name dans Analysis Models** — Fait.

### Backend / Architecture

#### 🎵 Analyse Audio (⚠️ implémentation partielle)

**État actuel :** Un seul champ `audioModelId`, pas d'implémentation réelle. L'analyse audio renvoie un placeholder.

**Architecture souhaitée :** Deux modes distincts — transcription (Whisper) et analyse (multimodal). Remplacer `audioModelId` par `audioTranscriptionModelId` + `audioAnalysisModelId`.

#### 📄 Analyse PDF visuelle (texte + images)

Extraire à la fois le texte ET les images de chaque page (pdfjs-dist + OCR fallback).

#### Autres idées Backend

- ✅ **Statistiques d'utilisation des tokens** — Fait.
- 💡 **Limite d'appels LLM en parallèle par provider** — Remplacer la limite globale (`maxLLMSlots`) par une limite par provider (ex: 3 pour OpenRouter, 2 pour OpenAI). Permettrait de mieux répartir la charge selon les quotas/RPM de chaque provider. Non prioritaire.
- 💡 **Nettoyage automatique des attachments orphelins** — Cron ou déclencheur.
- 💡 **Rate limiting** sur les uploads.
- 💡 **Streaming des résultats d'analyse** — Pour les gros PDFs.
- 💡 **Mise à jour progressive des attachments via WebSocket**.

### Agent

- ✅ **LLM conscient de son mode** — Fait (MODE_INSTRUCTIONS, MODE_IDENTITIES).
- ✅ **API agent externe** — Fait (routes, auth Bearer, docs).
- **Extension Slack/Discord** — Notifications de build/déploiement.
- **Extension Git hooks** — Analyses automatiques sur push.

---

## 🏗️ Architecture — Pi-Web Harness (v2 → v3)

### État actuel (v2) — Mode HARNESS optionnel

Mode YOLO déprécié, remplacé par le mode **HARNESS** : orchestration multi-agent avec rôles spécialisés.

```
1. TECH LEAD (/harness en mode CODE) → synthétise un BRIEF
2. ARCHITECTE → explore le code, produit un PLAN (JSON)
3. EXÉCUTION → agents spécialisés par tâche (context isolation)
4. RAPPORT FINAL → synthèse par phase dans le chat
```

### Cible (v3) — HARNESS par défaut (chef de projet)

**Décision :** Passer HARNESS en mode unique par défaut. L'agent principal devient un **chef de projet** qui orchestre les experts.

**Rôle de l'orchestrator (chef de projet) :**
- Répond directement aux questions simples, conseils, explications
- Délègue l'exécution (code, debug, review, test) aux experts
- Appelle l'architecte pour les tâches complexes (plusieurs fichiers, approche incertaine, nouvelle feature)
- Ne code JAMAIS, ne débugge JAMAIS, ne planifie JAMAIS
- Si un expert signale qu'une tâche simple est devenue complexe → l'orchestrator peut appeler l'architecte

**Flow :**
```
1. UTILISATEUR → parle à l'orchestrator
2. ORCHESTRATOR → évalue la complexité
   a. Question simple → répond directement
   b. Tâche simple → délègue à l'expert approprié
   c. Tâche complexe → appelle l'architecte → plan → experts
3. EXPERT → exécute, remonte le résultat (ou signale une complexité)
4. ORCHESTRATOR → présente le résultat à l'utilisateur
```

**Prérequis :**
1. Fixer BUG-58 (harness produit `content: []`)
2. Sessions persistantes par rôle (pas de recréation à chaque appel)
3. Redéfinir le system prompt de l'orchestrator
4. Supprimer les modes CODE/PLAN/REVIEW de l'UI (ou les garder cachés en fallback)

### Pool d'agents (12 rôles)

Architect, Backend Dev, Frontend Dev, Database Engineer, API Designer, Code Reviewer, QA Tester, Test Writer, Docs Writer, DevOps, Security Reviewer, Refactoring Specialist.

### Fichiers

| Fichier | Rôle | Statut |
|---------|------|--------|
| `backend/src/pi/harness-engine.ts` | Orchestrateur | ✅ (BUG-58+59 corrigés) |
| `backend/src/pi/concurrency.ts` | Concurrence | ✅ (BUG-59 corrigé) |
| `backend/src/pi/model-library.ts` | Types, pool, persistance | ✅ |
| `backend/src/pi/session.ts` | Intégration /harness | ✅ |
| `frontend/src/components/Modals/HarnessConfigModal.tsx` | UI config | ✅ |
| `frontend/src/components/Header/ModelQuickSwitch.tsx` | Toggle harness | ✅ |
| `extensions/harness-orchestrator/index.ts` | Extension v3 (orchestrator conversationnel) | ✅ (BUG-59 porté : timeout à activité + timeout global + retry) |
| `extensions/codebase-memory/index.ts` | Extension CBM (cbm_* tools) | ✅ (BUG-59 cbm_code : envoi `qualified_name`) |

### Fonctionnalités futures

| Fonctionnalité | Priorité |
|----------------|----------|
| HARNESS par défaut (v3 chef de projet) | P1 (après BUG-58) |
| Sessions persistantes par rôle | P1 (avec v3) |
| Parallélisme intra-phase | P3 |
| Technical Knowledge Base (cache firecrawl + TTL) | P3 |
| User Knowledge Base | P4 |
| Quality Gates Pipeline (lint → build → review → test → security) | P4 |
| Dark Factory (agents persistants, jobs async) | P6 |

---

## 🤝 Réflexion : Services Partagés (Architecture)

### Contexte
- Multiples agents LLM : Pi-Web, Openclaw, Hermes, nodes Ollama, etc.
- Besoin de services communs (libraire, mémoire) sans duplication
- Contrainte : isolation entre agents publics et privés

### Décision : Pi-Web comme hub central (Option C)
- Garder Pi-Web monolithique (pas de split UI/Engine)
- Exposer les services via REST API (déjà existantes)
- Ajouter une authentification API Key pour les agents externes
- Localhost = bypass (Pi-Web interne), externe = `X-API-Key` obligatoire
- Si un jour trop de services → extraire un Pi-Engine (pas pour maintenant)

### Pourquoi pas les autres options
- **Microservices séparés** → trop de containers, trop de config, déplace le problème
- **Split Pi-Web (UI + Engine)** → 2× complexité ops, pas nécessaire maintenant

### Protocole : REST API (pas MCP)
- REST = universel (curl, Python, JS, n'importe quel agent)
- MCP = intéressant mais écosystème encore jeune, pas tous les agents le supportent
- MCP possible plus tard comme wrapper léger si besoin

### Libraire — Service partagé (IMPLÉMENTÉ)

| Aspect | Détail |
|---|---|
| Fonctions | Recherche web + stockage documentation |
| Sanitize | `sanitizeContent` : emails, clés API, chemins, téléphones — aucune info perso stockée |
| Scan de projet | Supprimé des routes partagées (leak potentiel) |
| Auth externe | API Key (commit `3d09092`) |
| Doc agents | `docs/shared-services.md` (commit `20be234`) |
| Recherche | Bibliothèque locale → Webclaw scrape → Tavily (optionnel) → DuckDuckGo fallback |
| LLM synthèse | Pi SDK `completeSimple` (couplage OK, reste dans Pi-Web) |

### Libraire — État et Améliorations

#### ✅ Implémenté

| Fonctionnalité | Détail |
|---|---|
| Recherche web | Webclaw scrape → Tavily optionnel → DuckDuckGo fallback |
| Recherche locale prioritaire | `searchLocalDocs` avant `webclawSearch` |
| Tool `librarian_search` | Recherche dans le chat, retourne les résultats au LLM |
| Tool `librarian_archive` | Le LLM décide d'archiver quand c'est de la doc technique |
| Hint `💡` | Dans les résultats de recherche pour inciter le LLM à archiver |
| Sanitization | Emails, clés API, chemins perso, téléphones supprimés |
| Auth API Key | Pour agents externes (localhost bypass pour Pi-Web) |
| Scanner de projets étendu | Cherche `package.json` dans sous-dossiers (backend/, frontend/, etc.) |
| Cron hebdomadaire | Synthèse LLM via `completeSimple` (Pi SDK) |
| Déduplication DuckDuckGo | Par URL |
| Doc agents externes | `docs/shared-services.md` |

#### 🔧 À Améliorer

**Recherche sémantique**
> Le matching local actuel est basique (string matching sur `name` + `description` + `keywords`). Une recherche sur « système de messages » ne trouvera pas une doc archivée sous « hermes ».

- Embeddings (Ollama ou OpenRouter) pour la recherche sémantique
- Ou LLM-based keyword extraction au moment de l'archivage (générer des synonymes/tags)

**Synthèse à la volée**
> L'archivage stocke le contenu brut (`rawContent`). Le cron fait une synthèse LLM hebdomadaire, mais l'archivage manuel via `librarian_archive` ne synthétise pas.

- Option : ajouter une étape de synthèse LLM dans `librarian_archive` si un modèle est disponible

**Gestion des versions**
> Si la doc d'Express 4.21 est archivée et qu'on cherche Express 5, le système retourne la 4.21.

- Détecter les conflits de version et prioriser la version la plus récente

**Expiration / mise à jour**
> Les docs archivées manuellement n'ont pas de date d'expiration. Le cron ne met à jour que les docs qu'il a lui-même créées.

- Ajouter un mécanisme de staleness pour toutes les docs

### Webclaw self-hosté — Limitations identifiées

| Capacité | Statut |
|---|---|
| Scrape pages statiques | ✅ |
| TLS fingerprinting (bot protection basique) | ✅ |
| `/v1/search` | ❌ (501 sur self-hosted) |
| JS rendering | ❌ (Twitter/X retourne vide) |
| Cloudflare bypass | ⚠️ Partiel |

**Fallbacks :**
- **DuckDuckGo** scrape via `/v1/scrape`
- **Tavily** (optionnel) : API search propre, 1000 recherches/mois gratuit
- **Playwright / FlareSolverr** : pas nécessaires pour la doc technique (quasi toujours statique)

### Mémoire partagée — À VENIR
- Namespaces obligatoires : `public`, `agent:<id>`, `private`
- Agent public (Openclaw) → voit `public` + `agent:openclaw`
- Agent privé (Hermes) → voit `public` + `agent:hermes` + `private`
- Même pattern que le libraire (REST API + API Key + stockage JSON)

### Futurs services possibles

| Service | Description |
|---|---|
| Mémoire partagée | Namespaces `public` / `agent:<id>` / `private` |
| Scrape direct | Webclaw sans passer par le libraire |
| CBM scoped par projet | Codebase memory par projet |
| Event bus inter-agents | Communication asynchrone entre agents |

---

## 📋 État actuel du système

### Upload & Analyse de fichiers

| Composant | Statut |
|---|---|
| Upload (frontend) | ✅ |
| Stockage (backend) | ✅ |
| Analyse PDF | ✅ |
| Analyse images | ✅ (fallback modèle vision) |
| Analyse texte/code | ✅ |
| Analyse audio | ⏳ (placeholder) |
| Analyse vidéo | ⏳ (placeholder) |
| Download | ✅ |
| Suppression avec projet | ✅ |
| Cache d'analyse | ✅ |

### Outils Pi (extensions)

| Extension | Outil | Statut |
|---|---|---|
| file-analyzer | `analyze_file` | ✅ |
| compaction-checkpoint | `session_compact` | ✅ |
| @pi-unipi/memory | `memory_store/search/delete/list` | ✅ |
| @benvargas/pi-firecrawl | `firecrawl_scrape/map/search` | ✅ |
| codebase-memory | `cbm_search/trace/code/arch/diff/schema` | ✅ |

### Modèles d'analyse

| Type | Config | Endpoint |
|---|---|---|
| Vision | `visionModelId` | `PUT /api/model-library/vision-model/:id` |
| Audio | `audioModelId` | `PUT /api/model-library/audio-model/:id` |
| Commit | `commitModelId` | `PUT /api/model-library/commit-model/:id` |

### Modes

| Mode | Statut | Comportement |
|---|---|---|
| CODE | ✅ | Tous les outils + extensions |
| PLAN | ✅ | Lecture seule, pas de bash modifiant l'état |
| REVIEW | ✅ | Lecture seule + bash read-only |
| YOLO | ⏳ Déprécié | Conservé dans le code, masqué de l'UI |
| HARNESS | ✅ | Architecte → agents spécialisés, context isolation |
| Auto-review | ✅ | Review neutre + fix après prompt CODE |

### Routes API

| Catégorie | Endpoint | Statut |
|---|---|---|
| Modèles | `/api/model-library/*` | ✅ |
| Projets | `/api/projects/*` | ✅ |
| Fichiers | `/api/files/*` | ✅ |
| Attachments | `/api/attachments/*` | ✅ |
| Usage | `/api/usage/*` | ✅ |
| Pi | `/api/pi/*` | ✅ |
| Agent | `/api/agent/*` (Bearer auth) | ✅ |
| Agent Keys | `/api/agent-keys/*` (adminAuth) | ✅ |
| Providers | `/api/providers/*` | ✅ |
| Ollama | `/api/ollama/*` | ✅ |
| Sessions | `/api/sessions/:id/*` | ✅ |
| Health | `/api/health`, `/api/agent/health` | ✅ |
| CBM | `/api/cbm/*` | ✅ |

---

## 🔧 Architecture (référence rapide)

```
Frontend (React, TypeScript, Tailwind, Vite)
  ├── ChatView.tsx → WebSocket → pi_prompt / pi_event
  ├── SettingsModal.tsx → onglets : Models, Analysis, Extensions, General, Layout, API Keys
  ├── ModelQuickSwitch.tsx → boutons CODE/PLAN/REVIEW + dropdowns
  ├── ThinkingBlock.tsx + ToolTimeline.tsx → streaming
  ├── UsageStatsModal.tsx → stats tokens
  └── FileExplorer.tsx → arbre + prévisualisation + édition

Backend (Express + WebSocket + node-pty + Pi SDK)
  ├── /api/attachments/* → upload, serve, analyze, delete
  ├── /api/model-library/* → CRUD modèles, modes projet
  ├── /api/usage/* → stats tokens
  ├── /api/pi/* → settings, packages, reload
  ├── /api/agent/* → agent externe (Bearer auth)
  ├── /api/agent-keys/* → tokens agent (adminAuth)
  ├── /api/* → auth globale (apiAuth middleware)
  └── pi/session.ts → orchestration sessions, modes, harness, auto-review

Extensions Pi
  ├── file-analyzer/ → analyze_file tool
  ├── compaction-checkpoint/ → session_compact event
  └── codebase-memory/ → cbm_* tools (graph-based code intelligence)

Stockage
  /data/
    ├── attachments/<uuid>/<file> + meta.json + cache/
    ├── usage/YYYY-MM-DD.json
    └── model-library.json

Pi config
  ~/.pi/agent/
    ├── settings.json     ← extensions, skills, prompts, themes
    ├── models.json       ← providers + models (synced)
    └── sessions/projects/<projectId>/
```