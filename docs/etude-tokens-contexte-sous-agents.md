# Étude — Réduire les tokens des sous-agents à contexte vide

*Étude de veille, lecture seule (aucune modification de code). Rédigée le 2026-09-22.*

**La demande d'origine** : « j'ai toujours l'impression que CBM est pas vraiment utilisé. et j'ai l'impression qu'en mode harness on perd beaucoup de temps et de tokens à relire le code qu'on a déjà lu avant parce que le modèle part avec un contexte vide. »

---

## 1. Le problème

Quand le mode harness délègue une tâche, chaque sous-agent démarre dans une **tempSession fraîche** : le modèle ne sait *rien* du projet, même si l'orchestrateur (ou un sous-agent précédent, dans une autre session) vient juste de lire les mêmes fichiers. Il faut donc qu'il **re-paye l'exploration** :

- re-lire des fichiers déjà lus ailleurs (600 lignes ≈ **6 000–8 000 tokens** à chaque lecture, et souvent une seule signature suffisait) ;
- re-dérouler grep/ls/find (des milliers de tokens de chemins et de bruit) ;
- et comme la conversation est **renvoyée au modèle à chaque tour**, chaque gaspillage est **payé plusieurs fois** jusqu'à la fin de la session.

Deux problèmes distincts mais liés :

1. **Exploration répétée entre sessions** : le travail d'exploration payé dans une session est jeté à la fin ; la session suivante repart de zéro. C'est structurel : tant que les découvertes ne survivent pas à la session, elles sont re-payées indéfiniment.
2. **CBM sous-utilisé** : Pi-Web a pourtant un graphe de code (8 tools `cbm_*`) capable de répondre en **une requête** à ce que read/grep mettent des dizaines d'appels à trouver. Mais le graphe n'est utile que si l'agent **choisit** de l'appeler — et historiquement, il ne le choisit pas (audit antérieur : orchestrateur 4,5 %, sous-agents 1 appel sur 7 911).

Le point clé de l'état de l'art : les meilleurs systèmes ne demandent pas au modèle « d'avoir le réflexe ». Ils **injectent l'information utile d'office** (carte du repo) ou **la conservent hors fenêtre** (notes persistées). La bonne nouvelle : le réflexe s'améliore déjà (mesuré en section 4), mais il reste faible chez les sous-agents.

---

## 2. L'état de l'art : 7 techniques

### a. Carte du repo injectée automatiquement (Aider)

**Source : `aider-repo-map`** — Aider construit une **carte compacte de tout le dépôt** : liste des fichiers, symboles clés (classes/fonctions) et lignes critiques de leurs définitions, envoyée **avec chaque requête, automatiquement**.

- Construction : graphe où chaque fichier est un nœud, arêtes = dépendances, classement par **PageRank** → seuls les symboles les plus référencés entrent dans la carte.
- **Budget de tokens ~1 000 par défaut**, ajusté dynamiquement selon l'état du chat (la carte s'agrandit quand aucun fichier n'est « en conversation », et se concentre sur les fichiers concernés sinon).
- Bénéfices annoncés : le modèle **voit les signatures de tout le repo** (souvent suffisant pour coder correctement), et sait **quels fichiers valent la peine d'être lus** — le reste de l'exploration devient ciblé.

**La différence décisive avec notre CBM** : chez Aider, la carte est *toujours dans le contexte*. L'agent n'a pas de décision à prendre (« vais-je appeler cbm_search ? ») : l'information structurelle est déjà là. C'est exactement ce qui manque à CBM : le graphe existe mais l'agent doit y penser. (Voir piste 1, section 5.)

### b. Scratchpad / notes persistantes (mémoire hors fenêtre)

**Sources : `scratchpad-files-persistent-findings`, `agentmemory-persistent-memory`** — le principe : l'agent **écrit chaque découverte dans un fichier dès qu'il la trouve**, et relit ce fichier plus tard au lieu de se fier à une mémoire qui se dégrade.

