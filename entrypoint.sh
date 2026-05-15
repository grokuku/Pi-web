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

# ─── Auto-configure extension API keys from Pi providers ────
# Extract API keys from models.json and configure extensions automatically
MODELS_JSON="${PI_AGENT_DIR}/models.json"
UNIPI_CONFIG_DIR="$(eval echo ~$(whoami))/.unipi/memory"
UNIPI_CONFIG="${UNIPI_CONFIG_DIR}/config.json"

if [ -f "$MODELS_JSON" ]; then
  # Extract OpenRouter API key for @pi-unipi/memory embeddings
  OPENROUTER_KEY=$(node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('$MODELS_JSON', 'utf8'));
      for (const [pid, prov] of Object.entries(d.providers || {})) {
        if ((prov.baseUrl || '').toLowerCase().includes('openrouter')) {
          process.stdout.write(prov.apiKey || '');
          break;
        }
      }
    } catch(e) {}
" 2>/dev/null)

  if [ -n "$OPENROUTER_KEY" ]; then
    mkdir -p "$UNIPI_CONFIG_DIR"
    # Merge with existing config or create new
    node -e "
      const fs = require('fs');
      const path = '$UNIPI_CONFIG';
      let config = {};
      try { config = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e) {}
      config.provider = 'openrouter';
      config.apiKey = '$OPENROUTER_KEY';
      if (!config.model) config.model = 'openai/text-embedding-3-small';
      if (!config.dimensions) config.dimensions = 384;
      fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
      console.log('[PI-WEB] Configured @pi-unipi/memory embeddings (OpenRouter)');
    "
  else
    echo "[PI-WEB] No OpenRouter provider found in models.json — embeddings will use fuzzy-only mode"
  fi
else
  echo "[PI-WEB] No models.json found, skipping extension API key auto-configure"
fi

# ─── Start ────────────────────────────────────
echo "[PI-WEB] Starting server..."
cd /app
export PI_WEB_VERSION
exec node backend/dist/index.js
