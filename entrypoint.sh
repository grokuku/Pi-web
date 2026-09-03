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

# Version PINNÉE — monter de version uniquement manuellement : vérifier le changelog
# et les breaking changes d'abord (les nouveaux tools apparaissent sans garde-fou OS,
# ex: powershell en 0.84)
echo "[PI-WEB] Checking for pi-coding-agent updates..."
npm install @earendil-works/pi-coding-agent@0.84.4 --no-audit --no-fund --save 2>&1 | tail -3 || true

# Read installed version for display
PI_SDK_VERSION=$(node -p "try{require('@earendil-works/pi-coding-agent/package.json').version}catch(e){'unknown'}" 2>/dev/null)
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
    # Global install compiles native modules (better-sqlite3, sqlite-vec, etc.)
    if npm install -g $PACKAGES --no-audit --no-fund 2>&1; then
      echo "[PI-WEB] Extensions installed globally successfully"
    else
      echo "[PI-WEB] WARNING: Some extensions failed to install globally (see errors above)"
    fi

    # Update settings.extensions with resolved paths from GLOBAL npm root
    # (native modules like better-sqlite3 are compiled there, not in agent dir)
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settings = JSON.parse(fs.readFileSync('$PI_SETTINGS', 'utf8'));
      const packages = (settings.packages || []).map(p => typeof p === 'string' ? p : p.source);
      const extensions = [];
      const globalRoot = '$NPM_GLOBAL_ROOT';
      for (const pkg of packages) {
        // Resolve extension entry points from GLOBAL npm root
        // This is critical: native modules (better-sqlite3, sqlite-vec) are compiled here
        let pkgJsonPath = path.join(globalRoot, pkg, 'package.json');
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          const pi = pkgJson.pi || {};
          const pkgDir = path.dirname(pkgJsonPath);
          if (pi.extensions) {
            for (const ext of pi.extensions) {
              const extPath = path.resolve(pkgDir, ext);
              if (fs.existsSync(extPath)) {
                extensions.push(extPath);
              }
            }
          }
          if (pi.skills) {
            // skills paths are also relative to package dir
            // Pi SDK resolves them automatically from packages
          }
        } catch(e) {
          console.error('[PI-WEB] Could not read manifest for', pkg, ':', e.message);
        }
      }
      settings.extensions = [...new Set(extensions)];

      // Add local extensions from /app/extensions/
      const localExtDir = '/app/extensions';
      try {
        const localExts = fs.readdirSync(localExtDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => path.join(localExtDir, d.name, 'index.ts'))
          .filter(p => fs.existsSync(p));
        for (const ext of localExts) {
          if (!extensions.includes(ext)) {
            extensions.push(ext);
            settings.extensions.push(ext);
          }
        }
        if (localExts.length > 0) {
          console.log('[PI-WEB] Added local extensions:', localExts);
        }
      } catch(e) {
        // No local extensions directory — that's fine
      }

      fs.writeFileSync('$PI_SETTINGS', JSON.stringify(settings, null, 2) + '\n');
      console.log('[PI-WEB] Updated settings.extensions:', settings.extensions.length, 'entries:', settings.extensions);
    "
  else
    echo "[PI-WEB] No npm/git extensions to reinstall"
  fi

  # Also add local extensions even if no npm packages
  node -e "
    const fs = require('fs');
    const path = require('path');
    const settings = JSON.parse(fs.readFileSync('$PI_SETTINGS', 'utf8'));
    const localExtDir = '/app/extensions';
    let added = 0;
    try {
      const localExts = fs.readdirSync(localExtDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(localExtDir, d.name, 'index.ts'))
        .filter(p => fs.existsSync(p));
      for (const ext of localExts) {
        if (!(settings.extensions || []).includes(ext)) {
          settings.extensions = settings.extensions || [];
          settings.extensions.push(ext);
          added++;
        }
      }
      if (added > 0) fs.writeFileSync('$PI_SETTINGS', JSON.stringify(settings, null, 2) + '\n');
      if (added > 0 || localExts.length > 0) console.log('[PI-WEB] Local extensions:', localExts.length, 'found,', added, 'added');
    } catch(e) {
      // No local extensions directory
    }
  "
else
  echo "[PI-WEB] No Pi settings file found, skipping extension reinstall"
fi

# ── Download codebase-memory-mcp binary if not installed ──
CBM_BIN="$HOME/.local/bin/codebase-memory-mcp"
if [ ! -f "$CBM_BIN" ]; then
  echo "[PI-WEB] Downloading codebase-memory-mcp (UI variant)..."
  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --ui --skip-config 2>&1 | tail -3 || true
  if [ -f "$CBM_BIN" ]; then
    echo "[PI-WEB] ✓ codebase-memory-mcp installed"
  else
    echo "[PI-WEB] WARNING: codebase-memory-mcp download failed — graph tools will be unavailable"
  fi
else
  echo "[PI-WEB] codebase-memory-mcp already installed"
fi

# Persist CBM cache on the /app/.data volume (survives Docker rebuilds)
export CBM_CACHE_DIR="/app/.data/cbm"
mkdir -p "$CBM_CACHE_DIR"

# Start CBM HTTP server in background (3D graph UI on port 9749).
# NOTE (v0.10.4): in --ui mode the HTTP /rpc endpoint is restricted — only
# list_projects and get_code_snippet are allowed; everything else returns 403
# "UI RPC method is not allowed". The Pi extension (extensions/codebase-memory)
# therefore talks to the binary over MCP stdio for the FULL tool surface;
# this HTTP server is kept alive for the Pi-Web 3D graph UI (/cbm-ui/).
# The binary is an MCP stdio server — it exits if stdin closes.
# We keep stdin open with `tail -f /dev/null` so the HTTP UI stays alive.
if [ -f "$CBM_BIN" ]; then
  tail -f /dev/null | nohup "$CBM_BIN" --ui=true --port=9749 > /tmp/cbm-server.log 2>&1 &
  echo "[PI-WEB] codebase-memory-mcp server starting on port 9749 (PID $!)"
fi

# ─── Start ────────────────────────────────────
echo "[PI-WEB] Starting server..."
cd /app
export PI_WEB_VERSION
exec node backend/dist/index.js
