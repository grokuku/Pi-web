# Pi-Web — Suivi du projet

## 🔴 Bugs à corriger

### Infra — Authentik forward_auth (2026-08-22)

#### INFRA-01: NetworkError git ponctuelles + redirection login en pleine session — NON RÉSOLU (non bloquant)
- **Symptômes :** NetworkError ponctuelles sur les fetchs silencieux du frontend (ex. `git/status`), le site continue de marcher, le WS tient. Authentik force un re-login toutes les 24h, mais l'erreur apparaît AUSSI pendant la journée alors que l'utilisateur est connecté.
- **Mécanisme identifié :** le forward_auth d'Authentik répond par une redirection 302 vers `https://authentik.holaf.fr/application/o/authorize/` quand il juge la session invalide par intermittence. Cette redirection est **cross-origin** (pi.holaf.fr → authentik.holaf.fr) et sans header CORS → le navigateur bloque la lecture → NetworkError. Le WS, une fois établi (tunnel direct Caddy→Pi-Web), n'est pas concerné.
- **Écarté par tests :** Pi-Web sain (WS direct 90s stable ; `git/status` 12ms, 30/30 OK) ; Caddy sans erreur (logs propres) ; latence Authentik excellente (20 requêtes ~50ms stables). Le 404 du curl est normal (headers X-Authentik-* manquants).
- **Pistes restantes (à investiguer) :** durée de validité du token dans le provider Authentik (Advanced protocol settings → Access code validity / refresh) ; refresh silencieux qui échoue ; outpost qui référence une ancienne IP pour joindre l'API (Authentik a changé de machine/hôte — seule variable de l'incident).
- **Workaround appliqué (non résolutif) :** headers CORS ajoutés sur `authentik.holaf.fr` (Caddy) pour les origines `pi.holaf.fr`, `sd.holaf.fr`, `aikore.holaf.fr` (matcher + reflet conditionnel `{http.request.header.Origin}`). L'erreur muette a temporairement disparu puis est revenue.
- **Prochaine étape quand on s'y remet :** au moment exact d'une NetworkError → `docker logs --since 10m authentik-server | grep -iE "session|token|refresh|error|outpost|denied|invalid"` + `docker logs --since 10m caddypanel | grep -iE "error|abort|upstream|timeout|502|503"` + noter l'heure de l'erreur.

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

### Observations du log de démarrage (2026-08-01)

Issues remontées lors de l'analyse du log de démarrage post-rebuild. À traiter au fil de l'eau.

#### BUG-61: Conflit de port CBM 9749 — UI indisponible + `server.shutdown`
- **Fichier :** `extensions/codebase-memory/index.ts`
- **Sévérité :** 🔴 Haute (fonctionnalité)
- **Statut :** ✅ Résolu (2026-08-29) — deux causes cumulées trouvées :
  1. `isServerReady()` considérait un serveur CBM vivant comme absent : en mode `--ui`, `/rpc` répond **403** pour `tools/list` (comportement normal) et l'ancien code ne testait que `res.ok`. Un process CBM résiduel (toujours vivant sur 9749) n'était donc jamais réutilisé → le code tentait un 2e spawn → `ui.unavailable port=9749 reason=in_use` → `server.shutdown`. **Fix :** toute réponse HTTP (même 403) prouve que le process écoute → on le réutilise.
  2. Course possible entre `session_start`/`before_agent_start` (ou deux sessions) : `spawnServer()` n'était pas sérialisé, deux spawns concurrents pouvaient se marcher dessus. **Fix :** promesse partagée (`spawnPromise`), un seul spawn à la fois.
- **Description historique :** Au démarrage : `level=warn msg=ui.unavailable port=9749 reason=in_use hint=use_--port=N_to_override` puis `server.shutdown` + `watcher.stop`. Le serveur CBM ne peut pas lier son UI sur 9749 (déjà occupé) puis s'arrête.

#### BUG-62: Embeddings `@pi-unipi/memory` — OpenRouter codé en dur dans entrypoint.sh
- **Fichier :** `entrypoint.sh` (ancien bloc ~178-207) + `~/.unipi/memory/config.json`
- **Sévérité :** 🟡 Moyenne (qualité de recherche mémoire)
- **Statut :** ✅ Résolu par suppression
- **Description :** Log : `No OpenRouter provider found in models.json — embeddings will use fuzzy-only mode`. Ce message concernait l'extension mémoire `@pi-unipi/memory`, PAS le CBM : `entrypoint.sh` configurait `provider = 'openrouter'` en dur et le modèle `openai/text-embedding-3-small`. **Résolution :** le package `@pi-unipi/memory` a été entièrement supprimé de Pi-Web (jamais utilisé : 0 mémoire stockée, config embeddings absente, 180 packages npm + 3 min de build à chaque rebuild, dépendance OpenRouter codée en dur, package tiers non forké). Le bloc d'auto-configuration OpenRouter de `entrypoint.sh` est retiré, le fallback better-sqlite3 de `compaction-checkpoint` et les tools mémoire du mode YOLO sont nettoyés. **Clarification : le CBM (codebase-memory-mcp) ne dépend PAS d'OpenRouter — binaire C statique, embeddings vectoriels intégrés, recherche sémantique fonctionnelle sans clé API (vérifié : `semantic_query` répond).**

