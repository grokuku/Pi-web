# Logs backend (P0 Observabilité, volet 2/2)

## Où sont les logs

Tout est dans **`.data/logs/`** (dossier `DATA_DIR` du backend — volume monté
dans `/app/.data` côté Docker, `.data/` du repo en dev ; gitignore). Deux types
de fichiers :

| Fichier | Contenu |
|---|---|
| `backend-YYYYMMDD.log` | Journal courant : une ligne par événement (info/warn/error), y compris tout `console.error` capturé. Un fichier par jour (minuit local). |
| `crash-<ISO>-<pid>.json` | Dump complet d'un crash (un fichier par crash, écrit **synchrone** avant `process.exit(1)`). |

## Format d'une ligne du journal

```
2025-01-08T12:34:56.789Z [ERROR] [pi-session] Failed to create/resume Pi session | {"projectId":"...","error":"...","stack":"..."}
```

`<ISO timestamp> [NIVEAU] [catégorie] message | détails JSON compact`.

Catégories en place : `ws` (messages WebSocket — erreurs, mais aussi le cycle
 de vie complet : connexions/déconnexions client, envois `pi_history`, replays
 `pi_start` après reconnexion, cf. section suivante), `pi-session`
(création/resume de session Pi, y compris les replays `pi_start` sur session
déjà active), `express` (erreurs middleware global), `console` (capture des
`console.error` extérieurs), `crash` (résumé d'un crash), `harness`
(délégués du harness inline — archivage des sessions en échec, cause et
contexte de l'échec).

## Événements INFO/WARN du cycle WS et des envois d'historique

Suite à l'incident « chat figé puis rattrapage massif » (WS coupé par le
forward_auth Authentik → l'UI figée sur un vieux rendu, puis resync au retour
avec l'historique complet d'un coup — 2228 messages sans aucune trace), le
cycle de vie WS et les envois d'historique sont tracés (catégorie `ws`, sauf
mention contraire) :

| Ligne de log | Niveau | Signification |
|---|---|---|
| `WS client connecté` | INFO | Chaque connexion : projectId (si déjà connu), nb de clients. |
| `WS client déconnecté` | INFO | Chaque déconnexion : dernier projectId vu, abonnements, nb de clients restants, raison de fermeture (`code` + `reason` WS, ex. 1006 = coupure anormale, ou `error`). |
| `pi_history envoyé` | INFO | Chaque envoi d'historique : `cause` (`pi_start` / `pi_start_replay` / `pi_history_request` / `pi_prompt_fallback`), nb de `messages`, taille en `bytes`, durée de construction `buildMs`. |
| `pi_start rejoué après reconnexion (BUG-83)` | INFO (`pi-session`) | Un `pi_start` reçu sur une session déjà active (rejeu idempotent après reconnexion ou re-sélection du projet) : projectId + nb de messages renvoyés. |
| `pi_history volumineux envoyé (rattrapage massif ?)` | WARN | Un envoi dépasse 500 messages ou ~1 Mo — c'est LE signal « rattrapage massif » à surveiller (ex. resync complet après coupure longue). |

```bash
# Retrouver un rattrapage massif (le signal manquant pendant l'incident)
grep 'pi_history volumineux' .data/logs/backend-$(date +%Y%m%d).log

# Reconstituer une séquence coupure → reconnexion → replay → resync
grep -E 'WS client|pi_history|rejoué' .data/logs/backend-$(date +%Y%m%d).log
```

## Contenu d'un dump de crash

`crash-*.json` contient : `type` (`uncaughtException`/`unhandledRejection`),
message + **stack complet**, contexte fourni (ex. la promise d'une rejection),
état du process (pid, uptime, version node, plateforme, **mémoire** en Mo) et
les **50 derniers événements loggés** (ring buffer) pour comprendre la séquence
ayant mené au crash.

## Archives « boîte noire » des délégués (catégorie `harness`)

Chaque délégation du harness inline (planning / execute / review / integrate)
tourne dans une session Pi éphémère. En cas d'ÉCHEC (timeout, abort, erreur
modèle, réponse vide…), la session JSONL est **archivée** au lieu d'être
détruite, dans `.data/logs/harness/` :

| Fichier | Contenu |
|---|---|
| `<YYYYMMDD-HHMMSS>-<fonction>-<cause>.jsonl` | Copie brute de la session du délégué (boîte noire, tous les events). |
| `<même-nom>.meta.json` | Contexte de l'échec : `cause`, `attempts`, `eventCount`, `model`, `durationMs`, `lastEventExcerpt`, `errorMessage`. |

- Rétention : **7 jours** (purge des archives expirées à chaque écriture — pas
  de cron).
- L'archivage est **best-effort** : un échec I/O ne masque jamais l'issue
  réelle de la délégation ; chaque archivage trace une ligne `[harness]` dans
  le journal du jour.
- En cas de SUCCÈS, la session est supprimée comme avant (pas de pollution).

```bash
# Derniers échecs de délégués (les plus récents en premier)
ls -t .data/logs/harness/*.meta.json | head -10

# Détail de l'échec le plus récent
cat "$(ls -t .data/logs/harness/*.meta.json | head -1)"

# Événements harness du jour dans le journal backend (les deux chemins —
# logger partagé et fallback — écrivent la même catégorie)
grep '\[harness\]' .data/logs/backend-$(date +%Y%m%d).log
```

## Comment lire les logs en cas de crash

```bash
# Journal du jour (depuis la racine du projet, ou dans le container)
tail -n 100 .data/logs/backend-$(date +%Y%m%d).log

# Derniers dumps de crash (les plus récents en dernier)
ls -t .data/logs/crash-*.json | head -5

# Depuis l'hôte, si .data/logs est monté en volume Docker : lire directement
# le chemin monté. Sinon :
docker compose exec pi-web tail -n 100 /app/.data/logs/backend-$(date +%Y%m%d).log
```

En complément, `docker logs` garde stdout (les deux flux restent redondants).

## Implémentation

- `backend/src/utils/logger.ts` — module logger (`error/info/warn`,
  `crash`, `installConsoleCapture`, purge 14 jours à l'init, surcharge du
  répertoire via `PI_WEB_LOGS_DIR` pour les tests).
- `backend/src/pi/ext-inline/harness-archive.ts` — archivage « boîte noire »
  des délégués en échec (P0 observabilité, volet 1/2) : copie JSONL + meta
  dans `.data/logs/harness/`, purge 7 jours, traçage catégorie `harness`
  (logger partagé si dispo, sinon fallback `appendFileSync` — même format et
  même catégorie).
- Branché dans `backend/src/index.ts` : handlers `uncaughtException` /
  `unhandledRejection` (dump synchrone avant exit), try/catch des handlers WS,
  création de session Pi, middleware global Express.
- Aucune dépendance externe (fs synchrone uniquement — volontaire pour
  survivre à un exit).

## Suite possible (non implémenté)

- Route API `GET /api/logs` (liste + tail du journal, protégée par l'auth API
  existante) pour consulter les logs depuis l'UI — à écrire dans
  `routes/` derrière `apiAuth`, avec garde-fou de taille (tail -n).
- Rotation par taille en complément de la purge 14 jours si un journal devenait
  volumineux.