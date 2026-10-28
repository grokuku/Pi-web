# MCP dans Pi-Web — branchement, configuration, limites

**État :** le support MCP **du SDK** est branché dans Pi-Web (aucun serveur
déclaré pour l'instant). Pi-Web n'a **pas** d'écran d'édition MCP : la config
est un **fichier du SDK**, l'UI n'en affiche que l'**état en lecture seule**.

## Où se trouve la configuration

| Fichier | Portée | Lu par Pi-Web ? |
|---|---|---|
| `/root/.pi/agent/mcp.json` (`~/.pi/agent/mcp.json`) | **utilisateur** — **à privilégier** | ✅ **toujours** |
| `<projet>/.pi/mcp.json` | projet | ⚠️ **aussi** (voir « Project trust » ci-dessous) |

`/root/.pi` est un volume persistant : le fichier survit aux rebuilds.
Format (identique aux autres clients MCP) :

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "exposure": "direct"
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

Règles utiles (doc SDK `docs/mcp.md`) : `command` = **un** exécutable (pas une
chaîne shell) ; HTTP = `url` ; SSE refusé ; `${VAR}` et `!commande` acceptés dans
`env`/`headers` ; `enabled: false` garde l'entrée sans connecter ; `timeout` en
secondes (défaut 60). Outils exposés sous `mcp__<serveur>__<outil>`.

## Point à connaître : l'exposition des outils

Par défaut, un serveur MCP est en `"exposure": "codemode"` : ses outils ne sont
**pas** déclarés au modèle, ils ne seraient accessibles que depuis l'outil
`codemode`. **Pi-Web ne charge pas les extensions `codemode` ni `tool_search`**
(ce sont des « built-in extensions » du CLI, absentes des sessions SDK). Un
serveur MCP ajouté avec l'exposition par défaut **se connecte** mais ses outils
**ne sont pas appelables** par le modèle (le SDK le signale dans les logs).

👉 Pour un serveur réellement utilisable dans Pi-Web : `"exposure": "direct"`.

## Project trust — ce qui se passe réellement

Le SDK ne lit `.pi/mcp.json` que si le projet est « trusted ». Pi-Web crée son
`SettingsManager` **sans** option `projectTrusted`, et le SDK vaut `true` par
défaut (`dist/core/settings-manager.js`, `options.projectTrusted ?? true`) : il
n'y a **aucun écran d'approbation**, donc **tout `mcp.json` d'un projet est lu
comme un projet approuvé** — un serveur `stdio` déclaré dans un dépôt cloné
serait **exécuté**.

Conséquence pratique : **ne déclarer les serveurs qu'au niveau utilisateur**
(`~/.pi/agent/mcp.json`). Le fichier projet n'est utile que pour *désactiver*
(`{"enabled": false}`) un serveur utilisateur dans un projet donné.

## Journalisation (pas d'échec silencieux)

- Échec de connexion, config invalide, sign-in requise → le SDK les remonte via
  `ctx.ui.notify` ; Pi-Web fournit un contexte UI « log seulement » qui les
  écrit dans les logs backend (`docker logs` + `.data/logs/backend-*.log`) sous
  la forme `[PiSession][ui-notify] MCP servers need attention: <serveur>: failed: …`.
- Une exception dans un handler d'extension (dont `session_start`) → journalisée
  par `[PiSession] Extension error (<extension> — <événement>) : …`.
- Messages envoyés par un serveur (`notifications/message`) → `~/.pi/agent/mcp.log`.

## Branchement côté code

- `backend/src/pi/extension-bindings.ts` — `createPiWebExtensionFactories()`
  (prompt Pi-Web + `createMcpExtension()`), `bindPiWebExtensions()` (émet
  `session_start`, seul point de connexion des serveurs MCP), contexte UI log-only.
- `backend/src/pi/session.ts` — factories passées au `DefaultResourceLoader`,
  `bindPiWebExtensions(session, projectId)` juste après `createAgentSession`.
- `backend/src/pi/mcp-config.ts` — lecture **seule** de `mcp.json` pour l'état
  affiché (Réglages → Extensions, `GET /api/pi/available` → `mcp`).
