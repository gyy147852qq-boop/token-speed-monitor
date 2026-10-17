param([int]$Port = 7391)
# Opens the dashboard in a standalone application window (no browser tabs/address bar).
# Starts the local server first if it is not already running.

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/"

function Test-Server {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (-not (Test-Server)) {
  Start-Process -FilePath "node" -ArgumentList "app/server.mjs" -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 300
    if (Test-Server) { break }
  }
}

# Prefer an Edge/Chromium "app window": it looks like a real desktop app.
$browsers = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
foreach ($b in $browsers) {
  if (Test-Path $b) {
    Start-Process -FilePath $b -ArgumentList "--app=$url"
    exit 0
  }
}
# Fallback: default browser
Start-Process $url
