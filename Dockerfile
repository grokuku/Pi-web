# ══════════════════════════════════════════════════════════════════════
# Pi-Web — image AUTOPORTANTE (multi-étages)
#
#   deps    → npm ci backend + frontend
#   build   → typecheck extensions + tsc (backend) + tsc -b/vite (frontend)
#   runtime → node_modules ET dist DÉJÀ CONSTRUITS
#
# Conséquence : entrypoint.sh ne fait PLUS `npm install` ni `npm run build`
# au démarrage. Le conteneur démarre sur un code compilé, identique pour
# tous les hôtes (plus de dérive « ça compile chez moi »), et un `docker
# pull` ne redéclenche aucune installation réseau.
#
# Le binaire codebase-memory-mcp (CBM) est lui aussi EMBARQUÉ (étape `runtime`,
# /opt/cbm/bin, version épinglée + sha256) : plus aucun téléchargement au
# démarrage. Ses DONNÉES (CBM_CACHE_DIR) restent sur le volume /app/.data.
#
# CE QUI EST INCHANGÉ (comportement production strictement identique) :
#   • root, `ENV HOME=/root` (Chromium en root exige --no-sandbox, et
#     node-pty / le terminal / le binaire CBM supposent cet utilisateur) ;
#   • port 3000, `EXPOSE 3000`, aucun `HEALTHCHECK` (décision séparée) ;
#   • aucun `CMD` — `ENTRYPOINT ["./entrypoint.sh"]` seul ;
#   • mêmes chemins montés en volumes (/root/.pi, /projects, /sessions,
#     /app/.data, /root/.unipi) ;
#   • toolchain Go épinglée présente à l'exécution (compilation croisée de
#     l'agent d'exécution Yuki depuis ce conteneur).
#
# Le pré-téléchargement de l'image de base (3 tentatives) est fait par les
# workflows AVANT le build ; ce Dockerfile reste utilisable seul.
# ══════════════════════════════════════════════════════════════════════
ARG BASE_IMAGE=mirror.gcr.io/library/node:22-slim

# ──────────────────────────────────────────────────────────────────────
# ÉTAGE 1 — deps : dépendances uniquement (couche cache maximale)
# ──────────────────────────────────────────────────────────────────────
# Miroir Google `mirror.gcr.io` (contournement des quotas de pulls ANONYMES,
# qui sont comptés PAR IP et partagés par les runners GitHub : Docker Hub
# répond « 429 toomanyrequests » et public.ecr.aws « toomanyrequests: Data
# limit exceeded »). Contenu STRICTEMENT identique au tag
# docker.io/library/node:22-slim — seule la provenance change.
FROM ${BASE_IMAGE} AS deps

# node-pty et better-sqlite3 sont des modules NATIFS : ils compilent ici
# (node-gyp → python3 + build-essential) et sont ensuite copiés tels quel
# dans `runtime`, qui a donc la MÊME base glibc. Pas de recompilation.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Les manifests AVANT les sources : une modification de code n'invalide pas
# l'installation des dépendances.
COPY backend/package.json        ./backend/package.json
COPY backend/package-lock.json   ./backend/package-lock.json
COPY frontend/package.json       ./frontend/package.json
COPY frontend/package-lock.json  ./frontend/package-lock.json

# `npm ci` (et non `npm install`) : install STRICTEMENT conforme au lockfile,
# donc reproductible et cohérent avec ce que teste la CI.
RUN cd backend  && npm ci --no-audit --no-fund \
 && cd ../frontend && npm ci --no-audit --no-fund

# ──────────────────────────────────────────────────────────────────────
# ÉTAGE 2 — build : compilation réelle (backend + frontend + extensions)
# ──────────────────────────────────────────────────────────────────────
FROM deps AS build

WORKDIR /app

COPY VERSION ./VERSION
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY extensions/ ./extensions/
COPY skills/ ./skills/