- Anthropic en fait un **memory tool** officiel : un répertoire `/memories` avec opérations `create / view / str_replace / insert / delete`, livré avec la consigne « ton contexte peut être réinitialisé à tout moment → note tout ce que tu ne veux pas perdre ».
- Le contenu utile : faits confirmés, localisation fichier:symbole, décisions, questions ouvertes. **Une ligne par fait, verbeux interdit** (coller des dumps recrée le problème sur disque).
- Le bénéfice caché : **la note est portable**. Une découverte piégée dans une fenêtre de contexte ne sert qu'une fois ; une découverte écrite dans un fichier sert **toutes les sessions suivantes** — y compris les sous-agents, qui peuvent lire le même fichier. C'est le remède direct à la re-lecture de code déjà lu.
- `agentmemory` montre une implémentation concrète open source : markdown local (`MEMORY.md`, `SCRATCHPAD.md`, logs quotidiens), recherche sémantique optionnelle, serveur MCP avec 5 tools (`memory_context / search / read / write / scratchpad`).

### c. Mémoire automatique des agents ET des sous-agents (Claude Code)

**Source : `claude-code-auto-memory`** — Claude Code distingue deux mémoires rechargées **à chaque session** :

| | CLAUDE.md | Auto memory |
|---|---|---|
| Qui écrit | l'humain | **l'agent lui-même** |
| Contenu | règles, conventions | préférences, corrections reçues, contexte non dérivable du code |
| Chargement | chaque session | chaque session (**200 lignes / 25 KB max**) |

- L'auto memory est un index (`MEMORY.md`) + des fichiers par sujet, lus **à la demande** : le coût permanent reste faible.
- **⭐ Point crucial pour Pi-Web : « Subagents can also maintain their own auto memory »** — les sous-agents peuvent tenir leurs **propres notes** (scope par projet, partagé entre worktrees). C'est la démonstration qu'un sous-agent peut « apprendre » au lieu de repartir de zéro à chaque délégation.
- Détail d'architecture : chez Claude Code, la mémoire de la conversation principale n'est **pas** chargée dans les sous-agents (sauf fork) — chaque niveau a sa mémoire, sinon on re-gonfle le contexte.

### d. Hiérarchie de fichiers d'instructions

**Source : `agent-file-hierarchy-claude-md-agents-md`** — chaque fichier d'instructions a un scope, un moment de chargement et un coût. Les confondre = duplication de contexte et gaspillage (l'auteur estime que **70 % des développeurs** mélangent ces fichiers).

| Fichier | Rôle | Chargement | Coût |
|---|---|---|---|
| CLAUDE.md / AGENTS.md | identité, règles, architecture | **toujours**, démarrage | moyen, permanent |
| MEMORY.md | décisions long terme, corrections | toujours ou à la demande | croît avec le temps |
| SKILLS.md | expertise par type de tâche | **à la demande** (déclenché) | ~0 si non déclenché |
| CONTEXT.md | snapshot de la session en cours | réécrit chaque session | petit, frais |

