FROM node:20-slim

# ─── System packages only ──────────────────────
RUN apt-get update && apt-get install -y \
    git curl openssh-client smbclient cifs-utils \
    nano mc procps \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/node/.pi/agent && \
    mkdir -p /projects && mkdir -p /sessions && \
    chown -R node:node /home/node /projects /sessions

USER node
WORKDIR /app

# ─── Copy source (npm install happens at runtime) ──
COPY --chown=node:node backend/ ./backend/
COPY --chown=node:node frontend/ ./frontend/
COPY --chown=node:node entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000 3001
ENTRYPOINT ["./entrypoint.sh"]