#### BUG-63: Bundle frontend énorme (1.7 MB)
- **Fichier :** `frontend/` (Vite build)
- **Sévérité :** 🟡 Moyenne (performance)
- **Statut :** À noter
- **Description :** Log : `dist/assets/index-C4QOaryI.js 1,692.16 kB (gzip: 527.55 kB)` + warning Vite `Some chunks are larger than 500 kB`. Premier chargement lent. Piste : code-splitting via `dynamic import()`.

#### BUG-64: `pi-coding-agent version: unknown`
- **Fichier :** `entrypoint.sh` / check de version
- **Sévérité :** 🟢 Basse
- **Statut :** À noter
- **Description :** Log : `[PI-WEB] pi-coding-agent version: unknown`. La détection de version du SDK échoue ou le package ne l'expose pas. Mineur mais le mécanisme de check ne fonctionne pas.

#### BUG-65: Incohérence CBM — `discovered` vs `fallback` pour le même cwd
- **Fichier :** `extensions/codebase-memory/index.ts`
- **Sévérité :** 🟡 Moyenne (tools CBM inopérants)
- **Statut :** ✅ Corrigé (2026-08-01)
- **Description :** `indexProject()` cherchait le projet avec `p.name === dirName` (ex: `"Pi-Web"`) alors que le serveur nomme les projets avec le préfixe `projects-` (ex: `projects-Pi-Web`) → pas de match → fallback `"Pi-Web"` → tous les appels CBM suivants envoyaient un nom de projet inexistant → `"project not found or not indexed"`. Seul `discoverProjectName()` vérifiait `projects-${dirName}` — donc le bug apparaissait selon le chemin d'initialisation (Map en mémoire par session). Fix : `indexProject()` teste maintenant aussi `projects-${dirName}` (aligné sur `discoverProjectName()`).
- **Découverte annexe (test indexation) :** l'indexation incrémentale d'un fichier modifié prend **~400-800ms** (watcher multi-sec) et la recherche répond en **~16ms**. Très rapide.

#### BUG-66: `compaction-checkpoint` — aucun log « Extension loaded »
- **Fichier :** `extensions/compaction-checkpoint/index.ts`
- **Sévérité :** 🟢 Basse
- **Statut :** ✅ Corrigé (2026-08-01)
- **Description :** Au chargement des extensions, on voyait `[cbm]`, `[file-analyzer]`, `[harness-orchestrator]` chargés mais rien pour compaction-checkpoint. En réalité l'extension n'écrivait jamais ses checkpoints : un `require()` en ESM la faisait échouer au chargement et une garde empêchait la création du store. **Fix :** log `Extension loaded` ajouté, import dynamique ESM de `better-sqlite3`, et **fallback JSON** (`~/.unipi/memory/<projet>/memory.json`) quand better-sqlite3 est absent du runtime — le checkpoint n'est plus jamais perdu.

