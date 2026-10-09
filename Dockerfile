# ─── Image de base : miroir public Amazon ECR (contournement rate-limit Docker Hub) ───
# Docker Hub impose un quota de pulls anonymes (« unauthenticated pull rate limit »,
# erreur HTTP 429 « toomanyrequests ») qui fait échouer le build lors du pull de
# node:22-slim. public.ecr.aws/docker/library/ est le miroir PUBLIC et OFFICIEL des
# images Docker officielles (node, alpine, postgres, ...) maintenu par AWS.
# Avantages : aucun quota de pulls, aucune authentification requise, et pas besoin de
# redémarrer le daemon Docker (on ne touche ni à daemon.json ni aux services en cours).
# Contenu STRICTEMENT identique : même image, même tag — seule la provenance change
# (docker.io/library/node:22-slim → public.ecr.aws/docker/library/node:22-slim).
# Vérification : docker pull public.ecr.aws/docker/library/node:22-slim
FROM public.ecr.aws/docker/library/node:22-slim

# ─── System packages (light) ─────────────────
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
# Placé AVANT les COPY de code : cette couche ne s'invalide que si Go change.
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

WORKDIR /app
COPY VERSION ./VERSION
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY extensions/ ./extensions/
# Skills maison livrées avec Pi-Web : semées au démarrage du backend dans
# <agentDir>/skills SI ABSENTES (backend/src/pi/skills-seed.ts) — le dossier
# doit donc exister dans l'image à /app/skills (résolu depuis backend/dist/pi).
COPY skills/ ./skills/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000
ENV HOME=/root
# Binaire installé par le bloc apt chromium ci-dessus — détecté en priorité
# par extensions/web-screenshot (avant le fallback `which`).
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV USAGE_DIR=/app/.data/usage
ENTRYPOINT ["./entrypoint.sh"]