Pièges documentés : tout entasser dans un seul fichier (« monstre de 500 lignes »), ne jamais le mettre à jour (l'agent devient *confiamment faux*), et charger tous les skills d'office (ce qui annule leur intérêt).

### e. Prompt caching

**Source : `anthropic-prompt-caching`** — réutiliser côté serveur les tokens d'un **préfixe identique** entre deux appels.

- Chez Anthropic : lecture à **~0,1×** du prix (jusqu'à 0,05×/0,025× sur les modèles récents), écriture à 1,25× ; **−90 % de coût et −85 % de latence** sur la partie cachée ; TTL 5 min (ou 1 h à 2×).
- Le mode *automatic caching* pose le point de cache sur le dernier bloc cachable, qui **avance avec la conversation** — idéal pour un agent où chaque tour de tool call = un nouvel appel API qui renvoie tout l'historique.
- Condition absolue : un **prefix stable**. Toute variation en tête de prompt (timestamp, consigne qui change, ordre de tools qui varie) invalide le cache. Implication harness : **ne jamais faire varier le prompt système d'un tour à l'autre**.
- Détails pièges : le cache exige une correspondance 100 % identique ; minimum cachable (512–4 096 tokens selon modèle) ; l'invalidation d'un tool définition invalide tout.

**Support par provider (état des providers configurés dans Pi-Web, `/app/.data/providers.json`) :**

| Provider | Type | Prompt caching |
|---|---|---|
| DeepSeek (API) | openai-compatible | **Oui, automatique** (caching de contexte côté serveur, facturation réduite sur les hits) |
| Google (Gemini API) | google | Oui — *implicit caching* + *explicit caching* documentés |
| OpenRouter | openai-compatible | Dépend du provider amont ; les hits cache sont remontés dans l'usage |
| Ollama-Cloud (ollama.com) | openai-compatible | **Non documenté** — à vérifier ; rien d'annoncé côté API |
| llama.cpp (serveur local/vpn) | openai-compatible | **Partiel** : réutilisation du KV cache par slot (`cache_prompt`) si les requêtes partagent un préfixe et que le slot n'est pas évincé — gain de **latence**, pas de facturation (local) |
| Ollama local (Unraid, PC salon) | ollama | KV cache en RAM par modèle chargé : gain de latence sur préfixes répétés, non facturable |

⚠️ Le gain financier n'existe que chez les providers qui **facturent** les hits moins cher (DeepSeek, Gemini, OpenRouter selon amont). Pour Ollama/llama.cpp locaux, le caching ne change pas la facture (il n'y en a pas) mais peut réduire la latence.

### f. Compression et gating : payer moins à chaque tour

**Sources : `reduce-agent-token-usage-levers`, `agent-scratchpads-session-memory`** — parce que le contexte est re-renvoyé à chaque tour, **chaque économie se cumule**. Les leviers chiffrés :

| Levier | Gain documenté |
|---|---|
| Recherche par le sens (graphe/sémantique) au lieu de dump de dossiers | « une tâche qui lirait 25 000 tokens de fichiers en lit 2 000 » |
| Compression des sorties de commandes (`git status --porcelain`, filtrage des logs) | un `npm test` en échec : 12 000 tokens bruts → **~30 tokens utiles** ; « par ordre de grandeur » sur les logs |
| Lecture de la **structure** d'un fichier (signatures/exports) avant le contenu entier | « plus de la moitié » d'une lecture de fichier |
| Élagage du manifeste de tools (MCP) | taxe récurrente payée **à chaque tour** même sans usage |
| Todo tool avec **gating de taille** (Hermes : 256 items max, 4 000 chars/item, troncature par la queue) | empêche le scratchpad de devenir lui-même un gouffre |
| **Ré-injection post-compaction** : après une compaction, on réinjecte les tâches actives (et seulement elles) → le plan survit à la compression | évite les reprises à zéro après compact |
| Cadrer la tâche (« corrige le test X » plutôt que « améliore l'auth ») | gratuit, amplifie tous les autres leviers |

L'article note aussi les 3 modes de défaillance à connaître : *context decay* (les faits anciens s'effacent), *instruction drift* (les longues consignes sont perdues « au milieu »), *workspace contamination* (polluer le repo de l'utilisateur avec des notes temporaires → les écrire **hors du repo**).

### g. Memory stores managés (référence d'architecture)

**Source : `claude-managed-agents-memory-stores`** — modèle « industriel » de la mémoire persistante : store attaché à la session et **monté comme répertoire** dans le sandbox de l'agent (l'agent écrit avec ses tools fichiers normaux), description passée au système prompt, **versions immuables** de chaque écriture (audit trail), accès lecture/écriture séparés. Ce n'est pas à copier tel quel pour Pi-Web, mais ça valide le schéma : *mémoire = répertoire + description dans le prompt + traçabilité*.

---

## 3. Ce que Pi-Web a déjà (état vérifié par lecture seule)

| Capacité | État actuel | Comparaison à l'état de l'art |
|---|---|---|
| **Troncature des sorties d'outils** | Présente (harness-stream.ts, troncatures read/bash/diff ; résumés d'actions bornés) | ✔ couvre le levier « compression des sorties » |
| **Compaction** | Présente, avec **checkpoint** (extension compaction-checkpoint), fallback compaction manuelle | ✔ ; il manque la **ré-injection du plan post-compaction** à la façon Hermes |
| **Image-budget** | Présent (`image-budget.ts`, filtrage des images selon le modèle) | ✔ |
| **CBM en tools actifs** | Les 8 `cbm_*` sont dans l'allowlist des 4 rôles (planning/execute/review/integrate) **avec vérification** qu'ils sont réellement actifs dans la tempSession (warn sinon) | ✔ le graphe est dispo ; ✘ pas de **carte injectée d'office** |
| **Consigne CBM** dans chaque prompt de rôle + déclencheurs concrets (« avant toute 2e lecture du même fichier → cbm_code ») | Présente (`CBM_EXPLORATION_GUIDE`) | ✔ bonne pratique, mais reste une *incitation* |
| **Garde-fou anti-exploration (nudge)** | Présent : après **6** explorations read/grep/find/ls/bash consécutives sans `cbm_*` (seuil `EXPLORATION_NUDGE_THRESHOLD = 6`), injection d'un rappel discret dans le contexte du sous-agent | ✔ unique en son genre ; agit **trop tard** (6 appels payés avant rappel) |
| **AGENTS.md racine** (`/projects/Pi-Web/AGENTS.md`, 117 lignes) | Conventions humaines (commit/push, propreté, Docker, tests) — **pas d'architecture** ; chargé par le SDK pi pour les sessions principales, mais le prompt des sous-agents est **écrasé** par (rôle + guide CBM + cwd) → **AGENTS.md n'arrive pas aux sous-agents** | ✘ ni source de vérité architecturale, ni injecté aux sous-agents |
| **AGENTS.md global** (`~/.pi/agent/AGENTS.md`, 37 lignes) | Bloc « codebase-memory » qui recommande des tools **qui n'existent plus sous ces noms** (`search_graph`, `trace_path`, `get_code_snippet`…) alors que les tools réels s'appellent `cbm_*` | ⚠️ contre-productif là où il est chargé (noms obsolètes) |
| **Tool memory_* côté session principale** | Présent (`memory_store`/`memory_search`/`memory_delete` — visible dans les sessions) | ✔ pour l'orchestrateur ; ✘ **pas exposé aux sous-agents** |
| **Carnet d'exploration (P2) côté sous-agents** | Implémenté : stockage JSONL hors repo `.data/harness-notes/<projectId>/notes.jsonl`, tools `exploration_note`/`exploration_notes` exposés aux 4 rôles, digest borné (~2000 chars) réinjecté au démarrage | ✔ comble le manque de notes persistées ; élagage paresseux (TTL 90 j, plafond 300) |
| **Sessions des sous-agents** | Fichier supprimé en cas de succès, archivé en cas d'échec (`/app/.data/logs/harness/`) | ✔ les découvertes survivent hors session via le carnet (P2), indépendamment du fichier de session |

