FROM node:20-slim

# ─── System packages (light) ─────────────────
RUN apt-get update && apt-get install -y \
    git curl openssh-client \
    nano mc procps \
    build-essential python3 \
    cifs-utils \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /projects /sessions /mnt/smb && \
    git config --system --add safe.directory '*'

WORKDIR /app
COPY VERSION ./VERSION
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000
ENV HOME=/root
ENTRYPOINT ["./entrypoint.sh"]