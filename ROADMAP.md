# Pi-Web — Suivi du projet

## 🔴 Bugs à corriger

### Backend

#### BUG-01: Route dupliquée `POST /:id/git/sync` dans `projects.ts`
- **Fichier :** `backend/src/routes/projects.ts`
- **Lignes :** 137 et 371
- **Sévérité :** 🟡 Moyenne
- **Description :** La route `router.post("/:id/git/sync", ...)` est définie **deux fois** dans le même fichier. La première (ligne 137) et la seconde (ligne 371) ont un code identique. Express ne prendra en compte que la **première** définition — la seconde est du code mort qui ne sera jamais exécuté. Cela n'est pas un bug fonctionnel direct, mais c'est une source de confusion et de maintenance problématique.
- **Fix :** Supprimer la seconde définition (ligne 371+).

#### BUG-02: Promesses flottantes (floating promises) dans `model-library.ts`
- **Fichier :** `backend/src/routes/model-library.ts`
- **Lignes :** 206 et 233
- **Sévérité :** 🟡 Moyenne
- **Description :** Deux routes `DELETE` appellent `syncToModelsJson()` sans `await` ni `.catch()` :
  - Ligne 206 : `syncToModelsJson();` dans `DELETE /vision-model`
  - Ligne 233 : `syncToModelsJson();` dans `DELETE /audio-model`
  La fonction `syncToModelsJson()` est `async` et peut rejeter. Si elle échoue, l'erreur sera une promesse flottante non gérée (unhandled rejection), et le client recevra une réponse `200 OK` même si la synchronisation a échoué.
- **Fix :** Ajouter `await` devant les deux appels `syncToModelsJson()`, ou ajouter `.catch()`.

#### BUG-03: `reapplyAllSessions()` appelé sans `await` ni `catch` dans plusieurs routes
- **Fichier :** `backend/src/routes/model-library.ts`
- **Lignes :** 86, 110, 125, 140, 168
- **Sévérité :** 🟢 Basse
- **Description :** Plusieurs routes appellent `reapplyAllSessions().catch(...)` ce qui est correct (le `.catch()` est présent). Cependant, l'appel n'est pas `await`-ed, ce qui signifie que la réponse HTTP est envoyée avant que la réapplication soit terminée. Ce n'est pas un bug critique car c'est intentionnel (la réapplication peut être lente), mais si elle échoue silencieusement, les sessions restent dans un état incohérent.
- **Statut :** Acceptable tel quel — le `.catch()` est présent. Documenter le comportement.

#### BUG-04: Nettoyage incomplet du répertoire cache dans `DELETE /api/attachments/:id`
- **Fichier :** `backend/src/routes/attachments.ts`
- **Lignes :** ~155-170 (fonction de suppression)
- **Sévérité :** 🟡 Moyenne
- **Description :** Le code de suppression d'attachment tente de nettoyer le répertoire cache de manière incorrecte :
  ```ts
  try { mkdirSync(cacheDir, { recursive: true }); unlinkSync(cacheDir); } catch {}
  ```
  Il crée le répertoire cache avec `mkdirSync` puis essaie de le supprimer avec `unlinkSync` (qui ne fonctionne que sur les fichiers, pas les répertoires). Le répertoire cache n'est donc jamais réellement supprimé. De plus, le nettoyage du répertoire principal utilise `require("fs").rmdirSync(dir, { recursive: true })` — mais `rmdirSync` avec `{ recursive: true }` est deprecated depuis Node 16, il faut utiliser `rmSync`.
- **Fix :** Utiliser `rmSync(dir, { recursive: true, force: true })` pour supprimer tout le répertoire de l'attachment d'un coup (ce qui supprimera aussi le cache).

#### BUG-05: `require()` utilisé dans un module ESM
- **Fichier :** `backend/src/pi/session.ts`
- **Lignes :** Dans `runYoloAgent` (fonction de cleanup)
- **Sévérité :** 🟡 Moyenne
- **Description :** Plusieurs fichiers utilisent `require()` dans un module ESM (le projet est `"type": "module"`). Bien que Node.js puisse supporter `require` dans certains contextes ESM via interop, c'est non standard et peut causer des erreurs selon la configuration :
  - `backend/src/pi/session.ts` : `require("fs")`, `require("path")` dans `runYoloAgent` (fonction de cleanup)
  - `backend/src/projects/smb.ts` : `require("fs")` dans `cleanupCredentialsFile()`
  - `backend/src/routes/attachments.ts` : `require("fs")` dans `DELETE /:id` (ligne 412) et `require("pdf-parse")` dans `POST /:id/analyze` (ligne 482)
  
  Les imports ESM en haut de chaque fichier utilisent déjà `import` correctement pour d'autres fonctions du même module.
- **Fix :** Importer toutes les fonctions nécessaires via `import` en haut de chaque fichier et supprimer les appels `require()`. Pour `pdf-parse`, utiliser `await import("pdf-parse")`.

#### BUG-06: `removeModel()` ne nettoie pas les références YOLO dans `projectModes`
- **Fichier :** `backend/src/pi/model-library.ts`
- **Lignes :** Dans `removeModel()`
- **Sévérité :** 🟡 Moyenne
- **Description :** La fonction `removeModel()` nettoie les références au modèle supprimé dans `pm.code.modelId`, `pm.plan.modelId`, et `pm.review.modelId`, mais **ne nettoie pas** :
  - `pm.yolo.modelId` — si un modèle utilisé par la config YOLO est supprimé, la config YOLO pointe vers un modèle inexistant.
  - `library.visionModelId` — si le modèle supprimé était le modèle de vision, le champ reste pointé vers un modèle inexistant.
  - `library.audioModelId` — idem pour le modèle audio.
  - `library.commitModelId` — idem pour le modèle de commit.
- **Fix :** Ajouter `if (pm.yolo.modelId === id) pm.yolo.modelId = null;` dans la boucle de cleanup, et ajouter après la boucle : `if (library.visionModelId === id) library.visionModelId = null; if (library.audioModelId === id) library.audioModelId = null; if (library.commitModelId === id) library.commitModelId = null;`

