<#
=============================================================
package-windows.ps1 — build the double-click Windows package (Windows-native).
=============================================================
The Windows-native counterpart to package-windows.sh. Use this when you're
building ON Windows (Git Bash has no zip/unzip). Produces, under dist/:

  * an extracted, ready-to-run folder (materials-planner-windows\) containing
      - node\      the UNMODIFIED official Windows Node.js runtime (keeps its
                   valid Node.js Foundation signature — no pkg/SEA, which trip
                   SmartScreen)
      - app\       a clean, production-only copy of this app (npm ci --omit=dev,
                   run inside the staging copy so your repo node_modules\ is
                   never touched)
      - Run Planner.bat   the launcher (double-click; no PowerShell, no install)
      - README.txt        plain-English instructions for the recipient
  * the same, zipped, as a single portable file.

Pass -DestDrive 'F:' to also copy the finished folder + zip onto a drive
(e.g. a thumb drive) as "Materials Purchase Planner".

Requires: node, npm, curl.exe (all ship with a normal Node + Windows install).
Bump -NodeVersion deliberately; never float "latest".
=============================================================
#>
#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$NodeVersion = '24.19.0',
  [string]$OutDir,
  [string]$DestDrive
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # keeps Invoke-* / Expand-Archive fast

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'dist' }

$NodeDist   = "node-v$NodeVersion-win-x64"
$NodeZip    = "$NodeDist.zip"
$NodeUrl    = "https://nodejs.org/dist/v$NodeVersion/$NodeZip"
$ShaUrl     = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
$CacheDir   = Join-Path $env:LOCALAPPDATA 'materials-planner-packaging'
$AppVersion = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
$StageName  = 'materials-planner-windows'
$StageDir   = Join-Path $OutDir $StageName
$ZipPath    = Join-Path $OutDir "$StageName-v$AppVersion-node$NodeVersion.zip"

Write-Host "== Materials Purchase Planner - Windows package build =="

# Safety net, not a hard gate: warn on uncommitted changes, since the build
# packages whatever is on disk right now.
try {
  git -C $RepoRoot rev-parse --is-inside-work-tree *> $null
  if ($LASTEXITCODE -eq 0) {
    git -C $RepoRoot diff --quiet; $d1 = $LASTEXITCODE
    git -C $RepoRoot diff --cached --quiet; $d2 = $LASTEXITCODE
    if ($d1 -ne 0 -or $d2 -ne 0) { Write-Warning "working tree has uncommitted changes - packaging them as-is." }
  }
} catch { }

# ---- 1. download the official Node zip (cached) + verify checksum -----------
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
$NodeZipPath = Join-Path $CacheDir $NodeZip
if (-not (Test-Path $NodeZipPath)) {
  Write-Host "Downloading $NodeUrl ..."
  & curl.exe -fL --retry 3 -o "$NodeZipPath.part" $NodeUrl
  if ($LASTEXITCODE -ne 0) { throw "node download failed (curl exit $LASTEXITCODE)" }
  Move-Item "$NodeZipPath.part" $NodeZipPath -Force
} else {
  Write-Host "Using cached $NodeZipPath"
}

$shaText  = & curl.exe -fsSL $ShaUrl
if ($LASTEXITCODE -ne 0) { throw "could not fetch SHASUMS256.txt (curl exit $LASTEXITCODE)" }
$shaLine  = $shaText -split "`n" | Where-Object { $_ -match [regex]::Escape($NodeZip) } | Select-Object -First 1
$expected = if ($shaLine) { (($shaLine.Trim() -split '\s+')[0]).ToLower() } else { '' }
$actual   = (Get-FileHash -Algorithm SHA256 $NodeZipPath).Hash.ToLower()
if (-not $expected -or $expected -ne $actual) {
  throw "checksum mismatch for $NodeZip (expected '$expected', got '$actual')"
}
Write-Host "Checksum OK ($actual)."

# ---- 2. clean, re-creatable staging dir ------------------------------------
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

