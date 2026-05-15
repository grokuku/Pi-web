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
NPM_GLOBAL_ROOT=$(npm root -g)

# Ensure global npm root exists
mkdir -p "$NPM_GLOBAL_ROOT"

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

    # Install globally — the Pi SDK resolves packages via npm root -g
    if npm install -g $PACKAGES --no-audit --no-fund 2>&1; then
      echo "[PI-WEB] Extensions installed globally successfully"
    else
      echo "[PI-WEB] WARNING: Some extensions failed to install globally (see errors above)"
    fi

    # Also install in agent dir for backwards compat and native module resolution
    mkdir -p "$PI_AGENT_DIR"
    npm install --prefix "$PI_AGENT_DIR" $PACKAGES --no-audit --no-fund 2>&1 || true

    # Update settings.extensions with resolved paths so Pi SDK can discover them
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settings = JSON.parse(fs.readFileSync('$PI_SETTINGS', 'utf8'));
      const packages = (settings.packages || []).map(p => typeof p === 'string' ? p : p.source);
      const extensions = (settings.extensions || []).slice();
      const extDir = path.join('$PI_AGENT_DIR', 'node_modules');
      for (const pkg of packages) {
        // Read package.json pi manifest to find extension entry points
        let pkgJsonPath = path.join(extDir, pkg, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
          // Try scoped package
          const parts = pkg.split('/');
          if (pkg.startsWith('@') && parts.length >= 2) {
            // Already correct
          }
        }
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          const pi = pkgJson.pi || {};
          const pkgDir = path.dirname(pkgJsonPath);
          if (pi.extensions) {
            for (const ext of pi.extensions) {
              const extPath = path.resolve(pkgDir, ext);
              if (fs.existsSync(extPath) && !extensions.includes(extPath)) {
                extensions.push(extPath);
              }
            }
          }
        } catch(e) {}
      }
      settings.extensions = extensions;
      fs.writeFileSync('$PI_SETTINGS', JSON.stringify(settings, null, 2) + '\n');
      console.log('[PI-WEB] Updated settings.extensions:', extensions.length, 'entries');
    "
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
