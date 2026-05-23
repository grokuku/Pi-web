# API Agent Externe — Spécification v1

**Principe :** un agent externe (OpenClaw, Hermes…) pilote Pi-Web via une API REST dédiée, authentifiée par token. L'agent crée un projet, envoie des prompts en mode `code`, et récupère les fichiers modifiés.

---

## Authentification

```
Authorization: Bearer <pi-web-agent-token>
```

Le token est configuré dans **Settings → General**, stocké côté backend dans `agent-config.json`.

---

## Vue d'ensemble des endpoints

| Méthode | URL | Description |
|---|---|---|
| `GET` | `/api/agent/health` | Santé du serveur |
| `GET` | `/api/agent/projects` | Lister tous les projets |
| `POST` | `/api/agent/projects` | Créer un projet |
| `GET` | `/api/agent/projects/:id` | Détails d'un projet |
| `DELETE` | `/api/agent/projects/:id` | Supprimer un projet |
| `GET` | `/api/agent/models` | Modèles disponibles + capacités |
| `PUT` | `/api/agent/projects/:id/mode` | Définir mode + modèle |
| `GET` | `/api/agent/projects/:id/mode` | Lire config mode actuelle |
| `POST` | `/api/agent/projects/:id/chat` | Envoyer un prompt → réponse complète |
| `GET` | `/api/agent/projects/:id/chat/status` | Statut traitement en cours |
| `POST` | `/api/agent/projects/:id/chat/abort` | Annuler le traitement |
| `GET` | `/api/agent/projects/:id/context` | Usage contexte (tokens, %) |
| `GET` | `/api/agent/projects/:id/files/changed` | Fichiers modifiés (git diff) |
| `GET` | `/api/agent/projects/:id/files` | Browse le projet |
| `GET` | `/api/agent/projects/:id/files/read` | Lire un fichier |

---

## 1. Santé

```
GET /api/agent/health
→ { "status": "ok", "version": "0.1.0", "uptime": 12345 }
```

Pas d'authentification requise pour le health check.

---

## 2. Projets

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

---

## 3. Modèles

```
GET /api/agent/models
→ {
    "models": [
      {
        "id": "provider_xxx__gemma4:31b",
        "name": "gemma4:31b",
        "providerId": "provider_xxx",
        "modelId": "gemma4:31b",
        "providerName": "Ollama-Cloud",
        "reasoning": false,
        "vision": true,
        "contextWindow": 262144,
        "maxTokens": 16384
      },
      ...
    ],
    "defaultModelId": "provider_xxx__gemma4:31b"
  }
```

---

## 4. Configuration du mode

```
GET /api/agent/projects/:id/mode
→ {
    "activeMode": "code",
    "modes": {
      "code":   { "modelId": "provider_xxx__gemma4:31b", "modelName": "gemma4:31b" },
      "plan":   { "modelId": null, "enabled": false },
      "review": { "modelId": null, "enabled": false, "maxReviews": 1 },
      "yolo":   { "modelId": null, "enabled": false,
                  "config": { "model1": null, "model2": null,
                              "planCycles": 2, "codeCycles": 2, "globalCycles": 1 } }
    }
  }

PUT /api/agent/projects/:id/mode
Body: {
  "mode": "code",               // v1: uniquement "code"
  "modelId": "provider_xxx__..." // null = utiliser le modèle par défaut
}
→ { "mode": "code", "modelId": "provider_xxx__...", "modelName": "gemma4:31b", "contextWindow": 262144 }
```

---

## 5. Chat — envoyer un prompt et attendre la réponse

```
POST /api/agent/projects/:id/chat
Body: {
  "message": "Create a Python CLI that reads CSV and outputs JSON",
  "images": [                    // optionnel
    { "data": "<base64>", "mimeType": "image/png" }
  ],
  "timeout": 300                 // secondes, défaut: 300
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
    "filesChanged": [
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

### Statut et annulation

```
GET /api/agent/projects/:id/chat/status
→ {
    "running": true,
    "currentTool": "write",
    "tokensUsed": 3500
  }

