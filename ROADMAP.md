# Pi-Web — Suivi du projet

## 🔴 Bugs à corriger

### Backend

- **[FIXED] Vision fallback ne marchait pas** — Le `visionModelId` était stocké au format `providerId__modelId` mais la recherche utilisait `providerId/modelId`. Fix: ajout du match avec `__`.
- **[FIXED] Extensions non activées en mode plan/review/code** — `setActiveToolsByName(ALL_TOOLS)` écrasait les outils d'extension. Fix: `toolsForMode(session, BASE_TOOLS)` fusionne dynamiquement.
- **[FIXED] Extension file-analyzer ne se chargeait pas** — `@sinclair/typebox` introuvable par jiti depuis `/app/extensions/`. Fix: JSON Schema natif, zéro dépendance.

### Frontend

- **[FIXED] Images envoyées en base64 inline** — Maintenant uploadées via API, référencées par ID.
- **[FIXED] Noms de fichiers non sanitizés** — Risque de path traversal. Fix: `sanitizeFileName()`.
- **[FIXED] Attachments pas supprimés avec le projet** — Ajout de `deleteAttachmentsForProject()`.
- **[FIXED] Redimensionnement colonne Files impossible** — Implémenté dans `FileExplorer.tsx` : poignée de resize avec `treeWidth` / `fileTreeResizeRef`.

---

## 🟡 Bugs mineurs / améliorations

- **[?] Bouton download sur les fichiers** — Implémenté mais pas testé en conditions réelles (Docker). Vérifier que `Content-Disposition: attachment` fonctionne bien avec les noms sanitizés.
- **[?] Extension compaction-checkpoint** — Pas testé en conditions réelles. Vérifier que les résumés de compaction sont bien sauvegardés.
- **[?] Pi-unipi/memory** — Aucune modification, rester en version vanilla. Ne pas modifier le package npm.
- **[FIXED 2026-06-03] Auto-scroll bloqué pendant le streaming** — Le `scrollToBottom("smooth")` dans `handleSend` déclenchait une animation CSS qui modifiait `scrollTop` progressivement, ce qui déclenchait `handleScroll` à chaque étape et mettait `pinnedToBottomRef` à `false` (car temporairement > 50px du bottom). Résultat : le ResizeObserver ne scrollait plus, le texte arrivait plus vite que le scroll. Fix : remplacement par `scrollTop = scrollHeight` instantané + ajout d'un `MutationObserver` en fallback pour les `text_delta` rapides que ResizeObserver peut manquer.
- **[FIXED 2026-06-03] Auto-scroll se déclenche accidentellement** — Race condition : quand du contenu arrivait vite, le navigateur déclenchait un scroll event AVANT que le ResizeObserver n'ait scrollé vers le bas. `handleScroll` voyait `scrollHeight - scrollTop > 50px` et mettait `pinnedToBottomRef = false`, tuant l'auto-scroll. Fix : `handleScroll` ne dépine que si l'utilisateur scroll VERS LE HAUT (scrollTop diminue de +10px), pas quand le contenu pousse le scroll vers le bas.
- **[FIXED 2026-06-03] Thinking affiché en double** — Le composant `ThinkingBlock` affichait la barre de progression, ET le texte "Thinking…" s'affichait aussi en dessous si `hasThinking` était true. Fix : passage de `isStreaming` prop à ThinkingBlock (barre animée) + masquage du "Thinking…" redondant quand du thinking est déjà visible.
- **[FIXED 2026-06-03] Messages effacés pendant le streaming** — Deux bugs : (1) `message_end` remplaçait le contenu streamé par le contenu final (potentiellement un résumé de compaction). Fix : `message_end` ne touche PLUS jamais `content`/`thinking`, uniquement `_streaming`, tools, usage. (2) `AssistantGroup` écrasait `finalText = msg.content` à chaque message — seul le dernier contenu survivait. Fix : `allTexts.push(msg.content)` puis affichage de tous les contenus.
- **[FIXED 2026-06-03] Thinking et contenu hors ordre chronologique** — `AssistantGroup` fusionnait TOUS les thinking d'un coup puis TOUS les contenus. Quand le modèle faisait thinking → réponse → thinking → réponse, l'ordre était cassé. Fix : chaque message affiché individuellement dans l'ordre (thinking → tools → contenu), séparé par un trait horizontal.
- **[IDENTIFIED 2026-06-03] Latence interface sur Firefox/Floorp** — Le Cycle Collector de Firefox tourne à 50% CPU même au repos. Ce n'est PAS un problème de l'app (1877 nœuds DOM, le debug overlay confirne des latences keystroke normales). Cause : les autres onglets du navigateur. En navigation privée ou avec un seul onglet, le problème disparaît. Fix partiel : auto-désactivation des scanlines et matrix-bg sur Gecko (overlays plein écran `position: fixed` qui aggravent le CC). Recommandation : utiliser Chrome/Chromium pour des performances optimales, ou garder peu d'onglets ouverts sur Firefox.

