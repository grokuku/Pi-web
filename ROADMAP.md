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

---

## 🟡 Bugs mineurs / améliorations

- **[?] Bouton download sur les fichiers** — Implémenté mais pas testé en conditions réelles (Docker). Vérifier que `Content-Disposition: attachment` fonctionne bien avec les noms sanitizés.
- **[?] Extension compaction-checkpoint** — Pas testé en conditions réelles. Vérifier que les résumés de compaction sont bien sauvegardés.
- **[?] Pi-unipi/memory** — Aucune modification, rester en version vanilla. Ne pas modifier le package npm.

---


- **[?] Historique chat disparait avec 3 panneaux visibles** — Quand on ouvre le 3e module (pi + terminal + files), la conversation semble vide. L'historique est toujours dans le store (useChatHistory), mais ChatView perd son useState interne. Cause probable : remontage de ChatView du au changement de layout (LayoutRenderer change de structure JSX entre 2 et 3 panneaux). Le useState([]) se reinitialise, et le useEffect de restauration ne se declenche pas car projectId n'a pas change. Fix possible : monter ChatView a l'exterieur du LayoutRenderer (toujours visible, display:none gere par CSS), ou monter le state messages au niveau App au lieu de ChatView.

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
- **Presets de modèles** — Bouton à côté du sélecteur de mode (code/plan/review) pour sauvegarder/recharger des configurations complètes de modèles. Un preset = combinaison de (codeModel, planModel, reviewModel, visionModel, audioTranscriptionModel, audioAnalysisModel, commitModel, niveaux de thinking) associés à un nom. Permet de basculer rapidement entre "full power (cher)", "moyen", "light (gratuit)". Stockage côté backend dans un fichier JSON, switch via un seul appel API qui set tous les modèles d'un coup.
- **Export / Import de config complète** — Bouton dans Settings → General pour exporter toute la configuration (serveur + localStorage) en un seul fichier JSON, et bouton pour l'importer. Doit inclure : modèles (code/plan/review/vision/audio/commit), presets, thème, raccourcis, préférences UI, niveaux de thinking, providers. L'export télécharge un fichier .json ; l'import le parse et applique tout (appels API pour le serveur, setItem pour le localStorage). Utile pour backup, migration, ou partage de config entre instances.
- **Onglet Analysis Models dans Settings** — Déjà implémenté (vision model, audio model, commit model). Manque la sélection de modèle audio de transcription et d'analyse (voir section Backend → Analyse Audio).
- **Pieces jointes multiples** — Accepter plusieurs fichiers en meme temps (deja supporte cote backend, a verifier cote frontend).
- ✅ **Refonte du rendu Thinking + Tools** — Fait le 2026-05-17. Nouveaux composants `ThinkingBlock` et `ToolTimeline` :
  - ThinkingBlock : fond distinct avec bordure gauche, bouton copier, barre de progression pendant le streaming
  - ToolTimeline : timeline verticale avec icônes par type d'outil, arguments formatés, toggle individuel par outil
  - Mode compact (badges) et mode détaillé (timeline) pour les outils
  - CSS : `word-break: break-word` au lieu de `break-all`, animations `fadeIn`/`slideDown`/`toolPulse`
  - Anciens composants `ToolCallCard`, `getToolShortLabel`, `extractToolArgs` supprimés