**Manques par rapport à l'état de l'art :** pas de prompt caching exploité (le prefix système des sous-agents est stable — bon candidat — mais rien ne garantit un préfixe stable côté conversation pour DeepSeek) ; mémoire par rôle (P4) non encore en place ; AGENTS.md global obsolète. La carte du repo injectée (P1) et les notes d'exploration persistées (P2) sont désormais implémentées.

---

## 4. CBM est-il toujours sous-utilisé ? (re-mesure sur sessions récentes)

**Méthode** (lecture seule) : comptage des tool calls `cbm_*` dans les `*.jsonl` de `~/.pi/agent/sessions/projects/dd5e824c-…/` (projet Pi-Web) et dans les archives de sous-agents `/app/.data/logs/harness/`.

**Sessions principales du projet Pi-Web** (orchestrateur + conversation) :

| Date | Tool calls | cbm_* | Part CBM |
|---|---|---|---|
| 23/05 → 19/06 (5 sessions, pré-correctifs) | 1 814 | **0** | 0 % |
| 23/06 | 708 | 5 | 0,7 % |
| 29/06 (2 sessions) | 1 306 | 83 | 6,4 % |
| 31/07 | 304 | 51 | 16,8 % |
| 02/08 | 17 | 10 | — |
| 13/08 | 373 | 15 | 4,0 % |
| 22/08 | 977 | 83 | 8,5 % |
| **Total post-correctifs** | **3 686** | **247** | **≈ 6,7 %** |

**Sous-agents** (archives de sessions échouées — abort utilisateur/timeout, sept. 2026, post-correctifs) : 6 sessions, 276 tool calls, **4 cbm_*** (1,4 %), contre 186 read/grep/find/ls/bash (67 %). Un seul sous-agent (21/09) a touché au graphe.

**Verdict factuel** : l'impression du user était **juste et commence à être dépassée**. Côté orchestrateur/session principale, CBM est passé de 0 % à ~6,7 % des appels (jusqu'à 17 % sur une session de fin juillet) : les correctifs (allowlist + consigne + nudge) **ont marché**. Côté sous-agents, la mesure disponible (biaisée : seules les sessions *échouées* sont archivées, les réussies sont supprimées) reste faible — 1,4 % — et montre que la consigne seule ne crée pas le réflexe. C'est précisément l'argument de l'état de l'art : il ne faut pas compter sur le choix de l'agent, mais **injecter l'information d'office** (carte) et **conserver les découvertes hors session** (notes).

