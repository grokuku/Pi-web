# API Agent Externe — Spécification v1

**Public visé :** agent externe (OpenClaw, Hermes, script CI…) qui pilote **Pi-Web** via son API REST : gestion de projets, conversations code avec un LLM outillé, lecture des fichiers produits, mémoire durable, recherche technique (libraire).

**Principe :** tu crées ou retrouves un projet, tu lui envoies des prompts via `/chat`, tu récupères les fichiers modifiés et la conversation complète.

> Implémentation : `backend/src/routes/agent.ts` (router), `backend/src/routes/agent-keys.ts` (tokens), `backend/src/middleware/api-auth.ts` (auth globale). Documents sœurs : [librarian-api.md](librarian-api.md) (recherche internet + bibliothèque), [shared-memory-api.md](shared-memory-api.md) (mémoire durable).

---

## 1. Base URL

Selon où tu t'exécutes :

| Situation | Base URL | Auth |
|---|---|---|
| Tu es sur la machine de Pi-Web | `http://127.0.0.1:3000` | **aucune** (localhost = contournement auto) |
| Réseau local (Unraid) | `http://10.10.0.5:3005` | Bearer requis |
| Public (via reverse proxy) | `https://pi.holaf.fr` | Bearer requis |

Ci-dessous, `$BASE` désigne la base URL, `$TOKEN` le jeton agent.

## 2. Obtenir ton jeton

Le jeton n'est **pas auto-attribuable** : il est créé par l'administrateur de Pi-Web (**Settings → API Keys**, section agent), ou par tout appel depuis localhost vers `POST /api/agent-keys`. Demande-le lui, ou fais-toi créer une clé nommée à ton nom (traçabilité).

En-tête à envoyer sur **toutes** les routes sauf `/health` :

```
Authorization: Bearer <jeton>
```

- Un jeton invalide → **403** `Invalid token` ; sans jeton depuis l'extérieur → **401**.
- Santé : `GET /api/agent/health` est exempté d'authentification.

### Endpoints connexes (même jeton)

Le jeton agent ouvre **toute** l'API `/api`, y compris :
- **Libraire** (recherche web + bibliothèque technique) — cf. [`librarian-api.md`](librarian-api.md), section dédiée plus bas ;
- **Mémoire durable** `/api/shared-memory/…` — cf. [`shared-memory-api.md`](shared-memory-api.md).

## 3. Limites à connaître

| Limite | Valeur | Effet en cas de dépassement |
|---|---|---|
| Rate limit global `/api` | **600 requêtes/min par IP** | `429` — attends ~60 s |
| Timeout d'un prompt `/chat` | 600 s max (défaut 300 s) | réponse `status: "timeout"` |
| Uploads d'attachments | 30/min | `429` |

---

## Vue d'ensemble des endpoints

| Méthode | URL | Description |
|---|---|---|
| `GET` | `/api/agent/health` | Santé du serveur (sans auth) |
| `GET` | `/api/agent/projects` | Lister tous les projets |
| `POST` | `/api/agent/projects` | Créer un projet |
| `GET` | `/api/agent/projects/:id` | Détails d'un projet |
| `DELETE` | `/api/agent/projects/:id` | Supprimer un projet |
| `GET` | `/api/agent/models` | Modèles disponibles + capacités |
| `GET` | `/api/agent/projects/:id/mode` | Config mode actuelle |
| `PUT` | `/api/agent/projects/:id/mode` | Définir mode + modèle |
| `POST` | `/api/agent/projects/:id/chat` | Envoyer un prompt → réponse complète |
| `GET` | `/api/agent/projects/:id/chat/status` | Statut traitement en cours |
| `POST` | `/api/agent/projects/:id/chat/abort` | Annuler le traitement |
| `GET` | `/api/agent/projects/:id/context` | Usage contexte (tokens, %) |
| `GET` | `/api/agent/projects/:id/files/changed` | Fichiers modifiés (git diff + untracked, fallback fs) |
| `GET` | `/api/agent/projects/:id/files` | Browse le projet |
| `GET` | `/api/agent/projects/:id/files/read` | Lire un fichier |

---

## 4. Santé

```
GET /api/agent/health
→ { "status": "ok", "version": "0.1.0", "uptime": 12345 }
```

---

## 5. Projets

```
GET /api/agent/projects
→ {
    "projects": [
      { "id": "...", "name": "my-app", "storage": "local",
        "cwd": "/projects/my-app", "createdAt": "...", "lastActiveAt": "..." }
    ]
  }

POST /api/agent/projects
Body: {
  "name": "my-app",             // requis
  "storage": "local",           // "local" | "ssh" | "smb", défaut: "local"
  "cwd": "/projects/my-app"     // auto-généré si absent
}
→ { "id": "...", "name": "my-app", "storage": "local", "cwd": "/projects/my-app", ... }

GET /api/agent/projects/:id
→ { "id": "...", "name": "my-app", "storage": "local", "cwd": "...", "git": {...} }

DELETE /api/agent/projects/:id?deleteFiles=true
→ { "success": true }
```

