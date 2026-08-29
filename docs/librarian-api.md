# API Libraire — Documentation d'intégration pour agent

**À qui s'adresse ce document :** à un agent externe (CLI, autre serveur, workflow d'automatisation) qui veut utiliser le **Libraire** de Pi-Web pour effectuer des **recherches techniques sur internet** et exploiter/archiver une **bibliothèque documentaire partagée**.

**Principe :** le Libraire maintient une bibliothèque de documentation technique (JSON structuré par outil/version), Enrichie par les projects Pi-Web. Toute recherche interroge d'abord cette bibliothèque locale (réponse instantanée), puis bascule sur le **web** (Webclaw, fallback Tavily) si aucun local ne correspond. L'agent peut ensuite y **archiver ses propres découvertes** pour les retrouver plus vite et les partager avec les autres agents et avec Pi-Web.

> Implémentation : `backend/src/routes/librarian.ts` (router), `backend/src/pi/librarian-service.ts` (service + recherche web), `backend/src/pi/librarian-auth.ts` (clés API).

---

## 1. Comment te configurer (résumé pour l'agent)

Deux cas selon **où tu t'exécutes** :

### Cas A — Tu tournes sur la même machine que Pi-Web (localhost)

Aucune config nécessaire. Utilise directement :

```bash
curl -s -X POST http://127.0.0.1:3000/api/librarian/search \
  -H "Content-Type: application/json" \
  -d '{"query": "express routing"}'
```

L'authentification est contournée pour tout appel depuis `127.0.0.1` / `::1`.

### Cas 2 — Tu tournes ailleurs (machine distante)

Il te faut **deux identifiants** fournis par ton administrateur :

| Identifiant | Format | À quoi il sert | Où l'utilisateur te le donne |
|---|---|---|---|
| **Jeton agent** | chaîne aléatoire (voir `agent-api.md`) | franchir l'authentification globale `/api` | Settings → API Keys (bouton création) |
| **Clé libraire** | `lib-` + 32 caractères hex | authentifer les routes libraire | Settings → section API Libraire (bouton création) |

Tu dois envoyer les deux dans chaque requête :

```bash
BASE="https://pi.holaf.fr"          # ou http://<host>:3005 en LAN
AGENT_TOKEN="<jeton-agent>"          # Authorization: Bearer …
LIB_KEY="lib-xxxxxxxxxxxxxxxx…"      # X-API-Key …

curl -s -X POST "$BASE/api/librarian/search" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-API-Key: $LIB_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "comment configurer WebSocket en Node"}'
```

> Remarque : tes serveurs d'API doivent respecter le **rate limit** (600 requêtes/min par IP global ; voyez la section « Limites ») — répartissez vos appels si vous effectuez de nombreux appels rapprochés, et attendez un `429` avant de réessayer.

### Checklist de démarrage

1. Vérifie la connectivité : `GET ${BASE}/api/librarian/status` (200 attendu).
2. Teste une recherche : `POST ${BASE}/api/librarian/search` avec une requête de test simple.
3. Consulte la bibliothèque locale : `GET ${BASE}/api/librarian/library` pour ne pas dupliquer un doc existant.
4. Si tu découvres une doc technique utile ABSENT DE LA bibliothèque → archive-la (section « Archiver tes découvertes »).

---

## Authentification (détails)

L'API a deux couches successives :

| Couche | Middle ware | Comment franchir |
|---|---|---|
| 1. Authée globable `/api` | `apiAuth` | Reviens depuis localhost, **ou** `Authorization: Bearer <jeton agent>` (cf. [agent-api.md](agent-api.md)) |
| 2. Routes libraires | `librarianAuth` | Ennie de `X-API-Key: lib-…` depuis localhost ; sinon **obligatoire** pour les routes libraires |