- **ModelQuickSwitch : tri alphabetique des modeles** — Dans les dropdowns sous les boutons CODE/PLAN/REVIEW, les modeles sont listes dans l ordre de `library.models` (ordre du backend). Certains providers renvoient les modeles dans un ordre aleatoire. Ajouter un `.sort((a, b) => a.name.localeCompare(b.name))` avant le `.map()` pour chaque dropdown.
- ✅ **ModelQuickSwitch : supprimer le bouton commit** — Le bouton commit (a cote de REVIEW) avec son dropdown dedie prend de la place dans le header. Le modele de commit peut toujours etre configure dans Settings → Analysis Models. Supprimer le rendu du bouton commit et son dropdown de ModelQuickSwitch.
- ✅ **Thinking : titre sticky au scroll** — Quand on scrolle dans un bloc thinking, le titre "THINKING" et le bouton copier restent visibles en haut (sticky + backdrop blur). Permet de minimiser sans remonter.
- ✅ **Paramètre global "Think expand" par défaut** — Toggle dans Settings → General. Stocké dans localStorage.
- ✅ **Améliorer l'auto-scroll des messages** — Seuil réduit de 80px à 30px. Bouton sticky ↓ avec compteur "N nouveaux messages" quand on remonte. IntersectionObserver remplacé par onScroll (fiable avec overflow-y-auto).
- 💡 **Utiliser Chart.js pour les graphiques** — Remplacer les composants de visualisation actuels par Chart.js (librairie gratuite et légère) pour les stats d'utilisation des tokens, les graphiques de performance, et toute visualisation de données dans l'interface (barres, lignes, camemberts, etc.). Chart.js est gratuit, simple à intégrer, et largement adopté.
- 💡 **Onglet Raccourcis clavier dans Settings** — Permettre à l'utilisateur de visualiser et reconfigurer les raccourcis clavier. Stockage localStorage. Remplacer les Ctrl+L/T/O qui sont en conflit avec le navigateur.
- ✅ **Badge outil → expand individuel** — En mode compact, cliquer sur un badge d'outil specifique expand **seulement cet outil** en timeline (les autres restent en badges). Bouton ✕ pour refermer l'outil individuellement. Le toggle global "▶ TOOLS (N)" fonctionne toujours (expand tout).
- ✅ **Indicateur connexion texte** - Le point vert/rouge en haut a gauche indique la connexion WebSocket. Texte "Connecté" / "Hors ligne" ajoute a cote pour plus de clarte.
- ✅ **Onglet Analysis Models : afficher le nom du provider** au lieu de son ID** — Dans Settings → Analysis Models, les dropdowns montrent les providers avec leur ID technique (ex: provider_abc123) illisible. Il faut afficher le name ou le label du provider a la place, et garder l'ID uniquement en valeur interne.

### Backend / Architecture

#### 🎵 Analyse Audio (deux modes distincts)

**Mode 1 — Transcription (parole → texte)**
- Modèle dédié type Whisper (configuration : `audioTranscriptionModelId`)
- Entrée : fichier audio (wav, mp3, ogg, flac, etc.) → sortie : texte brut
- Options : local (whisper.cpp, faster-whisper) ou API (OpenAI Whisper)
- Le paramètre `mode: "transcribe"` ou query contenant "transcri" déclenche ce mode

**Mode 2 — Analyse / Compréhension audio (audio → description)**
- Modèle multimodal capable de traiter l'audio (Gemma 4, GPT-4o-audio, etc.)
- Entrée : fichier audio → sortie : description riche (émotions, instruments, ambiance, structure)
- Configuration : `audioAnalysisModelId` (peut être le même que le modèle de transcription)
- Comprend la musique, les sons ambiants, les dialogues
- Déclenché par défaut, ou via `mode: "describe"`

**Architecture proposée :**
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
 "Bonjour, je       "Saxo jazz doux,
  voudrais..."       ambiance nocturne,
                     tempo lent..."
```

**Configuration dans Settings :**
| Champ | Endpoint | Modèle typique |
|---|---|---|
| `audioTranscriptionModelId` | `PUT /api/model-library/audio-transcription/:id` | whisper-large-v3 |
| `audioAnalysisModelId` | `PUT /api/model-library/audio-analysis/:id` | gemma4:31b, gpt-4o-audio |

**Implémentation backend :**
- Endpoint `POST /api/attachments/:id/analyze` déjà existant, ajout du dispatch audio
- Si MIME type commence par `audio/` :
  - Si `query` contient "transcri" ou `mode === "transcribe"` → transcription
  - Sinon → analyse via modèle multimodal
- Les deux modèles sont optionnels — si non configurés, retourner un message clair
- Résultat mis en cache dans `meta.json` → `analysisCache` (future optimisation)

---

#### 📄 Analyse PDF visuelle (texte + images)

**Principe :** extraire à la fois le texte ET les images de chaque page, et lier les images dans le texte via leur `attachmentRef` (id) pour que le LLM puisse décider d'appeler `analyze_file` ou non.

**Architecture proposée :**
```
PDF uploadé
     │
     ├── pdf-parse ──────────────► Texte extrait
     ├── Rendu des pages en       │
     │   images (pdfjs-dist ou   Les 📎 page-N.png sont
     │   poppler-utils)          placées dans le texte
     ├── OCR (Tesseract.js) ──►  Si PDF scanné, fallback