Le `cwd` est contrôlé côté serveur : il doit rester sous les racines autorisées (défaut : `/projects`, `/mnt/smb`).

---

## 6. Modèles

```
GET /api/agent/models
→ {
    "models": [
      {
        "id": "provider_xxx__kimi-k2_7-code",
        "name": "kimi-k2.7-code",
        "providerId": "provider_xxx",
        "modelId": "kimi-k2.7-code",
        "providerName": "Ollama-Cloud",
        "reasoning": false,
        "vision": true,
        "contextWindow": 262144,
        "maxTokens": 131072
      }
    ],
    "defaultModelId": "provider_xxx__deepseek-v4-flash"
  }
```

- `id` = `providerId__modelId` (format canonique à passer à `/mode`).
- `vision: true` = le modèle accepte des images input. En pratique, Pi-Web route automatiquement : si le modèle courant est vision, les images accompagnent le prompt ; sinon elles sont redirigées vers le modèle *vision* configuré (analyse séparée).

---

## 7. Configuration du mode

Modes v1 disponibles : **`code`** (LLM outillé fichier/terminal) et **`harness`** (orchestrateur multi-agents). Les modes `plan`/`review` de l'UI ne sont pas exposés à l'API agent.

```
GET /api/agent/projects/:id/mode
→ {
    "activeMode": "code",
    "modes": {
      "code": {
        "modelId": "provider_xxx__deepseek-v4-flash",
        "modelName": "deepseek-v4-flash",
        "contextWindow": 1048576,
        "maxTokens": 384000,
        "providerName": "DeepSeek"
      }
    }
  }

PUT /api/agent/projects/:id/mode
Body: {
  "mode": "code",                // "code" | "harness"
  "modelId": "provider_xxx__..." // optionnel; null = modèle par défaut
}
→ { "mode": "code", "modelId": "...", "modelName": "...", "contextWindow": ..., "maxTokens": ... }
```

- `modelId` invalide → **400** `Model not found`. `modelId` absent → le modèle courant est conservé.
- La config est persistée **par projet** : le prochain prompt de ce projet utilisera ce modèle, y compris via l'interface web.

---

## 8. Chat — envoyer un prompt et attendre la réponse

```
POST /api/agent/projects/:id/chat
Body: {
  "message": "Create a Python CLI that reads CSV and outputs JSON",   // requis
  "images": [                    // optionnel — vision
    { "data": "<base64>", "mimeType": "image/png" }
  ],
  "timeout": 300                 // secondes, défaut 300, max 600
}

→ {
    "status": "completed",       // "completed" | "aborted" | "timeout" | "error"
    "messages": [
      {
        "role": "user",
        "content": "Create a Python CLI that reads CSV and outputs JSON"
      },
      {
        "role": "assistant",
        "content": "I'll create a Python CLI for that.\n\nFirst, let me write the main script...",
        "thinking": "The user wants a CLI tool. I need to use argparse, csv module, and json module...",
        "toolCalls": [
          {
            "name": "write",
            "arguments": { "path": "/projects/my-app/cli.py", "content": "..." },
            "output": "File written successfully.",
            "isError": false
          }
        ]
      }
    ],
    "filesChanged": [            // chemin ABSOLUS
      "/projects/my-app/cli.py",
      "/projects/my-app/requirements.txt"
    ],
    "usage": {
      "input": 5000,
      "output": 2000,
      "cost": { "total": 0.01 }
    }
  }
```

**Comportement :**

