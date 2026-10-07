# Skills maison : ce qui est livré avec Pi-Web, ce qui vient de l'écosystème

**Principe :** Pi-Web embarque ses propres **skills** (au sens du standard ouvert
« Agent Skills » du SDK Pi : un dossier + une fiche `SKILL.md`). Elles vivent
**dans le dépôt**, sont **versionnées avec le code**, et sont **installées
automatiquement au démarrage** dans le dossier de skills de l'agent — mais
**seulement si elles n'y sont pas déjà**. Une installation neuve de Pi-Web
dispose donc de ses skills sans aucune manipulation, et l'utilisateur reste
libre de modifier sa copie locale : elle ne sera **jamais écrasée**.

## Portable / non portable — à comprendre avant tout

Toutes les skills ne se valent pas : certaines ne décrivent que Pi-Web, d'autres
décrivent un **écosystème** qui n'est pas forcément installé sur la machine.

| Catégorie | Fiches | Où elles vivent | Livrées avec Pi-Web ? |
|---|---|---|---|
| **Portables** — ne référencent que le dépôt Pi-Web lui-même (chemins internes) ou des notions génériques de l'outil CBM | `pi-web-ui`, `pi-web-cbm` | `skills/` du dépôt Pi-Web | ✅ semées au démarrage dans `~/.pi/agent/skills/` si absentes |
| **Écosystème holaf** — ne s'appliquent que si la bibliothèque `holaf-lib` est présente sur la machine | `holaf-conventions`, `holaf-briques` | `/projects/holaf-lib/skills/` (dépôt de la bibliothèque) | ❌ jamais semées par Pi-Web |

**Pourquoi cette séparation :** une installation neuve de Pi-Web (autre
machine, autre dossier) ne connaît pas `/projects/holaf-lib`. Des fiches qui
pointeraient vers ce dossier seraient **trompeuses** — elles enverraient l'agent
vers des chemins qui n'existent pas. Les fiches de l'écosystème restent donc
avec la bibliothèque dont elles dépendent (leur source de vérité), et les fiches
livrées n'utilisent que des chemins internes à Pi-Web.

Les deux fiches d'écosystème commencent explicitement par une note « Portée » :
*elles ne s'appliquent que si `holaf-lib` est présent sur la machine ; sinon,
les ignorer* (adaptation possible si la lib est installée ailleurs).

## Les skills livrées avec Pi-Web

| Skill | Objet |
|---|---|
| `pi-web-ui` | Conventions d'interface de Pi-Web : thème (briques `tokens` vendorisées), icônes via `HolafIcon`, règle du repli des blocs de détail. |
| `pi-web-cbm` | Pièges vérifiés du graphe CBM (coalesce, symlinks, workspaces liés, cross-repo-intelligence, daemon indisponible…) — complément de la skill `codebase-memory`. |

