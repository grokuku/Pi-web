# AGENTS.md — Conventions pour les assistants IA travaillant sur Pi-Web

Ce fichier contient les règles de base que les assistants IA (Claude Code, GitHub Copilot, Cursor, RooCode, etc.) doivent suivre lorsqu'ils interviennent sur ce projet. Il est lu automatiquement par la plupart des outils.

## 🚫 Règles strictes

### Commits et push
- **L'utilisateur fait les `git commit` et `git push`.** L'assistant ne doit jamais le faire sauf demande explicite de l'utilisateur.
- L'assistant peut préparer le message de commit, mais doit attendre que l'utilisateur valide et exécute la commande lui-même.
- Ne jamais `git push` en fin de session sans que l'utilisateur l'ait demandé.
- Ne jamais utiliser de credentials stockés ou demander à l'utilisateur de les fournir.

### Propreté du dossier de sources
- **Aucun fichier temporaire dans le repo** : pas de `__pycache__/`, `node_modules/` (normalement dans `.gitignore`), `.pyc`, `.swp`, `.bak`, `.tmp`, etc.
- Vérifier qu'un `.gitignore` existe et couvre les fichiers usuels :
  - Backend Node : `node_modules/`, `dist/`, `*.log`
  - Frontend : `node_modules/`, `dist/`, `*.local`
  - Python (si ajouté) : `__pycache__/`, `*.pyc`, `.venv/`
- Si l'assistant crée un script temporaire pour tester, le supprimer avant de finir.

## 💡 Bonnes pratiques de travail

### Avant d'intervenir
1. **Lire `ROADMAP.md`** en premier — il contient l'état du projet, les bugs connus, et l'historique des décisions.
2. **Lire le code existant** avant de le modifier — ne pas réécrire ce qui fonctionne.
3. **Vérifier la structure** avec `ls` ou `find` pour comprendre l'organisation.

### Pendant l'intervention
- **Minimal et ciblé** : ne modifier que ce qui est nécessaire.
- **Pas de refactor massif** non demandé.
- **Consulter l'utilisateur** si une décision de design doit être prise.
- **Commenter** les sections complexes en français (le projet est en français).
- **Suivre le style existant** : indentation, nommage, conventions.

### Après l'intervention
- **Tester le build** : `cd frontend && npx tsc --noEmit && npx vite build` pour vérifier.
- **Mettre à jour `ROADMAP.md`** si un bug est corrigé ou une feature ajoutée.
- **Résumer** clairement ce qui a été fait et ce qui reste à faire.
- **Ne pas commit/push** — laisser l'utilisateur le faire.

## 📁 Structure du projet

```
/
├── backend/                    # Express + WebSocket + Pi SDK
│   └── src/
│       ├── routes/             # Endpoints API
│       ├── pi/                 # Logique Pi SDK (session, model-library, harness-engine)
│       └── middleware/         # Auth, etc.
├── frontend/                   # React + TypeScript + Tailwind + Vite
│   └── src/
│       ├── components/         # Composants React
│       ├── hooks/              # Hooks custom (useWebSocket, etc.)
│       ├── i18n/               # Traductions (fr, en)
│       └── styles/             # CSS (hacker-theme.css)
├── extensions/                 # Extensions Pi locales (codebase-memory, file-analyzer)
├── docs/                       # Documentation
│   └── agent-api.md
├── ROADMAP.md                  # Suivi du projet (lire en premier)
├── README.md
└── AGENTS.md                   # Ce fichier
```

## 🐳 Environnement Docker

Pi-Web tourne dans un conteneur Docker. Il y a deux copies du code :

- **`/projects/Pi-Web/`** — le dépôt git (source de vérité). C'est ici que les modifications doivent être faites.
- **`/app/`** — la copie utilisée par le conteneur en cours d'exécution. Cette copie est **recréée à chaque rebuild Docker** (le contenu de `/app` est effacé puis recréé depuis l'image).

**Règles importantes :**
- Toujours modifier les sources dans `/projects/Pi-Web/`, jamais dans `/app/`.
- Ne pas perdre de temps à compiler ou copier vers `/app/` — le rebuild Docker le fera automatiquement via `entrypoint.sh` (qui exécute `npm run build` au démarrage).
- Si on a besoin de tester rapidement sans rebuild, on peut copier le source modifié vers `/app/backend/src/` puis lancer `npm run build` dans `/app/backend/`, mais c'est **temporaire** — les changements seront perdus au prochain rebuild. Ne l'utiliser que pour du debug.
- L'utilisateur fait le `git push` depuis `/projects/Pi-Web/` puis rebuild le conteneur pour appliquer les changements de façon permanente.

## 🔗 Fichiers importants à connaître

- `ROADMAP.md` — état du projet, bugs, features planifiées
- `frontend/src/components/Chat/ChatView.tsx` — composant principal du chat, contient toute la logique de streaming, scroll, messages
- `backend/src/pi/session.ts` — orchestration des sessions Pi (modes, YOLO, auto-review)
- `docs/agent-api.md` — API REST externe pour agents tiers

## 🌐 Langue

- L'utilisateur communique en **français**.
- Les commentaires dans le code : **français** (le projet est en français).
- Les messages de commit : **français** (si l'utilisateur les prépare) ou anglais.
- Les noms de variables/fonctions : **anglais** (convention universelle).
- Les labels UI : **français** (avec i18n en parallèle).