1. Crée ou reprend la session Pi du projet (la conversation EST persistée : tu peux enchaîner des prompts, le contexte s'accumule).
2. Applique le modèle configuré en mode `code` (cf. `/mode`).
3. Snapshot des fichiers avant le prompt : git (`diff --name-only` + `ls-files --others`) si dépôt, sinon mtime `fs`.
4. Envoie le prompt et attend la fin (événement agent) — timeout max **600 s**.
5. Compare les snapshots → `filesChanged` (chemins absolus).
6. Renvoie la conversation complète : texte, **thinking** (si modèle raisonneur), appels d'outils avec sortie, usage (tokens/coût).

**Images :** base64, 20 Mo max de payload par image ; fournir le modèle courant avec vision (sinon description via le modèle vision configuré).

### Statut et annulation

```
GET /api/agent/projects/:id/chat/status
→ {
    "running": true,             // true si un prompt est en cours
    "currentTool": "write",      // outil en cours d'exécution ou null
    "tokensUsed": 3500           // approximation (somme des inputs)
  }

POST /api/agent/projects/:id/chat/abort
→ { "success": true }
```

---

## 9. Contexte

```
GET /api/agent/projects/:id/context
→ {
    "projectId": "project_xxx",
    "activeMode": "code",
    "model": {
      "id": "provider_xxx__deepseek-v4-flash",
      "name": "deepseek-v4-flash",
      "contextWindow": 1048576,
      "maxTokens": 384000
    },
    "contextUsed": 45000,
    "contextPercent": 4,
    "sessionId": "session_xxx",
    "sessionRunning": false
  }
```

- `contextUsed` : tokens actuels de la session (entrée + sortie cumulés).
- `contextPercent` : % de la fenêtre du modèle utilisée. Au-delà de ~80 %, la qualité baisse — envisage de démarrer une conversation neuve (`POST /projects` crée une nouvelle session) ou de compacter.

---

## 10. Fichiers

```
GET /api/agent/projects/:id/files/changed
Query: ?since=2026-05-23T10:00:00Z        // optionnel (filtre les fichiers plus récents)
→ {
    "files": [
      { "path": "src/App.tsx", "status": "M" },   // chemins RELATIFS au cwd, statuts git M/A/D
      { "path": "src/index.ts", "status": "A" },
      { "path": "old/deprecated.ts", "status": "D" }
    ]
  }

GET /api/agent/projects/:id/files
Query: ?path=/projects/my-app/src
→ {
    "path": "/projects/my-app/src",
    "entries": [
      { "name": "App.tsx", "type": "file", "size": 2048 },
      { "name": "components", "type": "dir", "size": 0 }
    ]
  }

GET /api/agent/projects/:id/files/read
Query: ?path=/projects/my-app/src/App.tsx
→ { "path": "/projects/my-app/src/App.tsx", "content": "import...", "size": 2048 }
```

**Note :** `files/changed` combine, quand le projet a un dépôt git, `git diff --name-status` (fichiers suivis) et `git ls-files --others --exclude-standard` (fichiers non suivis, statut `A`). Sans git, fallback implémenté : snapshot `fs` (chemin → mtime) comparé au timestamp `since` (ou statut `A` pour tous si `since` absent).

---

## 11. Libraire — recherche internet et bibliothèque partagée

L'API du **Libraire** est la porte d'accès aux **recherches web** et à la bibliothèque technique partagée (musé des docs archivées par les agents et Pi-Web). Résumé rapide — spec complète : [`librarian-api.md`](librarian-api.md).

| Méthode | URL | Description |
|---|---|---|
| `POST` | `/api/librarian/search` | `{ "query": "… " }` → recherche **bibliothèque locale d'abord, web ensuite** (Webclaw, fallback Tavily) |
| `GET` | `/api/librarian/library` | Inventaire complet de la bibliothèque |
| `GET` | `/api/librarian/doc/:name?version=x` | Contenu d'un doc archivé |
| `POST` | `/api/librarian/archive` | **Archiver ta découverte** (partagée avec tous) |
| `GET` | `/api/librarian/status` | Santé / nombre de docs |

Auth équivalente à l'agent : **Bearer suffit** (l'auth librariaire accepte localhost, et `X-API-Key: lib-…` sinon — avec un jeton agent, le Bearer franchit les deux couches).

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST -d '{"query":"comment configurer WebSocket en Node"}' \
  $BASE/api/librarian/search
```

Archiver une découverte (la met à disposition de tous les agents et du chat Pi-Web) :

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST -d '{
    "name": "express", "version": "routing",
    "sourceUrl": "https://expressjs.com/en/guide/routing.html",
    "content": {
      "summary": "… 2-3 phrases avec le chemin type…",
      "keyPoints": ["…", "…"],
      "api": [{ "signature": "app.METHOD(path, handler)", "description": "…" }],
      "examples": [{ "title": "Route basique", "code": "app.get('/', (req,res)=>res.send('ok'));" }]
    }
  }' $BASE/api/librarian/archive
```

**Règles :** `name`/`version` sans `/`, `\`, `..` ; jamais de secrets dans le contenu (un nettoyage automatique retire emails/clés/chemins personnels du `rawContent`, mais ne compte pas dessus pour des secrets) ; consulte `GET /library` avant d'archiver pour éviter les doublons.

---

## 12. Mémoire durable

Les agents peuvent lire/écrire la mémoire durable de Pi-Web (préférences, décisions, patterns) via `/api/shared-memory` — ton jeton Bearer suffit :

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -X PUT -H "Content-Type: application/json" \
  -d '{"title":"Build avec pnpm","content":"Installs monorepo = pnpm.","type":"decision"}' \
  $BASE/api/shared-memory/memories
```

