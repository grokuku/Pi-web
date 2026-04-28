FROM node:20-slim

# ─── System packages ──────────────────────────
RUN apt-get update && apt-get install -y \
    git curl openssh-client smbclient cifs-utils \
    nano mc procps \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/node/.pi/agent && \
    mkdir -p /projects && mkdir -p /sessions

WORKDIR /app

# ─── Copy source ──────────────────────────────
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000 3001
ENTRYPOINT ["./entrypoint.sh"]
