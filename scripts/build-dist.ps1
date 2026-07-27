$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$distDir = Join-Path $projectRoot "dist"
$browserDir = Join-Path $distDir "playwright-browsers"
$dataDir = Join-Path $distDir "data"
$logsDir = Join-Path $distDir "logs"

Write-Host "==> Build auto-cskh.exe" -ForegroundColor Cyan
Push-Location $projectRoot
try {
  npm.cmd run build:exe

  Write-Host "==> Create runtime folders" -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $distDir | Out-Null
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $browserDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $logsDir "runs") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $logsDir "errors") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $logsDir "uploads") | Out-Null

  Write-Host "==> Copy runtime files" -ForegroundColor Cyan
  Copy-Item -Path (Join-Path $projectRoot "start.bat") -Destination (Join-Path $distDir "start.bat") -Force

  $envFile = Join-Path $projectRoot ".env"
  if (Test-Path $envFile) {
    Copy-Item -Path $envFile -Destination (Join-Path $distDir ".env") -Force
  } else {
    Write-Warning ".env not found. Create dist\.env before running on client."
  }

  $addressDb = Join-Path $projectRoot "data\address-convert-map.json"
  if (Test-Path $addressDb) {
    Copy-Item -Path $addressDb -Destination (Join-Path $dataDir "address-convert-map.json") -Force
  } else {
    Write-Warning "data\address-convert-map.json not found. Address conversion will fail until this file exists in dist\data."
  }

  Write-Host "==> Install Playwright Chromium into dist\playwright-browsers" -ForegroundColor Cyan
  $env:PLAYWRIGHT_BROWSERS_PATH = $browserDir
  npx.cmd playwright install chromium

  Write-Host ""
  Write-Host "Build complete:" -ForegroundColor Green
  Write-Host "  $distDir"
  Write-Host ""
  Write-Host "Deploy the whole dist folder to client machines, then run start.bat."
}
finally {
  Pop-Location
}