POST /api/agent/projects/:id/chat/abort
→ { "success": true }
```

### Fonctionnement interne

1. Crée ou reprend la session Pi pour le projet (`createPiSession`)
2. Applique le mode et le modèle configurés (`applyModeToSession`)
3. Envoie le prompt (`sendPrompt`) et s'abonne aux événements de session
4. Attend l'événement `agent_end` (ou timeout, ou abort)
5. Détecte les fichiers modifiés via `git diff --name-only` (snapshot du cwd avant/après)
6. Sans git : compare les timestamps des fichiers dans le cwd
7. Retourne la conversation complète + métadonnées

---

## 6. Contexte

```
GET /api/agent/projects/:id/context
→ {
    "projectId": "project_xxx",
    "activeMode": "code",
    "model": {
      "id": "provider_xxx__gemma4:31b",
      "name": "gemma4:31b",
      "contextWindow": 262144,
      "maxTokens": 16384
    },
    "contextUsed": 45000,
    "contextPercent": 17,
    "sessionId": "session_xxx",
    "sessionRunning": false
  }
```

- `contextUsed` : nombre de tokens actuellement dans la session (entrée + sortie cumulés)
- `contextPercent` : pourcentage de la fenêtre du modèle utilisée
- `sessionRunning` : `true` si un prompt est en cours de traitement

---

## 7. Fichiers

```
GET /api/agent/projects/:id/files/changed
Query: ?since=2026-05-23T10:00:00Z
→ {
    "files": [
      { "path": "src/App.tsx", "status": "M" },
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

**Note :** `files/changed` utilise `git diff --name-status` si le projet a un dépôt git. Sans git, fallback sur `stat` des fichiers vs le timestamp `since`.

---

## Extension future (plan / review / yolo)

Dans une version ultérieure, l'endpoint chat acceptera un champ `mode` pour activer d'autres modes que `code` :

```json
POST /api/agent/projects/:id/chat
{
  "message": "Analyze the architecture of this project",
  "mode": "plan",
  "modelId": "provider_xxx__claude-sonnet-4"
}
```

Le backend appliquera `switchMode()` avant d'envoyer le prompt, ce qui activera/désactivera les outils appropriés (ex: pas d'outils d'édition en mode `plan`).

---

## Exemple d'utilisation complet

```python
import requests

BASE = "http://localhost:3005/api/agent"
TOKEN = "pi-web-agent-token"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# 1. Vérifier que le serveur est up
assert requests.get(f"{BASE}/health").json()["status"] == "ok"

# 2. Créer un projet
p = requests.post(f"{BASE}/projects", json={"name": "my-cli-app"}, headers=HEADERS).json()
project_id = p["id"]

# 3. Choisir le meilleur modèle (vision + grand contexte)
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

# 5. Récupérer les fichiers produits
for path in r["filesChanged"]:
    file = requests.get(f"{BASE}/projects/{project_id}/files/read",
                        params={"path": f"/projects/my-cli-app/{path}"},
                        headers=HEADERS).json()
    with open(path, "w") as f:
        f.write(file["content"])
    print(f"Saved: {path} ({file['size']} bytes)")

# 6. Itérer : demander une amélioration
r2 = requests.post(f"{BASE}/projects/{project_id}/chat",
                   json={"message": "Add error handling for malformed CSV and a --pretty flag"},
                   headers=HEADERS).json()

# 7. Vérifier le contexte
ctx = requests.get(f"{BASE}/projects/{project_id}/context", headers=HEADERS).json()
print(f"Context: {ctx['contextUsed']} / {ctx['model']['contextWindow']} ({ctx['contextPercent']}%)")
```

---

## Implémentation

| Composant | Emplacement |
|---|---|
| Route API | `backend/src/routes/agent.ts` |
| Auth middleware | `backend/src/middleware/agent-auth.ts` |
| Orchestrateur chat | Réutilise `createPiSession()` + `sendPrompt()` |
| Détection fichiers modifiés | `git diff --name-only` snapshot avant/après prompt |
| Configuration token | `agent-config.json`, UI dans Settings → General |
| Tests | `backend/src/__tests__/agent.test.ts` |