```

**Stockage :**
- Même système que les uploads : `/data/attachments/<uuid>/`
- Chaque image de page devient un attachment avec `parentId: <uuid-du-pdf>` dans `meta.json`
- Le résultat d'analyse est un texte enrichi : `"...le graphique montre...\n📎 page-3.png (id: xyz, 1.2 MB)\n...comme illustré ci-dessus"`
- L'extraction est **paresseuse** : déclenchée à l'appel de `analyze_file`, pas à l'upload

**Comportement :**
- PDF textuel → `pdf-parse` + images des pages (liées)
- PDF scanné (peu de texte) → OCR Tesseract + images des pages
- Le LLM reçoit le texte avec les refs et appelle `analyze_file` sur une image si nécessaire

---

### Autres idées Backend
- **Statistiques d utilisation des tokens** — Enregistrer chaque turn dans un fichier JSON (`/data/usage/YYYY-MM-DD.json`) avec : modele, provider, tokens input/output, cout, timestamp. API pour interroger les stats par jour/semaine/mois, par modele ou global. Frontend : page de stats dans Settings ou modal dedie. Permet de comparer le cout reel des providers et d optimiser ses reglages.


### Extensions Pi (🔽 priorité très basse)

- ~~**Skill de revue de code** — Déjà couvert par le mode REVIEW natif de Pi. Pas de doublon nécessaire.~~
- **Extension Slack/Discord** — Pousser les notifications de build/déploiement vers un channel. Priorité basse.
- **Extension Git hooks** — Déclencher des analyses automatiques sur push (lint, tests, review). Priorité basse.

### YOLO Mode (Multi-Agent Debate)

✅ **Mode YOLO — Débat multi-agent**

- Deux IAs discutent et codent en collaboration
- Phase PLAN (N cycles) : Agent 1 propose → Agent 2 critique → boucle
- Phase CODE (M cycles) : Agent 1 implémente → Agent 2 débugue → boucle
- Cycles globaux (P) : plan+code répétés avec réinjection du code produit
- Backend : orchestration dans session.ts (runYoloSession, runYoloDebate, runYoloAgent)
- Frontend : bouton YOLO dans le header, streaming du débat
- Configuration : modèle 1, modèle 2, nombre de cycles plan/code/global
- Route API : POST /api/pi/yolo


### Agent

- **LLM conscient de son mode (plan/analyse vs code)** — Quand l'utilisateur passe en mode plan/analyse, le LLM doit savoir qu'il est dans ce mode et adapter son comportement :
  - En mode **plan/analyse** : le LLM ne doit **jamais** proposer de modifier le code ni donner des instructions pour le faire. Il fait uniquement de la planification (architecture, design) ou de l'analyse (debug, investigation). Il ne produit pas de code.
  - En mode **code** : comportement normal avec les outils d'édition (read, edit, write, bash).
  - Implémentation : passer un indicateur `mode` dans le prompt système (via `applyModeToSession` déjà appelé après chaque switch), ou utiliser le `SystemPromptManager` pour activer/désactiver les outils d'édition selon le mode.

### Performance

- **Streaming des résultats d'analyse** — Pour les gros PDFs, streamer le texte extrait au lieu de tout retourner d'un coup.
- **Mise à jour progressive des attachments** — Ne pas recharger toute la liste quand un fichier est uploadé (WebSocket event).

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
| Analyse audio — transcription | ⏳ | Whisper ou autre modèle de STT configurable |
| Analyse audio — description | ⏳ | Modèle multimodal (Gemma 4, GPT-4o-audio) |
| Analyse vidéo | ⏳ | Placeholder, pas encore implémenté |
| Download bouton | ✅ | Hover sur les pièces jointes, `<a download>` |
| Suppression avec projet | ✅ | `deleteAttachmentsForProject()` |
| Sanitization noms | ✅ | Pas de path traversal |

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
| Audio transcription | `audioTranscriptionModelId` dans ModelLibrary | `PUT /api/model-library/audio-transcription/:id` |
| Audio analysis | `audioAnalysisModelId` dans ModelLibrary | `PUT /api/model-library/audio-analysis/:id` |
| Commit model | `commitModelId` dans ModelLibrary | `PUT /api/model-library/commit-model/:id` |

---

## 🔧 Architecture (pour référence rapide)

```
Frontend (React)
  ├── ChatView.tsx → upload via POST /api/attachments/upload
  ├── SettingsModal.tsx → onglet Analysis Models (vision, audio, commit)
  └── Affichage: 📎 fichier.pdf (id: abc123, 5.2MB) ✅ ⬇

