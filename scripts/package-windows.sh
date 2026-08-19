#!/usr/bin/env bash
# =============================================================
# package-windows.sh — build the double-click Windows package.
# =============================================================
# Maintainer-run only (Linux/macOS dev machine) — the end user never sees
# this script. Produces a .zip containing:
#   - the UNMODIFIED official Windows Node.js runtime (keeps its valid
#     Node.js Foundation signature — this is why we don't use pkg/SEA, which
#     produce a modified/unsigned binary that trips SmartScreen)
#   - a clean, production-only copy of this app (npm ci --omit=dev, built
#     inside the staging copy so the dev machine's own node_modules/ is
#     never touched)
#   - a "Run Planner.bat" launcher and a plain-English README.txt
#
# Requires: curl, unzip, zip, sha256sum, npm, node (all already on this box).
# =============================================================

set -euo pipefail

# ---- config (bump the pin deliberately; never float "latest") -------------
NODE_VERSION="24.19.0"
NODE_DIST="node-v${NODE_VERSION}-win-x64"
NODE_ZIP="${NODE_DIST}.zip"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}"
NODE_SHASUMS_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${NODE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/materials-planner-packaging}"
DIST_DIR="${REPO_ROOT}/dist"
STAGE_NAME="materials-planner-windows"
STAGE_DIR="${DIST_DIR}/${STAGE_NAME}"
APP_VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
ZIP_PATH="${DIST_DIR}/${STAGE_NAME}-v${APP_VERSION}-node${NODE_VERSION}.zip"

echo "== Materials Purchase Planner — Windows package build =="

# Safety net, not a hard gate: warn if the working tree has uncommitted
# changes, since the build packages whatever is on disk right now, not
# whatever is committed.
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
    echo "WARNING: working tree has uncommitted changes — packaging them as-is." >&2
  fi
fi

mkdir -p "$CACHE_DIR"

# ---- 1. download the official Node zip (cached) + verify its checksum -----
if [ ! -f "$CACHE_DIR/$NODE_ZIP" ]; then
  echo "Downloading $NODE_URL ..."
  curl -fL --retry 3 -o "$CACHE_DIR/$NODE_ZIP.part" "$NODE_URL"
  mv "$CACHE_DIR/$NODE_ZIP.part" "$CACHE_DIR/$NODE_ZIP"
else
  echo "Using cached $CACHE_DIR/$NODE_ZIP"
fi

curl -fsSL -o "$CACHE_DIR/SHASUMS256.txt.$NODE_VERSION" "$NODE_SHASUMS_URL"
EXPECTED_SHA="$(grep -F "  ${NODE_ZIP}" "$CACHE_DIR/SHASUMS256.txt.$NODE_VERSION" | awk '{print $1}')"
ACTUAL_SHA="$(sha256sum "$CACHE_DIR/$NODE_ZIP" | awk '{print $1}')"
if [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "ERROR: checksum mismatch for $NODE_ZIP (expected '$EXPECTED_SHA', got '$ACTUAL_SHA')" >&2
  exit 1
fi
echo "Checksum OK ($ACTUAL_SHA)."

# ---- 2. clean, re-creatable staging dir ------------------------------------
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# ---- 3. extract the unmodified portable runtime ----------------------------
unzip -q "$CACHE_DIR/$NODE_ZIP" -d "$STAGE_DIR"
mv "$STAGE_DIR/$NODE_DIST" "$STAGE_DIR/node"

# ---- 4. assemble a clean, prod-only copy of the app ------------------------
APP_DIR="$STAGE_DIR/app"
mkdir -p "$APP_DIR"
cp -R "$REPO_ROOT/src" "$APP_DIR/src"
cp -R "$REPO_ROOT/public" "$APP_DIR/public"
cp "$REPO_ROOT/package.json" "$APP_DIR/package.json"
cp "$REPO_ROOT/package-lock.json" "$APP_DIR/package-lock.json"

# Runs INSIDE the disposable staging copy — never touches the dev machine's
# own root node_modules/. This is the isolation mechanism, not a flag.
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund )

# ---- 5. generate the launcher + README (CRLF — see note below) ------------
# .gitattributes' `text=auto` only normalizes files git TRACKS. dist/ is
# gitignored, so it never applies here — force CRLF ourselves. cmd.exe has
# real quirks with LF-only batch files, and old Notepad renders LF-only text
# as one unbroken line.
cat <<'BATCH' | sed 's/$/\r/' > "$STAGE_DIR/Run Planner.bat"
@echo off
setlocal EnableExtensions

rem === Materials Purchase Planner - Windows launcher ===
rem This black window IS the server. Closing it stops the planner.

rem Re-invoke this same file in the background with a marker argument to
rem open the browser after a short delay. Avoids nested cmd /c quoting.
if "%~1"=="__open_browser__" (
    timeout /t 3 /nobreak >nul
    start "" "http://127.0.0.1:%~2"
    exit /b 0
)

title Materials Purchase Planner
cd /d "%~dp0"

set "HOST=127.0.0.1"
set "PORT=3000"

if not exist "%~dp0node\node.exe" (
    echo Could not find node\node.exe next to this script.
    echo Please re-download and unzip the Materials Purchase Planner folder, then try again.
    pause
    exit /b 1
)
if not exist "%~dp0app\src\planner\server.js" (
    echo Could not find app\src\planner\server.js next to this script.
    echo Please re-download and unzip the Materials Purchase Planner folder, then try again.
    pause
    exit /b 1
)

echo Materials Purchase Planner
echo ---------------------------
echo Starting on http://127.0.0.1:%PORT% ...
echo Your browser will open automatically in a moment.
echo.
echo Do NOT close this window while you're using the planner.
echo Closing this window stops the planner.
echo.

start /b "" "%~f0" __open_browser__ %PORT%

"%~dp0node\node.exe" "%~dp0app\src\planner\server.js"

set "PLANNER_EXIT=%ERRORLEVEL%"
if not "%PLANNER_EXIT%"=="0" (
    echo.
    echo The planner stopped unexpectedly ^(code %PLANNER_EXIT%^).
    echo Take a screenshot of this window if you need help.
    echo.
    pause
)

endlocal
BATCH

cat <<'TXT' | sed 's/$/\r/' > "$STAGE_DIR/README.txt"
Materials Purchase Planner — Windows

HOW TO START
1. Unzip this whole folder anywhere on your computer (Desktop, Documents, a
   USB drive — anywhere is fine).
2. Open the folder and double-click "Run Planner.bat".
3. A black window will open — this is normal. Leave it open while you use
   the planner. Your web browser will open automatically in a few seconds.
4. When you're done, just close the black window. That stops the planner.

TO START IT AGAIN LATER
Double-click "Run Planner.bat" again. Nothing needs to be reinstalled.

IF WINDOWS SHOWS A WARNING
- "Windows protected your PC" (blue box): click "More info", then
  "Run anyway". This tool isn't code-signed (it's a small internal tool),
  so Windows shows this once for unfamiliar downloads.
- A firewall prompt about node.exe: click "Allow access" (Private networks
  is fine). The planner only talks to your own browser on this same
  computer — it does not use the internet.

TROUBLESHOOTING
- The black window flashes and closes: double-click again and read what it
  says before it closes.
- Browser doesn't open by itself: open any browser and go to
  http://127.0.0.1:3000 — the planner is probably already running.
- "This site can't be reached": wait a few seconds and refresh.

This tool never sends your files anywhere. Everything happens on this
computer.
TXT

# ---- 6. zip it ---------------------------------------------------------------
rm -f "$ZIP_PATH"
( cd "$DIST_DIR" && zip -rq -X "$ZIP_PATH" "$STAGE_NAME" )

echo "Built: $ZIP_PATH"
du -h "$ZIP_PATH"
