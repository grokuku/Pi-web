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
| 17 | 🟢 | Switch de projet pendant streaming sans confirmation | 2026-06-29 |
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
| 45 | 🟡 | Aucun avertissement avant interruption de stream | 2026-06-29 |
| 46 | 🟢 | Code de sérialisation dupliqué dans `index.ts` | 2026-06-29 |
| 47 | 🟢 | `_ws_reconnect` jamais émis | 2026-06-29 |
| 48 | 🟢 | Conflit de routes API CBM proxy | 2026-06-29 |

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

## 🏗️ Architecture — Pi-Web Harness (v2)

Mode YOLO déprécié, remplacé par le mode **HARNESS** : orchestration multi-agent avec rôles spécialisés.

### Flux

```
1. TECH LEAD (/harness en mode CODE) → synthétise un BRIEF
2. ARCHITECTE → explore le code, produit un PLAN (JSON)
3. EXÉCUTION → agents spécialisés par tâche (context isolation)
4. RAPPORT FINAL → synthèse par phase dans le chat
```

### Pool d'agents (12 rôles)

Architect, Backend Dev, Frontend Dev, Database Engineer, API Designer, Code Reviewer, QA Tester, Test Writer, Docs Writer, DevOps, Security Reviewer, Refactoring Specialist.

### Fichiers

| Fichier | Rôle | Statut |
|---------|------|--------|
| `backend/src/pi/harness-engine.ts` | Orchestrateur | ✅ |
| `backend/src/pi/concurrency.ts` | Concurrence | ✅ |
| `backend/src/pi/model-library.ts` | Types, pool, persistance | ✅ |
| `backend/src/pi/session.ts` | Intégration /harness | ✅ |
| `frontend/src/components/Modals/HarnessConfigModal.tsx` | UI config | ✅ |
| `frontend/src/components/Header/ModelQuickSwitch.tsx` | Toggle harness | ✅ |

### Fonctionnalités futures

| Fonctionnalité | Priorité |
|----------------|----------|
| Parallélisme intra-phase | P3 |
| Technical Knowledge Base (cache firecrawl + TTL) | P3 |
| User Knowledge Base | P4 |
| Quality Gates Pipeline (lint → build → review → test → security) | P4 |
| Dark Factory (agents persistants, jobs async) | P6 |

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