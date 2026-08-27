# API Mémoire Partagée — Spécification v1

**Principe :** exposer le système de mémoire à deux niveaux de Pi-Web aux agents externes (OpenClaw, Hermes…) via une API REST, sur le même modèle que le libraire. Les agents peuvent ainsi partager des connaissances durables entre outils et entre sessions.

> Implémentation : `backend/src/routes/shared-memory.ts` (router), `backend/src/pi/memory-service.ts` (store).

---

## Le système de mémoire à deux niveaux

| Niveau | Stockage | Contenu | Exposition API |
|---|---|---|---|
| **Global** | `~/.unipi/memory/_global_/` | Préférences utilisateur, choix transverses à tous les projets | ✅ namespace `public` (v1) |
| **Projet** | `~/.unipi/memory/<projet>/` | Décisions techniques, patterns du repo, checkpoints de compaction | ❌ non exposé en v1 |

- Format de stockage : SQLite (`memory.db`) avec fallback JSON (`memory.json`), identique à l'extension `compaction-checkpoint` qui co-écrit les mêmes fichiers.
- L'ID canonique d'une mémoire est le **slug du titre** (minuscules, non-alphanumériques → `_`). Réutiliser un titre existant = **mise à jour** (upsert).
- Les entrées de type `summary` sont des **checkpoints de compaction** écrits automatiquement par l'extension : non créables et non supprimables via l'API.

### Namespaces

En v1, un seul namespace est disponible : **`public`** — alias du store global. Toute autre valeur demandée (`agent:<id>`, `private`, …) répond **501** avec un message explicite (réservée aux lots futurs, cf. ROADMAP « Mémoire partagée »). Le segment est optionnel dans les URLs : `/memories` ≡ `/public/memories`.

---

## Authentification

Le middleware accepte la requête si **l'une** de ces conditions est remplie :

1. **Requête locale** (depuis localhost — Pi-Web interne) ;
2. **Jeton agent** : `Authorization: Bearer <token>` (clés créées dans Settings → General, cf. [agent-api.md](agent-api.md)) ;
3. **Clé librarian** : `X-API-Key: <clé>` (clés `lib-*`, cf. `GET /api/librarian/keys`).

Sinon → **401**. La route `GET /status` est exemptée de l'authentification dédiée au router (health check), mais reste soumise à l'auth globale `/api`, comme tout le backend : elle n'est donc accessible sans clé **que depuis localhost** — tout appel externe reçoit **401** de cette auth globale.

---

## Vue d'ensemble des endpoints

Base : `/api/shared-memory`

| Méthode | URL | Description |
|---|---|---|
| `GET` | `/status` | Health check : `{ ok: true, namespaces: ["public"] }` |
| `GET` | `[/{ns}]memories?q=&limit=` | Liste ou recherche (summaries exclus) |
| `GET` | `[/{ns}]memories/:id` | Une mémoire par id (slug) ou titre exact (peut renvoyer une entrée `summary`/checkpoint, contrairement à la liste qui les exclut) |
| `PUT` | `[/{ns}]memories/:id` | Upsert `{ title?, content, type?, tags? }` |
| `DELETE` | `[/{ns}]memories/:id` | Suppression (403 si summary) |

---

## Formats de données

```jsonc
// MemoryEntry (lecture)
{
  "id": "utilise_pnpm_plutot_que_npm",     // slug du titre
  "title": "Utilise pnpm plutôt que npm",
  "content": "Toutes les installs du monorepo passent par pnpm…",
  "tags": ["build", "external:openclaw"],  // tags client + tag serveur external:*
  "project": "global",
  "type": "preference",                    // preference | decision | pattern | summary
  "created": "2026-08-01T10:00:00.000Z",
  "updated": "2026-08-01T10:00:00.000Z",
  "scope": "global"
}

// PUT body
{
  "title": "API auth via JWT RS256",  // optionnel sinon dérivé de la 1re ligne de content
  "content": "…",                     // requis, non vide, max ~20 Ko
  "type": "decision",                 // optionnel, défaut "pattern" ; "summary" refusé
  "tags": ["auth"]                    // optionnel ; préfixe "external:" réservé au serveur (400 sinon)
}
```

