# SoloMD installer for Windows — https://solomd.app
#
# Usage (PowerShell):
#   irm https://solomd.app/install.ps1 | iex
#
# Downloads the latest .msi installer and runs it interactively.
# For silent install: set $env:SOLOMD_SILENT=1 before running.

$ErrorActionPreference = 'Stop'
$repo = "zhitongblog/solomd"

function Write-Step($msg) {
    Write-Host "==> " -ForegroundColor Yellow -NoNewline
    Write-Host $msg
}

Write-Step "Fetching latest SoloMD release from GitHub..."
try {
    $latest = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -ErrorAction Stop
} catch {
    Write-Host "Error: failed to reach GitHub API. Check your internet connection." -ForegroundColor Red
    exit 1
}
$tag = $latest.tag_name
$version = $tag -replace '^v', ''
Write-Host "Latest version: $tag"

# Prefer x64 MSI (Tauri bundles x64 by default)
$asset = $latest.assets | Where-Object { $_.name -like "SoloMD_*_x64_en-US.msi" } | Select-Object -First 1
if (-not $asset) {
    # Fallback to setup.exe (NSIS)
    $asset = $latest.assets | Where-Object { $_.name -like "SoloMD_*_x64-setup.exe" } | Select-Object -First 1
}
if (-not $asset) {
    Write-Host "Error: no Windows installer found in latest release" -ForegroundColor Red
    exit 1
}

$out = Join-Path $env:TEMP $asset.name
Write-Step "Downloading $($asset.name) to $out..."
try {
    # Progress bar shows bytes downloaded
    $ProgressPreference = 'SilentlyContinue'  # cleaner output
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -UseBasicParsing
} catch {
    Write-Host "Error: download failed: $_" -ForegroundColor Red
    exit 1
}

Write-Step "Launching installer..."
if ($env:SOLOMD_SILENT -eq '1') {
    # Silent install (MSI only)
    if ($asset.name -like '*.msi') {
        Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', "`"$out`"", '/qn' -Wait
    } else {
        Start-Process -FilePath $out -ArgumentList '/S' -Wait
    }
} else {
    Start-Process -FilePath $out -Wait
}

Remove-Item $out -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "[OK] SoloMD installed. Launch from the Start Menu." -ForegroundColor Green
Write-Host "Docs: https://solomd.app"
Write-Host ""
