FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    openssh-client \
    smbclient \
    cifs-utils \
    nano \
    mc \
    procps \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Ensure directories exist
RUN mkdir -p /home/node/.pi/agent && \
    mkdir -p /projects && \
    mkdir -p /sessions && \
    chown -R node:node /home/node /projects /sessions

USER node
WORKDIR /app

# Copy package files and install dependencies
COPY --chown=node:node backend/package*.json ./backend/
RUN cd backend && npm install

COPY --chown=node:node frontend/package*.json ./frontend/
RUN cd frontend && npm install

# Copy source code
COPY --chown=node:node backend/ ./backend/
COPY --chown=node:node frontend/ ./frontend/

# Build frontend
RUN cd frontend && npm run build

# Expose ports
EXPOSE 3000 3001

# Start backend
CMD ["node", "backend/dist/index.js"]