Réponses :

| Cas | Statut | Corps |
|---|---|---|
| Création | `201` | `{ success, id, created: true, title, taggedAs? }` |
| Mise à jour | `200` | `{ success, id, created: false, title, taggedAs? }` |
| Suppression OK | `200` | `{ success: true, id }` |
| Content vide/manquant, type invalide, tag `external:*` fourni, titre sans alphanumérique | `400` | `{ error }` |
| Contenu > 20 Ko | `413` | `{ error }` |
| Introuvable | `404` | `{ error }` |
| Summary protégé | `403` | `{ error }` |
| Namespace inconnu | `501` | `{ error }` |

---

## Écritures externes taggées

Toute écriture effectuée via une clé externe reçoit **côté serveur** un tag additionnel **`external:<keyName>`** (nom de la clé agent Bearer ou librarian X-API-Key utilisée) :

- traçabilité de l'origine des entrées pour l'utilisateur et les agents ;
- filtrable via `GET /memories?q=external:openclaw` ;
- le contenu passe systématiquement par `sanitizeContent()` (emails, clés API, chemins personnels et téléphones neutralisés avant stockage — ce qui alimente aussi le system prompt des sessions Pi).

Les requêtes locales (sans clé) ne reçoivent pas ce tag : elles sont équivalentes à une écriture des tools LLM internes.

---

## Exemples curl

### Auth par jeton agent (Bearer)

```bash
BASE=http://localhost:3005/api/shared-memory
TOKEN="pia_xxxxxxxxxxxxxxxx"        # Settings → General
BEARER="Authorization: Bearer $TOKEN"

# Health check
curl -s "$BASE/status"
# → { "ok": true, "namespaces": ["public"] }

# Lister toutes les mémoires publiques
curl -s -H "$BEARER" "$BASE/memories"

# Rechercher (sous-chaîne insensible à la casse, max 10 résultats)
curl -s -H "$BEARER" "$BASE/public/memories?q=build&limit=10"

# Lire une mémoire par id (ou titre exact)
curl -s -H "$BEARER" "$BASE/memories/utilise_pnpm_plutot_que_npm"

# Upsert (création → 201, mise à jour → 200)
curl -s -X PUT -H "$BEARER" -H "Content-Type: application/json" \
  -d '{"title":"Utilise pnpm plutôt que npm","content":"Installs monorepo = pnpm.","type":"preference","tags":["build"]}' \
  "$BASE/memories/anything"

# Supprimer
curl -s -X DELETE -H "$BEARER" "$BASE/memories/utilise_pnpm_plutot_que_npm"
```

### Auth par clé librarian (X-API-Key)

```bash
KEY="lib-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

curl -s -H "X-API-Key: $KEY" "$BASE/memories"

curl -s -X PUT -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"content":"Le déploiement se fait uniquement via rebuild Docker.","type":"decision"}' \
  "$BASE/public/memories"
# → 201 { "success": true, "id": "le_deploiement_se_fait_uniquement_via_rebuild_docker_",
#         "created": true, "taggedAs": "external:openclaw" }
# (titre dérivé de la première ligne du contenu car absent du body)
```

### Namespace non implémenté

```bash
curl -s -H "$BEARER" "$BASE/private/memories"
# → 501 { "error": "Namespace \"private\" non implémenté. Seul \"public\" (alias du store global) est disponible en v1." }
```

---

## Notes d'implémentation

| Composant | Emplacement |
|---|---|
| Router + middleware `sharedMemoryAuth` | `backend/src/routes/shared-memory.ts` |
| Store hybride SQLite/JSON | `backend/src/pi/memory-service.ts` |
| Sanitization du contenu | `backend/src/pi/librarian-service.ts` (`sanitizeContent`, exporté) |
| Validation clés librarian / nom de clé | `backend/src/pi/librarian-auth.ts` (`validateKey` / `findKeyName`) |
| Validation jetons agent | `backend/src/routes/agent-keys.ts` (`validateToken`) |

Persistance : le dossier `~/.unipi` (mémoires + checkpoints) est monté en volume Docker (`pi-unipi:/root/.unipi`) pour survivre aux rebuilds.
