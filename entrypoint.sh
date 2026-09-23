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
npm install @earendil-works/pi-coding-agent@0.85.1 --no-audit --no-fund --save 2>&1 | tail -3 || true

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

# ─── Extensions Pi : check & install ROBUSTE (recalcul inconditionnel) ───
#
# ROLLBACK « harness+cbm inline → extensions normales » : les deux extensions
# sont redevenues des extensions NORMALES (extensions/harness-orchestrator/,
# extensions/codebase-memory/ — elles ne sont PAS supprimées), chargées par le
# loader PAR DÉFAUT du SDK via settings.extensions.
#
# LE BUG D'ORIGINE : l'ancien bloc était sous garde `if [ -f settings.json ]`
# et son recalcul de settings.extensions n'était atteint que si
# settings.packages contenait des packages npm/git. Sur une install neuve
# (settings.json absent, ou packages: []) : rien n'était écrit → ni
# harness-orchestrator ni codebase-memory dans le settings persistant
# (volume /root/.pi/agent), d'où des sessions sans tools cbm_*/delegate.
#
# Nouvelle logique (à CHAQUE boot, sans condition préalable) :
#  1. settings.json est CRÉÉ s'il est absent (structure minimale valide
#     { packages: [], extensions: [] } — celle du settings-manager du SDK :
#     packages = string[] | {source}[], extensions = string[]) ;
#  2. settings.extensions est RECALCULÉ de façon INCONDITIONNELLE comme
#     l'union de :
#       - extensions npm/git déclarées dans settings.packages, résolues via
#         npm root -g (manifest pi.extensions du package ; chemins vérifiés
#         existsSync — les natifs better-sqlite3/sqlite-vec y sont compilés) ;
#       - extensions locales /app/extensions/*/index.ts présentes sur disque
#         (harness-orchestrator, codebase-memory + les annexes) ;
#  3. ce recalcul EST la purge des chemins morts : tout chemin non vérifié
#     existsSync disparaît du settings au boot. C'est désormais le SEUL
#     garde-fou — l'ancien filtre extensionsOverride (loader custom de
#     session.ts) a été supprimé à l'étape A ;
#  4. idempotence : écriture SEULEMENT si le contenu change (pas d'écriture
#     inutile du volume persistant).
PI_AGENT_DIR="/root/.pi/agent"
PI_SETTINGS="${PI_AGENT_DIR}/settings.json"
NPM_GLOBAL_ROOT=$(npm root -g)

# Ensure global npm root + agent dir exist
mkdir -p "$NPM_GLOBAL_ROOT" "$PI_AGENT_DIR"

# ── Garde DURABLE : neutraliser cbmem.ts (extension auto-générée par CBM) ──
# Le binaire codebase-memory-mcp écrit ~/.pi/agent/extensions/cbmem.ts à
# CHAQUE install/update (bloc auto-régénéré, non éditable durablement). C'est
# un doublon NUISIBLE de nos tools cbm_* de l'extension extensions/codebase-
# memory :
#  - tools à nom NU (search_code, search_graph...) au lieu des cbm_* officiels ;
#  - spawn EN DUR de /root/.local/bin/codebase-memory-mcp — chemin NULLE PART
#    chez nous (le binaire vit dans le volume persistant /app/.data/bin,
#    exporté via CBM_BIN_PATH) → « spawn ENOENT » à chaque appel.
# Le SDK charge AUTOMATIQUEMENT tout *.ts de ~/.pi/agent/extensions/ (scan du
# dossier global extensions/, cf. discoverExtensionsInDir du loader) et
# l'ancien garde extensionsOverride a disparu avec le loader custom : la seule
# neutralisation durable est de détruire le fichier au boot. Il sera régénéré
# par le binaire ; on reneutralisera au boot suivant. (Le SDK ne charge que
# *.ts/*.js : le renommage en .disabled-broken-binpath suffit. Les autres
# fichiers du dossier — firecrawl.json, config du package npm
# @benvargas/pi-firecrawl — ne sont pas des extensions .ts : on n'y touche pas.)
CBMEM_EXT="${PI_AGENT_DIR}/extensions/cbmem.ts"
if [ -f "$CBMEM_EXT" ]; then
  mv -f "$CBMEM_EXT" "${CBMEM_EXT}.disabled-broken-binpath"
  echo "[PI-WEB] Neutralized auto-generated CBM extension (cbmem.ts → .disabled-broken-binpath — doublon des tools cbm_*, BIN_PATH inexistant)"
