# ─── Stage 1: Build ────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y \
    git curl wget openssh-client smbclient cifs-utils \
    nano mc procps python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Backend: install & build
COPY backend/package*.json ./backend/
RUN cd backend && npm install && npm cache clean --force
COPY backend/ ./backend/
RUN cd backend && npm run build && npm prune --production

# Frontend: install & build
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install && npm cache clean --force
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ─── Stage 2: Runtime ──────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git curl openssh-client smbclient cifs-utils \
    nano mc procps \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/node/.pi/agent && \
    mkdir -p /projects && mkdir -p /sessions && \
    chown -R node:node /home/node /projects /sessions

USER node
WORKDIR /app

# Copy only what's needed
COPY --from=builder --chown=node:node /app/backend/dist ./backend/dist
COPY --from=builder --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --from=builder --chown=node:node /app/backend/package.json ./backend/
COPY --from=builder --chown=node:node /app/frontend/dist ./frontend/dist

EXPOSE 3000 3001
CMD ["node", "backend/dist/index.js"]