# ---- 3. extract the unmodified portable runtime ----------------------------
Expand-Archive -Path $NodeZipPath -DestinationPath $StageDir -Force
Move-Item (Join-Path $StageDir $NodeDist) (Join-Path $StageDir 'node')

# ---- 4. assemble a clean, prod-only copy of the app ------------------------
$AppDir = Join-Path $StageDir 'app'
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item (Join-Path $RepoRoot 'src')              (Join-Path $AppDir 'src')     -Recurse
Copy-Item (Join-Path $RepoRoot 'public')           (Join-Path $AppDir 'public')  -Recurse
Copy-Item (Join-Path $RepoRoot 'package.json')     (Join-Path $AppDir 'package.json')
Copy-Item (Join-Path $RepoRoot 'package-lock.json') (Join-Path $AppDir 'package-lock.json')

# Runs INSIDE the disposable staging copy — never touches the dev machine's own
# root node_modules\. This is the isolation mechanism, not a flag.
Push-Location $AppDir
try {
  & npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

# ---- 5. generate the launcher + README (CRLF — cmd.exe / old Notepad) -------
$bat = @'
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
    echo Please re-copy the whole Materials Purchase Planner folder, then try again.
    pause
    exit /b 1
)
if not exist "%~dp0app\src\planner\server.js" (
    echo Could not find app\src\planner\server.js next to this script.
    echo Please re-copy the whole Materials Purchase Planner folder, then try again.
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
'@

$readme = @'
Materials Purchase Planner - Windows

HOW TO START
1. Copy this whole folder onto the computer (Desktop, Documents, or a USB
   drive - anywhere is fine). If you were handed a .zip, right-click it and
   choose "Extract All" first.
2. Open the folder and double-click "Run Planner.bat".
3. A black window will open - this is normal. Leave it open while you use
   the planner. Your web browser will open automatically in a few seconds.
4. When you're done, just close the black window. That stops the planner.

TO START IT AGAIN LATER
Double-click "Run Planner.bat" again. Nothing needs to be reinstalled.

IF WINDOWS SHOWS A WARNING
- "Windows protected your PC" (blue box): click "More info", then
  "Run anyway". This tool isn't code-signed (it's a small internal tool),
  so Windows shows this once for unfamiliar programs.
- A firewall prompt about node.exe: click "Allow access" (Private networks
  is fine). The planner only talks to your own browser on this same
  computer - it does not use the internet.

TROUBLESHOOTING
- The black window flashes and closes: double-click again and read what it
  says before it closes.
- Browser doesn't open by itself: open any browser and go to
  http://127.0.0.1:3000 - the planner is probably already running.
- "This site can't be reached": wait a few seconds and refresh.

This tool never sends your files anywhere. Everything happens on this
computer.
'@

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Crlf($path, $text) {
  $normalized = ($text -replace "`r`n", "`n") -replace "`n", "`r`n"
  [System.IO.File]::WriteAllText($path, $normalized, $utf8NoBom)
}
Write-Crlf (Join-Path $StageDir 'Run Planner.bat') $bat
Write-Crlf (Join-Path $StageDir 'README.txt')      $readme

# ---- 6. zip it --------------------------------------------------------------
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path $StageDir -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "Built folder: $StageDir"
Write-Host "Built zip:    $ZipPath"

# ---- 7. optional copy to a destination drive (thumb drive) ------------------
if ($DestDrive) {
  $destRoot = Join-Path $DestDrive 'Materials Purchase Planner'
  Write-Host "Copying to $destRoot ..."
  if (Test-Path $destRoot) { Remove-Item -Recurse -Force $destRoot }
  Copy-Item $StageDir $destRoot -Recurse
  Copy-Item $ZipPath (Join-Path $DestDrive (Split-Path $ZipPath -Leaf)) -Force
  Write-Host "Copied ready-to-run folder and zip to $DestDrive."
}

Write-Host "Done."