# Aligne la version des deux package.json sur VERSION (source unique), comme
# le faisait l'entrypoint au boot : l'image publiée porte donc directement la
# bonne version, sans attendre le premier démarrage.
RUN node -e "const fs=require('fs');const v=fs.readFileSync('/app/VERSION','utf8').trim();['/app/backend/package.json','/app/frontend/package.json'].forEach(f=>{const p=JSON.parse(fs.readFileSync(f,'utf8'));p.version=v;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n');});console.log('[build] version synced:',v);"

# Contrôle de types des extensions maison (extensions/*/index.ts ne sont pas
# compilées par le build backend).
RUN cd backend && npm run typecheck:extensions

# backend : `tsc` → dist/ (aucun script annexe à copier)
RUN cd backend && npm run build

# frontend : `tsc -b && vite build` → frontend/dist (servi sur `/`)
RUN cd frontend && npm run build

# Garde-fou de build : si l'un des artefacts manque, on échoue ICI et non au
# démarrage du conteneur en production.
RUN test -f /app/backend/dist/index.js \
 && test -f /app/frontend/dist/index.html \
 && echo "[build] artefacts OK"

# ──────────────────────────────────────────────────────────────────────
# ÉTAGE 3 — runtime : ce qui tourne réellement
# ──────────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS runtime

