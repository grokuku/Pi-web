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

## 💡 Idées pour plus tard

### UX / Frontend

- **Timestamps relatifs dans le chat** — Afficher `[2min]`, `[1h30]` entre les messages si le délai dépasse 30s. Donne au LLM une notion de chronologie sans polluer le contexte. Format proposé : `[0s] user: ... [45s] assistant: ...` — seulement si gap > 30s.
- **Onglet Analysis Models dans Settings** — Déjà implémenté (vision model, audio model, commit model). Manque la sélection de modèle audio (Whisper-compatible).
- **Prévisualisation PDF inline** — Au lieu d'ouvrir dans un nouvel onglet, afficher les PDF dans le viewer modal avec pdf.js.
- **Drag & drop multiple** — Accepter plusieurs fichiers en même temps (déjà supporté côté backend, à vérifier côté frontend).

### Backend / Architecture

- **Audio transcription (Whisper)** — Endpoint `/analyze` déjà prévu pour le type `audio`, mais pas implémenté. Nécessite un service Whisper (local ou API).
- **Analyse vidéo** — Extraction de frames via ffmpeg + transcription audio. Structure de cache déjà en place (`/data/attachments/<id>/cache/`).
- **Cache d'analyse** — Les résultats `analyze_file` pourraient être mis en cache côté backend (déjà prév dans `meta.json` → `analysisCache`) pour éviter de re-analyser le même fichier avec la même query.
- **Nettoyage automatique des attachments** — Job périodique (cron) pour supprimer les fichiers plus anciens que X jours, ou liés à des projets supprimés.
- **Rate limiting sur `/api/attachments/upload`** — Protéger contre les abus (limite par IP ou par session).

### Extensions Pi

- **Extension Slack/Discord** — Pousser les notifications de build/déploiement vers un channel.
- **Extension Git hooks** — Déclencher des analayses automatiques sur push (lint, tests, review).
- **Skill de revue de code** — Compétence Pi qui analyse automatiquement les diffs d'un commit.

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
| Analyse audio | ⏳ | Placeholder, pas encore implémenté |
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
| Audio model | `audioModelId` dans ModelLibrary | `PUT /api/model-library/audio-model/:id` |
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
      └── cache/            ← résultats d'analyse (futur)
```