fi

# Packages npm/git déclarés dans le settings (résolus puis installés
# globalement ci-dessous) — les extensions locales /app/extensions ne
# nécessitent AUCUN npm install : elles vivent dans l'image /app.
PACKAGES=$(node -e "
  try {
    const s = JSON.parse(require('fs').readFileSync('$PI_SETTINGS','utf8'));
    const pkgs = (s.packages || []).map(p => typeof p === 'string' ? p : (p && p.source)).filter(p => p && !p.startsWith('./') && !p.startsWith('/'));
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
else
  echo "[PI-WEB] No npm/git packages declared — local extensions only"
fi

# Recalcul INCONDITIONNEL de settings.extensions (union npm/git résolus ∪
# locales existantes) + création de settings.json si absent + purge des
# chemins morts (existsSync) + écriture seulement si changement (idempotence).
# Un échec ici ne doit JAMAIS bloquer le boot : chaque étape est try/catchée.
node -e "
  const fs = require('fs');
  const path = require('path');

  // 1. Charger ou CRÉER settings.json (install neuve : volume /root/.pi/agent vide)
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync('$PI_SETTINGS', 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('bad shape');
  } catch (e) {
    console.log('[PI-WEB] settings.json absent/illisible — création structure minimale valide');
    settings = {};
  }
  if (!Array.isArray(settings.packages)) settings.packages = [];
  if (!Array.isArray(settings.extensions)) settings.extensions = [];

  // 2. Recalcul : union, chaque chemin poussé est vérifié existsSync
  //    → la purge des chemins morts est intégrée au recalcul
  const next = [];

  // 2a. Packages npm/git : manifest pi.extensions résolu dans npm root -g
  const globalRoot = '$NPM_GLOBAL_ROOT';
  for (const pkg of settings.packages) {
    const source = typeof pkg === 'string' ? pkg : (pkg && pkg.source);
    if (!source || source.startsWith('./') || source.startsWith('/')) continue;
    try {
      const pkgJsonPath = path.join(globalRoot, source, 'package.json');
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const pkgDir = path.dirname(pkgJsonPath);
      for (const ext of (pkgJson.pi && pkgJson.pi.extensions) || []) {
        const extPath = path.resolve(pkgDir, ext);
        if (fs.existsSync(extPath) && !next.includes(extPath)) next.push(extPath);
      }
    } catch (e) {
      console.error('[PI-WEB] Could not read manifest for', source, ':', e.message);
    }
  }

  // 2b. Extensions locales /app/extensions/*/index.ts (existantes sur disque)
  const localDir = '/app/extensions';
  try {
    for (const d of fs.readdirSync(localDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const extPath = path.join(localDir, d.name, 'index.ts');
      if (fs.existsSync(extPath) && !next.includes(extPath)) next.push(extPath);
    }
  } catch (e) {
    // Pas de dossier /app/extensions — ok
  }

  // 3. Écrire SEULEMENT si le contenu change (idempotence : pas d'écriture
  //    inutile du volume persistant /root/.pi/agent). try/catch : un échec
  //    d'écriture ne doit jamais faire avorter le boot (set -e).
  try {
    if (JSON.stringify(settings.extensions) !== JSON.stringify(next)) {
      settings.extensions = next;
      fs.writeFileSync('$PI_SETTINGS', JSON.stringify(settings, null, 2) + '\n');
      console.log('[PI-WEB] settings.extensions recalculated (' + next.length + ' entries):', next);
    } else {
      console.log('[PI-WEB] settings.extensions up to date (' + next.length + ' entries) — nothing to write');
    }
    if (next.length === 0) {
      console.log('[PI-WEB] WARNING: aucune extension résolue — vérifier /app/extensions et settings.packages');
    }
  } catch (e) {
    console.error('[PI-WEB] settings.json write skipped:', e.message);
  }
"
# ── codebase-memory-mcp : binaire PERSISTANT sur le volume /app/.data ──
#
# Deux régressions corrigées ici :
#  1. `--ui` n'existe PLUS dans l'installeur upstream (vérifié : « install.sh:
#     unknown option '--ui' ») — l'ancienne commande échouait donc TOUJOURS.
#     L'erreur était avalée par `2>&1 | tail -3 || true`, d'où un CBM jamais
#     installé sur un Pi-Web neuf (le binaire « --ui » est désormais inclus
#     dans l'archive portable : aucun flag d'installeur n'est nécessaire).
#  2. $HOME/.local/bin n'est PAS un volume : le binaire (~286 Mo) était perdu à
#     chaque rebuild. On l'installe dans /app/.data/bin (volume pi-appdata) et
#     on exporte CBM_BIN_PATH, lu par le backend (routes/cbm.ts) et par
#     l'extension extensions/codebase-memory/index.ts.
CBM_BIN_DIR="/app/.data/bin"
CBM_BIN="$CBM_BIN_DIR/codebase-memory-mcp"
CBM_INSTALL_URL="https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh"
export CBM_BIN_PATH="$CBM_BIN"
mkdir -p "$CBM_BIN_DIR"
if [ ! -f "$CBM_BIN" ]; then
  echo "[PI-WEB] Installing codebase-memory-mcp into persistent volume ($CBM_BIN_DIR)..."
  # Téléchargement du script PUIS exécution (pas de pipe) : avec `curl | bash`,
  # le code de sortie vu par le shell est celui de bash (0) même si curl a
  # échoué — impossible de détecter l'échec.
  if curl -fsSL "$CBM_INSTALL_URL" -o /tmp/cbm-install.sh \
     && bash /tmp/cbm-install.sh --dir "$CBM_BIN_DIR" --skip-config; then
    if [ -f "$CBM_BIN" ]; then
      echo "[PI-WEB] ✓ codebase-memory-mcp installed: $CBM_BIN"
    else
      echo "[PI-WEB] WARNING: installer exited 0 but no binary at $CBM_BIN"
    fi
  else
    echo "[PI-WEB] WARNING: codebase-memory-mcp install failed (see errors above) — graph tools will be unavailable"
  fi
  rm -f /tmp/cbm-install.sh
else
  echo "[PI-WEB] codebase-memory-mcp already installed: $CBM_BIN"
fi

# Persist CBM cache on the /app/.data volume (survives Docker rebuilds)
export CBM_CACHE_DIR="/app/.data/cbm"
mkdir -p "$CBM_CACHE_DIR"

# Start CBM HTTP server in background (3D graph UI on port 9749).
# NOTE (v0.10.4): in --ui mode the HTTP /rpc endpoint is restricted — only
# list_projects and get_code_snippet are allowed; everything else returns 403
# "UI RPC method is not allowed". The Pi extension
# (extensions/codebase-memory/index.ts) therefore talks
# to the binary over MCP stdio for the FULL tool surface;
# this HTTP server is kept alive for the Pi-Web 3D graph UI (/cbm-ui/).
# The binary is an MCP stdio server — it exits if stdin closes.
# We keep stdin open with `tail -f /dev/null` so the HTTP UI stays alive.
if [ -f "$CBM_BIN" ]; then
  tail -f /dev/null | nohup "$CBM_BIN" --ui=true --port=9749 > /tmp/cbm-server.log 2>&1 &
  echo "[PI-WEB] codebase-memory-mcp server starting on port 9749 (PID $!)"
fi

# ─── Start ────────────────────────────────────
# ── P3 (prompt caching) : rétention LONGUE du cache de prompt provider ──
# Le SDK pi-ai lit PI_CACHE_RETENTION : "long" active la rétention étendue
# (Anthropic 1h, OpenAI 24h) LÀ OÙ le provider le supporte, sinon repli
# automatique sur "short". On ne force AUCUN marqueur de cache (breakpoints) :
# c'est le SDK qui décide, donc aucun risque de 400 provider non compatible.
export PI_CACHE_RETENTION="${PI_CACHE_RETENTION:-long}"
echo "[PI-WEB] PI_CACHE_RETENTION=${PI_CACHE_RETENTION}"

echo "[PI-WEB] Starting server..."
cd /app
export PI_WEB_VERSION
exec node backend/dist/index.js