#### BUG-07: `deleteProvider()` ne nettoie pas les références YOLO non plus
- **Fichier :** `backend/src/pi/providers.ts`
- **Lignes :** Dans `deleteProvider()`
- **Sévérité :** 🟡 Moyenne
- **Description :** Similaire au BUG-06. La fonction `deleteProvider()` nettoie les références dans les modes `code`, `plan`, `review`, et nettoie également `commitModelId`, mais **ne nettoie pas** :
  - `yolo.modelId` — si le provider supprimé hébergeait le modèle YOLO, la config reste pointée vers un modèle inexistant.
  - `visionModelId` — si le provider hébergeait le modèle de vision.
  - `audioModelId` — si le provider hébergeait le modèle audio.
- **Fix :** Ajouter le cleanup pour `m.yolo?.modelId` dans la boucle, et ajouter `if (library.visionModelId && !library.models.find(m => m.id === library.visionModelId)) library.visionModelId = null; if (library.audioModelId && !library.models.find(m => m.id === library.audioModelId)) library.audioModelId = null;` après la boucle.

#### BUG-08: `tool_execution_end` met `isStreaming = true` au lieu de `false` — [FIXED 2026-06-23]
- **Fichier :** `backend/src/pi/session.ts`
- **Sévérité :** 🟡 Moyenne
- **Description :** Après `tool_execution_end`, le code forçait `isStreaming = true`, ce qui pouvait laisser le frontend dans un état de streaming permanent si `agent_end` était manqué.
- **Fix :** Supprimé `state.isStreaming = true` du bloc `tool_execution_end`. Le streaming global est géré uniquement par `agent_start`/`agent_end`. Ajouté un watchdog frontend (3 min) et une restauration auto lors de la reconnexion WebSocket.

#### BUG-09: Fichiers de sauvegarde dans le repo (`App.tsx.bak`, `.backup2`, etc.) — [RESOLVED]
- **Fichiers :** `frontend/src/App.tsx.bak`, `frontend/src/App.tsx.bak2`, `frontend/src/App.tsx.backup2`
- **Sévérité :** 🟢 Basse
- **Description :** Trois fichiers de backup de `App.tsx` étaient présents dans le repo. Cela viole la règle du `AGENTS.md` : "Aucun fichier temporaire dans le repo".
- **Statut :** Les fichiers ont été supprimés du repo. Le `.gitignore` couvre désormais `*.bak`, `*.bak2`, `*.backup`, `*.backup2`.

#### BUG-10: `test.db` commité dans le repo — [RESOLVED]
- **Fichier :** `test.db` (à la racine)
- **Sévérité :** 🟢 Basse
- **Description :** Un fichier `test.db` (probablement une base de données de test SQLite) était présent à la racine du repo. Il ne devrait pas être versionné.
- **Statut :** Le fichier a été retiré du repo. Le `.gitignore` contient désormais `test.db`.

#### BUG-11: `unhandledRejection` ne termine pas le processus
- **Fichier :** `backend/src/index.ts`
- **Lignes :** Fin du fichier (handler `unhandledRejection`)
- **Sévérité :** 🟡 Moyenne
- **Description :** Le handler `uncaughtException` appelle `shutdown()` et force un `process.exit(1)` après 1s, mais le handler `unhandledRejection` se contente de logger l'erreur sans arrêter le processus. En Node.js, une promesse rejetée non gérée peut laisser l'application dans un état instable. Bien que Node 15+ ne crash plus par défaut sur les unhandled rejections, l'application peut continuer à tourner avec un état corrompu.
- **Recommandation :** Selon la politique de robustesse souhaitée, soit arrêter le processus (comme pour `uncaughtException`), soit s'assurer que toutes les promesses sont correctement gérées en amont.

#### BUG-12: API Keys agent exposées sans authentification — [FIXED]
- **Fichier :** `backend/src/routes/agent-keys.ts`
- **Sévérité :** 🔴 Haute (sécurité)
- **Description :** Les routes `/api/agent-keys/*` n'avaient **aucune authentification**. N'importe qui avec accès à l'URL du serveur pouvait lister, créer, révéler le token complet, ou supprimer les clés.
- **Fix :** Ajout d'un middleware `adminAuth` avec 3 niveaux :
  1. **Bootstrap** — si aucune clé n'existe, `POST /` est autorisé sans auth (pour créer la première clé)
  2. **Same-origin** — les requêtes du navigateur sur le même serveur (web UI) sont autorisées via `Sec-Fetch-Site: same-origin` (navigateurs modernes) ou comparaison `Origin`/`Host` (fallback)
  3. **Externe** — les requêtes externes (curl, autre site web) nécessitent un `Bearer <agent-token>` valide
  Le frontend n'a pas besoin de modification : les requêtes du navigateur sont automatiquement same-origin.

#### BUG-13: `setGitIdentity` écrit toujours dans le config global
- **Fichier :** `backend/src/projects/git.ts`
- **Sévérité :** 🟡 Moyenne
- **Description :** `setGitIdentity()` fait `git config --global user.name` et `git config --global user.email` en plus du config local. Si plusieurs projets tournent sur le même serveur avec des identités git différentes, l'identité globale sera écrasée à chaque changement, créant des conflits.
- **Fix :** Ne configurer que le repository local (`git config user.name/email`), pas le global. Ou ajouter un paramètre pour choisir le scope.

