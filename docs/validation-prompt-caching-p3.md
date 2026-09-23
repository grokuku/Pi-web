# Validation — Optimisation du Prompt Caching (P3)

- **Date** : 2026-09-23
- **Périmètre** : Pi-Web, mode harness. Rendre le **prompt système déterministe**
  pour un couple (projet, rôle) afin de réactiver le **caching de prompt
  cross-délégation** (entre deux sous-agents du même rôle), cassé par les boosts
  de tâche P1 (carte du repo) et P2 (carnet d'exploration).
- **Références** : `docs/etude-tokens-contexte-sous-agents.md` (P3).
- **Nature** : validation à base de tests unitaires + démonstrations d'exécution.
  **Aucun commit** n'est effectué.

---

## 1. Le problème

Le SDK gère le caching **intra-session** (le point de cache avance avec la
conversation). Mais le caching **cross-délégation** — le préfixe système d'un
sous-agent réutilisé par le suivant du même rôle — exige un préfixe **100 %
identique**. Or le prompt système était assemblé ainsi :

```
systemPrompt = rôle
             + carte CBM   (boostée par la TÂCHE → variable)
             + carnet P2   (boosté par la TÂCHE → variable)
             + cwd
```

La carte et le carnet changeaient d'ordre selon la tâche (`extractTaskHints`) →
le préfixe différait à chaque délégation → **cache miss systématique**.

---

## 2. Ce qui a été livré

| Élément | Fichier |
|---|---|
| Option `rank: "stable"` (tri centralité/récence seule, sans hint de tâche) | `backend/src/pi/repo-map.ts` |
| Option `rank: "stable"` (tri récence seule, sans hint de tâche) | `backend/src/pi/exploration-notes.ts` |
| Pont stable `__cbmRepoMap` + nouvelle annexe `__cbmRepoMapAnnex` (cache partagé) | `extensions/codebase-memory/index.ts` |
| Préfixe système stable + annexe de pertinence dans le **premier message user** | `extensions/harness-orchestrator/index.ts` |
| Tracking `cacheReadTokens` / `cacheWriteTokens` (SDK → JSON) | `backend/src/pi/session.ts`, `backend/src/routes/usage.ts` |
| Rétention longue du cache provider | `docker-compose.yml`, `entrypoint.sh` (`PI_CACHE_RETENTION=long`) |
| Test de stabilité octet-pour-octet | `backend/src/pi/prompt-stability.test.ts` (32 tests) |

### Architecture P3

```
┌─ PROMPT SYSTÈME (stable pour un couple projet+rôle, cachable) ─────────────┐
│ rôle (effectiveFunc.systemPrompt)                                          │
│ + <!-- PI_REPO_MAP -->   carte CBM  rank:"stable"  (centralité seule)      │
│ + <!-- PI_EXPLORATION_NOTES -->  carnet P2 rank:"stable" (récence seule)   │
│ + Current working directory: …                                             │
└────────────────────────────────────────────────────────────────────────────┘

┌─ PREMIER MESSAGE USER (variable par tâche, HORS préfixe cachable) ─────────┐
│ ## Contexte / ## Tâche                                                     │
│ + <!-- PI_TASK_RELEVANCE -->                                              │
│    ### Carte du repo — pertinence pour la tâche   (rank:"task", boosté)    │
│    ### Carnet d'exploration — pertinence …         (rank:"task", boosté)   │
│ + <!-- /PI_TASK_RELEVANCE -->                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

Les deux ponts partagent le **même cache d'extraction** (5 min, `repoMapCache`) :
l'annexe ne coûte aucune requête Cypher supplémentaire.

---

## 3. Preuve de la stabilité (octet-pour-octet)

Test : `backend/src/pi/prompt-stability.test.ts` — reproduit l'assemblage exact
de l'orchestrateur et compare les chaînes via `===` **et** via
`Buffer.from(a).equals(Buffer.from(b))` (UTF-8).

```
$ npx vitest run src/pi/prompt-stability.test.ts
 Test Files  1 passed (1)
      Tests  32 passed (32)
```

Démonstration par empreintes SHA-256 (mêmes données, deux tâches visant des
fichiers différents) :

```
system prompt (même pour les 2 tâches): 3e6438d9bcbc384f len 866
  vue tâche A : 3e6438d9bcbc384f
  vue tâche B : 3e6438d9bcbc384f
annexe tâche A : 5e8b5f2d9ff7ab0c
annexe tâche B : 0ffdac7a92de3d5e
annexe A == B ? false
systeme A == B ? true
```

- préfixe système : **hash identique** pour les deux tâches → cache hit possible ;
- annexe : **hash distinct** → la pertinence par tâche reste effective (le boost
  n'est pas « éteint », il est seulement déplacé hors du préfixe) ;
- le mode `rank: "task"` (défaut) est couvert par les tests existants
  (`repo-map.test.ts`, `exploration-notes.test.ts`) : sa sensibilité à la tâche
  est prouvée, donc la stabilité du mode `stable` n'est pas « vide ».

Garde-fou anti-collision : une assertion vérifie que le prompt système ne
contient **jamais** le titre `pertinence pour la tâche` ni le corps de l'annexe
(séparation stricte préfixe / variable).

---

## 4. Démonstration du tracking des tokens de cache

Chemin : `turn_end` (SDK `Usage`) → `recordUsage` (`session.ts`) → JSON journalier
(`routes/usage.ts`) → agrégation exposée par l'API.

- `UsageRecord` porte `cacheReadTokens` / `cacheWriteTokens` (optionnels, lus
  avec `|| 0` → compatibles avec les enregistrements historiques) ;
- `AggregatedBucket` et la réponse `GET /api/usage` exposent les totaux
  `totalCacheRead` / `totalCacheWrite` et les champs par bucket ;
- déclenchement élargi : `usage.input || output || cacheRead || cacheWrite`
  (un tour majoritairement servi par le cache n'est plus perdu).

Exécution réelle (2 tours enregistrés, agrégation `groupBy=model`) :

```
$ npx tsx .demo-cache-usage.mts
{
  "groupBy": "model",
  "totalInput": 700,
  "totalOutput": 210,
  "totalCacheRead": 27000,
  "totalCacheWrite": 800,
  "totalTokens": 910,
  "buckets": [
    {
      "key": "deepseek-chat",
      "label": "deepseek-chat",
      "inputTokens": 700,
      "outputTokens": 210,
      "cacheReadTokens": 27000,
      "cacheWriteTokens": 800
    }
  ]
}
```

Interprétation : 27 000 tokens de prompt ont été **lus depuis le cache**
(discount ~0,1× chez les providers qui le supportent) et 800 tokens ont été
**écrits** dans le cache (surcoût). Ces compteurs sont la mesure directe de
l'efficacité du P3 (ratio `cacheRead / (input + cacheRead + cacheWrite)`).

---

## 5. Infrastructure : rétention longue

- `PI_CACHE_RETENTION=long` ajouté à `docker-compose.yml` (environnement) et
  exporté par défaut dans `entrypoint.sh` (`${PI_CACHE_RETENTION:-long}`).
- Le SDK `pi-ai` lit cette variable : `"long"` active la rétention étendue
  (Anthropic 1 h, OpenAI 24 h) **là où le provider le supporte**, sinon repli
  automatique sur `"short"`.
- **Aucun marqueur de cache (breakpoint) n'est posé manuellement** : toute la
  logique est déléguée au SDK → aucun risque de 400 chez un provider non
  compatible.

---

## 6. Garde-fous vérifiés

| Garde-fou | Vérification |
|---|---|
| Préfixe strictement stable | `prompt-stability.test.ts` : égalité `===` + octet-pour-octet pour 2 tâches différentes, et reproductibilité sur appels successifs. |
| Pas de risque 400 (cache) | Aucun breakpoint forcé ; `PI_CACHE_RETENTION` piloté par le SDK, repli `short` automatique. |
| Annexe hors préfixe | Marquée `<!-- PI_TASK_RELEVANCE -->` dans le premier message user ; assertion d'absence côté système. |
| Aucune régression intra-session | Mode `rank` par défaut = `"task"` (rétrocompatible) ; suites `repo-map`/`exploration-notes` inchangées. |
| Pas de modif SDK | Seuls les helpers backend et les deux extensions sont modifiés. |
| Robustesse | Les blocs carte/annexe restent sous `try/catch` permanents : une carte ou un carnet indisponible ne bloque jamais le sous-agent. |
| Budget | L'annexe réutilise `REPO_MAP_BUDGET_CHARS` (4000) et `EXPLORATION_NOTES_BUDGET_CHARS` (2000) — pas de dépassement. |
| Cache partagé | `__cbmRepoMap` et `__cbmRepoMapAnnex` passent par `getRepoMapData()` (même `repoMapCache` 5 min) → 0 requête Cypher supplémentaire. |

---

## 7. Résultats de la suite

```
$ npx tsc --noEmit -p backend            → OK
$ npx vitest run (backend)                → 25 fichiers · 430 tests passés
```

Nouveaux tests P3 : `backend/src/pi/prompt-stability.test.ts` (32 tests).

---

## 8. Conclusion

- Le prompt système d'un sous-agent est désormais **strictement identique** pour
  un couple (projet, rôle), quelle que soit la tâche : les boosts P1/P2 sont
  déplacés dans l'**annexe de pertinence** du premier message user.
- Le caching cross-délégation devient exploitable pour les providers qui le
  supportent (DeepSeek/Gemini/OpenRouter selon amont), avec la rétention longue
  activée (`PI_CACHE_RETENTION=long`) et **sans** forcer de marqueur de cache.
- Les tokens de cache (`cacheRead` / `cacheWrite`) sont tracés de bout en bout
  (SDK → journal → API), ce qui rend l'effet **mesurable** après déploiement.
- Aucune modification du SDK, aucun commit.