⚠️ La skill `codebase-memory` **n'est pas livrée par Pi-Web** : elle est générée
par le binaire CBM (`codebase-memory-mcp`) à chaque installation/mise à jour.
Ne pas l'éditer à la main et ne pas l'inclure dans `skills/` (elle serait écrasée
et entrerait en conflit avec l'originale).

## Où elles vivent, où elles s'installent

| | Emplacement | Rôle |
|---|---|---|
| **Version livrée** | `<racine du dépôt>/skills/<nom>/SKILL.md` | Référence versionnée avec le code ; source du seed. |
| **Copie installée** | `~/.pi/agent/skills/<nom>/SKILL.md` | Dossier global des skills de l'agent Pi (`agentDir` du SDK), scanné par le SDK et affiché dans l'UI Paramètres → « Extensions & Skills ». C'est CETTE copie que l'agent lit. |

## Comment fonctionne l'installation automatique

Au démarrage du backend (`backend/src/index.ts`, callback d'écoute du serveur),
le module `backend/src/pi/skills-seed.ts` :

1. liste les dossiers de `skills/` contenant un `SKILL.md` ;
2. pour chacun, si `~/.pi/agent/skills/<nom>` **existe déjà** (dossier ou
   fichier), il ne fait **rien** ;
3. sinon, il copie le dossier **tel quel** depuis `skills/`.

C'est le même motif que l'amorçage existant de Pi-Web (`entrypoint.sh` crée
`settings.json` seulement s'il est absent, et n'écrit que si le contenu change)
et que la règle de Yuki « seed jamais écrasé » (`seedSettingsFile()`).

Propriétés :

- **Idempotent** : un deuxième démarrage ne réécrit rien.
- **Best-effort** : si la copie échoue (permissions, disque…), le démarrage
  n'est pas bloqué ; l'événement est signalé dans les logs
  (`[startup] skills maison : échec pour …`).
- **Prudent** : seules les fiches présentes dans `skills/` sont semées. Les
  skills de l'écosystème (`holaf-*`) et celle générée par CBM
  (`codebase-memory`) ne sont jamais touchées par le seed.

Un dossier global qui contient déjà les fiches (cas de l'installation de
référence) → l'opération est un no-op complet : aucun fichier touché, aucune
duplication. Si vous supprimez volontairement une fiche livrée de votre dossier
global, elle sera **re-semée au prochain démarrage** (le seed ne peut pas
distinguer « jamais installée » de « supprimée exprès »).

## Personnaliser une fiche

Éditez directement votre copie locale :

```
~/.pi/agent/skills/<nom>/SKILL.md
```

Elle est relue par l'agent **à chaque session** (le loader est recréé), et
**jamais** réécrite par Pi-Web. Vous pouvez aussi la désactiver depuis l'UI
(Paramètres → « Extensions & Skills ») : elle n'est plus chargée, mais reste sur
le disque.

Pour une modification durable qui profite à tout le monde : modifiez aussi la
version dans le dépôt (`skills/<nom>/SKILL.md`). La version du dépôt sert aux
**prochaines installations** : elle ne se propage pas vers les copies locales
existantes (voir ci-dessous).

## Mise à jour et retour à la version d'origine

**Stratégie retenue : seed-only (première itération).** Une copie locale
existante n'est jamais comparée ni réécrite automatiquement, même si la fiche
livrée a évolué dans le dépôt. C'est la solution la plus **simple** et la plus
**sûre** :

- il est impossible de faire disparaître une personnalisation de l'utilisateur
  (pas de comparaison de hash à maintenir, pas de fichier d'état en écriture,
  pas d'écrasement silencieux possible) ;
- le prix à payer : une fiche livrée mise à jour dans le dépôt **ne remplace
  pas** les copies locales déjà présentes. Chacun choisit s'il veut la retrouver.

**Retrouver la version d'origine d'une fiche :**

1. supprimer la copie locale : `rm -rf ~/.pi/agent/skills/<nom>` ;
2. redémarrer le backend — la fiche est re-semée depuis `skills/` du dépôt.

**Voir si votre copie a divergé de la version livrée :**

```bash
diff -r ~/.pi/agent/skills/<nom> /chemin/vers/Pi-Web/skills/<nom>
```

(Silence = identique.) Si le diff montre des changements : ce sont soit vos
personnalisations, soit une évolution de la version livrée — l'arbitrage reste
manuel, par choix.

Une éventuelle itération future pourra comparer la copie locale à l'empreinte
(sha256) de la fiche au moment du seed et proposer une mise à jour quand rien
n'a été modifié ; ce n'est **pas** retenu aujourd'hui (complexité et risque
d'écrasement pour un gain marginal).

## Les skills de l'écosystème holaf (non livrées)

`holaf-conventions` et `holaf-briques` vivent dans **`/projects/holaf-lib/skills/`**
(versionnées avec la bibliothèque, dont elles sont une dépendance). Pi-Web ne
les connaît pas et ne les installe pas.

Pour les installer sur une machine où `holaf-lib` est présent :

```bash
cp -r /chemin/vers/holaf-lib/skills/holaf-conventions ~/.pi/agent/skills/
cp -r /chemin/vers/holaf-lib/skills/holaf-briques     ~/.pi/agent/skills/
```

Sur l'installation de référence, elles sont déjà installées ainsi (copie
manuelle, hors du seed de Pi-Web).

## Vérifier / dépanner

- Le seed tourne **au démarrage du backend**. Logs types :
  - installation neuve : `[startup] skills maison installées dans ~/.pi/agent/skills : …` ;
  - cas normal (déjà installées) : `[startup] skills maison : 2 déjà présente(s) — rien à écrire`.
- En cas de problème : vérifier que le dossier `skills/` existe à la racine du
  dépôt (et, en Docker, que le `Dockerfile` l'a bien copié vers `/app/skills`).
- Tests du module : `cd backend && npx vitest run src/pi/skills-seed.test.ts`.