#### BUG-14: `gitWithAuth` ne restaure pas l'URL en cas d'erreur non-auth
- **Fichier :** `backend/src/projects/git.ts`
- **Sévérité :** 🟡 Moyenne
- **Description :** Dans `gitPull()` et `gitPush()`, `restoreRemoteUrl()` est appelé dans le bloc `finally`. C'est correct. Mais dans `gitCommitAndPush()`, `gitPush()` est appelé dans un try/catch qui n'est pas dans un `finally` pour la restauration. En réalité, `gitPush()` a déjà son propre `finally` avec `restoreRemoteUrl()`, donc c'est OK. Cependant, si `gitWithAuth()` lui-même échoue (avant que l'opération git ne commence), l'URL n'est pas restaurée car le `finally` des fonctions pull/push ne s'exécute que si `gitWithAuth` réussit.
- **Statut :** À vérifier — le risque est faible car `gitWithAuth` ne modifie l'URL que s'il réussit à la lire d'abord.

#### BUG-15: Fuite de credentials dans les logs
- **Fichier :** `backend/src/projects/git.ts`
- **Sévérité :** 🟡 Moyenne (sécurité)
- **Description :** Plusieurs `console.log` affichent des URLs avec credentials redacted (`replace(/:[^@]+@/, ":****@")`), ce qui est bien. Cependant, dans `gitClone()`, le log `console.log(\`[git-clone] Auth URL (redacted): ${authUrl.replace(/:[^@]+@/, ":****@")}\`)` peut ne pas redacter correctement si le password contient un `@` (le regex s'arrête au premier `@` rencontré, pas au dernier). Un password avec `@` exposerait une partie du credential dans les logs.
- **Fix :** Utiliser un regex plus robuste pour la rédaction, ou ne jamais logger l'URL complète, même redactée.

#### BUG-16: `BroadcastChannel` dans `App.tsx` référence `panels` et `savePanels` dans les deps mais ne les utilise pas correctement
- **Fichier :** `frontend/src/App.tsx`
- **Lignes :** useEffect avec BroadcastChannel
- **Sévérité :** 🟢 Basse
- **Description :** L'effet BroadcastChannel a `panels` et `savePanels` dans ses dépendances, mais `savePanels` n'est pas utilisé dans le handler. Le `setPanels` direct est utilisé à la place, ce qui contourne `savePanels` (qui persiste dans localStorage). Le panel restauré ne sera pas persisté.
- **Fix :** Utiliser `savePanels` au lieu de `setPanels` dans le handler `restore-panel`.

#### BUG-17: `handleSelectProject` ne vérifie pas si un streaming est en cours
- **Fichier :** `frontend/src/App.tsx`
- **Sévérité :** 🟢 Basse (UX)
- **Description :** `handleSelectProject` appelle directement `activateProject(project)` sans vérifier si le projet courant est en streaming. La ROADMAP mentionnait `showProjectSwitch` et `pendingProject` pour confirmer le switch pendant un streaming, mais `handleSelectProject` ne déclenche jamais cette confirmation — il active directement le nouveau projet.
- **Fix :** Si `isStreaming && activeProject`, afficher la `ProjectSwitchModal` au lieu d'activer directement.

### Frontend

#### BUG-18: Multiples listeners `pi_event` dupliqués dans `ChatView`
- **Fichier :** `frontend/src/components/Chat/ChatView.tsx`
- **Sévérité :** 🟡 Moyenne
- **Description :** `ChatView` enregistre **trois** listeners séparés sur `pi_event` via `on("pi_event", ...)` :
  1. Le handler principal de streaming (messages, tool calls)
  2. Le handler de custom messages (git_notification, etc.)
  3. Le handler de session reload
  
  Chaque appel à `on()` ajoute un listener indépendant. Bien que chacun ait son `unsub()`, tous les trois reçoivent **tous** les événements `pi_event`. Cela signifie que le handler principal et le handler de custom messages traitent tous les deux `message_start` — le handler de custom messages filtre sur `role === "custom"`, mais le handler principal ne filtre pas les customs, ce qui peut causer des doublons d'affichage pour certains types de messages custom.
- **Fix :** Consolider les trois handlers en un seul, ou s'assurer que les filtres sont mutuellement exclusifs.

#### BUG-19: `useChatHistory` est instancié deux fois pour le même projectId
- **Fichier :** `frontend/src/components/Chat/ChatView.tsx` et `frontend/src/App.tsx`
- **Sévérité :** 🟢 Basse
- **Description :** `useChatHistory(projectId)` est appelé dans `ChatView`. Le hook utilise des `useRef` pour stocker le store global, donc chaque instance de `ChatView` (docked + floating + standalone) aura son propre store indépendant. Si plusieurs instances de `ChatView` existent simultanément (panneau docké + fenêtre flottante), elles ne partageront pas le même store, ce qui peut causer des désync.
- **Statut :** En pratique, une seule instance de ChatView est active à la fois (docked OU floating OU standalone), donc le risque est faible.

#### BUG-20: `GroupedMessages` utilise `groups.length===0` au lieu de `groups.length === 0`
- **Fichier :** `frontend/src/components/Chat/ChatView.tsx`
- **Sévérité :** 🟢 Basse (style)
- **Description :** Ligne : `if (msg.role === "user" || groups.length===0 || groups[groups.length-1][0].role==="user")` — manque d'espaces autour de `===`. Purement cosmétique, pas un bug fonctionnel.

#### BUG-21: Chat non effacé après `/new` si `pi_command_result` arrive avant `pi_history`
- **Fichier :** `frontend/src/components/Chat/ChatView.tsx`
- **Sévérité :** 🟡 Moyenne
- **Description :** Quand l'utilisateur tape `/new`, le backend envoie d'abord un `pi_command_result` avec `command: "new"`, puis l'événement `pi_started` avec `pi_history` contenant les messages de la nouvelle session (vide). Le handler `pi_command_result` fait `setMessages([])`, mais le handler `pi_history` peut arriver après et restaurer des messages si le timing est mauvais (race condition). Le handler `pi_history` vérifie `existing.some(m => m._streaming)` mais ne vérifie pas si un `/new` vient d'être exécuté.
- **Fix :** Ajouter un flag temporaire (ex: `justClearedRef`) qui ignore le prochain `pi_history` après un `/new` ou `/clear`.

#### BUG-22: Pas de limite de taille pour le localStorage des messages
- **Fichier :** `frontend/src/components/Chat/ChatView.tsx`
- **Sévérité :** 🟡 Moyenne
- **Description :** Les messages sont persistés dans `localStorage` via `localStorage.setItem(\`pi-web-chat-${projectId}\`, JSON.stringify(messagesRef.current))`. Pour de longues conversations, cela peut dépasser la limite de 5-10MB de localStorage, causant un `QuotaExceededError` silencieux (le `catch {}` l'ignore). Les messages seront perdus au prochain rechargement.
- **Fix :** Limiter le nombre de messages persistés (ex: les 200 derniers), ou utiliser IndexedDB.

#### BUG-23: `MAX_VISIBLE_GROUPS` limite les rendus mais pas le state
- **Fichier :** `frontend/src/components/Chat/ChatView.tsx`
- **Sévérité :** 🟢 Basse (performance)
- **Description :** `GroupedMessages` ne rend que les 200 derniers groupes, mais le state `messages` contient TOUS les messages. Pour une conversation de 1000+ messages, `setMessages` est appelé avec un tableau de plus en plus grand à chaque `text_delta`, ce qui consomme de la mémoire et ralentit le diff React.
- **Fix :** Envisager de tronquer le state `messages` lui-même, ou utiliser une virtualisation (react-window).

#### BUG-24: `App.tsx` — `showProjectSwitch` et `pendingProject` ne sont jamais utilisés
- **Fichier :** `frontend/src/App.tsx`
- **Sévérité :** 🟢 Basse (code mort)
- **Description :** Les states `showProjectSwitch` et `pendingProject` sont déclarés, et le modal `ProjectSwitchModal` est rendu si `showProjectSwitch && pendingProject`, mais aucune logique ne met jamais ces states à `true` / une valeur non-null. `handleSelectProject` appelle directement `activateProject` sans passer par la confirmation. Le composant `ProjectSwitchModal` est importé mais jamais réellement déclenché.
- **Fix :** Soit implémenter la logique de confirmation (comme prévu), soit supprimer le code mort.

### Extensions & Configuration

#### BUG-25: `isPathAllowed` dans `agent.ts` diffère de `files.ts`
- **Fichier :** `backend/src/routes/agent.ts` vs `backend/src/routes/files.ts`
- **Sévérité :** 🟢 Basse
- **Description :** Les deux fichiers définissent `isPathAllowed` avec la même logique de base, mais avec des différences subtiles :
  - `files.ts` utilise `resolved.startsWith(resolvedRoot)` (vulnérable au path traversal si `resolvedRoot = /home` et `resolved = /homeetc`)
  - `agent.ts` utilise `path.resolve(root) === resolved || resolved.startsWith(path.resolve(root) + path.sep)` (plus sûr)
  Le code de `files.ts` est moins sûr car `startsWith` sans `path.sep` peut matcher `/homeevil` si `root = /home`.
- **Fix :** Utiliser la version sécurisée de `agent.ts` partout, ou factoriser dans un utilitaire partagé.

#### BUG-26: `ALLOWED_ROOTS` hardcoded — pas configurable
- **Fichiers :** `backend/src/routes/files.ts` et `backend/src/routes/agent.ts`
- **Sévérité :** 🟡 Moyenne
- **Description :** Les racines autorisées pour le file browser sont hardcoded : `["/projects", "/home", "/mnt"]`. En Docker, le cwd des projets peut être n'importe où (défini par l'utilisateur). Si un projet a son cwd en dehors de ces racines (ex: `/app/myproject`), le file browser refusera l'accès.
- **Fix :** Soit auto-inclure le cwd des projets dans les ALLOWED_ROOTS, soit rendre configurable via env var.

#### BUG-27: `gitInit` ne configure pas de upstream tracking
- **Fichier :** `backend/src/projects/git.ts`
- **Sévérité :** 🟢 Basse
- **Description :** `gitInit()` fait `git init()`, `addRemote("origin", remote)`, et `checkoutLocalBranch(branch)`, mais ne configure pas le tracking upstream (`git push -u origin branch`). Le premier `gitPush()` peut échouer avec "no upstream branch".
- **Fix :** Ajouter `await git.push(["-u", "origin", branch], () => {})` ou `git.branch(["--set-upstream-to", \`origin/${branch}\`, branch])`.

---

## 🆕 Bugs identifiés lors de l'analyse du 2026-06-23

#### BUG-28: Command injection dans `pi-settings.ts` — 🔴 CRITIQUE
- **Fichier :** `backend/src/routes/pi-settings.ts`
- **Lignes :** 296, 310, 353
- **Sévérité :** 🔴 Haute (sécurité — exécution de commandes arbitraires)
- **Description :** Les appels `execSync()` utilisent des chaînes interpolées avec des valeurs provenant de l'utilisateur (`source`), permettant l'injection de commandes arbitraires :
  ```ts
  // Ligne 296 — npm install
  const pkgSpec = source.startsWith("@") ? source : source.split("@")[0].split("/")[0];
  execSync(`npm install --prefix ${AGENT_DIR} ${pkgSpec}`, ...);

  // Ligne 310 — git clone
  execSync(`git clone --depth 1 ${source.includes("@") ? source.split("@")[0] : source} ${...}`, ...);

  // Ligne 353 — npm uninstall
  const pkgName = source.startsWith("@") ? ... : source.split("@")[0].split("/")[0];
  execSync(`npm uninstall --prefix ${AGENT_DIR} ${pkgName}`, ...);
  ```
  Un utilisateur peut envoyer `source = "foo; rm -rf /tmp/pi-web"` → `execSync("npm install --prefix /root/.pi/agent foo; rm -rf /tmp/pi-web")` → exécution arbitraire.
- **Fix :** Utiliser `execFileSync(npm, ["install", "--prefix", AGENT_DIR, pkgSpec], ...)` avec un tableau d'arguments (pas de shell), ou sanitizer strictement les entrées avec une regex `^[a-zA-Z0-9@/_\.\-]+$`.

#### BUG-29: Aucune authentification sur la majorité des routes API
- **Fichier :** `backend/src/index.ts`
- **Sévérité :** 🔴 Haute (sécurité)
- **Description :** Seules deux routes ont un middleware d'authentification :
  - `/api/agent/*` → `agentAuth` (Bearer token)
  - `/api/agent-keys/*` → `adminAuth` (same-origin + Bearer)
  
  Toutes les autres routes sont **complètement non authentifiées** :
  - `/api/projects/*` — créer/supprimer/modifier des projets, git push/pull/clone
  - `/api/files/*` — naviguer, lire, écrire, uploader, télécharger des fichiers
  - `/api/settings/*` — changer de modèle, thinking, créer session, **update pi-agent** (provoque `process.exit(0)`)
  - `/api/model-library/*` — CRUD modèles
  - `/api/providers/*` — CRUD providers, test connexion (expose clés API dans la réponse)
  - `/api/attachments/*` — upload/serve/delete fichiers
  - `/api/usage/*` — consulter les statistiques
  - `/api/pi/*` — gestion extensions, **npm install/git clone** (→ commande injection BUG-28), reload, YOLO
  - `/api/ollama/*` — configuration Ollama
  - `/api/cbm/*` — codebase memory
  - `/api/sessions/*` — historique des conversations
  
  Le CORS (`ALLOWED_ORIGINS`) et le WS origin check protègent contre les attaques cross-origin depuis un navigateur, mais ne protègent pas contre les accès directs (curl, scripts, réseau local).
- **Fix :** Ajouter un middleware d'authentification global (session token, basic auth, ou similaire à `adminAuth`), configurable via env var pour le mode développement.

#### BUG-30: `POST /api/settings/update` provoque un `process.exit(0)` sans authentification — [FIXED 2026-06-23]
- **Fichier :** `backend/src/routes/settings.ts`
- **Lignes :** 61-76
- **Sévérité :** 🟡 Moyenne (lié à BUG-29)
- **Description :** La route `POST /api/settings/update` exécute `npm install @earendil-works/pi-coding-agent@latest` puis `process.exit(0)` pour redémarrer. Sans authentification, n'importe qui pouvait forcer la mise à jour et le redémarrage du serveur.
- **Fix :** Corrigé par le middleware `apiAuth` (BUG-29) — la route `/api/settings/update` n'est pas dans les endpoints publics, donc elle nécessite désormais une authentification pour les accès externes.
- **Impact UX :** Aucun — le frontend (same-origin) accède à cette route sans token.

#### BUG-31: Route `PUT /reorder` injoignable (code mort) — réorganisation des projets cassée
- **Fichier :** `backend/src/routes/projects.ts`
- **Lignes :** 86 (`PUT /:id`) et 518 (`PUT /reorder`)
- **Sévérité :** 🟡 Moyenne
- **Description :** La route `PUT /:id` est définie à la ligne 86, et `PUT /reorder` à la ligne 518. Express évalue les routes dans l'ordre. `PUT /:id` matche `PUT /reorder` avec `id = "reorder"`. La route `reorder` est donc **injoignable** — toute requête `PUT /api/projects/reorder` est interceptée par `PUT /:id` qui tente de trouver un projet avec l'ID `"reorder"`, échoue, et renvoie une erreur.
- **Impact :** La réorganisation des projets est complètement cassée.
- **Fix :** Déplacer `PUT /reorder` AVANT `PUT /:id`, ou utiliser un chemin distinct comme `PUT /reorder-projects`.

#### BUG-32: `removeModel()` ne nettoie pas `visionModelId`, `audioModelId`, `commitModelId`
- **Fichier :** `backend/src/pi/model-library.ts`
- **Sévérité :** 🟡 Moyenne
- **Description :** La fonction `removeModel()` nettoie les références dans `projectModes` (code/plan/review) mais ne nettoie pas les champs globaux `visionModelId`, `audioModelId`, et `commitModelId`. Si le modèle supprimé était configuré comme modèle de vision, audio, ou commit, ces champs pointent vers un modèle inexistant. (Le cleanup YOLO est couvert par BUG-06.)
- **Fix :** Ajouter après la boucle de cleanup : `if (library.visionModelId === id) library.visionModelId = null; if (library.audioModelId === id) library.audioModelId = null; if (library.commitModelId === id) library.commitModelId = null;`

#### BUG-33: `deleteProvider()` ne nettoie pas `visionModelId` et `audioModelId`
- **Fichier :** `backend/src/pi/providers.ts`
- **Sévérité :** 🟡 Moyenne
- **Description :** La fonction `deleteProvider()` nettoie `commitModelId` et les références dans les modes code/plan/review, mais ne nettoie pas `visionModelId` ni `audioModelId`. Si le provider supprimé hébergeait le modèle de vision ou audio, ces champs deviennent des références pendantes. (Le cleanup YOLO est couvert par BUG-07.)
- **Fix :** Ajouter le cleanup pour `visionModelId` et `audioModelId` après le nettoyage de `commitModelId`.

#### BUG-34: `require("fs")` dans `smb.ts` — module ESM
- **Fichier :** `backend/src/projects/smb.ts`
- **Ligne :** 138
- **Sévérité :** 🟡 Moyenne
- **Description :** `cleanupCredentialsFile()` utilise `const { unlinkSync, rmdirSync } = require("fs")` dans un module ESM. Le fichier importe déjà `writeFileSync`, `existsSync`, `mkdirSync` via `import` en haut — `unlinkSync` et `rmdirSync` devraient être ajoutés à cet import. (Même classe de bug que BUG-05.)
- **Fix :** Ajouter `unlinkSync, rmdirSync` à l'import ESM existant en haut du fichier.

#### BUG-35: `require("pdf-parse")` et `require("fs")` dans `attachments.ts` — module ESM
- **Fichier :** `backend/src/routes/attachments.ts`
- **Lignes :** 412, 482
- **Sévérité :** 🟡 Moyenne
- **Description :** Deux utilisations de `require()` dans un module ESM :
  - Ligne 412 : `require("fs").rmdirSync(dir, { recursive: true })` — utiliser `rmSync` de l'import ESM déjà présent en haut du fichier.
  - Ligne 482 : `require("pdf-parse")` — devrait utiliser `await import("pdf-parse")`.
  (Même classe de bug que BUG-05.)
- **Fix :** Remplacer `require("fs").rmdirSync(...)` par `rmSync(...)` (déjà importé) et `require("pdf-parse")` par `await import("pdf-parse")`.

#### BUG-36: Race condition potentielle dans le project manager (lectures non protégées)
- **Fichier :** `backend/src/projects/manager.ts`
- **Sévérité :** 🟢 Basse
- **Description :** Les fonctions `getAllProjects()`, `getProject()`, `getProjectByName()` appellent `loadProjects()` sans le mutex. Les fonctions d'écriture (`createProject`, `updateProject`, etc.) utilisent le mutex. Si une lecture se produit pendant qu'une écriture est en cours (sauvegarde du fichier JSON), la lecture pourrait obtenir des données partielles. Le risque est faible car `writeFileSync` est généralement atomique, mais le pattern read-modify-write n'est pas protégé pour les lectures.
- **Fix :** Utiliser le mutex pour toutes les opérations de lecture, ou utiliser un cache en mémoire avec invalidation.

#### BUG-37: `gitClone` utilise deux méthodes différentes pour le même clone
- **Fichier :** `backend/src/projects/git.ts`
- **Lignes :** ~430-470
- **Sévérité :** 🟢 Basse
- **Description :** Dans `gitClone()`, le clone avec auth utilise `git.raw(["-c", "transfer.credentialsInUrl=allow", "clone", authUrl, repoName, "--branch", branch])`, mais le clone sans auth utilise `git.clone(remote, repoName, ["--branch", branch])`. Ces deux méthodes peuvent se comporter différemment (la méthode `git.clone` peut ajouter des options par défaut).
- **Fix :** Utiliser la même méthode `git.raw()` dans les deux cas pour assurer un comportement cohérent.

#### BUG-38: `rmdirSync` (deprecated) utilisé dans `smb.ts`
- **Fichier :** `backend/src/projects/smb.ts`
- **Ligne :** 140
- **Sévérité :** 🟢 Basse
- **Description :** `rmdirSync(path.dirname(credFile))` — `rmdirSync` est deprecated depuis Node 16 pour les suppressions récursives. Bien qu'ici il ne s'agisse que d'un répertoire vide, c'est une API deprecated.
- **Fix :** Utiliser `rmSync(path.dirname(credFile), { force: true })` à la place.

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
- **[IDENTIFIED 2026-06-03] Latence interface sur Firefox/Floorp** — Le Cycle Collector de Firefox tourne à 50% CPU même au repos. Ce n'est PAS un problème de l'app (1877 nœuds DOM, le debug overlay confirme des latences keystroke normales). Cause : les autres onglets du navigateur. En navigation privée ou avec un seul onglet, le problème disparaît. Fix partiel : auto-désactivation des scanlines et matrix-bg sur Gecko (overlays plein écran `position: fixed` qui aggravent le CC). Recommandation : utiliser Chrome/Chromium pour des performances optimales, ou garder peu d'onglets ouverts sur Firefox.

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
- ✅ **Utiliser Chart.js pour les graphiques** — Implémenté dans UsageStatsModal. Toggle Bar/Line/Pie, tooltips au hover, axes formatés (K/M), thème hacker préservé. La modale utilise aussi le `ModalDialog` standard (1200x800 par défaut) avec drag/resize.
- ✅ **Onglet Raccourcis clavier dans Settings** — Implémenté. Affiche les raccourcis groupés par catégorie (Application / Chat / Modales) avec `<kbd>` stylés, icônes et warnings pour les conflits navigateur. La personnalisation (reconfiguration) reste une future amélioration.
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

---

## 🏗️ Architecture Planifiée — Pi-Web Harness

### Contexte

S'inspirant de **SAW (SAFe Agentic Workflow)** de ByBren LLC (https://github.com/bybren-llc/safe-agentic-workflow), on remplace le mode YOLO (déprécié) par un nouveau mode **HARNESS** : orchestration multi-agent avec rôles spécialisés, contrôle de concurrence, et bases de connaissance.

### 1. Concurrency Manager (P1)

Deux pools indépendants configurables dans l'interface Settings :

```
☎️ LLM slots max : [3]    ← Limite ton abonnement provider (RPM/TPM)
🔧 Agent slots max : [5]  ← Limite RAM serveur (~200MB/session)
```

**Règles :**
- Un agent **consomme un agent slot** au démarrage (sa session Pi SDK)
- Un agent **consomme un LLM slot** seulement pendant un appel provider (attente réseau)
- Si tous les LLM slots sont pris, l'agent attend en file d'attente
- Si tous les agent slots sont pris, la tâche attend au niveau le plus haut

**Fichiers :** `backend/src/pi/concurrency.ts` + UI dans Settings

---

### 2. Harness Mode (P2)

Nouveau mode dédié, 100% indépendant des modes CODE/PLAN/REVIEW. On peut basculer entre mode normal et harness.

**Architecture :**
```
Orchestrator (lead agent)
├── Agent 1 (ARCHITECT) → Session #1 (modèle rapide, read/grep/cbm)
├── Agent 2 (DEVELOPER) → Session #2 (modèle puissant, read/write/edit/bash)
├── Agent 3 (REVIEWER)  → Session #3 (modèle équilibré, read/grep/diff)
└── Agent 4 (QA)        → Session #4 (modèle rapide, bash/test)
```

**Principes :**
- Chaque agent a **son propre contexte** (sa session Pi SDK avec son historique)
- Contexte **partagé** via artefacts sur disque + messages de l'orchestrator
- Chaque agent peut avoir son **propre modèle LLM**
- Qualité : pipeline multi-étage
- Orchestrator synthétise le résultat final

**Fichiers :** `backend/src/pi/harness-engine.ts`

---

### 3. Technical Knowledge Base (P3)

Cache automatique des recherches web avec TTL configurable.

```
.pi/knowledge/technical/
├── sources/              ← Fichiers horodatés
├── index.json            ← URL → fichier, date, TTL
└── config.json           ← TTL par défaut
```

**Interception :** Hook automatique sur les appels `firecrawl_scrape/search` → vérifie le cache avant d'appeler l'API.

**Fichiers :** `backend/src/pi/knowledge-base.ts`

---

### 4. User Knowledge Base (P4)

Profil utilisateur persistant : préférences UI/UX, habitudes de code, décisions d'architecture.

```
.pi/knowledge/user/
├── preferences.json          ← Thème, police, accent
├── ui-preferences.md         ← Style UI, composants préférés
├── coding-habits.md          ← Conventions code
├── project-templates/        ← Templates réutilisables
└── decisions.log             ← Décisions passées
```

**Apprentissage :** Détection de patterns au fil des sessions (framework, librairies, outils).

**Fichiers :** `backend/src/pi/user-preferences.ts`

---

### 5. Quality Gates Pipeline (P4)

Pipeline de validation multi-étage configurable :

```
[Agent] → [Lint & Build] → [Auto-Review N cycles] → [QA Tests] → [Security] → [Résultat]
```

Chaque gate peut être requis (bloquant) ou optionnel.

---

### 6. Timeline de réalisation

| Phase | Contenu | Dépend de | Complexité |
|-------|---------|-----------|-----------|
| **P0** | Retirer YOLO de l'UI + préparer mode Harness | — | 🟢 Faible (1j) |
| **P1** | Concurrency Manager (LLM + Agent slots) | P0 | 🟡 Moyenne (2j) |
| **P2** | Harness Engine (N agents, rôles, orchestration) | P1 | 🔴 Élevée (5j) |
| **P3** | Technical KB (cache auto, TTL, refresh) | — | 🟡 Moyenne (3j) |
| **P4** | User KB (préférences, auto-apprentissage) | — | 🟡 Moyenne (2j) |
| **P5** | Quality Gates Pipeline (multi-stage) | P2 | 🟡 Moyenne (3j) |
| **P6** | Dark Factory (agents persistants parallèles) | P2 | 🔴 Élevée (5j) |

---

### 7. Fichiers à créer

| Fichier | Phase | Rôle |
|---------|-------|------|
| `backend/src/pi/concurrency.ts` | P1 | Gestionnaire de concurrence |
| `backend/src/pi/harness-engine.ts` | P2 | Orchestrateur multi-agent |
| `backend/src/pi/knowledge-base.ts` | P3 | Base de connaissance technique |
| `backend/src/pi/user-preferences.ts` | P4 | Profil utilisateur |
| `frontend/src/components/Modals/HarnessConfigModal.tsx` | P2 | UI config harness |
| `frontend/src/components/Modals/KnowledgeBaseModal.tsx` | P3 | UI KB technique |
| `frontend/src/components/Modals/ConcurrencyConfigModal.tsx` | P1 | UI config concurrence |

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
| YOLO | ⏳ Déprécié (remplacé par HARNESS) | Débat multi-agent : 2 sessions temporaires, cycles plan + code. Conservé dans le code mais masqué de l'interface. |
| HARNESS | 🚧 Planifié | Orchestration multi-agent avec rôles SAFe, files d'attente, quality gates, knowledge base. Voir section Architecture Planifiée. |
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
| Agent Keys | `/api/agent-keys/*` (CRUD, reveal — auth `adminAuth`) | ✅ |
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
  ├── /api/agent-keys/* → gestion tokens agent (auth `adminAuth`)
  ├── ⚠️ BUG-29 : toutes les autres routes /api/* n'ont aucune authentification
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

## 📊 Résumé des bugs identifiés

| # | Sévérité | Type | Description | Fichier |
|---|----------|------|-------------|---------|
| 01 | 🟡 | Code mort | Route `POST /:id/git/sync` dupliquée | `routes/projects.ts` |
| 02 | 🟡 | Promesse flottante | `syncToModelsJson()` sans `await` dans DELETE vision/audio model | `routes/model-library.ts` |
| 03 | 🟢 | Robustesse | `reapplyAllSessions()` non awaité (intentionnel mais à documenter) | `routes/model-library.ts` |
| 04 | 🟡 | Logique | Nettoyage cache attachments incorrect (`unlinkSync` sur un dossier) | `routes/attachments.ts` |
| 05 | 🟡 | Compatibilité | `require()` en ESM dans `session.ts`, `smb.ts`, `attachments.ts` | plusieurs |
| 06 | 🟡 | Logique | `removeModel()` ne nettoie pas `yolo.modelId` | `pi/model-library.ts` |
| 07 | 🟡 | Logique | `deleteProvider()` ne nettoie pas `yolo.modelId` | `pi/providers.ts` |
| 08 | 🟡 | Logique | `tool_execution_end` force `isStreaming = true` — **[FIXED]** | `pi/session.ts` |
| 09 | 🟢 | Propreté | Fichiers `.bak` / `.backup2` dans le repo — **[RESOLVED]** | `frontend/src/` |
| 10 | 🟢 | Propreté | `test.db` commité dans le repo — **[RESOLVED]** | racine |
| 11 | 🟡 | Robustesse | `unhandledRejection` ne termine pas le processus | `index.ts` |
| 12 | 🔴 | Sécurité | API Keys agent exposées sans auth — **[FIXED]** : middleware `adminAuth` | `routes/agent-keys.ts` |
| 13 | 🟡 | Logique | `setGitIdentity` écrit toujours dans le config global git | `projects/git.ts` |
| 14 | 🟡 | Sécurité | URL remote non restaurée si `gitWithAuth` échoue avant l'opération | `projects/git.ts` |
| 15 | 🟡 | Sécurité | Fuite potentielle de credentials dans les logs (password avec `@`) | `projects/git.ts` |
| 16 | 🟢 | Logique | BroadcastChannel utilise `setPanels` au lieu de `savePanels` (pas persisté) | `App.tsx` |
| 17 | 🟢 | UX | Switch de projet pendant streaming sans confirmation | `App.tsx` |
| 18 | 🟡 | Logique | 3 listeners `pi_event` séparés dans ChatView (doublons potentiels) | `Chat/ChatView.tsx` |
| 19 | 🟢 | Architecture | `useChatHistory` instancié par-instance (peut désync si multi-instances) | `ChatView.tsx` |
| 20 | 🟢 | Style | Manque d'espaces `===` dans GroupedMessages | `ChatView.tsx` |
| 21 | 🟡 | Race condition | Chat non effacé après `/new` si `pi_history` arrive après `pi_command_result` | `ChatView.tsx` |
| 22 | 🟡 | Limite | Pas de limite de taille pour localStorage des messages (QuotaExceeded) | `ChatView.tsx` |
| 23 | 🟢 | Performance | `MAX_VISIBLE_GROUPS` limite le rendu mais pas le state (mémoire) | `ChatView.tsx` |
| 24 | 🟢 | Code mort | `showProjectSwitch` / `pendingProject` / `ProjectSwitchModal` jamais déclenchés | `App.tsx` |
| 25 | 🟢 | Sécurité | `isPathAllowed` dans `files.ts` vulnérable (startsWith sans path.sep) | `routes/files.ts` |
| 26 | 🟡 | Config | `ALLOWED_ROOTS` hardcoded — projets hors racines inaccessibles | `routes/files.ts` |
| 27 | 🟢 | Logique | `gitInit` ne configure pas le tracking upstream | `projects/git.ts` |
| **28** | **🔴** | **Sécurité** | **Command injection dans `npm install` / `git clone` — [FIXED]** | `routes/pi-settings.ts` |
| **29** | **🔴** | **Sécurité** | **Aucune auth sur la majorité des routes API — [FIXED]** : middleware `apiAuth` | `index.ts` |
| **30** | 🟡 | Sécurité | `process.exit(0)` sans auth sur `/api/settings/update` — [FIXED] | `routes/settings.ts` |
| **31** | 🟡 | Code mort | Route `PUT /reorder` injoignable — réorganisation cassée | `routes/projects.ts` |
| **32** | 🟡 | Logique | `removeModel()` ne nettoie pas `visionModelId`/`audioModelId`/`commitModelId` | `pi/model-library.ts` |
| **33** | 🟡 | Logique | `deleteProvider()` ne nettoie pas `visionModelId`/`audioModelId` | `pi/providers.ts` |
| **34** | 🟡 | Compatibilité | `require("fs")` en ESM dans `smb.ts` | `projects/smb.ts` |
| **35** | 🟡 | Compatibilité | `require("pdf-parse")` / `require("fs")` en ESM dans `attachments.ts` | `routes/attachments.ts` |
| **36** | 🟢 | Race condition | Lectures non protégées dans le project manager | `projects/manager.ts` |
| **37** | 🟢 | Cohérence | `gitClone` utilise deux méthodes différentes pour le même clone | `projects/git.ts` |
| **38** | 🟢 | Deprecated | `rmdirSync` deprecated utilisé dans `smb.ts` | `projects/smb.ts` |
| **39** | 🔴 | Performance | `session.prompt()` / `session.steer()` sans timeout — **[FIXED 2026-06-28]** : `withSessionTimeout` 5 min | `pi/session.ts` |
| **40** | 🟡 | Logique | Auto-review ne se déclenche qu'une fois par session — **[FIXED 2026-06-28]** : reset `reviewCycle` à chaque prompt | `pi/session.ts` |
| **41** | 🟡 | UX | Impossible de savoir si le streaming est actif ou bloqué — **[FIXED 2026-06-28]** : stall detector + indicateurs | `App.tsx` + UI |

### Priorité de correction recommandée

1. **🔴 BUG-28** — Sécurité critique : command injection dans `pi-settings.ts` — **[FIXED]**
2. **🔴 BUG-29** — Sécurité critique : aucune auth sur la majorité des routes API — **[FIXED]**
3. **🔴 BUG-12** — Sécurité : API Keys agent exposées — **[FIXED]**
4. **🟡 BUG-08** — `isStreaming` forcé à `true` — **[FIXED]**
5. **🟡 BUG-30** — `process.exit(0)` sans auth — **[FIXED]**
6. **🟡 BUG-31** — Route `PUT /reorder` injoignable — réorganisation cassée
6. **🟡 BUG-04** — Nettoyage cache attachments cassé
7. **🟡 BUG-02** — Promesses flottantes `syncToModelsJson()`
8. **🟡 BUG-06 + BUG-07** — Cleanup YOLO manquant dans `removeModel` / `deleteProvider`
9. **🟡 BUG-32 + BUG-33** — Cleanup `visionModelId`/`audioModelId`/`commitModelId` manquant
10. **🟡 BUG-05 + BUG-34 + BUG-35** — `require()` en ESM (3 fichiers)
11. **🟡 BUG-01** — Route dupliquée
12. **🟡 BUG-21** — Race condition `/new` + `pi_history`
13. **🟡 BUG-15** — Fuite credentials dans logs
14. **🟡 BUG-22** — Limite localStorage
15. **🟡 BUG-25 + BUG-26** — Sécurité file browser
16. **🟡 BUG-30** — `process.exit(0)` sans auth
17. **🟡 BUG-11** — `unhandledRejection` ne termine pas
18. **🟡 BUG-13** — `setGitIdentity` écrit dans global config
19. **🟢 BUG-09 + BUG-10** — Propreté repo — **[RESOLVED]**
20. **🟢 Autres** — Code mort, style, améliorations