---

- **[?] Historique chat disparait avec 3 panneaux visibles** — Quand on ouvre le 3e module (pi + terminal + files), la conversation semble vide. L'historique est toujours dans le store (useChatHistory), mais ChatView perd son useState interne. **Note 2026-06-03** : `LayoutRenderer.tsx` monte maintenant tous les panneaux en permanence (`display:none` pour les cachés, `key={panelId}` stable). Le state React devrait être préservé, mais des conditions de re-render rares peuvent encore causer le bug. Si ça persiste, il faudra monter `messages` au niveau `App` au lieu de `ChatView`.

- **[FIXED] Stats du contexte incoherentes** — La barre en bas montre `ctx 0.2K   30%   /128K`, mais 0.2K (200 tokens) ne fait pas 30% de 128K (ca serait ~38K). Cause : les trois valeurs viennent de sources differentes :
  - `tokens` = `u.input` du dernier message (juste le prompt, pas le contexte cumule)
  - `contextPercent` = `Math.round(lastInputTokens / contextWindow * 100)` — pourcentage du DERNIER prompt, pas du contexte total. En plus il n'augmente que via `Math.max(prevStats.contextPercent, contextPercent)`, donc il reste bloque a son pic historique
  - `totalTokens` = cumul de tous les tokens (input + output)
  - `/128K` = `session.model.contextWindow` (la fenetre max du modele)
  - Les trois ne sont pas lies entre eux, ce qui affiche des chiffres contradictoires. Fix : `tokens` devrait etre le contexte cumule (total des messages dans la session), `contextPercent` le ratio de ce cumule par rapport a `contextWindow`, et `totalTokens` peut rester cumulatif pour le cout.

---

**🟡 Conflits raccourcis clavier avec le navigateur**

| Raccourci | Pi-Web | Chrome / Firefox | Conflit |
|-----------|--------|------------------|---------|
| **Ctrl+L** | Ouvrir Settings / modele | Focus barre d'adresse | 🔴 OUI |
| **Ctrl+T** | Afficher/Masquer tous les Thinkings | Nouvel onglet | 🔴 OUI |
| **Ctrl+O** | Expand/Collapse tous les outils | Ouvrir fichier | 🔴 OUI |
| **Shift+Tab** | Cycle niveau thinking (off→high) | Focus element precedent | 🟡 Partiel (hors inputs) |
| **Ctrl+Shift+D** | Debug overlay | — | 🟢 Non |
| **Esc** | Abort / fermer modales / viewer | Stop / fermer dialogue | 🟢 Non |
| **Enter** | Envoyer message (textarea) | — | 🟢 Non |
| **Shift+Enter** | Nouvelle ligne (textarea) | — | 🟢 Non |

**Probleme :** Ctrl+L/T/O sont interceptes par le navigateur avant la page. Pistes de fix :
- `Ctrl+Shift+T` pour thinking, `Ctrl+Shift+O` pour outils, `Ctrl+Shift+L` pour settings
- Ou `F1` settings, `Ctrl+.` thinking, `Ctrl+/` outils
- Ou proposer une app Electron / PWA kiosk