#### BUG-67: Experts tués par abort de l'orchestrator pendant une délégation (travail perdu)
- **Fichier :** `backend/src/pi/session.ts` + `extensions/harness-orchestrator/index.ts`
- **Sévérité :** 🔴 Haute (perte de travail)
- **Statut :** ✅ Corrigé (2026-08-01)
- **Description :** Cercle vicieux confirmé en live : (1) l'extension v3 ne forwarde aucun event de l'expert → silence total pendant la délégation ; (2) l'utilisateur s'impatiente et écrit un message ; (3) si `pi_prompt` → `sendPrompt` branche isStreaming fait `session.abort()` direct, si `pi_steer` → `steerPrompt` applique un `withSessionTimeout` de 5 min qui abort la session principale ; (4) l'abort se propage à l'extension via le signal → l'expert est tué alors que son travail (fichiers modifiés) est souvent terminé → la réponse est perdue.
- **Fix :**
  - `session.ts` `sendPrompt` : en mode harness, si isStreaming → `steer()` au lieu d'`abort()` (le message est injecté après la délégation en cours)
  - `session.ts` `steerPrompt` : en mode harness → pas de `withSessionTimeout` abortif (le SDK gère l'injection, les experts ont leurs propres timeouts)
  - `harness-orchestrator` : forward des events de l'expert vers le frontend via `onUpdate` (tool_execution_update : text_delta, tool_execution_start/end) → l'utilisateur voit l'activité en temps réel
  - `harness-orchestrator` : sur abort de l'orchestrator, récupérer la réponse partielle de l'expert (`collectExpertResponse`) au lieu de jeter
- **Restant :** rebuild Docker requis pour appliquer.

#### BUG-68: Erreurs LLM invisibles — « le process s'arrête et rien ne se passe » (mode CODE)
- **Fichier :** `backend/src/index.ts` + `frontend/src/components/Chat/ChatView.tsx` + `frontend/src/hooks/useChatHistory.ts` + `frontend/src/types.ts` + `frontend/src/App.tsx`
- **Sévérité :** 🔴 Haute (aucun retour utilisateur sur échec)
- **Statut :** ✅ Corrigé (2026-08-01)
- **Description :** En mode CODE normal, une erreur LLM était avalée à 3 niveaux : (1) le SDK Pi (`handleRunFailure`) transforme toute erreur en message assistant VIDE avec `stopReason:"error"` + `errorMessage` — `session.prompt()` ne reject jamais ; (2) `serializeMessagesForUi()` ne copiait ni `stopReason` ni `errorMessage` → l'erreur était perdue avant le frontend ; (3) le frontend ne faisait que `console.error` sur `on("error")`, un assistant vide ne rendait rien, et `streamingStalled` était codé en dur à `false`. Résultat : l'utilisateur envoyait un message, voyait son message, puis plus rien pendant des minutes sans aucune erreur visible.
- **Fix :**
  - `index.ts` `pi_prompt` : le catch envoie maintenant `{ type:"error", projectId, error }` (routeur frontend)
  - `index.ts` `serializeMessagesForUi` : préserve `stopReason` + `errorMessage`
  - `ChatView.tsx` : nouveau `useEffect` sur `on("error")` → `setError` + message visible `❌ …` dans la conversation ; bannière d'erreur rouge dans `AssistantGroup` si `stopReason === "error"` / `errorMessage` ; `applyPiEvent` (`message_end`) propage `stopReason`/`errorMessage`
  - `useChatHistory.ts` : `convertHistoryToDisplayMessages` préserve `stopReason`/`errorMessage` et ne skip plus un turn assistant vide en erreur
  - `types.ts` : `DisplayMessage` + `stopReason?`/`errorMessage?`
  - `App.tsx` : `streamingStalled` n'est plus `false` en dur — calculé (vrai si `isStreaming` et aucun event reçu depuis 30s)

#### BUG-69: steer() perdu silencieusement quand l'agent est idle (flags désynchronisés backend/frontend/SDK)
- **Fichier :** `backend/src/pi/session.ts`
- **Sévérité :** 🟡 Moyenne (message perdu sans erreur)
- **Statut :** ✅ Corrigé (2026-08-01)
- **Description :** En mode harness, `sendPrompt`/`steerPrompt` appelaient `steer()` dès que `state.isStreaming` était true (flag backend). Après un reload/desync, le flag pouvait rester true alors que l'agent était en réalité idle côté SDK → `steer()` perdait le message sans aucun retour.
- **Fix :** garde `sdkStreaming = (state.session as any)?.agent?.state?.isStreaming === true` dans les deux branches harness. Si l'agent est idle côté SDK, on fait un `prompt()` complet (avec `withSessionTimeout` 5 min — OK car l'agent n'est pas en délégation longue). Sinon `steer()` comme avant (pas de timeout abortif en délégation, BUG-67 conservé).

#### BUG-70: Race dans le retry de l'extension harness-orchestrator — « Agent is already processing a prompt »
- **Fichier :** `extensions/harness-orchestrator/index.ts`
- **Sévérité :** 🟡 Moyenne (2e attempt jeté)
- **Statut :** ✅ Corrigé (2026-08-01)
- **Description :** Sur timeout d'inactivité d'un expert, le retry lançait le 2e `prompt()` alors que l'abort du 1er attempt était encore en cours → « Agent is already processing a prompt ».
- **Fix :** `await tempSession.waitForIdle()` entre les attempts (résout quand la run et tous les event listeners ont fini).

#### BUG-71: Mode CODE contaminé par `delegate_to_expert` — le LLM délègue aux experts au lieu de travailler
- **Fichier :** `backend/src/pi/session.ts`
- **Sévérité :** 🔴 Haute (mode CODE inopérant : le LLM ne code jamais)
- **Statut :** ✅ Corrigé (2026-08-01)
- **Description :** `getExtensionToolNames()` renvoyait **tous** les tools d'extension sans exclusion → `delegate_to_expert` (enregistré par l'extension harness-orchestrator) était exposé dans TOUS les modes, y compris CODE/PLAN/REVIEW. En mode CODE, le LLM utilisait naturellement ce tool → il délégnait aux experts au lieu de coder directement.
- **Fix :** nouvelle constante `HARNESS_EXCLUDE = ["delegate_to_expert"]` passée comme 3e argument de `toolsForMode()` dans les branches plan/review/code de `applyModeToSession`, ainsi que dans `restoreCodeMode` (retour mode CODE) et l'auto-review (tempSession REVIEW). La branche harness garde volontairement l'exclusion **non appliquée** : l'orchestrator DOIT conserver `delegate_to_expert` pour déléguer aux experts.