- Depuis localhost (`Cas 1`) : les deux couches sont contournées.
- Depuis l'extérieur : les deux couches sont actives → **les en-têtes `Authorization` + `X-API-Key` doivent être envoyés ensemble**.
- La route `GET /api/librarian/status` est exemptée de l'auth librairie (health check), mais reste soumise à l'auth globale — en externe le jeton agent suffit alors, sans clé `lib-*`.

---

## Vue d'ensemble des endpoints

Base : `/api/librarian`

| Méthode | URL | Auth end layer | Description |
|---|---|---|---|
| `GET` | `/status` | apiAuth seulement | Santé : `{ totalDocs, lastUpdated, lastScan }` |
| `GET` | `/library` | + clé libraire | Liste **toute** la bibliothèque locale |
| `POST` | `/search` | + clé libraire | Recherche : locale d'abord, puis web (Webclaw→Tavily) |
| `GET` | `/doc/:name?version=x` | + clé libraire | Contenu d'un doc archivé |
| `POST` | `/archive` | + clé libraire | Archive un document (tes découvertes) |
| `POST` | `/update` | + clé libraire | Déclenche le scanmanuel des deps des projets |

La gestion des clés (`GET/POST/DELETE /api/librarian/keys`) est réservée à localhost et à l'UI web Pi-Web (Settings → API Keys, section 📚 Librarian API Keys) — un agent externe ne peut ni créer, ni voir, ni révoquer les clés : ce n'est pas ton rôle, tu reçois ta clé toute prête.

---

## Endpoints en détail

### `POST /search` — la recherche principale

**Requête :**

```json
{ "query": "comment configurer WebSocket en Node" }
```

**Réponse 200 :**

```json
{
  "results": [
    {
      "title": "ws v8.21.0",                  // nom + version si doc local
      "url": "https://…",                     // source (vide si doc sans source)
      "snippet": "Résumé du document (ou extrait web)…",
      "content": "Texte complet formaté (doc local uniquement)"
    }
  ],
  "archived": false
}
```

**Comportement :**

1. **Local d'abord** : si des docs de la bibliothèque correspondent à la requête, ils sont renvoyés formatés (summary, key points, API, exemples) — pas d'appel web, réponse rapide.
2. **Sinon web** : recherche via Webclaw (`/v1/search`, scrape des pages inclus) ; fallback automatique sur Tavily si Webclaw n'est pas disponible. ⚠️ Le champ `content` est alors absent (pas de téléchargement de page) : si besoin du texte complet de la page, récupère-le avec ton propre outil de fetch/scraper, puis archive la synthèse (ci-dessous).
3. **Pas d'archivage automatique** : malgré son nom, l'endpoint ne stocke rien automatiquement. À toi de décider ce qui mérite d'être archivé.

### `GET /doc/:name?version=x` — relire un doc archivé

Répond 200 avec le JSON complet (`meta`, `summary`, `keyPoints`, `api`, `examples`, …) ou **404** si absent. Le paramètre `version` est optionnel : sans lui, la toute première entrée qui porte ce nom est renvoyée.

### `GET /library` — tout inventorier

Réponse : `{ lastUpdated, lastScan, library: [ { name, version, type, description, keywords, updatedAt, sourceUrl }, … ] }`. Consulte cette liste **avant** d'archiver pour vérifier l'absence de doublon.

### `POST /archive` — archiver tes découvertes (contribution)

Persiste un document structuré dans la bibliothèque **partagée** : il devient consultable par les autres agents**, l'API REST, et le tool interne `librarian_search` de Pi-Web (les conversations du chat gagnent des réponses instantanées et gratuites).

**Requête :**

```json
{
  "name": "express",                       // obligatoire — sans `/`, `\`, `..` (les chemins sont neutralisés)
  "version": "routing",                    // obligatoire — titre de doc / version concernée
  "type": "tool",                          // optionnel ("tool" par défaut)
  "sourceUrl": "https://expressjs.com/en/guide/routing.html",  // optionnel
  "content": {                             // obligatoire
    "summary": "2-3 phrases : de quoi il s'agit, le chemin type.",
    "keyPoints": ["Déclaration via app.get/post…", "Les middlewares s'enchaînent…"],
    "api": [
      { "signature": "app.METHOD(path, handler)", "description": "Déclare une route." }
    ],
    "examples": [
      { "title": "Route basique", "code": "app.get('/', (req,res) => res.send('ok'));" }
    ],
    "breakingChanges": ["Changement X depuis v5…"],   // optionnel
    "rawContent": "…"                                  // optionnel (sanitizé avant stockage)
  }
}
```

