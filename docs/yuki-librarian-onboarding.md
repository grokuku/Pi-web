# Brancher Yuki sur le Libraire de Pi-Web — procédure d'intégration

**Public :** Yuki (agent externe de l'écosystème holaf, remplaçant d'OpenClaw —
décision D121) et l'administrateur qui lui fournit ses accès.

**Référence complète de l'API :** [`docs/librarian-api.md`](librarian-api.md).
Ce document ne la remplace pas : il ne décrit que le branchement de Yuki, dans
l'ordre où le faire. Chaîne d'authentification : voir aussi
[`docs/agent-api.md`](agent-api.md).

---

## 1. Obtenir les deux identifiants (administrateur, dans Pi-Web)

Interface Pi-Web → **Settings → API Keys** :

| Identifiant | Format | Section de l'UI |
| --- | --- | --- |
| Jeton agent | `pia_…` | « API Keys » — créer une clé nommée `Yuki` |
| Clé libraire | `lib-…` | « Librarian API keys » — bouton de création |

⚠️ Chaque secret n'est affiché qu'**une seule fois** à la création : le copier
immédiatement. Les clés sont révocables à tout moment depuis la même page.

> État au 2026-10-09 : il existe déjà une clé agent nommée « Yuki »
> (fonctionnelle, dernière utilisation vérifiée par test réel). La réutiliser
> si son secret est connu ; sinon créer une nouvelle clé et révoquer l'ancienne.

## 2. Les transmettre à Yuki (config, jamais dans un dépôt)

Deux valeurs à placer dans la configuration de Yuki — variables
d'environnement ou fichier de secrets local :

```
PIWEB_AGENT_TOKEN=pia_…
PIWEB_LIBRARIAN_KEY=lib-…
```

Les noms de variables sont indicatifs : aucune variable de ce type n'existe
encore côté Yuki, c'est à lui (ou à l'administrateur) de les câbler.

## 3. URL de base selon l'emplacement de Yuki

| Situation | URL |
| --- | --- |
| Yuki et Pi-Web sur le même réseau Docker | `http://pi-web:3000` |
| Même machine, port publié par le compose | `http://<ip-de-l-hôte>:3005` |
| Accès via reverse proxy (déploiement public) | `https://pi.holaf.fr` |

## 4. Les appels, dans l'ordre — usage typique

Toujours envoyer **les deux en-têtes** sur les routes protégées (envoyer le
jeton en trop ne gêne jamais ; l'omettre casse dès que les origines autorisées
sont restreintes) :

```
Authorization: Bearer <pia_…>
X-API-Key: <lib-…>
```

1. **Santé** — `GET {BASE}/api/librarian/status`
   → `{ totalDocs, lastUpdated, lastScan }`. Seul le Bearer est requis pour
   cette route (health check).
2. **Chercher** — `POST {BASE}/api/librarian/search` avec
   `{"query": "ta question technique"}` → la bibliothèque locale répond en
   priorité (instantané), sinon recherche web (quelques secondes). ⚠️ Seul
   `query` est lu — ne pas envoyer `num`. La recherche **n'archive jamais**.
3. **Vérifier avant d'archiver** — `GET {BASE}/api/librarian/library` (liste
   des docs) ou `GET {BASE}/api/librarian/doc/:name?version=x` pour un doc
   précis. Éviter de créer un doublon.
4. **Archiver une découverte** — `POST {BASE}/api/librarian/archive` avec
   `{ name, version, type?, sourceUrl?, content: { summary, keyPoints, api, examples } }`.
   Le serveur **ne scrape pas** d'URL : c'est Yuki qui fournit la synthèse.
   Ne jamais mettre de secret dans un champ.
5. **Relire** — `GET {BASE}/api/librarian/doc/:name?version=x` → 404 si absent.

## 5. Erreurs courantes

| Code | Cause probable | Geste |
| --- | --- | --- |
| `401 Invalid or missing API key` | clé `lib-…` absente ou invalide | vérifier la clé libraire (et le Bearer si les origines sont restreintes) |
| `403 Invalid token` | jeton `pia_…` invalide ou révoqué | vérifier/recréer le jeton agent |
| `404 Doc not found` | doc jamais archivé ou version différente | `GET /library` pour trouver le bon couple nom/version |
| `400` au `POST /archive` | `name`/`version` invalides (pas de `/`, `\`, `..`) ou `content` manquant | corriger le corps |
| `429` | limite globale 600 req/min par IP | espacer les appels |

## 6. Ce qui n'est PAS nécessaire

- **Aucun serveur MCP à déclarer** pour cet accès : le libraire s'utilise en
  **REST direct** (choix assumé de Pi-Web, cf. `ROADMAP.md` « REST API (pas MCP) »).
- Aucune modification côté Pi-Web : les clés se créent dans l'UI.
- Aucun scraping côté Yuki pour `POST /archive` : Yuki envoie la synthèse.
