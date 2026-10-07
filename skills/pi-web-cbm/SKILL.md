---
name: pi-web-cbm
description: "Complément à la skill codebase-memory : pièges vérifiés du graphe CBM (codebase-memory-mcp), valables quel que soit le projet indexé. À lire quand un résultat du graphe semble faux ou vide (requête Cypher sans lignes, coalesce), quand on investigue un projet LIÉ (workspace de symlinks, fusion multi-projets, paramètre target), avant toute indexation cross-repo, ou quand le registre des projets est vide. Déclencheurs : résultat CBM inattendu, requête qui renvoie 0 ligne, coalesce, projet lié, sous-projet, target, cross-repo-intelligence, indexer un dépôt, CBM_CACHE_DIR, daemon CBM indisponible."
---

# CBM — pièges vérifiés du graphe

Usage général du graphe (workflows, outils, tiers de preuve, exemples Cypher) :
lire la skill `codebase-memory`. ⚠️ Cette fiche-là est **générée par l'outil CBM** :
ne pas l'éditer (écrasée à la prochaine mise à jour) — les règles maison vivent ici.

Cette fiche ne suppose aucun projet particulier : les pièges ci-dessous sont
propres à l'outil CBM et s'appliquent quel que soit le dépôt indexé. Les outils
exposés par l'intégration Pi-Web (extension `extensions/codebase-memory`)
s'appellent `cbm_search`, `cbm_trace`, `cbm_code`, `cbm_search_code`, `cbm_diff`,
`cbm_arch`, `cbm_cypher`, `cbm_schema` ; le binaire MCP s'installe selon
l'environnement (répertoire et mécanisme variables — ne jamais supposer un
chemin précis).

## Pièges vérifiés
1. **`coalesce()` dans un motif joint.** Avec `(a)-[r]->(b)`, un WHERE qui applique
   `coalesce()` **des deux côtés** renvoie 0 ligne silencieusement
   (`WHERE coalesce(a.file_path,'')<>'' AND coalesce(b.file_path,'')<>''` → 0,
   alors que `a.file_path<>'' AND b.file_path<>''` → des milliers).
   → Utiliser les colonnes directement dans ces WHERE.
2. **Un workspace lié est multi-projets.** Les outils CBM interrogent tous les
   sous-projets indexés et fusionnent les résultats sous des en-têtes
   `## [sous-projet]` ; `target` (nom de dossier d'un sous-projet indexé)
   restreint à un seul. Toujours regarder la provenance d'un résultat avant de
   conclure.
3. **CBM n'indexe pas les symlinks.** Indexer la **racine réelle** de chaque
   dépôt, jamais le dossier de symlinks d'un workspace lié (graphe vide sinon).
4. **`cross-repo-intelligence` ÉCRIT dans les bases cibles** : il ajoute des
   arêtes `CROSS_HTTP_CALLS` y compris dans les bases de production, et
   `delete_project` ne les supprime pas. Ne jamais l'utiliser sans isolation.
5. **`CBM_CACHE_DIR` est refusé tant que le daemon tourne** (« active account
   daemon uses a different cache directory ») : fermer toutes les sessions CBM
   avant de tenter un store isolé.
6. **Registre vide = réessayer.** Le daemon CBM redémarre parfois : si un appel
   échoue avec un registre vide / un projet introuvable, relancer l'appel avant
   de conclure « projet non indexé ».

## Fraîcheur
Un index peut être ancien ou incomplet : une **absence** dans le graphe n'est une
preuve que si l'index est frais. Sinon, vérifier dans les fichiers avant d'affirmer.