---

## 💡 Idées pour plus tard

### UX / Frontend

- ✅ **Timestamps absolus sur les messages** — L'heure (HH:MM) est affichée en haut à droite des messages utilisateur et dans le footer des blocs assistant.
- **Presets de modèles** — Bouton à côté du sélecteur de mode (code/plan/review) pour sauvegarder/recharger des configurations complètes de modèles. Un preset = combinaison de (codeModel, planModel, reviewModel, visionModel, audioModel, commitModel, niveaux de thinking) associés à un nom. Stockage côté backend dans un fichier JSON, switch via un seul appel API qui set tous les modèles d'un coup.
- **Export / Import de config complète** — Bouton dans Settings → General pour exporter toute la configuration (serveur + localStorage) en un seul fichier JSON, et bouton pour l'importer. Doit inclure : modèles, presets, thème, raccourcis, préférences UI, niveaux de thinking, providers, API keys agent.
- ✅ **Onglet Analysis Models dans Settings** — Implémenté (vision model, audio model, commit model). Voir section Backend → Analyse Audio pour le gap.
- **Pieces jointes multiples** — Accepter plusieurs fichiers en meme temps (deja supporte cote backend, a verifier cote frontend).
- ✅ **Refonte du rendu Thinking + Tools** — Fait le 2026-05-17. Nouveaux composants `ThinkingBlock` et `ToolTimeline`.
- ✅ **ModelQuickSwitch : tri alphabetique des modeles** — `.sort((a, b) => a.name.localeCompare(b.name))` ajouté dans les dropdowns de chaque mode (code, plan, review, yolo).
- ✅ **ModelQuickSwitch : supprimer le bouton commit** — Le bouton commit a été retiré du header. La config reste accessible dans Settings → Analysis Models.
- ✅ **Thinking : titre sticky au scroll** — CSS `position: sticky; top: 0; z-index: 2; background: var(--surface)` sur `.thinking-block-header`.
- ✅ **Paramètre global "Think expand" par défaut** — Toggle dans Settings → General. Stocké dans localStorage (`pi-web-thinking-expand`).
- ✅ **Améliorer l'auto-scroll des messages** — Seuil à **50px** (pas 30px comme indiqué dans la première version). Bouton sticky ↓ avec compteur "N nouveaux messages". `onScroll` (fiable). ResizeObserver + MutationObserver fallback.
- 💡 **Utiliser Chart.js pour les graphiques** — Actuellement barres SVG custom dans UsageStatsModal. Chart.js serait plus flexible.
- 💡 **Onglet Raccourcis clavier dans Settings** — Permettre de visualiser et reconfigurer les raccourcis clavier. Stockage localStorage.
- ✅ **Badge outil → expand individuel** — Mode compact dans ToolTimeline : clic sur un badge expand seulement cet outil en timeline. Bouton ✕ pour refermer.
- ✅ **Indicateur connexion texte** — Point vert/rouge + texte "Connecté" / "Hors ligne" dans le header.
- ✅ **Provider name dans Analysis Models** — Les dropdowns affichent le `name` du provider, pas son ID technique.

### Backend / Architecture

#### 🎵 Analyse Audio (⚠️ implémentation actuelle différente de l'architecture proposée)

**État actuel (v0.1.8-beta) :**
- Un seul champ `audioModelId` dans `ModelLibrary`
- Un seul endpoint `PUT /api/model-library/audio-model/:id`
- L'analyse audio dans `POST /api/attachments/:id/analyze` renvoie un placeholder : pas d'appel de modèle
- Interface Settings → Analysis Models : select pour audio model existe, message "Coming soon"

**Architecture souhaitée (deux modes distincts) :**

```
analyze_file(file_id, query, mode?)
               │
      ┌────────┴────────┐
      │                  │
mode: transcribe    mode: analyze (default)
      │                  │
 Modèle de           Modèle d'analyse
 transcription       audio (multimodal)
 (Whisper, etc.)     (Gemma 4, etc.)
      │                  │
      ▼                  ▼
 Texte brut         Description riche
```

