# Validation — Carnet d'exploration des sous-agents (P2)

**Date :** 2026-09-23
**Périmètre :** P2 de l'étude `docs/etude-tokens-contexte-sous-agents.md` — persistance
hors-repo des découvertes durables des sous-agents + héritage via un digest injecté.
**Objet :** prouver l'injection du digest dans le prompt système d'un sous-agent, et
l'aller-retour écriture/lecture d'une note.

---

## 1. Livrables

| Livrable | Fichier | Rôle |
|---|---|---|
| Helper + stockage | `backend/src/pi/exploration-notes.ts` | Rendu PUR (digest borné, boost, dégradation) + JSONL append-only + compaction paresseuse + purge |
| Tests | `backend/src/pi/exploration-notes.test.ts` | 21 tests Vitest (budget, boost, dégradation, parsing, TTL, plafond, purge, sécurité chemin) |
| Intégration | `extensions/harness-orchestrator/index.ts` | Tools `exploration_note`/`exploration_notes` (4 rôles), guide `SCRATCHPAD_GUIDE`, injection `<!-- PI_EXPLORATION_NOTES -->` |
| Cycle de vie | `backend/src/projects/manager.ts` | Purge du carnet à la suppression du projet |

---

## 2. Preuve 1 — l'injection du bloc dans le prompt du sous-agent

L'injection est câblée dans `extensions/harness-orchestrator/index.ts` (bloc
`explorationNotesBlock`, juste après la carte P1), enveloppé d'un `try/catch`
permanent (une erreur de lecture ne bloque jamais le spawn). Le texte suit le
même patron que P1 : marqueurs + budget strict via le helper.

Simulation du chemin d'injection (helper compilé, `task` = « Corrige le helper
repo-map.ts ») :

```
DIR /tmp/carnet-lPm6Ay
ECRITURES: [fact] Le backend se compile avec npm run build (tsc + copie git-askpass.sh). | [pitfall] repo-map.ts doit rester PUR (aucun I/O) sinon les tests Vitest deviennent instables. | [decision] Le carnet d'exploration est stocké hors repo sous .data/harness-notes/<projectId>/.
LECTURE: 3 note(s)
BUDGET_MAX=2000 · DIGEST=469 · BLOC=532
=====BLOC_INJECTE=====

<!-- PI_EXPLORATION_NOTES -->
Carnet d'exploration (3 notes · complet) — faits/pièges/décisions persistés hors repo. Relis avec exploration_notes, écris avec exploration_note.
- [piège] backend/src/pi/repo-map.ts — repo-map.ts doit rester PUR (aucun I/O) sinon les tests Vitest deviennent instables.
- [décision] Le carnet d'exploration est stocké hors repo sous .data/harness-notes/<projectId>/.
- [fait] backend/package.json — Le backend se compile avec npm run build (tsc + copie git-askpass.sh).
<!-- /PI_EXPLORATION_NOTES -->
=====FIN_BLOC=====
```

**Lecture :** le bloc fait **532 chars** (dont marqueurs), très en deçà du budget
de **2000 chars**. La note citée par la tâche (`repo-map.ts`) remonte en tête :
le boost fonctionne. Les marqueurs `<!-- PI_EXPLORATION_NOTES -->` …
`<!-- /PI_EXPLORATION_NOTES -->` encadrent le bloc, comme `<!-- PI_REPO_MAP -->`
pour P1.

### Preuve 1b — outils réellement enregistrés et invoqués

L'extension chargée via jiti avec un `ExtensionAPI` factice enregistre bien les
trois outils, et l'aller-retour via leurs `execute` (projectId résolu depuis
`ctx.cwd`, repli = nom de dossier) fonctionne de bout en bout :

```
TOOLS ENREGISTRÉS: delegate, exploration_note, exploration_notes
WRITE: ✅ Note [piège] enregistrée dans le carnet du projet (backend/src/pi/exploration-notes.ts) : Le carnet E2E fonctionne de bout en bout.
READ:
## Carnet d'exploration (filtre « E2E ») — 1 note(s)
- [piège] 2026-09-23T09:22:43.773Z backend/src/pi/exploration-notes.ts — Le carnet E2E fonctionne de bout en bout.
PURGE: true
```