---

## 5. Pistes applicables à Pi-Web (statut d'implémentation)

Ordre recommandé : **P0 → P1 → P2 → P3 → P4 → P5** (le flux cible est schématisé après le tableau). Statut au 2026 : **P0 ✅, P1 ✅, P2 ✅, P3 ✅** ; P4/P5 restent à faire.

| # | Piste | Quoi | Gain attendu | Effort | Risque | Dépendance |
|---|---|---|---|---|---|---|
| **P0** | **Corriger l'AGENTS.md global** (`~/.pi/agent/AGENTS.md`) | Remplacer les noms de tools obsolètes (`search_graph`…) par les vrais `cbm_*` ; raccourcir | Faible coût, supprime une source de confusion directe pour tout agent qui le lit | **S** | Quasi nul | Aucune |
| **P1** | **Carte du repo CBM injectée d'office** dans la tempSession de chaque sous-agent (à la Aider : fichiers + symboles clés + signatures, budget ~1k tokens, boost des fichiers cités dans la tâche) | L'agent **voit** la structure sans décision à prendre ; il lit ensuite en ciblé. Répond exactement au « contexte vide qui relit tout » | Fort : oriente dès le 1er tour, réduit les chaînes read/grep | **S/M** | Faible (budget plafonné) ; à régénérer périodiquement | Graphe CBM à jour au moment du delegate |
| **P2** | **Carnet d'exploration par projet** (hors repo, `.data/harness-notes/<projectId>/notes.jsonl`) : le sous-agent écrit ses découvertes (`exploration_note` : fait/piège/décision, fichier:symbole) et **relit au besoin** (`exploration_notes` : lecture/recherche) ; digest borné (~2000 chars) réinjecté au démarrage de chaque sous-agent (boost par la tâche, dégradation ordonnée) | Les explorations cessent d'être jetées : la session suivante (ou un autre sous-agent) hérite du travail | Fort sur la re-lecture entre sessions | **M** | Faible ; taille plafonnée (TTL 90 j, 300 notes max) et purge à la suppression du projet | ✅ **Implémenté** (`backend/src/pi/exploration-notes.ts`, tools dans `extensions/harness-orchestrator/index.ts`) |
| **P3** | **Prompt caching sur DeepSeek/Gemini** : verrouiller un préfixe système stable (rôle + guide CBM + AGENTS.md éventuel) et éviter tout élément variable en tête (pas de timestamp, ordre des tools fixe) | −90 % de coût sur le préfixe chez les providers qui le supportent ; latence réduite | **M** | Faible si discipline de préfixe ; nul chez Ollama-Cloud/llama.cpp | **Support provider** : DeepSeek oui, Gemini oui, OpenRouter selon amont, Ollama-Cloud non documenté — ✅ **Implémenté** (`rank: "stable"` dans `repo-map.ts`/`exploration-notes.ts`, ponts `__cbmRepoMap`/`__cbmRepoMapAnnex`, annexe dans le 1er message user ; `docs/validation-prompt-caching-p3.md`) |
| **P4** | **Mémoire par rôle** (à la Claude Code) : chaque rôle (planning/execute/review/integrate) maintient ses propres notes persistantes par projet (« pièges du build », « où sont les tests »), index court chargé au démarrage + détails à la demande | Les sous-agents « apprennent » au fil des sessions | Moyen à fort à terme | **M/L** | Contamination (notes fausses/périmées) → prévoir revue/élagage | P2 en place (même infrastructure) |
| **P5** | **Compression supplémentaire des sorties** (formats terses pour git/test, structure-first reads, élagage des tools non utilisés par rôle) | Réduction continue du contexte re-payé à chaque tour | Moyen (déjà partiellement couvert par les troncatures) | **M** | Faible | Ajustement des allowlists |

**Ordre recommandé : P0 (immédiat, gratuit) → P1 (le plus gros rapport gain/effort) → P2 (transforme les sessions isolées en capital) → P3 (argent pur chez DeepSeek) → P4/P5 (affinage).**

Flux cible pour un sous-agent :

