# Services Partagés — Documentation pour Agents

> Ce document décrit les services exposés par Pi-Web accessibles aux agents externes.

## Généralités

### Principe
- Pi-Web expose des services via API REST
- Chaque service nécessite une clé API (header `X-API-Key`)
- Les appels internes (localhost) n'ont pas besoin de clé
- Base URL : `http://pi-web:3000/api` (Docker) ou `http://<ip>:3000/api` (externe)

### Obtenir une clé API
Demander à l'administrateur de créer une clé dans :
Pi-Web → Settings → Analysis → Librarian API Keys → "+ Generate"

Format de clé : `lib-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### Format général des réponses
- Succès : JSON avec les données
- Erreur : `{ "error": "message" }` avec code HTTP approprié
- 401 : Clé API manquante ou invalide

---

## Service : Libraire

### Description
Le libraire est un service de recherche et de documentation technique. Il permet de :
1. Rechercher des informations techniques sur le web
2. Stocker et restituer de la documentation

Le contenu est automatiquement nettoyé (aucune info personnelle n'est stockée).

### Endpoints

#### Santé du service
`GET /librarian/status`
- Pas d'auth requise
- Réponse : `{ "docs": 42, "lastUpdate": "2026-07-15T...", "lastScan": "..." }`

#### Rechercher
`POST /librarian/search`
- Auth : `X-API-Key` requis
- Body : `{ "query": "Express 4.21 API", "num": 5 }`
- Recherche d'abord dans la bibliothèque locale, puis sur le web
- Réponse :
```json
{
  "results": [
    {
      "title": "Express 4.x API",
      "url": "https://expressjs.com/en/4x/api.html",
      "snippet": "Express is a minimal web framework...",
      "content": "Full content (max 5000 chars)..."
    }
  ],
  "source": "local|web"
}
```

#### Lister la bibliothèque
`GET /librarian/library`
- Auth : `X-API-Key` requis
- Réponse : `{ "lastUpdated": "...", "lastScan": "...", "library": [{ "name": "express", "version": "4.21", ... }] }`

#### Récupérer une doc archivée
`GET /librarian/doc/:name`
- Auth : `X-API-Key` requis
- Paramètre : nom de la doc (ex: `express@4.21` ou `express`)
- Réponse :
```json
{
  "meta": { "name": "express", "version": "4.21", "sourceUrl": "...", "updatedAt": "..." },
  "summary": "Express is a minimal web framework for Node.js",
  "keyPoints": ["Point 1", "Point 2"],
  "api": [{ "signature": "app.use(path, callback)", "description": "Mount middleware" }],
  "examples": [{ "title": "Basic server", "code": "..." }]
}
```

#### Archiver une URL
`POST /librarian/archive`
- Auth : `X-API-Key` requis
- Body : `{ "url": "https://expressjs.com/en/4x/api.html", "name": "express", "version": "4.21" }`
- Scrape l'URL, nettoie le contenu, archive dans la bibliothèque
- Réponse : `{ "saved": true, "doc": { ... } }`

#### Déclencher une mise à jour
`POST /librarian/update`
- Auth : `X-API-Key` requis
- Déclenche manuellement la mise à jour de la bibliothèque (cron)
- Réponse : `{ "started": true }`

### Exemples d'utilisation

#### curl
```bash
curl -X POST http://pi-web:3000/api/librarian/search \
  -H "X-API-Key: lib-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"query": "React 19 useEffect", "num": 5}'
```

#### Python
```python
import requests
res = requests.post(
    "http://pi-web:3000/api/librarian/search",
    headers={"X-API-Key": "lib-xxxx"},
    json={"query": "React 19 useEffect", "num": 5}
)
print(res.json())
```

#### JavaScript
```javascript
const res = await fetch("http://pi-web:3000/api/librarian/search", {
  method: "POST",
  headers: {
    "X-API-Key": "lib-xxxx",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: "React 19 useEffect", num: 5 }),
});
const data = await res.json();
```

### Notes importantes
- Le contenu est automatiquement nettoyé (emails, clés API, chemins personnels supprimés)
- La recherche locale est instantanée (pas d'appel réseau)
- La recherche web peut prendre 3-10 secondes
- Maximum 5 résultats par recherche
- Le contenu scrapé est limité à 5000 caractères par résultat

---

<!-- Futurs services ajoutés ici -->

## Service : [À venir]
- Mémoire partagée (avec namespaces public/agent/private)
- ...