**Configuration future :**
| Champ | Endpoint | Modèle typique |
|---|---|---|
| `audioTranscriptionModelId` | `PUT /api/model-library/audio-transcription/:id` | whisper-large-v3 |
| `audioAnalysisModelId` | `PUT /api/model-library/audio-analysis/:id` | gemma4:31b, gpt-4o-audio |

**TODO :** Remplacer `audioModelId` unique par `audioTranscriptionModelId` + `audioAnalysisModelId` dans `ModelLibrary`, `routes/model-library.ts`, et `SettingsModal.tsx`.

---

#### 📄 Analyse PDF visuelle (texte + images)

**Principe :** extraire à la fois le texte ET les images de chaque page.

**Architecture proposée :**
```
PDF uploadé
     ├── pdf-parse ────► Texte extrait
     ├── Rendu en       │
     │   images         Les 📎 page-N.png sont
     │   (pdfjs-dist)   placées dans le texte
     ├── OCR (Tes.) ──► Si PDF scanné, fallback
```

---

### Autres idées Backend
- ✅ **Statistiques d utilisation des tokens** — Implémenté : enregistrement dans `/data/usage/YYYY-MM-DD.json` avec modèle, provider, tokens input/output, coût, timestamp. API `GET /api/usage?from=&to=&groupBy=hour|day|week|month|model`. Frontend : `UsageStatsModal.tsx` avec graphique SVG et tableau.
- 💡 **Nettoyage automatique des attachments orphelins** — Cron ou déclencheur qui supprime les fichiers sans `projectId` valide.
- 💡 **Rate limiting** sur les uploads de fichiers.
- 💡 **Streaming des résultats d'analyse** — Pour les gros PDFs, renvoyer le texte par morceaux.
- 💡 **Mise à jour progressive des attachments via WebSocket** — Au lieu de recharger toute la liste.

### Agent

- ✅ **LLM conscient de son mode** — Implémenté via `MODE_INSTRUCTIONS` et `MODE_IDENTITIES` dans `session.ts`. En mode plan/review, les outils d'édition sont désactivés (`setActiveToolsByName`), et le prompt système contient des instructions explicites pour ne jamais modifier le code. Les blocs sont nettoyés à chaque changement de mode.

### API Agent Externe

- ✅ **API agent externe** — Implémentée ! Routes dans `backend/src/routes/agent.ts`, auth via `agent-auth.ts` (Bearer token). Endpoints : santé, projets (CRUD), modèles, configuration de mode, chat synchrone (POST → attend la fin), contexte, fichiers. Documentation : `docs/agent-api.md`. Configuration des tokens : Settings → API Keys (pas General comme indiqué dans la doc). Stockage : `agent-keys.json`.

### Extensions Pi (🔽 priorité très basse)

- ~~**Skill de revue de code** — Déjà couvert par le mode REVIEW natif de Pi.~~
- **Extension Slack/Discord** — Pousser les notifications de build/déploiement.
- **Extension Git hooks** — Déclencher des analyses automatiques sur push.

### YOLO Mode (Multi-Agent Debate)

✅ **Mode YOLO — Débat multi-agent**

- Implémenté backend + frontend :
  - `session.ts:runYoloSession()` — orchestration cycles plan/code
  - `session.ts:runYoloDebate()` — boucle agent1 → agent2
  - `session.ts:runYoloAgent()` — session temporaire par agent, clean up après
  - `routes/pi-settings.ts` → `POST /api/pi/yolo`
  - `ModelQuickSwitch.tsx` → bouton YOLO + dropdown
  - `YoloConfigModal.tsx` → configuration (2 modèles, cycles)
  - Streaming temps réel des tool calls des deux agents
- Configuration : `model1`, `model2`, `planCycles`, `codeCycles`, `globalCycles`

---

## 📋 État actuel du système

### Upload & Analyse de fichiers