# ─── System packages (light) ─────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    git curl openssh-client \
    nano mc procps \
    build-essential python3 \
    cifs-utils \
    && rm -rf /var/lib/apt/lists/*

# ─── Chromium (headless screenshots — extensions/web-screenshot) ─────────
# Bloc isolé du bloc "light" ci-dessus pour préserver son cache de couche.
# --no-install-recommends : deps headless fournies en Depends du paquet
# chromium (libnss3, libgbm1, ...) — ~300 Mo acceptés.
# fonts-liberation : police minimale pour un rendu texte correct des captures.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# ─── Toolchain Go (compilation croisée de l'agent d'exécution — Lot 4 Yuki) ───
# L'agent d'exécution de Yuki (Lot 4) est un programme Go à compiler pour Linux
# et Windows (amd64/arm64) DANS ce conteneur. Installé à la volée, Go ne vivrait
# que dans la couche d'écriture ÉPHÉMÈRE du conteneur (/usr/local/go sur /) et
# disparaîtrait à chaque `docker compose up --build` — il DOIT donc être dans
# l'image. Tarball de la distribution OFFICIELLE go.dev/dl (aucun dépôt tiers,
# aucune clé APT). Épinglé par version ET par sha256 (règle maison : jamais de
# `latest`) : le sha256 du fichier est vérifié AVANT extraction, donc toute
# altération du binaire fait échouer le build. `curl` est fourni par le bloc
# « System packages » ci-dessus, `sha256sum` par coreutils (base Debian slim).
ARG GO_VERSION=1.27.1
ARG GO_SHA256=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445
RUN curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
 && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz \
 && ln -sf /usr/local/go/bin/go    /usr/local/bin/go \
 && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
 && go version

RUN mkdir -p /projects /sessions /mnt/smb && \
    git config --system --add safe.directory '*'

# ─── codebase-memory-mcp (CBM) — EMBARQUÉ DANS L'IMAGE ────────────────────
# CBM fait partie intégrante de Pi-Web (tools cbm_* de l'agent + graphe 3D servis
# par le backend) : il est livré PAR L'IMAGE, à version FIGÉE, et non plus
# téléchargé au démarrage du conteneur (l'ancien `install.sh` de `main` prenait
# la dernière release, donc chaque redémarrage pouvait changer de version).
#
# ⚠ EMPLACEMENT : /opt/cbm/bin, HORS du volume `pi-appdata:/app/.data` monté par
# docker-compose.yml. Tout ce qui serait écrit sous /app/.data dans l'image
# serait MASQUÉ par le volume au démarrage → un binaire livré là serait
# invisible. L'ancien emplacement (/app/.data/bin) est donc abandonné ; les
# DONNÉES du graphe (`CBM_CACHE_DIR`) restent, elles, sur le volume.
#
# ⚠ VERSION : 0.11.0 — la version de PRODUCTION (mesurée), pas 0.12.x dont le
# CHANGELOG annonce des ruptures qui touchent exactement ce dont Pi-Web dépend
# (noms qualifiés, requêtes Cypher en dur, noms d'outils). Monter de version =
# changer CES DEUX LIGNES (CBM_VERSION + CBM_SHA256) puis reconstruire l'image :
# c'est le SEUL endroit à modifier.
#
# ⚠ ASSET : `-portable` = la variante que `install.sh` choisit pour linux (elle
# embarque le binaire `--ui`, nécessaire au graphe 3D) ; le tag `ui-` porte le
# même contenu (sha256 identique dans checksums.txt).
#
# ⚠ INTÉGRITÉ : sha256 vérifié AVANT extraction (somme publiée dans
# `checksums.txt` de la release). Toute altération de l'archive fait échouer le
# build. `--version` en fin de bloc : garde-fou, un binaire non exécutable casse
# le build ICI et pas au démarrage en production.
ARG CBM_VERSION=0.11.0
ARG CBM_SHA256=1f9e8293eb2bc5c05cfa27a7e8fc033da6d729ffad525ccfcdaa3fd606306683
RUN curl -fsSL -o /tmp/cbm.tgz \
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}/codebase-memory-mcp-linux-amd64-portable.tar.gz" \
 && echo "${CBM_SHA256}  /tmp/cbm.tgz" | sha256sum -c - \
 && mkdir -p /opt/cbm/bin \
 && tar -C /opt/cbm/bin -xzf /tmp/cbm.tgz codebase-memory-mcp \
 && chmod +x /opt/cbm/bin/codebase-memory-mcp \
 && rm -f /tmp/cbm.tgz \
 && /opt/cbm/bin/codebase-memory-mcp --version

# Chemin par défaut lu par le backend (backend/src/pi/cbm-bin.ts) et par
# l'extension codebase-memory. Une valeur fournie par l'environnement (compose)
# PREND LE DESSUS : l'entrypoint n'écrase jamais un CBM_BIN_PATH existant.
ENV CBM_BIN_PATH=/opt/cbm/bin/codebase-memory-mcp

WORKDIR /app

COPY VERSION ./VERSION
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# ─── Artefacts DÉJÀ CONSTRUITS (plus aucun npm install/build à l'exécution) ───
# backend : package.json + node_modules (dont node-pty compilé dans `deps`) +
#           dist/ + sources TS (2 Mo, conservées
#           à l'identique de l'image historique).
# frontend : dist/ servi sur `/` + node_modules (outillage conservé).
COPY --from=build /app/backend  ./backend
COPY --from=build /app/frontend ./frontend

# Extensions maison chargées par le loader du SDK (chemins /app/extensions/*/index.ts)
COPY --from=build /app/extensions ./extensions

# Skills maison livrées avec Pi-Web : semées au démarrage du backend dans
# <agentDir>/skills SI ABSENTES (backend/src/pi/skills-seed.ts) — le dossier
# doit donc exister dans l'image à /app/skills (résolu depuis backend/dist/pi).
COPY --from=build /app/skills ./skills

EXPOSE 3000
ENV HOME=/root
# Binaire installé par le bloc apt chromium ci-dessus — détecté en priorité
# par extensions/web-screenshot (avant le fallback `which`).
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV USAGE_DIR=/app/.data/usage

# ⚠ Aucun HEALTHCHECK : décision séparée (l'entrypoint démarre aussi un
# serveur CBM en arrière-plan ; un HEALTHCHECK sur /api/health ne dirait rien
# de l'état du reste). Le smoke test des workflows couvre la vérification.
ENTRYPOINT ["./entrypoint.sh"]