#### BUG-72: Faux « stalled » pendant les runs + erreur « Agent is already processing » (heartbeat applicatif + SDK comme source de vérité)
- **Fichier :** `backend/src/pi/session.ts`, `backend/src/routes/agent.ts`, `frontend/src/App.tsx`, `frontend/src/components/Sidebar/Sidebar.tsx`
- **Sévérité :** 🔴 Haute (faux « stalled » à chaque run silencieux > 60s + prompt en échec quand le SDK est occupé)
- **Statut :** ✅ Corrigé (2026-08-01)
- **Description :** Cinq causes racines : (1) aucun heartbeat applicatif pendant les phases silencieuses (bash silencieux, thinking long, compaction, retry, expert harness) → tout silence > 60s = faux « stalled » ; (2) `state.isStreaming` backend n'était JAMAIS mis à true en mode normal (aucune branche `agent_start` dans le subscribe principal) → le guard `if (state.isStreaming)` de `sendPrompt` était du code mort → `session.prompt()` direct → erreur SDK « Agent is already processing... » ; (3) `agent_end` n'est pas la fin réelle du run (le SDK poursuit avec retry/compaction/drain ; le vrai marqueur est `agent_settled`) → désync frontend pendant compaction/retry ; (4) pas de réconciliation de `isStreaming` au reload/reconnect WS ; (5) seuils incohérents (60s watchdog App vs 30s Sidebar).
- **Fix :**
  - `session.ts` : branche `agent_start` manquante dans le subscribe principal (set `state.isStreaming = true` + démarre le heartbeat) ; `agent_settled` = vraie fin (set `false` + stop heartbeat + cleanup tools) ; `agent_end` ne touche plus à `isStreaming` (le SDK poursuit après). Même traitement pour la session temporaire d'auto-review.
  - `session.ts` : nouveau helper `isSessionStreaming(projectId)` = `state.session?.isStreaming ?? state.isStreaming` (le getter SDK reflète run + retry + compaction + drain ; optional chaining pour ne JAMAIS créer de session en lisant l'état). Utilisé dans `sendPrompt` (décision steer / abort+re-prompt / prompt), `steerPrompt`, `triggerAutoReviewIfNeeded` (le guard ne bloquait jamais), `getSessionInfo` (expose le bon `isStreaming`). Les checks inline `(state.session as any)?.agent?.state?.isStreaming` (BUG-69) sont remplacés par le helper.
  - `session.ts` : heartbeat applicatif — `setInterval` 10s par session active (Map projectId → timer) qui émet `{ type: "heartbeat" }` vers les subscribers tant que `session.isStreaming` est true. Nettoyage propre : sur `agent_settled`, timeout (`withSessionTimeout`), `/new`, `newSession`, `disposeSession`, `disposeAllSessions` (`stopAllStreamingHeartbeats`). `timer.unref()` pour ne pas bloquer la sortie du process.
  - `agent.ts` : `running`/`sessionRunning` des routes agent utilisent `isSessionStreaming` (source de vérité SDK).
  - `App.tsx` : fin de streaming sur `agent_settled` au lieu d'`agent_end` (cause 3) ; case `heartbeat` (rafraîchit `lastEventAt` déjà mis à jour en tête de handler → le watchdog stalled ne déclenche plus de faux positif) ; nouveau handler du message `connected` (le backend envoie `activeSessions` avec le VRAI `isStreaming` à chaque connexion/reconnexion) pour resynchroniser l'état frontend au reconnect WS (cause 4).
  - `Sidebar.tsx` : seuil stalled 30s → 60s (uniformisé avec le watchdog App.tsx, cause 5).

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
| 27 | 🟢 | `gitInit` pas de tracking upstream ; suivi 2026-08-01 : upstream posé seulement si commit + ref distante existent (sinon `gitInit` échouait systématiquement) | 2026-06-29 |
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
| 50 | 🔴 | `ALLOWED_ORIGINS=*` / `WS_ALLOWED_ORIGINS=*` — sécurisés par l'auth refondue (apiAuth) + WebSocket derrière Authentik ; origines rétablies à `*` volontairement | 2026-08-01 |
| 51 | 🔴 | Path traversal upload neutralisé (attachments/files) | 2026-08-01 |
| 52 | 🔴 | cwd arbitraire refusé — racines réduites à `/projects` + `/mnt/smb` | 2026-08-01 |
| 53 | 🔴 | Scan arbitraire `/code-stats` confiné (realpath + isPathAllowed) | 2026-08-01 |
| 58 | 🔴 | Harness : session temporaire sans modèle valide → échec immédiat | 2026-06-30 (system prompt fixé + extraction JSON robuste) |
| 59 | 🔴 | Harness v2 + extension v3 : timeout global sur `prompt()` tue les experts actifs (fix porté sur harness-orchestrator : timeout à activité + retry) + bug de réentrance concurrency + pas de timeout sur files d'attente + fix `cbm_code` (`qualified_name` requis par le serveur MCP CBM) | 2026-06-30 |
| 60 | 🟡 | Extension codebase-memory : 4 tools CBM corrigés — cbm_trace (`trace_path` au lieu de `trace_call_path`), cbm_search_code (`pattern` requis au lieu de `query`), cbm_search (`label` string au lieu de `labels` array, ignoré par le serveur), cbm_diff (fallback git local — `detect_changes` inexistant sur le serveur MCP CBM) | 2026-08-01 |
| 68 | 🔴 | Erreurs LLM invisibles (avalées à 3 niveaux) — le process s'arrête sans message visible | 2026-08-01 |
| 69 | 🟡 | steer() perdu silencieusement quand l'agent est idle (flags désynchronisés) | 2026-08-01 |
| 70 | 🟡 | Race retry expert harness — 2e prompt() avant la fin de l'abort du 1er | 2026-08-01 |
| 71 | 🔴 | Mode CODE contaminé par `delegate_to_expert` — le LLM délègue aux experts au lieu de travailler | 2026-08-01 |
| 72 | 🔴 | Faux « stalled » pendant les runs + erreur « Agent is already processing » (heartbeat applicatif + SDK comme source de vérité) | 2026-08-01 |
| 73 | 🔴 | Module Design cassé — contrat frontend/backend `pages[]` réaligné | 2026-08-01 |
| 74 | 🟡 | `render_design`/`get_design` projectId toujours `unknown` — projectId capturé par `createDesignTools` | 2026-08-01 |
| 75 | 🟡 | Fuite de slot agent dans l'auto-review — libération dans `finally` | 2026-08-01 |
| 76 | 🟡 | Attachements uploadés sans `projectId` (front + back) — UUID requis | 2026-08-01 |
| 77 | 🟡 | API agent `filesChanged` incomplet (untracked) + fallback sans git implémenté | 2026-08-01 |
| 78 | 🟢 | UI stale sur le projet actif — `updateProjectSession` ne re-render que sur changement visible et gère l'arrière-plan | 2026-08-01 |
| 79 | 🔴 | Aperçu de commit destructeur (`gitCommitPushPreview`) — simulation sans effet de bord sur l'index | 2026-08-01 |
| 80 | 🟡 | Prompt auto-review sans timeout — `withSessionTimeout` sur le fix prompt | 2026-08-01 |

---

### 🔒 Correctifs de sécurité (2026-08-01)

- **BUG-51 — Path traversal upload :** `attachments.ts` et `files.ts` neutralisent les noms de fichier contrôlés par le client (`sanitizeFileName` / `path.basename`) et valident la destination finale réelle avant écriture.
- **BUG-52 — cwd arbitraire :** `isCwdAllowed()` refuse tout cwd hors `/projects` et `/mnt/smb` (strictement sous la racine). Utilisé par `projects/manager.ts` et le terminal WS (`terminal_create`).
- **BUG-53 — Scan arbitraire `/code-stats` :** `routes/cbm.ts` exige `isPathAllowed` + `realpathSync` avant de parcourir le chemin.
- **Durcissement chemins :** `path-security.ts` résout les liens symboliques (`realpathSync`), refuse les symlinks cassés, élargit la deny-list (`.data`/`agent-keys.json`, credentials, clés SSH, `.env*`…) et réduit les racines par défaut à `/projects` + `/mnt/smb`. Les routes fichiers/agent confinent l'accès au cwd du projet.
- **Masquage des clés API providers :** `toPublicProvider()` remplace `apiKey` par `hasApiKey` — la clé n'est plus exposée par l'API.
- **Sanitization librarian :** `sanitizeContent()` supprime emails, clés API, chemins personnels et téléphones avant archivage.
- **SSRF :** `validateHttpUrl()` bloque link-local/loopback/privé, sauf autorisation explicite pour Ollama/openai-compatible auto-hébergés.
- **Auth refondue :** `apiAuth` (jeton valide → localhost → navigateur same-origin/origin autorisée) remplace l'ancienne comparaison Origin/Host. `ALLOWED_ORIGINS`/`WS_ALLOWED_ORIGINS` sont rétablis à `*` volontairement ; le WebSocket est protégé par Authentik en frontal (voir BUG-50).
- **Durcissement WebSocket — Origin seul jamais suffisant (2026-08-22) :** `verifyClient` (backend/src/index.ts) n'accepte plus une connexion sur la seule correspondance du header Origin (forgeable par un client non-navigateur). Ordre d'acceptation : 1) jeton valide (`?token=` ou `Bearer`, même validation que l'API REST) ; 2) connexion locale (127.0.0.1/::1) ; 3) navigateur authentique = **tous** les critères requis — Origin présent ET autorisé par la liste effective ET `Sec-Fetch-Site: same-origin` ET `Sec-Fetch-Mode: websocket` ; 4) sinon 401. Validé par tests d'intégration (Origin autorisée seule → 401, jeton valide → accepté, signature navigateur complète → accepté).
- **Origines autorisées dynamiques + config UI (2026-08-22) :** nouveau module partagé `backend/src/utils/origins.ts` — la liste EFFECTIVE est l'union des variables d'environnement (`ALLOWED_ORIGINS` / `WS_ALLOWED_ORIGINS` / `PUBLIC_BASE_URL`) et d'un réglage UI persisté dans `.data/allowed-origins.json`. Résolue **à chaque requête/handshake** (cache invalidé à l'écriture) : les changements prennent effet à chaud, sans restart, pour CORS, `apiAuth`, l'adminAuth des agent-keys et le WS. Endpoints `GET/PUT /api/settings/allowed-origins` (protégés par apiAuth) avec validation stricte des origines (scheme://host[:port], pas de chemin/query/userinfo, wildcards partielles refusées, seul `*` explicite accepté, normalisation minuscules + dédup, max 64). UI : nouvel onglet Settings → Sécurité (état chargement/succès/erreur, valeur effective + source affichées, i18n fr/en parité 1:1). Aucune source configurée → `*` (comportement historique conservé).
- **Téléchargement de dossiers réactivé (2026-08-18) :** `GET /api/files/download` accepte désormais les dossiers. L'endpoint parcourt récursivement chaque sélection, revalide **chaque entrée** avec `isPathAllowed()` (deny-list + realpath + confinement aux racines), ignore les dotfiles (cohérent avec l'UI) et exclut les symlinks dangereux (hors racine, deny-listés, boucles via `realpath` visités). Le tout est servi en `.tar.gz` à la volée (`tar -czf - -h -C <parent> -T -`, `-T -` pour éviter ARG_MAX, `-h` pour déréférencer les symlinks autorisés). Déduplication par chemin relatif pour éviter les doublons (ex: bouton « select all »). Fichiers uniques : streaming direct inchangé.
- **Durcissement XSS — service de fichiers (2026-08-29) :** les fichiers uploadés (`GET /api/attachments/:id/file`) et les images du workspace (`GET /api/files/read`) ne peuvent plus s'exécuter sur l'origine de Pi-Web : `Content-Security-Policy: sandbox` (bloque scripts/formulaires en navigation directe, sans affecter le rendu `<img>` ni le viewer PDF) + `X-Content-Type-Options: nosniff` global (anti MIME-sniffing) + les MIME exécutables (`text/html`, `application/xhtml+xml`, `image/svg+xml`, XML) sont forcés en `Content-Disposition: attachment` au lieu d'inline. Filename échappé dans le header (anti header-injection). Validé par smoke test : upload SVG+HTML malveillants → `attachment; CSP:sandbox` attendu.
- **Rate limiting serveur (2026-08-29) :** `express-rate-limit` (nouvelle dépendance) avec `trust proxy 1` (derrière Caddy). Global `/api` : 600 req/min/IP (standard IETF `RateLimit-*`) ; uploads : 30/min ; `/api/shared-memory` : 60/min (brute-force d'API keys limité). Validé : 6e requête d'une rafale → 429.
- **Clés Tavily/Webclaw masquées (2026-08-29) :** `GET /api/settings/tavily` et `/webclaw` ne renvoient plus la clé (`hasApiKey` + `apiKeyPreview` `••••abcd` seulement) ; le POST garde la clé existante si `apiKey` est absent (modèle providers). Corrige au passage un bug corollaire de Tavily : le frontend réenvoyait la clé **tronquée affichée** au POST, écrasant la vraie clé si l'utilisateur ne touchait pas le champ. UI : placeholder affiche l'aperçu masqué, champ vide = inchangé.

## 🟡 Bugs mineurs / améliorations

- **[?] Bouton download sur les fichiers** — Implémenté mais pas testé en conditions réelles (Docker).
- **[?] Extension compaction-checkpoint** — Pas testé en conditions réelles.
- **[?] Historique chat disparait avec 3 panneaux visibles** — `LayoutRenderer.tsx` monte tous les panneaux en permanence (`display:none`). Le state React devrait être préservé, mais des conditions de re-render rares peuvent encore causer le bug.
- **[?] Conflits raccourcis clavier avec le navigateur** — Ctrl+L/T/O sont interceptés par le navigateur. Pistes : `Ctrl+Shift+T` pour thinking, `Ctrl+Shift+O` pour outils, `Ctrl+Shift+L` pour settings.
- ✅ **Confirmation avant nouvelle conversation (`/new`)** — Fait (2026-08-01). Ajout d'un modal de confirmation (`NewChatConfirmModal`) déclenché avant d'exécuter la commande `/new`, que ce soit via le bouton de la Sidebar ou via la saisie dans le chat. Évite d'effacer la conversation en cours par accident. i18n fr/en.
- ✅ **Option « mode review : corriger / lister seulement »** — Fait (2026-08-01). Nouveau réglage par projet `review.fixWithInstructions` (défaut : `true` = comportement actuel : corriger). Quand `false`, l'auto-review n'injecte PLUS l'instruction « Fix each one specifically » au LLM suivant (`fixPrompt` de `runAutoReviewCycle`) : le rapport de review (liste des bugs + contexte) est injecté dans la session principale via `injectSessionNotification` (affichage seul, sans déclencher de turn LLM). Réglable dans Paramètres → Général (toggle CORRIGER / LISTER SEULEMENT, i18n fr/en). Backend : `model-library.ts` (type + défaut + migration + setter `setProjectModeReviewFix`), `routes/model-library.ts` (PUT `/projects/:id/mode`, champ `fixWithInstructions`), `routes/agent.ts` (API agent externe), `pi/session.ts` (Phase 2 de `runAutoReviewCycle`).
- ✅ **Correctifs mineurs (2026-08-01)** — `listSessions` utilise le bon répertoire de sessions par projet ; `getSessionInfo` n'embarque plus les messages (payload `connected`/`session_update` allégé) ; reconnexion terminal sans duplication de buffer ; `usage.ts` sérialise les écritures (mutex + écriture atomique tmp/rename) ; images legacy restaurées dans `useChatHistory` ; race retry harness-engine corrigée (`waitForIdle()` entre attempts, cf. BUG-70).

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
- 💡 **Système de mémoire simple** — Mémoire persistante inter-sessions pour l'agent (outil de code). Pas besoin d'un système poussé : stockage markdown/SQLite simple, embeddings optionnels (recherche plein texte suffisante au début). Remplace `@pi-unipi/memory` (supprimé, voir BUG-62). Note : `extensions/compaction-checkpoint` continue d'écrire dans `~/.unipi/memory/<projet>/memory.db` (format SQLite simple, conservé tel quel — réutilisable par ce futur système).
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

Mode YOLO supprimé — remplacé par le mode **HARNESS** : orchestration multi-agent avec rôles spécialisés.

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

#### 🔍 Recherche sémantique du libraire / OpenViking (évalué 2026-08-29)

**Décision : pas maintenant** — surdimensionné pour l'échelle actuelle (quelques
dizaines de docs structurés, retrouvés par nom/version/keywords).