| Composant | Statut | Détail |
|---|---|---|
| Upload (frontend) | ✅ | Drag & drop, tous types de fichiers, upload via API |
| Stockage (backend) | ✅ | `/data/attachments/<uuid>/<nom-sanitizé>/` |
| Analyse PDF | ✅ | `pdf-parse`, extraction de texte |
| Analyse images | ✅ | Fallback via modèle vision configuré |
| Analyse texte/code | ✅ | Lecture directe du fichier |
| Analyse audio — transcription | ⏳ | **Voir note** : un seul champ `audioModelId`, pas d'implémentation réelle |
| Analyse audio — description | ⏳ | Pas encore implémenté |
| Analyse vidéo | ⏳ | Placeholder, pas encore implémenté |
| Download bouton | ✅ | Hover sur les pièces jointes, `<a download>` |
| Suppression avec projet | ✅ | `deleteAttachmentsForProject()` |
| Sanitization noms | ✅ | Pas de path traversal |
| Cache d'analyse | ✅ | Hash de (query+page) → fichier JSON dans `cache/` |

### Outils Pi (extensions)

| Extension | Statut | Outil | Activation automatique |
|---|---|---|---|
| file-analyzer | ✅ | `analyze_file` | Via `session_start` + `toolsForMode()` |
| compaction-checkpoint | ✅ | Événement `session_compact` | Automatique |
| @pi-unipi/memory | ✅ | `memory_store/search/delete/list` | Via `toolsForMode()` |
| @benvargas/pi-firecrawl | ✅ | `firecrawl_scrape/map/search` | Via `toolsForMode()` |

### Modèles d'analyse

| Type | Config | Endpoint |
|---|---|---|
| Vision model | `visionModelId` dans ModelLibrary | `PUT /api/model-library/vision-model/:id` |
| Audio model | `audioModelId` dans ModelLibrary | `PUT /api/model-library/audio-model/:id` |
| Commit model | `commitModelId` dans ModelLibrary | `PUT /api/model-library/commit-model/:id` |

### Modes

| Mode | Statut | Comportement |
|---|---|---|
| CODE | ✅ | Tous les outils (read, bash, edit, write, grep, find, ls + extensions) |
| PLAN | ✅ | Lecture seule, pas de bash modifiant l'état, instructions planification |
| REVIEW | ✅ | Lecture seule + bash read-only, focus revue de code, format structuré |
| YOLO | ✅ | Débat multi-agent : 2 sessions temporaires, cycles plan + code |
| Auto-review | ✅ | Après un prompt CODE : review neutre (session fraîche) + fix (session principale) |

### Routes API

| Catégorie | Endpoint | Statut |
|---|---|---|
| Modèles | `/api/model-library/*` | ✅ |
| Projets | `/api/projects/*` | ✅ |
| Fichiers | `/api/files/*` (browse, read, write, upload, download) | ✅ |
| Attachments | `/api/attachments/*` (upload, serve, analyze, delete) | ✅ |
| Usage | `/api/usage/*` (query, models list) | ✅ |
| Pi | `/api/pi/*` (settings, packages, yolo, reload) | ✅ |
| Agent | `/api/agent/*` (projets, modèles, chat, fichiers — auth Bearer) | ✅ |
| Agent Keys | `/api/agent-keys/*` (CRUD, reveal — sans auth) | ✅ |
| Providers | `/api/providers/*` | ✅ |
| Ollama | `/api/ollama/*` | ✅ |
| Sessions | `/api/sessions/:id/*` (history, info, tools) | ✅ |
| Health | `/api/health`, `/api/agent/health` | ✅ |

---

## 🔧 Architecture (pour référence rapide)