```
   contexte vide
        │
        ▼
┌─────────────────────────────┐
│ Injection automatique       │   P1 : carte CBM (fichiers + symboles +
│ (sans décision de l'agent)  │        signatures, budget ~1k tokens)
└─────────────┬───────────────┘   + AGENTS.md global corrigé (P0)
              ▼
┌─────────────────────────────┐
│ Exploration minimale        │   1 question structurelle = 1 cbm_*
│ graphe AVANT fichiers       │   (au lieu de N read/grep payés N fois)
└─────────────┬───────────────┘   nudge reste en garde-fou
              ▼
┌─────────────────────────────┐
│ Notes persistées hors repo  │   P2 : découvertes écrites dès qu'elles
│ /app/.data/notes/<projet>/  │        sont trouvées, relues au besoin
└─────────────┬───────────────┘
              ▼
┌─────────────────────────────┐
│ Session suivante démarre    │   lit les notes (just-in-time)
│ avec le capital d'avant     │   + mémoire par rôle (P4)
└─────────────────────────────┘
        + P3 : le préfixe stable (rôle+guide) passe au cache
               DeepSeek → même contexte, ~0,1× le prix
```

---

## 6. Sources (bibliothèque du Librarian, `/app/.data/docs/tools/`)

1. **aider-repo-map** (aider.chat/docs/repomap.html) — carte compacte du repo (symboles + signatures) injectée automatiquement à chaque requête ; graphe de dépendances + PageRank + budget ~1k tokens ajusté dynamiquement.
2. **reduce-agent-token-usage-levers** (tokenade.net) — les leviers qui marchent : recherche par le sens, compression des sorties, lecture structure-first, élagage des tools, contexte stable cachable ; avec les chiffres (600 lignes ≈ 6–8k tokens ; 25k→2k tokens par la recherche ; 12 000→30 tokens sur un log de test).
3. **scratchpad-files-persistent-findings** (aiskillcerts.com) — le pattern « mémoire hors fenêtre » : écrire les découvertes au fil de l'eau et les relire (just-in-time) ; le memory tool Anthropic `/memories`.
4. **agentmemory-persistent-memory** (github.com/jayzeng/agentmemory) — couche mémoire markdown locale (MEMORY.md, SCRATCHPAD.md, logs quotidiens), recherche sémantique, serveur MCP avec 5 tools.
5. **anthropic-prompt-caching** (platform.claude.com) — caching de préfixe : automatic caching + breakpoints, TTL 5 min/1 h, lecture à ~0,1×, −90 % coût / −85 % latence ; le piège du bloc variable en tête de prompt.
6. **agent-scratchpads-session-memory** (make-no-mistakes) — 3 patterns (todo tool in-memory avec gating 256 items/4 000 chars, ré-injection post-compaction, scratchpads privés hors workspace) et 3 modes de défaillance (context decay, instruction drift, workspace contamination).
7. **claude-code-auto-memory** (code.claude.com/docs/en/memory) — CLAUDE.md vs auto memory (notes écrites par l'agent, 200 lignes/25 KB, scope repo) ; **les sous-agents peuvent maintenir leur propre auto memory**.
8. **claude-managed-agents-memory-stores** (platform.claude.com) — memory stores workspace-scoped montés comme répertoire dans le sandbox, versions immuables (audit trail), seeded, max 8 stores/session.
9. **agent-file-hierarchy-claude-md-agents-md** (amitray.com) — hiérarchie CLAUDE.md / AGENTS.md / MEMORY.md / SKILLS.md / CONTEXT.md : scope, moment de chargement, coût de chacun ; 70 % des devs confondent → duplication et gaspillage.

---

### Récapitulatif demandé

- **Chemin du document** : `docs/etude-tokens-contexte-sous-agents.md`
- **Mesure CBM sessions récentes** : sessions principales du projet Pi-Web — 0 cbm avant le 23/06, puis 247 cbm / 3 686 tool calls (≈ 6,7 %) jusqu'au 22/08, avec des pointes à 16,8 % ; sous-agents (archives d'échecs, sept.) : 4 cbm / 276 appels (1,4 %) — mieux que l'audit antérieur (1/7 911 ≈ 0,01 %) mais encore faible. Réserve : les sessions de sous-agents réussies sont supprimées, la mesure sous-agent est donc partielle.
- **Top 3 gain/effort** : **1)** carte du repo CBM injectée automatiquement au démarrage des sous-agents (P1) ; **2)** scratchpad d'exploration persisté par projet, hors du repo (P2) ; **3)** correction de l'AGENTS.md global obsolète (P0, effort S immédiat).