---

## 3. Preuve 2 — écriture/lecture d'une note (JSONL append-only)

Les tools `exploration_note` (écriture) et `exploration_notes` (lecture/recherche)
délèguent au helper. Le fichier de stockage reste **append-only** :

```
$ cat /tmp/carnet-lPm6Ay/demo-project/notes.jsonl
{"at":"2026-09-23T09:22:16.965Z","kind":"fact","text":"Le backend se compile avec npm run build (tsc + copie git-askpass.sh).","file":"backend/package.json"}
{"at":"2026-09-23T09:22:16.967Z","kind":"pitfall","text":"repo-map.ts doit rester PUR (aucun I/O) sinon les tests Vitest deviennent instables.","file":"backend/src/pi/repo-map.ts"}
{"at":"2026-09-23T09:22:16.967Z","kind":"decision","text":"Le carnet d'exploration est stocké hors repo sous .data/harness-notes/<projectId>/."}
```

Sortie du tool de lecture (du plus récent au plus ancien) :

```
## Carnet d'exploration — 3 note(s)
- [décision] 2026-09-23T09:22:16.967Z — Le carnet d'exploration est stocké hors repo sous .data/harness-notes/<projectId>/.
- [piège] 2026-09-23T09:22:16.967Z backend/src/pi/repo-map.ts — repo-map.ts doit rester PUR (aucun I/O) sinon les tests Vitest deviennent instables.
- [fait] 2026-09-23T09:22:16.965Z backend/package.json — Le backend se compile avec npm run build (tsc + copie git-askpass.sh).
```

Recherche `query: "repo-map"` :

```
## Carnet d'exploration (filtre « repo-map ») — 1 note(s)
- [piège] 2026-09-23T09:22:16.967Z backend/src/pi/repo-map.ts — repo-map.ts doit rester PUR (aucun I/O) sinon les tests Vitest deviennent instables.
```

---

## 4. Preuve 3 — suite de tests

```
$ cd backend && npx tsc --noEmit          # 0 erreur
$ cd backend && npx vitest run
 Test Files  24 passed (24)
      Tests  419 passed (419)
```

Les 21 nouveaux tests couvrent : budget (60→2000 chars), boost par la tâche,
dégradation ordonnée (complet → court → titres), carnet vide → `""`, parsing
JSONL tolérant, append sans écrasement, isolation par projetId, recherche,
TTL 90 j, plafond 300 notes, purge, et refus de traversée de chemin.

---

## 5. Garanties de conception

- **Budget strict :** le digest ne dépasse jamais 2000 chars (`buildNotesDigest`
  dégrade puis tronque à la dernière ligne entière).
- **Isolation du stockage :** `<racine>/.data/harness-notes/<projectId>/notes.jsonl`,
  jamais dans le cwd du projet. `safeProjectSegment()` interdit `..` et `/`.
- **Non bloquant :** l'injection et les tools sont enveloppés de `try/catch`
  permanents ; une erreur de lecture rend un digest vide (le sous-agent démarre
  normalement).
- **Cycle de vie :** append atomique, compaction paresseuse à l'écriture (TTL
  90 j + plafond 300 notes, les plus récentes gagnent), purge du dossier projet
  à la suppression du projet (`projects/manager.ts`, best-effort).

---

## 6. Reproductibilité

Le script de simulation utilisé pour les preuves 1 et 2 : voir la commande
`node /tmp/validate-notes.mjs` (importe le helper compilé `backend/dist/pi/exploration-notes.js`).
Les tests unitaires (preuve 3) : `cd backend && npx vitest run src/pi/exploration-notes.test.ts`.

> **Note `log_commit_note`** : ce tool n'est pas exposé dans le contexte
> d'exécution de cette tâche ; il n'a donc pas pu être appelé après chaque étape.
> Aucun commit n'a été effectué, conformément à la consigne.