- **Contexte :** OpenViking (Volcengine, AGPL-3) = « context database » pour
  agents : filesystem virtuel `viking://`, unifie resource/memory/skill,
  recherche vectorielle hiérarchique (L0 résumés → L1/L2 détails) + rerank,
  `find()` (vectoriel pur) vs `search()` (analyse d'intention + expansion).
  Docs archivées : `openviking-intro` (libraire).
- **Alternative légère retenue si besoin de sémantique** (~100 lignes, zéro
  dépendance) : embeddings maison des docs archivés via Ollama local
  (ex. `nomic-embed-text`) + champ vector dans le store JSON/SQLite du
  libraire + recherche cosinus dans `searchLocalDocs`.
- **Seuils de revisite** (l'un de ces trois) : bibliothèque > ~300 docs
  hétérogènes / besoin de recherche « par le sens » exprimé par les agents /
  volonté d'unifier mémoire + ressources + compétences dans un seul store
  (redésign profond d'architecture, projet à part entière).

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

### Mémoire partagée — Lot M2 implémenté (2026-08)
- **Implémenté (v1)** : namespace `public` uniquement — alias lecture/écriture du store global (`~/.unipi/memory/_global_/`). Tout autre namespace demandé → 501.
- Router : `backend/src/routes/shared-memory.ts` (monté sur `/api/shared-memory`), auth dédiée localhost ∥ Bearer agent ∥ X-API-Key librarian.
- Écritures externes sanitizées (`sanitizeContent`) et taggées côté serveur `external:<keyName>` ; type `summary` non créable/supprimable via l'API (403).
- Persistance : volume Docker `pi-unipi:/root/.unipi` ajouté (sinon mémoires + checkpoints perdus au rebuild).
- Doc : `docs/shared-memory-api.md`.
- Reste à venir (lots futurs) :
- Namespaces obligatoires : `public`, `agent:<id>`, `private`
- Agent public (Openclaw) → voit `public` + `agent:openclaw`
- Agent privé (Hermes) → voit `public` + `agent:hermes` + `private`
- Même pattern que le libraire (REST API + API Key + stockage JSON)

### Mémoire — Lot M3 implémenté (2026-08) : onglet « Mémoire » dans les Settings
- **UI** : `frontend/src/components/Modals/MemorySettingsTab.tsx` — nouvel onglet 🧠 dans SettingsModal (`TabId` "memory"). Deux sections indépendantes : « Mémoire globale » (profil utilisateur) et « Mémoire du projet » (projet actif via la prop `activeProjectId`, déjà passée à SettingsModal). Liste (titre, badge de type, extrait, date), ajout / édition inline / suppression avec confirmation inline en deux temps ; feedback succès temporaire.
- **Routes internes** : `backend/src/routes/memory.ts` monté sur `/api/memory` derrière l'apiAuth globale (same-origin, sans clé). Endpoints : `GET /global`, `GET /project?projectId=<id>` (ou `?cwd=` validé par isCwdAllowed — cwd résolu via getProject de projects/manager), `PUT /:scope` (upsert : content requis, cap 15 Ko, type summary refusé — validation alignée sur shared-memory), `DELETE /:scope/:id` (summary_protected propagé en 403).
- **Renommage UI** : l'id étant le slug du titre, éditer une entrée en changeant son titre supprime d'abord l'ancienne entrée (404 tolérée) puis upsert la nouvelle — sinon doublon.
- **i18n** : namespace `memory.*` ajouté fr/en, parité 1:1 vérifiée (560 clés de chaque côté).

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
| @benvargas/pi-firecrawl | `firecrawl_scrape/map/search` | ✅ |
| codebase-memory | `cbm_search/trace/code/arch/diff/schema` | ✅ |

> ~~@pi-unipi/memory~~ (`memory_store/search/delete/list`) — **supprimé** (jamais utilisé, 180 packages npm + 3 min de build, OpenRouter codé en dur, package tiers non forké). Voir BUG-62 et l'idée « Système de mémoire simple » ci-dessous.

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
| YOLO | ❌ Supprimé | Code retiré (backend + frontend), remplacé par HARNESS (2026-08-01) |
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
| Agent Keys | `/api/agent-keys/*` (adminAuth, origines effectives résolues à chaud) | ✅ |
| Providers | `/api/providers/*` | ✅ |
| Ollama | `/api/ollama/*` | ✅ |
| Sessions | `/api/sessions/:id/*` | ✅ |
| Settings | `/api/settings/*` dont `GET/PUT /allowed-origins` (apiAuth, hot-reload) | ✅ |
| Health | `/api/health`, `/api/agent/health` | ✅ |
| CBM | `/api/cbm/*` | ✅ |

---

## 🔧 Architecture (référence rapide)

```
Frontend (React, TypeScript, Tailwind, Vite)
  ├── ChatView.tsx → WebSocket → pi_prompt / pi_event
  ├── SettingsModal.tsx → onglets : Models, Analysis, Extensions, General, Security (origines autorisées), Layout, API Keys
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