# Validation — Carte du Repo CBM injectée aux sous-agents (P1)

- **Date** : 2026-09-23
- **Périmètre** : Pi-Web, mode harness. Injection d'une vue compacte du graphe CBM
  dans le prompt système des sous-agents (`extensions/harness-orchestrator`), à la
  façon de la « repo map » d'Aider.
- **Références** : `docs/etude-tokens-contexte-sous-agents.md` (P1), piste #1 du
  top 3 gain/effort.
- **Nature** : validation à base de traces de production sur disque. **Aucun
  commit** n'est effectué par l'assistant.

---

## 1. Ce qui a été livré

| Élément | Fichier |
|---|---|
| Helper PUR (rendu, budget, boost, dégradation) + tests | `backend/src/pi/repo-map.ts`, `backend/src/pi/repo-map.test.ts` |
| Extraction agrégée Cypher + pont `globalThis.__cbmRepoMap` | `extensions/codebase-memory/index.ts` |
| Point d'injection du prompt système du sous-agent | `extensions/harness-orchestrator/index.ts` (≈ l. 1222) |

Rendu (palier nominal « signatures ») — format compact `Chemins / Hubs / Routes` :

```
Carte du repo (CBM · signatures) — 163 fichiers · 60 hubs · 80 routes. Interroge cbm_* avant read/grep.
CHEMINS:
backend/src/pi
backend/src/routes
...
HUBS:
loadModelLibrary() (32↩) — backend/src/pi/model-library.ts
...
ROUTES:
GET /projects
...
```

- **Budget** : plafond `REPO_MAP_BUDGET_CHARS = 4000`. Carte réelle du dépôt :
  **2711 chars ≈ 678 tokens** (vs ~3 000–8 000 tokens pour un seul fichier de 300–600 lignes).
- **Extraction** : `query_graph` avec des requêtes Cypher **agrégées** (hubs par
  `count(CALLS)`, fichiers, routes), **cachées 5 min** par projet — le coût est
  amorti sur toutes les délégations de la fenêtre.
- **Dégradation ordonnée** : `signatures` → `noms seuls` → `arborescence`, puis
  troncature à la dernière ligne entière. Le premier palier qui tient dans le
  budget est retenu ; le palier est affiché dans l'en-tête.

---

## 2. Méthode de mesure du ratio d'exploration

- **Source** : sessions des sous-agents Pi-Web dans
  `~/.pi/agent/sessions/--projects-Pi-Web--/*.jsonl` (transcripts SDK, seuls à
  contenir les vrais tool calls ; les logs backend ne journalisent que le WS).
- **Comptage** : pour chaque session, comptage des blocs `toolCall` par nom.
- **Catégories** :
  - *exploration* = `read` + `grep` + `find` + `ls` + `bash` (le `bash` de
    sous-agent sert majoritairement à explorer : `git log`, `cat`, `sed`, …) ;
  - *graphe* = `cbm_*`.
- **Exclusion** : la session courante de l'assistant (2026-09-23T07-30, qui est
  elle-même une délégation *de cette tâche*, donc non représentative).

---

## 3. AVANT (mesuré)

### 3.1 Échantillon récent (délégations ≥ 2026-09, avant injection)

| Délégation | Tool calls | read/grep/find/ls/bash | cbm_* |
|---|---:|---:|---:|
| 2026-09-19T09-27-12 | 151 | 141 | 0 |
| 2026-09-19T14-08-06 | 5 | 5 | 0 |
| 2026-09-19T19-29-11 | 30 | 30 | 0 |
| 2026-09-19T20-08-54 | 11 | 11 | 0 |
| **Total** | **197** | **187 (94,9 %)** | **0 (0,0 %)** |

### 3.2 Échantillon élargi (22 délégations Pi-Web, hors session courante)

| Métrique | Valeur |
|---|---:|
| Tool calls | 7 834 |
| dont `read/grep/find/ls/bash` | **6 192 (79,0 %)** |
| dont `cbm_*` | **0 (0,0 %)** |
| Médiane d'appels par délégation | 40 |

**Lecture** : avant injection, les sous-agents consacrent l'essentiel de leurs
appels à l'exploration de fichiers, et n'utilisent **jamais** le graphe.

---

## 4. Effet attendu — mesuré par la couverture de la carte

