#!/bin/bash
set -e

PI_WEB_VERSION="2.0.0"

echo "╔══════════════════════════════════════════╗"
echo "║  ⚡ PI-WEB  ███▓▓▒▒░░  v${PI_WEB_VERSION}  ░░▒▒▓▓███  ║"
echo "╚══════════════════════════════════════════╝"

# ─── Backend ──────────────────────────────────
cd /app/backend

if [ ! -f "node_modules/.package-lock.json" ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "[PI-WEB] Installing backend dependencies..."
  npm install --prefer-offline --no-audit --no-fund
  touch node_modules/.package-lock.json
else
  echo "[PI-WEB] Backend dependencies up to date"
fi

echo "[PI-WEB] Building backend..."
npm run build

# ─── Frontend ─────────────────────────────────
cd /app/frontend

if [ ! -f "node_modules/.package-lock.json" ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "[PI-WEB] Installing frontend dependencies..."
  npm install --prefer-offline --no-audit --no-fund
  touch node_modules/.package-lock.json
else
  echo "[PI-WEB] Frontend dependencies up to date"
fi

echo "[PI-WEB] Building frontend..."
npm run build

# ─── Start ────────────────────────────────────
echo "[PI-WEB] Starting server..."
cd /app
exec node backend/dist/index.js
