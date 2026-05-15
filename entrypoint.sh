#!/bin/bash
set -e

PI_WEB_VERSION=$(cat /app/VERSION 2>/dev/null || echo "unknown")

echo "╔══════════════════════════════════════════╗"
echo "║  ⚡ PI-WEB  ███▓▓▒▒░░  v${PI_WEB_VERSION}  ░░▒▒▓▓███  ║"
echo "╚══════════════════════════════════════════╝"

# ── Sync version from VERSION file into package.jsons ──
if [ -f "/app/VERSION" ]; then
  echo "[PI-WEB] Syncing version ${PI_WEB_VERSION} into package.json files..."
  node -e "const v='${PI_WEB_VERSION}';['/app/backend/package.json','/app/frontend/package.json'].forEach(f=>{try{const p=JSON.parse(require('fs').readFileSync(f,'utf8'));p.version=v;require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n');}catch(e){}})"
fi

# ─── Backend ──────────────────────────────────
cd /app/backend

if [ ! -f "node_modules/.package-lock.json" ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "[PI-WEB] Installing backend dependencies..."
  npm install --prefer-offline --no-audit --no-fund
  touch node_modules/.package-lock.json
else
  echo "[PI-WEB] Backend dependencies up to date"
fi

# Always update pi-coding-agent to latest ("latest" in package.json)
echo "[PI-WEB] Checking for pi-coding-agent updates..."
npm install @earendil-works/pi-coding-agent@latest --no-audit --no-fund --save 2>&1 | tail -3 || true

# Read installed version for display
PI_SDK_VERSION=$(node -e "try{console.log(require('@earendil-works/pi-coding-agent/package.json').version)}catch(e){console.log('unknown')}" 2>/dev/null)
echo "[PI-WEB] pi-coding-agent version: ${PI_SDK_VERSION}"

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

# ─── Reinstall Pi extensions from settings ────
PI_AGENT_DIR="/root/.pi/agent"
PI_SETTINGS="${PI_AGENT_DIR}/settings.json"

if [ -f "$PI_SETTINGS" ]; then
  PACKAGES=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('$PI_SETTINGS','utf8'));
      const pkgs = (s.packages || []).map(p => typeof p === 'string' ? p : p.source).filter(p => p && !p.startsWith('./') && !p.startsWith('/'));
      if (pkgs.length) console.log(pkgs.join(' '));
    } catch(e) {}
  ")

  if [ -n "$PACKAGES" ]; then
    echo "[PI-WEB] Reinstalling Pi extensions: $PACKAGES"
    mkdir -p "$PI_AGENT_DIR"
    if npm install --prefix "$PI_AGENT_DIR" $PACKAGES --no-audit --no-fund 2>&1; then
      echo "[PI-WEB] Extensions reinstalled successfully"
    else
      echo "[PI-WEB] WARNING: Some extensions failed to install (see errors above)"
    fi
  else
    echo "[PI-WEB] No npm/git extensions to reinstall"
  fi
else
  echo "[PI-WEB] No Pi settings file found, skipping extension reinstall"
fi

# ─── Start ────────────────────────────────────
echo "[PI-WEB] Starting server..."
cd /app
export PI_WEB_VERSION
exec node backend/dist/index.js