Backend (Express)
  ├── /api/attachments/* → upload, serve, analyze, delete
  ├── /api/model-library/vision-model/:id → config
  └── toolsForMode(session, baseTools) → merge base + extension tools

Extensions Pi
  ├── file-analyzer/index.ts → analyze_file tool (zero deps, JSON Schema)
  └── compaction-checkpoint/index.ts → session_compact event

Stockage
  /data/attachments/<uuid>/
      ├── <nom-sanitizé>    ← fichier original
      ├── meta.json          ← {id, name, originalName, mimeType, projectId, ...}
      └── cache/            ← résultats d'analyse (cache ✅)
```

---

## 📊 Résumé succinct des bugs et features

| # | Type | Description |
|---|------|-------------|
| 1 | 🟡 Bug | **Historique chat disparait** avec 3 panneaux visibles |
| 2 | ✅ Fixed | **Stats contexte incohérentes** dans la StatusBar |
| 3 | ✅ Done | **Timestamps absolus** (HH:MM) sur les messages utilisateur et assistant |
| 4 | 💡 | **Presets de modèles** (sauver/charger des configs complètes) |
| 5 | 💡 | **Export/Import config** complète (serveur + localStorage) |
| 6 | 💡 | **Analyse audio** — transcription (Whisper) + description (multimodal) |
| 7 | 💡 | **Analyse PDF visuelle** — texte + images des pages liées |
| 8 | ✅ Done | **Refonte rendu Thinking + Tools** — timeline, icônes, animations |
| 9 | ✅ Done | **Provider name** au lieu de l'ID dans Analysis Models |
| 10 | ✅ Done | **Tri alphabétique** des modèles dans ModelQuickSwitch |
| 11 | ✅ Done | **Supprimer bouton commit** du header |
| 12 | 💡 | **Prévisualisation PDF inline** |
| 13 | ✅ Done | **Cache d'analyse** (hash query+page) |
| 14 | 💡 | **Nettoyage auto** des attachments |
| 15 | 💡 | **Rate limiting** upload |
| 16 | 🔽 Basse | **Extensions** Slack/Discord, Git hooks (revue de code déjà couverte par mode REVIEW) |
| 17 | 💡 | **Streaming** résultats d'analyse (gros PDFs) |
| 18 | 💡 | **Mise à jour progressive** des attachments (WebSocket) |
| 19 | ✅ Done | **Stats d'utilisation** (par jour/mois, graphs, modal) des tokens (jour/semaine/mois, par modèle/providers) |
| 20 | 💡 | **LLM conscient du mode** — en plan/analyse, ne jamais proposer du code, juste planifier/analyser |
| 21 | ✅ Done | **Thinking : titre sticky** au scroll (titre + copier restent visibles) |
| 22 | ✅ Done | **Paramètre "Think expand"** par défaut dans Settings → General |
| 23 | ✅ Done | **Auto-scroll messages** — seuil 30px, bouton sticky ↓ avec compteur |
| 24 | 💡 | **Onglet Raccourcis clavier** dans Settings (visu + reconfiguration) |
| 25 | ✅ Done | **Badge outil → expand individuel** (✕ pour refermer) |
| 26 | ✅ Done | **Indicateur connexion** — texte "Connecté" / "Hors ligne" ajouté |
| 27 | ✅ Done | **Mode YOLO** — débat multi-agent (2 IA, plan+code, cycles plan/code/global) |
| 27 | ✅ Done | **Mode YOLO** — débat multi-agent (2 IA, plan+code, N cycles)
| 28 | 💡 | **Utiliser Chart.js** pour les graphiques (stats tokens, visualisations de données)
