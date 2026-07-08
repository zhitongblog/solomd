<#
.SYNOPSIS
    Builds the solomd-mcp sidecar binary for the current Rust target and copies
    it into app/src-tauri/binaries/ under Tauri's externalBin naming convention.

.DESCRIPTION
    Equivalent of build-mcp-sidecar.sh for Windows. Called automatically by
    `pnpm tauri build` via beforeBundleCommand in tauri.conf.json.

    Usage:
        .\scripts\build-mcp-sidecar.ps1                   # current host target
        .\scripts\build-mcp-sidecar.ps1 -Target aarch64-apple-darwin
#>

param(
    [string]$Target = ""
)

$ErrorActionPreference = "Stop"

# Resolve repo paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$McpCrate = Join-Path $RepoRoot "mcp-server"
$OutDir = Join-Path $RepoRoot "app" | Join-Path -ChildPath "src-tauri" | Join-Path -ChildPath "binaries"

# Determine target triple
if (-not $Target) {
    $rustcLines = rustc -vV
    foreach ($line in $rustcLines) {
        if ($line -match '^host:\s+(.+)$') {
            $Target = $matches[1].Trim()
            break
        }
    }
    if (-not $Target) {
        Write-Host "build-mcp-sidecar: could not determine rust target triple"
        exit 1
    }
}

Write-Host "build-mcp-sidecar: building solomd-mcp for $Target"

# Build
Push-Location $McpCrate
try {
    cargo build --release --target $Target
    if ($LASTEXITCODE -ne 0) {
        Write-Host "cargo build failed with exit code $LASTEXITCODE"
        exit 1
    }
} finally {
    Pop-Location
}

# Pick extension
$exe = if ($Target -like "*windows*") { ".exe" } else { "" }

$SrcBin = Join-Path $McpCrate "target" | Join-Path -ChildPath $Target | Join-Path -ChildPath "release" | Join-Path -ChildPath "solomd-mcp$exe"
if (-not (Test-Path $SrcBin)) {
    Write-Host "build-mcp-sidecar: expected $SrcBin but it doesn't exist"
    exit 1
}

# Copy into Tauri's externalBin staging dir
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$Dest = Join-Path $OutDir "solomd-mcp-$Target$exe"
Copy-Item -LiteralPath $SrcBin -Destination $Dest -Force

Write-Host "build-mcp-sidecar: -> $Dest"
