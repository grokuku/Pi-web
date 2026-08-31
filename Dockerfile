FROM node:22-slim

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

RUN mkdir -p /projects /sessions /mnt/smb && \
    git config --system --add safe.directory '*'

WORKDIR /app
COPY VERSION ./VERSION
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY extensions/ ./extensions/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000
ENV HOME=/root
# Binaire installé par le bloc apt chromium ci-dessus — détecté en priorité
# par extensions/web-screenshot (avant le fallback `which`).
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV USAGE_DIR=/app/.data/usage
ENTRYPOINT ["./entrypoint.sh"]