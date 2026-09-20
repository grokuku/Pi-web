# Étude de faisabilité — Laya & routage de modèle par complexité dans Pi-Web

> **Statut** : étude de faisabilité + design d'intégration (PAS d'implémentation — rien ne s'exécute sans validation du user)
> **Date** : 2026-09-20
> **Question posée** : faut-il utiliser **Laya** dans Pi-Web, notamment pour « la sélection de la complexité des tâches pour sélectionner le modèle à utiliser » ?
> **Sources** : bibliothèque du librarian (`laya-system1-decision-engine`, `jevlike-open-jev-reimplementation`, `llm-model-routing-routellm-openrouter-notdiamond`, `llm-routing-complexity-cost-policies`) + lecture directe du code Pi-Web (fichiers et lignes cités).
> **Limite méthodologique majeure** : ce conteneur n'a **pas d'accès web**. Tout ce qui concerne Laya, Jev et les routeurs externes provient des documents ci-dessus ; rien n'a pu être revérifié à la source (Hugging Face, PyPI, GitHub, arXiv). Chaque affirmation non vérifiable est marquée **« non confirmé dans les sources »**.

---

## TL;DR

**Laya : non, pas maintenant.** Le concept (modèle de décision System 1 non-autorégressif : texte + N options → probabilités calibrées en un passage) est pertinent, mais (1) Pi-Web a **déjà** la couche de routage que Laya prétend améliorer (heuristique + classifieur LLM + fusion + fail-safe, dans `routing.ts`), (2) la preuve de valeur de Laya repose sur **une seule source auto-promotionnelle** avec des poids/package/licence **invérifiables depuis ici**, (3) Laya est **Python** alors que le backend est **Node/TypeScript** (sidecar = coût d'ops réel), (4) le conteneur n'a **pas de GPU** et la latence CPU du modèle n'est documentée nulle part. Le gain de coût attendu du routage par complexité sur une instance Pi-Web (usage mono-utilisateur, faible volume) est faible ; le levier réel est le **mapping en tiers (local GPU / petit cloud / gros cloud) + garde-fou d'escalade**, réalisable avec l'existant. Laya reste sur une liste de veille avec un protocole de validation bon marché (§6).

---

## 1. De quoi on parle

### 1.1 Les modèles de décision « System 1 »

Un **modèle de décision System 1** n'est pas un LLM : il ne génère pas de texte. Il prend un **état** (texte, e-mail, ticket, JSON) et une **liste de N options** (ou une rubrique ordinale, ou une question booléenne) et retourne **une probabilité calibrée par option en un seul passage** (forward pass bidirectionnel, type encoder BERT, pas de génération token par token).

Trois primitives (d'après la doc Laya, source unique — voir §1.3) :

| Primitive | Entrée | Sortie |
|---|---|---|
| `choice` | état + dictionnaire d'options | option élue + distribution + confiance calibrée |
| `score` | état + rubrique ordinale (0..n) | niveau attendu + distribution sur les rangs + confiance |
| `noul` | état + question booléenne | P(true) ∈ [0,1] calibrée (P(false) = 1 − P(true) par construction) |

**En quoi c'est différent d'un LLM pour le routage :**

| Critère | LLM (autorégressif) | Modèle System 1 (encoder) |
|---|---|---|
| Sortie | texte libre → parsing fragile (regex/JSON) | probabilités/numbres uniquement → pas de JSON malformé possible |
| Hallucination | oui (y compris sur les « confidence: 0.95 » auto-déclarés, sans calibration mathématique) | impossible en texte ; calibration mesurable (ECE) |
| Latence typique | 500 ms – 2 s (streaming) | ~33 ms revendiqués pour Laya (GPU) ; 236–276 ms pour Jev (API) |
| Coût | tokens facturés | $0 si auto-hébergé (open-weight) ou ~0,042 $/M tokens (Jev) |
| Limite structurelle | n/a | **le nombre d'options** : dégradation au-delà de ~20 (cf. §1.2) |

Pour Pi-Web, l'usage visé est précisément le point faible actuel du routage : **classer une demande (trivial / standard / complex / review) pour choisir le modèle**. Aujourd'hui ce classement est fait par (a) une heuristique mots-clés gratuite et (b) un classifieur LLM optionnel — c'est-à-dire exactement le « sur-coût » que les modèles System 1 prétendent éliminer (appeler un LLM générateur pour produire 3 champs JSON).

### 1.2 Jev vs Laya

**Jev** — TypeSafe AI (fondée par Diogo Almeida, co-inventeur de ChatGPT chez OpenAI). Modèle commercial **fermé** : API sans papiers, sans poids, sans dataset ouverts. Entrée : texte + N options → distribution de confiance. Tarification ~0,042 $/M tokens d'entrée, latence P50 236–276 ms (chiffres rapportés par les études tierces citées par la doc Laya : AbdelStark, nibzard, TypeSafe). Benchmark « typed-decisions » : 0,727 ; ECE 0,246.

**Laya** — ConvAI Innovations (Nandakishor Mukkunnoth, Founder & CEO). Présenté comme le **concurrent open-weight de Jev** : entraîné par **RLCD** (Reinforcement Learning for Calibrated Decisions), multilingue (100+ langues, balayage 51 langues sur MASSIVE), ~32,8 ms sur un GPU (7,2 ms/question en batch), poids revendiqués Apache 2.0, $0 auto-hébergé. L'auteur affirme avoir publié l'approche un an **avant** Jev (papiers arXiv mars 2025 et sept. 2025 — **IDs tronqués dans la source, non vérifiables**).

| Benchmark (déclaré par l'auteur de Laya) | Jev 1.13.0 | Laya (routed) | Delta déclaré |
|---|---|---|---|
| typed-decisions (2 000 décisions) | 0,727 | 0,766 | +3,9 % |
| AG News (4 labels) | 0,910 | 0,950 | +4,0 % |
| DAIR Emotion (6 labels) | 0,480 | 0,595 | +11,5 % |
| Erreur de calibration (ECE) | 0,246 | 0,081 | ×3 meilleure |
| Latence P50 (1 question) | 236–276 ms | 32,8 ms | ×7,8 |
| Latence P50 (10 questions batchées) | ~1 500 ms | 72,3 ms | ×20 |
| Langues utilisables (> 3× hasard) | non publié | 45/51 | — |
| Coût / 1M tokens | 0,042 $ (API) | 0 $ (self-host) | — |
| Poids & code | fermés | safetensors ouverts | — |

⚠️ **Ce tableau est celui publié par l'auteur de Laya lui-même.** Les chiffres Jev y proviennent d'études tierces et de TypeSafe ; les chiffres Laya sont mesurés par l'auteur et **non reproductibles depuis notre environnement**.

**Limitations déclarées par l'auteur lui-même (points importants pour Pi-Web)** :

1. **`choice` se dégrade au-delà de ~20 options** : sur Banking77 (77 labels), Laya 0,425 vs Jev 0,870 — les options partagent un budget de 192–256 tokens, soit 3–4 tokens par candidate à 77 options. → Recommandation de l'auteur : rester < 20 options ou hiérarchiser en deux passes. **Pour Pi-Web (4 catégories) ce n'est pas bloquant.**
2. **Zéro-shot ≈ quasi aléatoire** : les poids de base scorent ~0,35 sur typed-decisions ; le 0,766 est obtenu **après fine-tuning sur le train split du benchmark**. → Laya est un « fondation model à spécialiser », pas un oracle zéro-shot. **C'est le point critique pour Pi-Web : classer la complexité de tâches de coding-agent n'est PAS la tâche d'entraînement des checkpoints publiés.**
3. **Calibration brute** : les poids livrent des logits de température bruts ; sans re-fit de la température sur le domaine, l'ECE est 0,466 (contre 0,081 après fit). → Un déploiement sérieux exige un jeu de calibration local.

Autre leçon utile rapportée (transposable même sans Laya) : **la confiance d'un modèle ne prévient pas quand il ne comprend pas l'entrée** (khmer : 0,000 de précision à 0,952 de confiance moyenne sur le checkpoint anglais) → le choix du modèle doit se faire **avant** le forward pass, pas par « gating » sur la confiance.

### 1.3 Niveau de preuve — à lire avant de croire quoi que ce soit

**La seule source sur Laya est la page produit de son auteur** (`laya.convaiinnovations.com`, « Research & Engineering, Updated September 2026 », signée par le Founder & CEO). C'est un article auto-promotionnel avec benchmarks auto-publiés, comparé à un concurrent commercial. Aucune source indépendante sur Laya n'est disponible dans notre bibliothèque.

**Ce qui DOIT être vérifié avant tout pari** (impossible depuis ce conteneur) :

| # | À vérifier | Où | Statut actuel |
|---|---|---|---|
| 1 | Les 3 checkpoints existent réellement (safetensors, tailles ~808 Mo / ~647 Mo / total 2,5 Go) | HF `convaiinnovations/laya` (hub unique, sous-dossiers) | **non confirmé** — seul lien HF vérifiable dans le texte = le VIEUX modèle vertical ventes (`DeepMostInnovations/sales-conversion-model-reinf-learning`), pas Laya |
| 2 | Le package PyPI `laya` existe, version ≥ 0.3.3, dépendances (torch ? transformers ? flash-attn ?), Python min | pypi.org/project/laya | **non confirmé** |
| 3 | Licence du **code** (Apache 2.0 est revendiquée pour les **poids**) | GitHub `NandhaKishorM/laya` | **non confirmé** |
| 4 | Repo GitHub actif, harness de benchmarks reproductible (branche `research`), issues | GitHub | **non confirmé** |
| 5 | Les 2 papiers arXiv (mars 2025, sept. 2025) — IDs **tronqués** dans la source | arXiv | **non confirmé** |
| 6 | Export **ONNX** ou équivalent (pour tourner hors Python) | — | **non documenté** dans les sources |
| 7 | Latence **CPU** réelle (le 32,8 ms est mesuré **sur GPU**) | — | **non documenté** — estimation plausible : 200 ms – 1 s pour un encoder 421M sur CPU de conteneur, à mesurer |
| 8 | Reproductibilité des 9 workflows et de l'ECE 0,081 | branche `research` | **non confirmé** |
| 9 | Performance **zéro-shot sur la tâche de Pi-Web** (complexité de tâche d'agent) | à mesurer nous-mêmes | **inconnu** — et le point §1.2-2 (zéro-shot quasi aléatoire hors domaine) incite à la prudence maximale |

### 1.4 Homonymes — ne pas confondre

« Laya » désigne aussi :
- **laya.aay.sh** — un centre de notifications ;
- **github.com/aayushch/laya** — un projet local-first ;
- **LayaAir** — un moteur de jeu (très référencé, pollue les recherches).

Et à ne pas confondre avec **`vinnylarouge/jevlike`** : ré-implémentation **indépendante et ouverte** (MIT) de la forme entrée/sortie de Jev — option-attention + softmax sur un encodage du contexte et des options, encodeur byte-apprenti ou encoder HF figé (ex. Qwen2.5-0.5B), entraînable sur JSONL `{"context", "options", "label"}` en CPU/MPS/CUDA. L'auteur précise honnêtement qu'il **n'égale pas Jev** (98 % sur menus synthétiques ; 26–29 % sur Wikispeedia) et qu'il n'a pas reproduit la méthode d'entraînement de TypeSafe. Intérêt pour Pi-Web : **fallback pédagogique** — si un jour on veut un classifieur d'options entraîné sur NOS données, `jevlike` fournit l'architecture et le pipeline d'entraînement complets, en restant maîtres des données.

---

## 2. Faisabilité technique de Laya

### 2.1 Disponibilité réelle

| Élément | Déclaré | Vérifié ? |
|---|---|---|
| Poids | 3 checkpoints sur le hub HF `convaiinnovations/laya`, téléchargement sélectif par sous-dossier (~808 Mo EN, ~647 Mo multilingue, 2,5 Go total) | **non confirmé** (pas d'accès web) |
| Package | `pip install laya>=0.3.3` (PyPI), SDK avec `laya.load(...)`, `Router(preload=True)` | **non confirmé** |
| Licence | Apache 2.0 pour les poids ; licence du code **non précisée** dans la source | **non confirmé** |
| Démo interactive | Space HF `convaiinnovations/laya-demo` (ZeroGPU) | **non confirmé** |
| Code + benchmarks | GitHub `NandhaKishorM/laya`, branche `research` | **non confirmé** |

### 2.2 Taille, dépendances, empreinte

- Paramètres : **421M** (ModernBERT-large, EN et typed-decisions) / **322M** (mmBERT-base, multilingue, vocab 256k, contexte 1024 → 8k).
- Contexte : 512 (EN) / 1024–8k (multilingue, typed-decisions).
- Poids sur disque : ~0,65–0,8 Go par checkpoint (déclaré) ; en RAM, un encoder 421M en fp32 ≈ 1,7 Go (+ tokenizer + runtime). Non documenté au-delà.
- Dépendances revendiquées : PyPI `laya` ; écosystème HF/PyTorch implicite (encoders ModernBERT/mmBERT). **Aucune mention d'export ONNX, de quantification officielle, ni de support CPU dédié** → non documenté.
- Le `Router` intégré (22 scripts Unicode + distribution de stopwords) ajoute 0,09–0,73 ms ; `Router(preload=True)` évite un cold-swap de 7–10 s entre checkpoints.

### 2.3 Latence et exécution CPU vs GPU

| Scénario | Ce qu'on sait | Statut |
|---|---|---|
| GPU (T4, single) | 32,8 ms / question ; 7,2 ms/q en batch de 10 | déclaré par l'auteur |
| GPU (RTX 3080 du user) | ≥ perf T4 attendue | plausible, non mesuré |
| CPU (conteneur Pi-Web, **sans GPU**) | rien de publié | **non documenté** — un encoder 421M/322M sur CPU de conteneur est typiquement 10–30× plus lent qu'un T4 ; ordre de grandeur : **0,1–1 s** (estimation, à mesurer) |
| llama.cpp sur la RTX 3080 (10.10.0.33:24625) | **inadapté** : llama.cpp sert des LLM autorégressifs (et des embeddings), pas un encoder BERT avec tête de classification custom → Laya ne peut pas être hébergé par le service llama.cpp existant | architectural |

Conséquence : dans le conteneur des agents (sans GPU), l'avantage « 33 ms » de Laya s'évapore probablement (0,1–1 s CPU) — ce reste **mieux qu'un classifieur LLM** (0,5–2 s + coût tokens), mais la comparaison avec l'**heuristique actuelle de Pi-Web (0 ms, 0 $)** devient défavorable pour les cas que l'heuristique traite déjà bien.

### 2.4 Coût d'intégration

- **Langage** : Laya est **Python** (PyPI). Le backend Pi-Web est **Node/TypeScript**. Trois options : (1) **sidecar HTTP** (FastAPI/uvicorn dans le conteneur ou sur la box GPU) + client `fetch` côté Node ; (2) process enfant Python (fragile, pas de résilience) ; (3) export ONNX + `@onnxruntime-node` (pas de Python, mais **export ONNX non documenté** pour Laya — il faudrait le faire soi-même via transformers/optimum, travail non trivial).
- **Empreinte** : + 1–2 Go RAM (modèle chargé), + téléchargement de poids au build/au boot (à épingler par digest), + image Docker plus lourde, + un service de plus à surveiller.
- **Maintenance** : dépendance à un projet solo (1 auteur, pas de communauté visible dans nos sources), risques de rupture d'API PyPI, checkpoints à recalibrer (température) sur notre domaine, et — le plus cher — **fine-tuning probable** : les checkpoints publiés sont spécialisés (ventes, tickets, spam, typed-decisions) ; classer la complexité de tâches d'agent de code est **hors domaine**, et le zéro-shot déclaré est quasi aléatoire hors domaine fine-tuné.
- **Effort estimé** : sidecar + intégration `routing.ts` = **M** (quelques jours) si tout est vrai et zéro-shot suffisant ; **L** (semaines) si fine-tuning + calibration nécessaires.

### 2.5 Verdict faisabilité

Techniquement plausible (encoders BERT classiques, pas de magie), mais : disponibilité invérifiable depuis ici, support CPU/ONNX non documenté, intégration Python→Node réelle, et surtout **aucune garantie que les poids publiés savent classer des tâches de coding-agent sans fine-tuning**. Le risque n'est pas « ça ne marchera jamais », c'est « on ne sait pas encore si ça marche pour NOUS, et le vérifier coûte du temps ».

---

## 3. Comparaison des options de routing

Options évaluées pour « choisir le modèle selon la complexité de la tâche » dans Pi-Web. Sources : `llm-model-routing-routellm-openrouter-notdiamond` (nomadx.ae, août 2026), `llm-routing-complexity-cost-policies` (openlegion.ai, juil. 2026), doc Laya, README jevlike.

| Option | Type | Open source | Coût | Latence du signal | Dépendances | Effort d'intégration | Risque | Qualité du signal |
|---|---|---|---|---|---|---|---|---|
| **Heuristiques maison** (existant : `heuristicClassifier`) | règles (mots-clés, longueur, signaux de session) | ✅ interne | 0 $ | **0 ms** | aucune | **déjà fait** | très faible (déterministe, auditable) | moyenne — mots-clés trompés par les faux amis ; mais fail-safe + gate review compensent |
| **Classifieur LLM cheap** (existant : `llmClassifier` via `completeSimple`) | LLM générateur contraint JSON | ✅ interne | ~tokens d'un mini-modèle | 100–500 ms + appel réseau | modèle cheap existant (peut être le llama.cpp local) | **déjà fait** (off par défaut) | faible (fail-safe heuristique) | bonne si prompt stable ; coût de parsing JSON, calibration factice (« confiance prédite, pas mesurée ») |
| **Laya** (3 checkpoints, si poids confirmés) | classifieur System 1 encoder (RLCD) | poids Apache 2.0 (déclaré) ; code ? | 0 $ self-host | **33 ms GPU ; CPU non documenté** | Python + torch/transformers (sidecar), 1–2 Go RAM | **M** (sidecar) → **L** si fine-tuning | **élevé** : source unique auto-promotionnelle, zéro-shot hors domaine ~aléatoire, projet solo | potentiellement **excellente** (calibration ECE 0,081 déclarée) mais **non prouvée sur notre tâche** |
| **Jev** (TypeSafe) | API commerciale System 1 | ❌ fermé | 0,042 $/M tokens entrée | 150–276 ms | clé API | S (appel HTTP) | moyen : vendor lock-in, pas de papiers/poids, pas de SLA connu | bonne (typed-decisions 0,727, ECE 0,246) — chiffres tiers |
| **jevlike** (réimpl. ouverte) | starter kit à entraîner soi-même | ✅ MIT | 0 $ (CPU/CUDA) | rapide (encoder minuscule) | Python, option encoder HF | **L** (il faut entraîner sur nos données) | moyen : qualité dépend 100 % de notre dataset | inconnue tant que non entraînée ; bon exercice, mauvais raccourci |
| **RouteLLM** (LMSYS) | routeur ML appris (matrice de factorisation, BERT, similarité) | ✅ | 0 $ self-host | ~10–50 ms (BERT classifier) | Python, données de préférence | **M–L** (déployer + ré-étalonner sur tâches d'agent) | élevé pour agents : entraîné sur Chatbot Arena (conversationnel) ; sur tâches structurées, la dégradation peut être bien > 5 % | prouvée sur MT-Bench (−40 % d'appels GPT-4, < 5 % dégradation) ; **non prouvée sur tâches d'agents** |
| **Not Diamond** | SaaS recommender (« meilleur modèle par prompt ») | ❌ | abonnement/API | ~100–500 ms (API) | clé API, PII sortent | **M** (eval + API) | moyen : SaaS tiers, confiance à gagner par eval | bonne (appris), opaque |
| **OpenRouter** | agrégateur (routage prix/latence/fallback, pas « complexité ») | ❌ service | coût provider + marge ~5–10 % | négligeable (config) | clé API | **S** | faible techniquement ; SPOF (garder un accès provider direct) | ne classifie PAS la complexité — il choisit le endpoint le moins cher/rapide pour un modèle demandé ; utile pour le fallback |
| **Martian** | routeur ML (per-customer) | ❌ | API | n/a | — | n/a | **élevé : la société a pivoté vers l'interprétabilité (2026)** — disponibilité du produit à vérifier avant toute considération | historiquement « classifieur de complexité par client » |
| **LiteLLM** (router/proxy) | proxy OSS : fallback, retry, load-balancing, routage par coût | ✅ Apache 2.0 | 0 $ | négligeable | Python (proxy OpenAI-compatible) | **M** (proxy de plus dans la chaîne) | faible : orienté **disponibilité/résilience**, pas sélection par complexité | n/a (ne décide pas « fort vs faible » sur la difficulté) |
| **Bedrock intelligent prompt routing** | classifieur géré AWS, 2 modèles **d'une même famille** | ❌ | inclus Bedrock (~−30 % coût déclaré) | géré AWS | AWS Bedrock | **S** si on est sur Bedrock ; n/a sinon | faible | limité : même famille, pas de cross-provider, pas de re-étalonnage custom |
| **Routage structurel** (modèle par fonction, décidé au design) | config versionnée, zéro classifieur | ✅ interne | 0 $ | **0 ms** | aucune | **déjà fait** (4 fonctions × catégories) | **le plus faible** : déterministe, pas de surface d'attaque, audit git | ne s'adapte pas per-query, mais capture « la majorité des économies » selon OpenLegion pour les flottes d'agents |

**Lecture honnête de ce tableau** : pour le volume réel de Pi-Web (usage personnel/local, pas 100 000 requêtes/jour), les analyses citées concluent que le **routage dynamique par classifieur n'est rentable qu'au-delà de ~10 000 requêtes/jour** et que le **routage structurel** (par fonction/rôle) capture l'essentiel du gain — sans overhead, sans surface d'attaque, avec audit trail. Pi-Web a **déjà** le meilleur des deux mondes pour son échelle : structurel (4 fonctions) + heuristique gratuite + classifieur LLM optionnel.

---

## 4. Design proposé pour Pi-Web

### 4.1 Ce qui existe déjà (constaté dans le code — ne pas réimplémenter)

| Brique | Fichier | État |
|---|---|---|
| Types de routage (4 fonctions, 4 catégories, `Route`, `RoutingConfig`) | `backend/src/pi/routing-types.ts` (145 l.) | ✅ implémenté + testé |
| Heuristique (mots-clés risque/complexité, longueur, verbes, signaux session) | `backend/src/pi/routing.ts` (421 l.), `heuristicClassifier` | ✅ implémenté |
| Classifieur LLM optionnel (`completeSimple`, JSON, temp 0.1, maxTokens 100) | `routing.ts`, `llmClassifier` | ✅ implémenté (off par défaut **global** ; activé **par projet** — ex. Pi-Web : `gemma4:31b`) |
| Fusion + gate review + fail-safe | `routing.ts`, `resolveRoute` / `pickModel` | ✅ implémenté |
| Endpoint debug `GET/POST /api/routing/decision` | `backend/src/routes/routing.ts` | ✅ implémenté |
| Routage des délégations (fonction + modèle par sous-agent) | `extensions/harness-orchestrator/index.ts` (`resolveRoutingDecision` l.391, appel `/api/routing/decision` l.1028, `resolveRoutingModel` l.1052, `setModel` l.1154) | ✅ **branché et exercé** (traces d'exécution 19/09/2026) |
| Config routage par projet + migration legacy (architect→complex, reviewers→review) | `backend/src/pi/model-library.ts` (644 l., `getProjectRoutingConfig`, `normalizeRoutingConfig`) | ✅ implémenté |
| Concurrence par provider (`providerMaxLLMSlots[providerId] ?? maxLLMSlots`, files isolées, timeout 60 s) | `backend/src/pi/concurrency.ts` (335 l.) | ✅ implémenté |
| **Routage au niveau message** (`sendPrompt` → `resolveRoute` avant `session.prompt`) | `backend/src/pi/session.ts` | ❌ **code mort** : `lastRoute` déclaré (l.70) et lu (l.1679) mais **jamais assigné** ; `sendPrompt` (l.832) ne synchronise que le modèle du **mode** (`getModeModel` l.853 → `applyModeToSession` l.861/866) ; `applyRouteToSession` n'existe pas (seul un commentaire l.2011) |

> **✅ Audit factuel du 20/09/2026 — preuves (fichier:ligne + traces d'exécution réelles).**
>
> - **(b)/(c) Routage des sous-agents : RÉEL et exercé.** L'orchestrateur appelle `GET /api/routing/decision` (`extensions/harness-orchestrator/index.ts:1028`), puis pose le modèle conseillé : `routingModel = resolveRoutingModel(...)` (`:1052`) → `tempSession.setModel(routingModel)` (`:1154`). Config réellement persistée : `.data/model-library.json` → `projectModes[<Pi-Web>].harness.routing` (trivial=`gemma4:31b`, standard/complex=`deepseek-v4.1-flash`, review=`glm-5.3-flash`, `reviewRiskThreshold=0.5`, `classifierModelId=gemma4:31b`). Traces d'exécution (archives boîte noire `/app/.data/logs/harness/`) : `20260919-124244-planning…meta.json` → modèle effectif **deepseek-v4.1-flash** ; `20260919-140811-execute…meta.json` → **glm-5.3-flash** (modèle `review`, donc **choisi par le routage** — le mode harness de Pi-Web vaut `deepseek-v4.1-flash`). Les `.jsonl` portent un `model_change` `deepseek-v4-flash:0731` (défaut SDK) → modèle routé.
> - **(a) Routage au niveau message : ❌ code mort.** `session.ts` n'importe que le **type** `Route` (`session.ts:18`) ; `resolveRoute`/`pickModel` ne sont appelés que par l'endpoint debug `routes/routing.ts`. `lastRoute` n'est jamais écrit (grep exhaustif : seulement l.70 et l.1679).
> - **Kill switch : ❌ inerte.** `ROUTING_ENABLED`/`isRoutingEnabled()` (`routing.ts:36`) et `RoutingConfig.enabled` ne sont **que renvoyés** dans le JSON de `/api/routing/decision` (`routes/routing.ts:98-99`) ; aucun `if` ne les consomme. Le commentaire `routing.ts:32-34` (« géré côté appelant (session.ts) ») est **faux**. Conséquence : on ne peut pas désactiver le routage des sous-agents depuis la config aujourd'hui, et `pickModel` retombe toujours sur le modèle par défaut de la bibliothèque (jamais sur `ctx.model`).

### 4.2 OÙ router — les trois niveaux

```
   (a) NIVEAU MESSAGE          (b) NIVEAU FONCTION          (c) NIVEAU SOUS-AGENT
   message utilisateur    →    delegate{function}      →    tempSession du sous-agent
   modèle de l'ORCHESTRATEUR   planning/execute/review/     modèle par tâche déléguée
   (sendPrompt, session.ts)    integrate (orchestrator)     (découlé de (b))
```

- **(a) Message → modèle orchestrateur** : le seul niveau **non branché — et il ne l'a jamais été**. `sendPrompt` (session.ts l.832) applique le modèle du mode courant (`getModeModel`) ; le design consiste à appeler `resolveRoute()` sur le message + signaux, stocker la route dans `state.lastRoute` (champ **mort**, jamais assigné — cf. audit §4.1) et appliquer le modèle choisi via le helper factorisé `applyModelAndThinking` (l.2014) — sans dupliquer la logique d'override de provider.
- **(b) Fonction de délégation → modèle par fonction** : **déjà opérationnel**. L'orchestrateur appelle `/api/routing/decision`, qui renvoie `{route, modelId}` ; le choix explicite de l'orchestrateur **prime** (le routeur ne sert que de fallback + recommandation de modèle — bonne propriété : on ne veut pas qu'un triage re-classe un `execute` explicite en `planning`).
- **(c) Sous-agent** : découlé de (b) — le modèle conseillé est posé sur la tempSession (`routingModel ?? ctx.model`). Chaque `delegate` peut donc déjà tourner sur un modèle différent.

### 4.3 QUOI router — les tiers

La valeur économique du routage ne vient pas du classifieur, mais du **mapping catégorie → tier de modèle** :

| Tier | Cible | Coût | Latence | Usage |
|---|---|---|---|---|
| **Tier 0 — local GPU** | llama.cpp sur RTX 3080 (10.10.0.33:24625, provider `openai-compatible`) | 0 $ (électricité) | très bonne, slots limités | trivial, standard, tâches à fort volume de tokens (contexte long gratuit) |
| **Tier 1 — petit cloud** | modèles mini-class (haiku/flash/mini) | faible | très bonne | standard, classifieur LLM, tâches rapides |
| **Tier 2 — gros cloud** | frontier (reasoning) | cher | moyenne | complex, review, escalades |

Mapping vers les catégories existantes (configurable, défauts conservateurs — tout retombe sur le modèle par défaut si non configuré, comportement actuel) :

| Catégorie `RoutingConfig` | Tier par défaut proposé | Justification |
|---|---|---|
| `trivial` | Tier 0 (local) ou Tier 1 | corriger un typo, renommer : pas de raisonnement profond |
| `standard` | défaut du projet (souvent Tier 1) | comportement nominal actuel |
| `complex` | Tier 2 | planification, multi-fichiers, architecture |
| `review` | Tier 2 (modèle dédié possible) | le gate de relecture exige un contexte séparé et un modèle capable |

Le lien avec `providerMaxLLMSlots` est direct : **le tier = le provider**. Router vers le tier 0 = router vers le provider llama.cpp → la limite par provider du `concurrencyManager` (`getEffectiveLLMLimit`) protège automatiquement la RTX 3080 (ex. `providerMaxLLMSlots = {"llamacpp": 2, "openrouter": 3}`), sans aucun changement de code. C'est un gros avantage de l'existant : **le routage et la backpressure sont déjà orthogonaux**.

### 4.4 COMMENT router — trois niveaux de classifieur, même interface `Route`

```
                       demande + signaux (activeToolCalls, git, contexte)
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        ▼                                 ▼                                 ▼
  Niveau 0 (défaut)             Niveau 1 (optionnel)              Niveau 2 (futur)
  heuristicClassifier           llmClassifier                     classifieur System 1
  (routing.ts, 0 ms, 0 $)       (completeSimple, cheap model)     (ex. Laya, sidecar HTTP)
        │                                 │                                 │
        └────────────── fusion resolveRoute (confiance + gate review + fail-safe) ─┘
                                          │
                                          ▼
                     Route {category, function, riskScore, confidence}
                                          │
                                          ▼
                     pickModel → category.modelId → tier (provider) → fallback défaut
```

Le point clé : **l'interface `Route` (routing-types.ts) est déjà la bonne abstraction**. Un classifieur System 1 (Laya, Jev, ou un jevlike entraîné) ne remplacerait que **la fonction de classification**, pas l'architecture. Ajout minimal :

```ts
// routing-types.ts — extension de RoutingConfig (migration gérée par normalizeRoutingConfig)
export interface RoutingConfig {
  // ... existant ...
  classifier: "heuristic" | "llm" | "laya";  // défaut "heuristic"
  layaEndpoint?: string;                      // ex. "http://laya:8100" (sidecar)
}
```

Dans `routing.ts`, un `layaClassifier(request, signals): Promise<Route | null>` qui : (1) POST au sidecar un état + questions `choice` (4 options = trivial/standard/complex/review, **largement sous la limite des 20 options** de Laya) et `noul` (risque), (2) mappe la réponse vers `Route` avec `confidence` = probabilité calibrée retournée, (3) retourne `null` en cas d'échec → `resolveRoute` retombe sur l'heuristique (le fail-safe actuel fait exactement ça pour le classifieur LLM).

**Pourquoi les questions à 4 options sont le cas d'usage idéal si Laya est validé un jour** : distribution complète sur les 4 catégories (pas juste l'argmax), confiance exploitable par le fail-safe existant, un seul forward pass ~33 ms, $0 — contre un appel LLM complet (0,5–2 s, tokens facturés, JSON à parser).

### 4.5 Schéma de flux cible

```
 ┌──────────────┐   message utilisateur
 │   FRONTEND   │ ──────────────────────────────┐
 └──────────────┘                               ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ session.ts — sendPrompt (l.821)                                            │
 │                                                                            │
 │  POINT (a) : resolveRoute(message, config, extractSignals(...))            │
 │      classifieurs : heuristique ─┐                                         │
 │                    llm cheap ────┤  fusion + gate review + fail-safe       │
 │                    [laya] ───────┘                                         │
 │  → state.lastRoute = route          (fondation déjà en place, l.68)        │
 │  → applyModelAndThinking(pickModel(route, config, library))   (l.1978)     │
 └────────────────────────────────────────────────────────────────────────────┘
                                │ mode harness
                                ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ harness-orchestrator — tool delegate {function, task}                      │
 │                                                                            │
 │  POINT (b) : resolveRoutingDecision → GET /api/routing/decision            │
 │  (l.1012) — l'orchestrateur PRIME sur le routeur (fallback + modèle)       │
 │                                                                            │
 │  POINT (c) : routingModel → tempSession.setModel()            (l.1137)     │
 └────────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ concurrency.ts — acquireLLMSlot(slotKey, label, providerId)                │
 │   limite = providerMaxLLMSlots[providerId] ?? maxLLMSlots (par provider)   │
 └────────────────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼─────────────────────────────┐
        ▼                       ▼                             ▼
 ┌────────────────┐   ┌────────────────────┐   ┌──────────────────────────┐
 │ TIER 0 local   │   │ TIER 1 petit cloud │   │ TIER 2 gros cloud        │
 │ llama.cpp      │   │ mini-class         │   │ frontier                 │
 │ RTX 3080       │   │ trivial / standard │   │ complex / review         │
 │ :24625         │   │                    │   │                          │
 └────────────────┘   └────────────────────┘   └──────────────────────────┘
                                │
                                ▼
          signaux de sortie : tool_error, JSON invalide, review KO, spinning
                                │
                   ┌────────────▼─────────────┐
                   │ GARDE-FOU : ESCALADE      │
                   │ tier+1 sur échec, cap ×1, │
                   │ tout loggé (route + score)│
                   └───────────────────────────┘
```

### 4.6 Points d'insertion précis (fichiers réels)

| Étape du design | Fichier | Insertion |
|---|---|---|
| Routage au niveau message | `backend/src/pi/session.ts` | dans `sendPrompt` (l.821), à côté du bloc « sync model » actuel : appeler `resolveRoute()` quand `isRoutingEnabled() && routingConfig.enabled`, persister dans `state.lastRoute` (champ déjà défini l.68), appliquer le modèle routé via `applyModelAndThinking` (l.1978) |
| Classifieur Laya (si un jour validé) | `backend/src/pi/routing.ts` | nouveau `layaClassifier()` à côté de `llmClassifier()` (l.248) ; branché dans `resolveRoute` (l.349) derrière `config.classifier` |
| Config + migration | `backend/src/pi/routing-types.ts` + `model-library.ts` | ajouter `classifier` + `layaEndpoint` à `RoutingConfig` ; `normalizeRoutingConfig` (model-library.ts) gère déjà les champs manquants → migration triviale ; `.data/model-library.json` est une donnée de production générée au runtime (pas dans le dépôt), le modèle de données est dans `model-library.ts` |
| Escalade | `extensions/harness-orchestrator/index.ts` | dans le bloc post-exécution du `delegate` (détection d'échec déjà instrumentée : `attemptsMade`, `archiveCause`, events `subagent_end`) : si échec ET escalade permise → re-déléguer avec tier+1 ; cap 1 escalade par tâche |
| Tier → provider | `backend/src/pi/model-library.ts` + UI | `RoutingConfig[category].modelId` référence déjà un `RegisteredModel` (donc un provider) → le tier est implicite ; compléter `concurrency.providerMaxLLMSlots` pour protéger le provider local |
| Observabilité | `backend/src/routes/routing.ts` | l'endpoint `/api/routing/decision` existe ; ajouter le log systématique des décisions en production (cf. protocole §6) |

### 4.7 Risques

| Risque | Détail | Mitigation |
|---|---|---|
| **Mauvais routage → tâche ratée** | le « false economy » documenté : router une tâche dure sur un modèle cheap fait perdre plus en retry/escalade que ce qu'il économise en tokens ; en agent, un tool call malformé n'est pas une « réponse moins bonne », c'est un pipeline cassé | fail-safe déjà en place (`confidenceThreshold`, repli `standard/execute`) ; biais conservateur : en cas de doute → tier supérieur ; gate review intact |
| **Coût caché de la cascade** | escalader = payer le tier bas **puis** le tier haut ; chaque échec double le coût de la tâche | escalade déclenchée par signaux explicites (erreur outil, JSON invalide, review KO), pas systématique ; cap ×1 ; ne cascade que si le taux de succès du tier bas est élevé (≥ 85 %) — sinon routage direct |
| **Complexité opérationnelle** | un classifieur de plus = un service de plus (si Laya : Python, poids, RAM, calibration, fine-tuning potentiel) | l'heuristique reste le défaut ; tout classifieur optionnel est un `null`-safe derrière la même interface, kill switch `ROUTING_ENABLED` existant |
| **Dérive du seuil** | la distribution des demandes change (nouveaux types de tâches) → le classifieur devient faux silencieusement | revue mensuelle des logs de décisions (§6) ; re-calibration du seuil selon le processus OpenLegion |
| **Surface d'attaque du classifieur** | déflation de complexité (une requête piégeuse paraît simple), inflation (coût), probing | volume mono-utilisateur local → risque faible ; garder les logs de décisions + le routage structurel (l'orchestrateur prime) comme ceinture de sécurité |
| **Confusion d'homonymes** | « Laya » = centre de notifications / projet local-first / LayaAir ; risque de tirer le mauvais repo/package | toujours citer l'organisation : ConvAI Innovations / `convaiinnovations/laya` / PyPI `laya` — et vérifier avant tout install |

### 4.8 Garde-fou central : l'escalade (cascade encadrée)

Principe : **commencer au tier que la route indique, remonter d'un tier sur signal d'échec explicite, une seule fois**.

1. La route choisit le modèle (ex. `standard` → Tier 1).
2. Signaux d'échec acceptés : tool call en erreur répété, sortie non conforme au schéma attendu, review qui échoue, `spinning` détecté.
3. Sur signal → re-dispatch sur tier+1 (mêmes outils, même tâche, contexte repris), **cap 1 escalade** par tâche (au-delà : échouer proprement et remonter à l'orchestrateur/utilisateur).
4. Chaque escalade est loggée : `{route initiale, score de confiance, signal déclencheur, tier final, issue}` — c'est la donnée brute du protocole §6.

C'est la traduction du pattern « cascade routing » de la littérature, avec sa limite connue assumée : la cascade ne paie que si le tier bas réussit souvent (≥ 85 %) et si l'échec est détectable automatiquement — ce qui est le cas de Pi-Web (échecs structurés : erreurs d'outils, review, schéma), pas une cascade « au jugé ».

---

## 5. Recommandation

**Faut-il utiliser Laya ? → Non, pas maintenant (option b).**

1. **Le problème que Laya résout est déjà résolu à ~80 % dans Pi-Web.** *(Reformulation vérifiée le 20/09/2026 : la couche de **classification** et le **routage des sous-agents** sont réels et exercés ; en revanche le **routage au niveau message est du code mort** — preuves en §4.1. Le « ~80 % » ne vaut donc que pour la brique classifieur + délégation, pas pour le routage message.)* La couche de classification par complexité existe (heuristique + classifieur LLM optionnel + fusion + fail-safe + gate review, dans `routing.ts`), le routage par fonction de délégation est opérationnel (orchestrateur → `/api/routing/decision` → modèle par sous-agent), et la configuration par catégorie (`RoutingConfig`) est branchée sur `model-library.json`. Ce qui manque n'est pas un meilleur classifieur : c'est (i) **écrire** le routage au niveau message (`resolveRoute` n'est appelé que par l'endpoint debug ; `lastRoute` est un champ mort), (ii) mapper les catégories sur les **tiers** (local GPU / petit cloud / gros cloud), (iii) l'escalade + l'observabilité.
2. **La preuve de valeur de Laya est insuffisante pour un pari.** Source unique auto-promotionnelle, benchmarks auto-publiés, liens arXiv tronqués, poids/PyPI/licence code invérifiables depuis ce conteneur, support CPU/ONNX non documenté, et — décisif — **zéro-shot déclaré quasi aléatoire hors domaine d'entraînement** : classer la complexité de tâches de coding-agent n'est la tâche d'aucun checkpoint publié. Adopter Laya aujourd'hui, c'est potentiellement signer pour un fine-tuning + calibration + un sidecar Python dans une chaîne Node.
3. **Le rapport coût/bénéfice ne passe pas à notre échelle.** Les économies documentées du routage dynamique (RouteLLM −40 % d'appels forts, −66 % de coût à 70/30) supposent du volume (les analyses citées situent le seuil de rentabilité du routage par classifieur vers 10 000 requêtes/jour). Pi-Web est un outil personnel : le levier rentable est le **tier mapping** (tokens gratuits sur la RTX 3080, gros modèle réservé à complex/review) et la **protection du provider local** par `providerMaxLLMSlots` — tout cela est de la config, pas du ML.
4. **Alternative recommandée (design retenu, §4)** : finaliser l'existant — (1) brancher `resolveRoute` dans `sendPrompt` au niveau message ; (2) mapper trivial/standard/complex/review sur les tiers avec biais conservateur ; (3) ajouter l'escalade encadrée (cap ×1) et le logging des décisions ; (4) **garder Laya en veille** avec le protocole de validation §6 (coût : 1–2 h) : vérifier PyPI/HF/GitHub/licence, puis tester **zéro-shot** des checkpoints publiés sur un jeu étiqueté de vraies demandes Pi-Web ; s'il bat l'heuristique de façon nette **sans fine-tuning**, le brancher comme classifieur optionnel derrière l'interface `Route` (effort M, isolé, réversible). À ce stade, `jevlike` (MIT, entraînable sur nos propres données) est l'alternative plus honnête si on veut un classifieur appris : on contrôle les données, la qualité et le déploiement.
5. **Conformément aux préférences du user** : ce document est un design ; aucune modification de code n'est faite, rien ne s'exécute sans validation explicite. La mise en œuvre recommandée, si validée, suit l'ordre : tier mapping + escalade (config + ~100 lignes) → routage message (R2) → protocole de mesure → seulement ensuite, éventuellement, un classifieur appris.

---

## 6. Protocole de test (si on y va)

Objectif : mesurer si un routeur choisit **bien**, avant de lui confier des modèles réels. Basé sur les pratiques citées (calibration de seuil OpenLegion, « measure quality after routing » nomadx.ae, MT-Bench vs tâches d'agents openlegion.ai).

### 6.1 Construire le jeu de tâches

1. Extraire de l'historique Pi-Web (sessions sur disque + logs `/api/routing/decision`) un échantillon de **200–500 demandes réelles** (messages utilisateur + tâches `delegate`), équilibré entre catégories.
2. Étiqueter chaque item **trivial / standard / complex / review** par l'issue constatée, pas par intuition : le tier inférieur a-t-il suffi ? (validation : review passée sans correction, pas de retry, tool calls valides).
3. Réserver 20 % en set de test jamais touché pendant le réglage (séparation par session/projet pour éviter les quasi-dupliqués — leçon jevlike : « split related records together »).

### 6.2 Bras de comparaison

| Bras | Description | Ce qu'on mesure |
|---|---|---|
| A — fixe bas | tout sur Tier 1 (ou défaut actuel) | coût, réussite — la ligne de base qualité/coût |
| B — fixe haut | tout sur Tier 2 | coût maximal, qualité maximale (plafond) |
| C — routé (heuristique) | l'existant `resolveRoute` | réussite par tier, coût, latence, escalades |
| D — routé (candidat : classifieur LLM, puis Laya si validé) | même pipeline, classifieur remplacé | idem + **matrice de confusion** du classifieur (precision/rappel par catégorie) |

Chaque tâche est exécutée dans les bras A/B (et échantillonnée en C/D) avec le même prompt, outils et timeout ; réussite binaire définie **par type de tâche** (test passe, review sans bloquant, artifact conforme).

### 6.3 Métriques

| Métrique | Définition | Seuil d'acceptation suggéré |
|---|---|---|
| Taux de réussite par tier | % de tâches OK par tier de destination | tier inférieur à ≤ 2 % du tier supérieur sur sa catégorie |
| Coût moyen par tâche | tokens × prix, par bras | C/D ≤ B − 30 % à qualité égale |
| Latence P50/P95 | fin de tâche − début, par tier | P95 pas de plus de 20 % au-dessus du bras A |
| Taux d'escalade | % de tâches qui remontent d'un tier | < 15 % (au-delà : le mapping de départ est mal calibré) |
| Précision du classifieur | accords classifieur vs étiquette issue | > 80 % sur `complex` et `review` (les catégories coûteuses en cas d'erreur) |
| Dérive mensuelle | mêmes métriques sur le mois glissant | alerte si la réussite du tier bas baisse de 5 points |

### 6.4 Calibration et garde-fous

1. **Seuil** : pour chaque catégorie, identifier le percentile de complexité sous lequel le tier bas est acceptable (processus : 500–1 000 échantillons, mesurer l'écart faible/fort, régler le seuil — OpenLegion). Dans Pi-Web ce sont les règles de `heuristicClassifier` + `reviewRiskThreshold`/`confidenceThreshold`.
2. **Asymétrie** : sous-router (complex → tier bas) coûte une tâche ratée ; sur-router (trivial → tier haut) ne coûte que des tokens. Biais conservateur assumé vers le tier haut.
3. **Logs** : chaque décision loggée avec `{request (tronqué), signals, classifieur, score, route, modèle choisi, escalade?, issue}` — sans PII inutile ; revue mensuelle de dérive.
4. **Kill switch** : `ROUTING_ENABLED=0` (existant) revient au comportement fixe en un redémarrage.

### 6.5 Critère de sortie du pilote Laya (le cas échéant)

Le candidat System 1 n'est adopté que si, **zéro-shot sur le jeu étiqueté Pi-Web**, il obtient : (a) ≥ l'heuristique + 10 points d'accuracy sur les 4 catégories, (b) une calibration exploitable (ECE < 0,15), (c) une latence p95 < 150 ms dans les conditions réelles d'exécution (CPU conteneur OU sidecar GPU), (d) une licence confirmée (poids **et** code). Sinon : on reste sur heuristique + classifieur LLM, et on referme le dossier.

---

## Annexe — Sources

| Source | Nature | Usage dans ce doc |
|---|---|---|
| `laya.convaiinnovations.com` (lu via librarian, snapshot 2026-09-20) | **page produit de l'auteur de Laya** — unique source sur Laya | §1, §2 — tout y est marqué « déclaré » |
| `typesafe.ai/blog/introducing-system-one-models-and-jev` (cité par jevlike) | annonce commerciale Jev | §1.2 |
| `github.com/vinnylarouge/jevlike` (README) | réimplémentation ouverte de Jev | §1.4, §3 |
| `nomadx.ae/blog/llm-model-routing-routellm-openrouter-notdiamond-2026` | comparatif routeurs (RouteLLM/OpenRouter/Not Diamond) | §3, §4.8 |
| `openlegion.ai/en/learn/llm-routing` | routage par complexité/coût, RouteLLM (−40 % < 5 %), Martian (pivot), LiteLLM, Bedrock, sécurité des routeurs, cascade | §3, §4.7, §6 |
| Code Pi-Web : `routing.ts`, `routing-types.ts`, `routing.test.ts`, `model-library.ts`, `session.ts`, `concurrency.ts`, `routes/routing.ts`, `extensions/harness-orchestrator/index.ts`, `docs/routing-design.md` | lecture directe du dépôt | §4 en entier |
| `.data/model-library.json` | **donnée de production générée au runtime, absente du dépôt** (le checkout ne contient que `.secret-key`, `agent-keys.json`, `projects.json`) ; le schéma de référence est `ModelLibrary` dans `model-library.ts` | §4.3 |