```
Frontend (React, TypeScript, Tailwind, Vite)
  ├── ChatView.tsx → WebSocket → pi_prompt / pi_event
  ├── SettingsModal.tsx → onglets : Models, Analysis, Extensions, General, Layout, API Keys
  ├── ModelQuickSwitch.tsx → boutons CODE/PLAN/REVIEW/YOLO + dropdowns
  ├── ThinkingBlock.tsx + ToolTimeline.tsx → refonte streaming
  ├── UsageStatsModal.tsx → stats tokens SVG
  └── FileExplorer.tsx → arbre + prévisualisation + édition

Backend (Express + WebSocket + node-pty + Pi SDK)
  ├── /api/attachments/* → upload, serve, analyze, delete
  ├── /api/model-library/* → CRUD modèles, modes projet
  ├── /api/usage/* → stats tokens par période/modèle
  ├── /api/pi/* → settings, packages, yolo, reload
  ├── /api/agent/* → agent externe (Bearer auth)
  ├── /api/agent-keys/* → gestion tokens agent
  └── pi/session.ts → orchestration sessions, modes, YOLO, auto-review

Extensions Pi
  ├── file-analyzer/ → analyze_file tool
  └── compaction-checkpoint/ → session_compact event

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

---

## 📊 Résumé succinct des bugs et features

| # | Type | Description |
|---|------|-------------|
| 1 | 🟡 Bug | **Historique chat disparait** avec 3 panneaux visibles (partiellement mitigé) |
| 2 | ✅ Fixed | **Stats contexte incohérentes** dans la StatusBar |
| 3 | ✅ Done | **Timestamps absolus** (HH:MM) sur les messages |
| 4 | 💡 | **Presets de modèles** (sauver/charger des configs complètes) |
| 5 | 💡 | **Export/Import config** complète (serveur + localStorage) |
| 6 | 💡 | **Analyse audio** — refonte en 2 modèles (transcription + analyse) |
| 7 | 💡 | **Analyse PDF visuelle** — texte + images des pages liées |
| 8 | ✅ Fixed | **Thinking affiché en double** (barre + "Thinking…" redondant) |
| 9 | ✅ Fixed | **Messages effacés** pendant le streaming (message_end compaction + finalText overwrite) |
| 10 | ✅ Fixed | **Thinking/contenu hors ordre** chronologique dans les groupes assistant |
| 11 | ✅ Fixed | **Auto-scroll se déclenche** accidentellement (race condition scroll vs ResizeObserver) |
| 12 | 🟡 Bug | **Latence Firefox/Floorp** — Cycle Collector à 50% causé par les autres onglets, pas l'app. Utiliser Chrome ou limiter les onglets |
| 13 | 💡 | **Prévisualisation PDF inline** |
| 14 | 💡 | **Nettoyage auto** des attachments |
| 15 | 💡 | **Rate limiting** upload |
| 16 | 🔽 Basse | **Extensions** Slack/Discord, Git hooks |
| 17 | 💡 | **Streaming** résultats d'analyse (gros PDFs) |
| 18 | 💡 | **Mise à jour progressive** des attachments (WebSocket) |
| 19 | ✅ Done | **Stats d'utilisation des tokens** (API + modal graphique) |
| 20 | ✅ Done | **LLM conscient du mode** — plan/review : pas de code, outils filtrés |
| 21 | ✅ Done | **Thinking : titre sticky** au scroll |
| 22 | ✅ Done | **Paramètre "Think expand"** par défaut dans Settings → General |
| 23 | ✅ Fixed | **Auto-scroll messages** — seuil 50px, bouton ↓ avec compteur, ResizeObserver + MutationObserver |
| 24 | 💡 | **Onglet Raccourcis clavier** dans Settings |
| 25 | ✅ Done | **Badge outil → expand individuel** (✕ pour refermer) |
| 26 | ✅ Done | **Indicateur connexion** — texte "Connecté" / "Hors ligne" |
| 27 | ✅ Done | **Mode YOLO** — débat multi-agent (2 IA, N cycles plan+code) |
| 28 | 💡 | **Utiliser Chart.js** pour les graphiques |
| 29 | ✅ Done | **API agent externe** — REST API Bearer auth (projets, chat, fichiers) |
| 30 | 💡 | **Onglet Analysis Models : modèles audio séparés** transcription + analyse (actuellement un seul `audioModelId`) |