→ Spécification complète : **[shared-memory-api.md](shared-memory-api.md)** (endpoints, namespace `public` v1, tagging `external:<keyName>` des écritures externes).

---

## Extension future (plan / review / harness dans /chat)

Dans une version ultérieure, l'endpoint chat acceptera un champ `mode` pour activer d'autres modes que `code` en un seul appel :

```json
POST /api/agent/projects/:id/chat
{
  "message": "Analyze the architecture of this project",
  "mode": "plan",
  "modelId": "provider_xxx__claude-sonnet-4"
}
```

D'ici là, configure le modèle via `PUT /projects/:id/mode` avant le prompt (le mode y est déjà pris en compte côté chat : c'est la config `code` du projet qui est appliquée).

---

## Exemple d'utilisation complet

```python
import requests

BASE = "http://127.0.0.1:3000/api/agent"   # ou https://pi.holaf.fr/api/agent (Bearer requis)
TOKEN = "ton-jeton-agent"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# 1. Vérifier que le serveur est up
assert requests.get(f"{BASE}/health").json()["status"] == "ok"

# 2. Créer un projet
p = requests.post(f"{BASE}/projects", json={"name": "my-cli-app"}, headers=HEADERS).json()
project_id = p["id"]

# 3. Choisir un bon modèle (vision + grand contexte)
models = requests.get(f"{BASE}/models", headers=HEADERS).json()["models"]
best = [m for m in models if m["vision"] and m["contextWindow"] >= 256000][0]
requests.put(f"{BASE}/projects/{project_id}/mode",
             json={"mode": "code", "modelId": best["id"]}, headers=HEADERS)

# 4. Envoyer le prompt et attendre la réponse
r = requests.post(f"{BASE}/projects/{project_id}/chat",
                  json={"message": "Create a Python CLI that reads CSV and outputs JSON",
                        "timeout": 300},
                  headers=HEADERS).json()

print(f"Status: {r['status']}")
print(f"Files changed: {r['filesChanged']}")
print(f"Tokens: {r['usage']['input']} in / {r['usage']['output']} out")

# 5. Récupérer les fichiers produits (filesChanged = chemins absolus)
for abs_path in r["filesChanged"]:
    file = requests.get(f"{BASE}/projects/{project_id}/files/read",
                        params={"path": abs_path}, headers=HEADERS).json()
    with open(file["path"], "w") as f:
        f.write(file["content"])
    print(f"Saved: {abs_path} ({file['size']} bytes)")

# 6. Faire une recherche internet (libraire, cf. section 11)
API_BASE = BASE.replace("/api/agent", "")    # racine : http://…:3000 ou https://pi.holaf.fr
s = requests.post(f"{API_BASE}/api/librarian/search",
                  headers=HEADERS, json={"query": "best practices argparse"}).json()

# 7. Itérer : demander une amélioration
r2 = requests.post(f"{BASE}/projects/{project_id}/chat",
                   json={"message": "Add error handling for malformed CSV and a --pretty flag"},
                   headers=HEADERS).json()

# 8. Vérifier le contexte
ctx = requests.get(f"{BASE}/projects/{project_id}/context", headers=HEADERS).json()
print(f"Context: {ctx['contextUsed']} / {ctx['model']['contextWindow']} ({ctx['contextPercent']}%)")
```

---

## Erreurs typiques et réponses

| Code | Signification | Réaction |
|---|---|---|
| `401` `Authentication required...` | Jeton absent (ou localhost non respecté) | Vérifie l'en-tête `Authorization: Bearer` |
| `403` `Invalid token` | Jeton inconnu/révoqué | Demande un nouveau jeton |
| `429` `Too many requests` | Rate limit (600/min/IP) | Attends ~60 s, espace tes appels |
| `400` `message (string) is required` | Corps JSON malformé | Vérifie le body |
| `404` `Project not found` | Identifiant projet invalide | Liste via `GET /projects` |
| `500` `status: "error"` | Erreur côté session LLM | Relis `error` ; réessaie sans `images` si souci de vision |

---

## Implémentation

| Composant | Emplacement |
|---|---|
| Route API | `backend/src/routes/agent.ts` |
| Tokens agent | `backend/src/routes/agent-keys.ts` (UI : Settings → API Keys) |
| Auth globale | `backend/src/middleware/api-auth.ts` (Bearer → localhost → navigateur same-origin) |
| Orchestrateur chat | Réutilise `createPiSession()` + `sendPrompt()` |
| Détection fichiers modifiés | snapshot git (diff + untracked) avant/après prompt, fallback fs (mtime) |
| Configuration token | `agent-keys.json`, UI dans Settings → API Keys |
| Tests | `backend/src/__tests__/agent.test.ts` |