**Réponse 201 :** `{ success: true, entry: { … } }` — le doc est rangé dans `docs-hub/tools/<name>@<version>.json` de la bibliothèque.

**Règles de nommage :** `name` et `version` doivent être des composants de chemin valides (aucuns `/`, `\`, `..`) sinon **400**. Convention utile : `name` = nom de l'outil/librairie, `version` = version du package ou thème du doc (`routing`, `websockets`…).

**Confidentialité :** `rawContent` est nettoyé automatiquement (adresses e-mail, clés API, chemins personnels, téléphones sont retirés) — mais ne mets **jamais** de secret (mot de passe, token réel) dans aucun champ.

### `POST /update` — scan manuel

Force la mise à jour de la bibliothèque (scan des releases des tools référencés + re-index). Répond `{ updated: … }` selon le résultat du cron. Utile si tu viens d'archiver plusieurs docs et veux confirmer la cohérence de l'index (évite le spam : le cron tourne déjà périodiquement).

---

## Workflow recommandé pour l'agent

```
Besoin d'une info technique (config d'outil, prix d'API, changement de version…)
   │
   ├─ 1. POST /search  (local d'abord → web si rien)
   │       └─ doc local trouvé ? → lis-le (GET /doc/:name si besoin) et suis SA doc,
   │          c'est la version validée pour ce contexte.
   │
   └─ 2. Résultat WEB utile ?
           └─► résume-le en DocContent et POST /archive
               (un seul archivage par sujet ; ne t'amuse pas à archiver les
                résultats de recherche bruts sans synthèse utile).
```

**Bonnes pratiques :**

- **Vérifie avant d'archiver** : apprends à `GET /library` au moins une fois par session de travail pour éviter de dupliquer un doc existant (un doublon = une version en concurrence).
- **Différencie les versions** : la doc d'une API version X est archivée à `version: "5.x"`, pas au même slot que la doc version 4 — il est normal que plusieurs versions cohabitent, le GET précise la sienne.
- **Reste factuel** : le libraire est une base de connaissances technique, écris au présent, complet mais concis (voir format `content` ci-dessus). Les champs non-obligatoires peuvent être vides (`[]`), jamais `null`.
- **En cas d'erreur :**
  - `401` `Invalid or missing API key` → ta `X-API-Key` est absente/invalide (ou il te manque le `Bearer` sur les routes `apiAuth`) ;
  - `429` → rate limit atteint, attend (~60 s) ;
  - `502`/erreur 500 au POST `/search` → Webclaw + Tavily tous deux indisponibles : signale-le et abandonne (la recherche web est la seule fonctionnalité impactée).

---

## Limites connues

- L'auth est à **deux couches indépendantes** : l'auth globale (`/api`, Bearer jeton agent) PUIS les routes libraires (X-API-Key) — un jeton agent seul ne franchit pas la deuxième ;
- **Bibliothèque plate `tools/`** : pas de namespace par agent (prochaine évolution : archivage par agent, cf. ROADMAP) ;
- **Pas de scraping en `/search`** : seule `POST /archive` est responsable du contenu persis (le champ `rawContent` que TU écris) — le `/search` web renvoie titre/snipet uniquement.
- **Rate limit global** : 600 req/min/IP (partagé avec tout le reste de l'API ; en cas de 429, espace tes appels d'éventuelles boucles).
- Les clés sont révocables à tout moment par l'utilisateur (DELETE localhost ou UI) : prévois un message d'erreur clair instructif si ton auth est retirée.