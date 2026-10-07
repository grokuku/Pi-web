---
name: pi-web-ui
description: "Conventions d'interface de Pi-Web (React + Tailwind + Vite). À consulter AVANT de créer ou modifier un composant d'interface, d'ajouter un bloc d'affichage de détail, ou de toucher au thème / aux icônes. Déclencheurs : nouveau composant frontend, bloc de détail (réflexion, sortie d'outil, journal d'agent, résultat de sous-agent), repli/dépli d'un bloc, réglage « déplier le détail d'affichage », thème / couleurs / famille de la brique holaf, Matrix, icône, HolafIcon, hacker-theme.css, vendor/holaf."
---

# Pi-Web — conventions d'interface

> Cette fiche ne décrit que le dépôt Pi-Web lui-même : tous les chemins sont
> relatifs à sa racine, aucune autre bibliothèque n'est supposée installée sur
> la machine.

## 1. Thème : la brique `tokens` est la seule source de couleurs
- Brique vendorisée : `frontend/src/vendor/holaf/holaf-tokens.js` (version pinnée
  dans `frontend/src/vendor/holaf/holaf-manifest.json`, ≥ 0.5.0).
- Module : `frontend/src/theme/pi-web-theme.ts`. Pi-Web n'enregistre AUCUN thème
  maison : le sélecteur n'offre QUE les FAMILLES de la brique — `matrix` (identité,
  défaut) puis les 6 familles couleur (corail, ambre, emeraude, turquoise,
  amethyste, neutre) — appliquées via le preset `<famille>-<mode>`. Thème par
  défaut : **`matrix-dark`** (famille `matrix` en mode sombre).
- Application : `initPiWebTheme()` (`main.tsx`, avant le premier rendu) et
  `applyPiWebTheme()` (`App.tsx`) ; sélecteur : `frontend/src/components/Header/ThemePicker.tsx`.
- CSS : `frontend/src/styles/hacker-theme.css` — chaque variable Pi-Web est un
  **alias** `var(--holaf-…, <repli>)`. Ne pas écrire de couleur en dur dans un composant.
- ⚠️ Piège RGB : Tailwind mappe les classes `hacker-*` via
  `rgb(var(--<x>-rgb) / <alpha-value>)` ; les triples `-rgb` sont **calculés en JS**
  (`hexToRgbTriple`, via la couche hôte `buildPiWebOverlay`) car la brique fournit
  du hex — ne jamais les écrire en CSS.
- Ne PAS réintroduire de packs `pi-web-*` : Matrix et les thèmes vivent dans la
  brique holaf-lib (dépôt séparé).

## 2. Icônes : brique `icons` via `HolafIcon`
- Utiliser `frontend/src/components/icons/HolafIcon.tsx`
  (`<HolafIcon name="chevron-down" size={12} />`), jamais une librairie externe
  pour du nouveau code. La migration depuis `lucide-react` est progressive :
  l'existant lucide subsiste, il ne fait pas référence.
- Noms disponibles : `HolafIcons.list()` — API typée localement dans
  `frontend/src/vendor/holaf/holaf-icons.d.ts` (la brique est la copie pinnée
  `frontend/src/vendor/holaf/holaf-icons.js`).
- Icône absente de la brique : **pas de SVG ad hoc dans Pi-Web** — le besoin se
  traite dans le dépôt d'origine de la brique *s'il est présent sur la machine*
  (bibliothèque holaf-lib, dépôt séparé) ; sinon, le signaler et s'abstenir.

## 3. Blocs de détail : TOUJOURS le repli partagé
Tout contenu de détail — réflexion, sortie d'outil, journal d'agent, résultat de
sous-agent — passe par `CollapsibleBlock` / `useCollapsible`
(`frontend/src/components/Chat/CollapsibleBlock.tsx` ; règle pure de précédence
dans `frontend/src/utils/collapse.ts`).
- Le bloc doit être rendu **sous le `CollapseProvider`** de la liste de messages
  (`ChatView`) : hors provider, le réglage utilisateur n'est pas appliqué.
- Le réglage « **Déplier le détail d'affichage par défaut** »
  (`pi-web-display-detail` ; bascule Ctrl+T ou Paramètres) est évalué **à chaque
  render** — ne jamais le figer dans un `useState` d'initialisation.
- ⚠️ Piège rencontré 3 fois : un nouveau composant qui affiche du détail sans
  passer par ce mécanisme ignore le réglage de l'utilisateur. Si tu affiches du
  détail autrement qu'avec `CollapsibleBlock`, c'est un bug.

## 4. Nouvelle intégration
Avant d'ajouter une dépendance ou un composant réutilisable : vérifier d'abord
les briques déjà vendorisées dans `frontend/src/vendor/holaf/`
(`holaf-manifest.json` donne les versions pinnées) — une brique existante se
préfère à une réécriture.
Si l'écosystème holaf est présent sur cette machine (bibliothèque `holaf-lib`,
dépôt séparé), ses règles communes s'appliquent en plus ; sinon, cette fiche
suffit : elle ne référence que le dépôt Pi-Web.