À défaut de re-exécuter des sessions LLM *post-déploiement* dans cet
environnement, on mesure un **proxy de réduction de l'exploration aveugle** :
quelle proportion des fichiers réellement explorés par les délégations
« avant » est déjà **visible** dans la carte injectée (chemin de hub, ou
dossier listé dans `CHEMINS`) ?

- 333 fichiers distincts explorés par les délégations Pi-Web ;
- **297 (89 %)** sont représentés dans la carte (65 cités exactement comme hub,
  232 rattachés à un dossier listé) ;
- 11 % restent hors carte (fichiers racine : `entrypoint.sh`,
  `docker-compose.yml`, … ou dossiers au-delà du plafond `CHEMINS = 16`).

**Conséquence** : dès le 1er tour, l'agent peut **cibler** ces fichiers au lieu
de les découvrir par `ls`/`find`/`read` en chaîne — exactement le levier
« rechercher la structure avant le contenu » de l'étude. Le coût de la carte
(≈ 678 tokens, une fois par délégation) est amorti dès qu'**un seul** fichier lu
en moins est évité.

---

## 5. APRÈS — procédure de mesure (à exécuter post-déploiement)

Aucune session sous-agent n'a été produite *après* déploiement de la carte dans
le conteneur d'exécution (les sources modifiées sont dans `/projects/Pi-Web`,
le conteneur tourne sur `/app`). La mesure « après » se fait avec le même script,
une fois le conteneur reconstruit :

```bash
python3 - <<'PY'
import json, glob, collections, os
D=os.path.expanduser("~/.pi/agent/sessions/--projects-Pi-Web--")
EXPL={"read","grep","find","ls","bash"}
agg=collections.Counter()
for f in glob.glob(D+"/*.jsonl"):
    for line in open(f):
        try: d=json.loads(line)
        except: continue
        if d.get("type")!="message": continue
        for b in (d.get("message",{}).get("content") or []):
            if isinstance(b,dict) and b.get("type")=="toolCall":
                agg[b.get("name")]+=1
tot=sum(agg.values())
expl=sum(v for k,v in agg.items() if k in EXPL)
cbm=sum(v for k,v in agg.items() if str(k).startswith("cbm_"))
print(f"{tot} calls · exploration {expl} ({100*expl/tot:.1f}%) · cbm {cbm} ({100*cbm/tot:.1f}%)")
print(dict(agg.most_common()))
PY
```

**Critères de succès attendus** :
1. la carte est présente dans le prompt des sous-agents (marqueurs
   `<!-- PI_REPO_MAP -->` … `<!-- /PI_REPO_MAP -->`) sans dépasser 4000 chars ;
2. le ratio d'exploration `read/grep/find/ls/bash` **baisse** par rapport au
   baseline (79 % global / 94,9 % récent), au bénéfice de `cbm_*` et de lectures
   ciblées ;
3. aucune délégation échoue à cause de la carte (garde-fou : erreur → pas de
   carte, sous-agent démarré quand même).

---

## 6. Garde-fous vérifiés

| Garde-fou | Vérification |
|---|---|
| Budget plafonné | Tests Vitest : sortie ≤ budget pour 120/200/400/800/1600/4000 et troncature propre. |
| Pas de dump de code | Le rendu ne contient que noms/signatures courtes (± 30 chars) et chemins — jamais de corps de fonction. |
| Dégradation ordonnée | Tests : `signatures → noms seuls → arborescence`, mesurés sur données réelles (`2518 → 2094 → 1359` chars). |
| Graphe non indexé | `buildRepoMap([])` → `""` ; `buildRepoMapCached` ne jette jamais (retourne `null`). |
| Absence de blocage | Injection orchestrateur sous `try/catch` permanent ; pont `globalThis` optionnel (type-check avant appel). |
| Minimisation MCP | Requêtes Cypher agrégées + cache 5 min par projet (le moteur Cypher CBM n'accepte qu'un seul `WITH` et pas d'`UNION` → 2 requêtes). |
| Pas de modif SDK / routes API | Aucune. |

---

## 7. Conclusion

- **Avant** : 79 % (élargi) à 94,9 % (récent) des appels de sous-agents sont de
  l'exploration ; `cbm_*` = 0 %.
- **Injection** : carte de 2711 chars (≤ budget 4000), couvrant 89 % des
  fichiers historiquement explorés, injectée automatiquement au 1er tour.
- **Après** : la mesure quantitative doit être refaite post-déploiement (script
  ci-dessus) ; l'infrastructure est validée par les tests unitaires (15) et la
  suite backend complète (398 tests).
