#!/usr/bin/env bash
# Publish SoloMD to all package managers in one command.
#
# Usage:
#   ./scripts/publish-packages.sh 0.1.9                 # all platforms
#   ./scripts/publish-packages.sh 0.1.9 brew            # just Homebrew
#   ./scripts/publish-packages.sh 0.1.9 brew winget     # multiple
#
# Supported platforms: brew, winget, scoop, choco
# (AUR is NOT supported here — requires SSH access to aur.archlinux.org,
#  see aur-solomd-bin/ for manual submission steps.)
#
# Prerequisites:
#   - gh CLI authenticated
#   - nuget installed (brew install nuget)
#   - CHOCOLATEY_API_KEY env var or .env.local file with it
#   - Fork repos already exist on your GitHub account:
#       zhitongblog/homebrew-cask, zhitongblog/winget-pkgs, zhitongblog/Extras

set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 VERSION [brew|winget|scoop|choco|all]"
    echo "Example: $0 0.1.9"
    exit 1
fi

VERSION="$1"
shift

# Default: all platforms
if [ "$#" -eq 0 ]; then
    TARGETS=("brew" "winget" "scoop" "choco")
else
    TARGETS=("$@")
fi

REPO="zhitongblog/solomd"
BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"
YOUR_GH="zhitongblog"

# Colors
ORANGE='\033[0;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${ORANGE}==>${RESET} ${BOLD}%s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

# ==================================================================
# Check release exists on GitHub
# ==================================================================
info "Verifying v${VERSION} release exists on GitHub…"
if ! gh release view "v${VERSION}" --repo "$REPO" >/dev/null 2>&1; then
    fail "Release v${VERSION} not found. Push the tag first."
    exit 1
fi
ok "Release v${VERSION} found"

# ==================================================================
# Download installers and compute SHA256 (cached)
# ==================================================================
CACHE_DIR="/tmp/solomd-release-${VERSION}"
mkdir -p "$CACHE_DIR"

fetch_sha256() {
    local asset="$1"
    local cache_file="${CACHE_DIR}/${asset}.sha256"
    if [ -f "$cache_file" ]; then
        cat "$cache_file"
        return
    fi
    local url="${BASE_URL}/${asset}"
    local sha
    sha=$(curl -sL --max-time 600 "$url" | shasum -a 256 | awk '{print $1}')
    if [ -z "$sha" ] || [ "$sha" = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]; then
        fail "Empty hash for $asset — download failed"
        return 1
    fi
    echo "$sha" > "$cache_file"
    echo "$sha"
}

DMG="SoloMD_${VERSION}_universal.dmg"
MSI="SoloMD_${VERSION}_x64_en-US.msi"
EXE="SoloMD_${VERSION}_x64-setup.exe"
APPIMAGE="SoloMD_${VERSION}_amd64.AppImage"

# ==================================================================
# Homebrew Cask
# ==================================================================
publish_brew() {
    info "Publishing to Homebrew Cask…"
    local sha
    sha=$(fetch_sha256 "$DMG") || return 1
    ok "DMG SHA256: $sha"

    local repo_dir="/tmp/homebrew-cask"
    if [ ! -d "$repo_dir/.git" ]; then
        info "Cloning Homebrew/homebrew-cask (this takes a while)…"
        gh repo clone Homebrew/homebrew-cask "$repo_dir" -- --depth=1 >/dev/null 2>&1
        (cd "$repo_dir" && git remote add fork "https://github.com/${YOUR_GH}/homebrew-cask.git" 2>/dev/null || true)
    fi

    (
        cd "$repo_dir"
        git fetch origin main 2>&1 | tail -1
        git checkout main 2>/dev/null || git checkout -b main origin/main
        git reset --hard origin/main >/dev/null
        local branch="update-solomd-${VERSION}"
        git checkout -B "$branch" >/dev/null

        cat > "Casks/s/solomd.rb" <<RUBY
cask "solomd" do
  version "${VERSION}"
  sha256 "${sha}"

  url "https://github.com/${REPO}/releases/download/v#{version}/SoloMD_#{version}_universal.dmg",
      verified: "github.com/${REPO}/"
  name "SoloMD"
  desc "Lightweight Markdown and plain text editor"
  homepage "https://solomd.app/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :big_sur"

  app "SoloMD.app"

  zap trash: [
    "~/Library/Application Support/app.solomd",
    "~/Library/Caches/app.solomd",
    "~/Library/Preferences/app.solomd.plist",
    "~/Library/Saved Application State/app.solomd.savedState",
    "~/Library/WebKit/app.solomd",
  ]
end
RUBY

        git add Casks/s/solomd.rb
        git -c user.email=dev@solomd.local -c user.name="${YOUR_GH}" commit -q -m "Update solomd to ${VERSION}"
        git push fork "$branch" --force >/dev/null 2>&1
    )

    local url
    url=$(gh pr create --repo Homebrew/homebrew-cask \
        --head "${YOUR_GH}:update-solomd-${VERSION}" \
        --title "Update solomd to ${VERSION}" \
        --body "Update SoloMD to v${VERSION}. See release notes: https://github.com/${REPO}/releases/tag/v${VERSION}" 2>&1 | tail -1 || true)
    ok "Homebrew PR: $url"
}

# ==================================================================
# winget
# ==================================================================
publish_winget() {
    info "Publishing to winget…"
    local sha
    sha=$(fetch_sha256 "$MSI") || return 1
    ok "MSI SHA256: $sha"

    local repo_dir="${HOME}/code/notebook/winget-pkgs"
    if [ ! -d "$repo_dir/.git" ]; then
        info "Cloning winget-pkgs (this takes a while)…"
        gh repo clone "${YOUR_GH}/winget-pkgs" "$repo_dir" -- --depth=1 >/dev/null 2>&1
        (cd "$repo_dir" && git remote add upstream https://github.com/microsoft/winget-pkgs.git 2>/dev/null || true)
    fi

    (
        cd "$repo_dir"
        git fetch upstream master 2>&1 | tail -1
        git checkout master 2>/dev/null || git checkout -b master upstream/master
        git reset --hard upstream/master >/dev/null
        local branch="add-solomd-${VERSION}"
        git checkout -B "$branch" >/dev/null

        local manifest_dir="manifests/z/zhitong/SoloMD/${VERSION}"
        mkdir -p "$manifest_dir"

        local sha_upper
        sha_upper=$(echo "$sha" | tr '[:lower:]' '[:upper:]')
        local today
        today=$(date +%Y-%m-%d)

        cat > "$manifest_dir/zhitong.SoloMD.yaml" <<YAML
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.version.1.9.0.schema.json

PackageIdentifier: zhitong.SoloMD
PackageVersion: ${VERSION}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.9.0
YAML

        cat > "$manifest_dir/zhitong.SoloMD.installer.yaml" <<YAML
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.installer.1.9.0.schema.json

PackageIdentifier: zhitong.SoloMD
PackageVersion: ${VERSION}
MinimumOSVersion: 10.0.17763.0
InstallerType: wix
UpgradeBehavior: install
FileExtensions:
- md
- markdown
- mdown
- mkd
- txt
ReleaseDate: ${today}
Installers:
- Architecture: x64
  InstallerUrl: https://github.com/${REPO}/releases/download/v${VERSION}/SoloMD_${VERSION}_x64_en-US.msi
  InstallerSha256: ${sha_upper}
ManifestType: installer
ManifestVersion: 1.9.0
YAML

        cat > "$manifest_dir/zhitong.SoloMD.locale.en-US.yaml" <<YAML
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.defaultLocale.1.9.0.schema.json

PackageIdentifier: zhitong.SoloMD
PackageVersion: ${VERSION}
PackageLocale: en-US
Publisher: zhitong
PublisherUrl: https://github.com/${YOUR_GH}
PublisherSupportUrl: https://github.com/${REPO}/issues
PackageName: SoloMD
PackageUrl: https://solomd.app
License: MIT
LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE
Copyright: Copyright (c) 2026 xiangdong li
ShortDescription: A lightweight Markdown and plain text editor
Description: |-
  SoloMD is a free, open-source, cross-platform Markdown + plain text editor
  built with Tauri 2 + Vue 3 + CodeMirror 6. Under 15 MB installed.
Moniker: solomd
Tags:
- editor
- markdown
- text-editor
- tauri
- vim
ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${VERSION}
Documentations:
- DocumentLabel: Website
  DocumentUrl: https://solomd.app
ManifestType: defaultLocale
ManifestVersion: 1.9.0
YAML

        git add "$manifest_dir/"
        git -c user.email=dev@solomd.local -c user.name="${YOUR_GH}" commit -q -m "New version: zhitong.SoloMD version ${VERSION}"
        git push origin "$branch" --force >/dev/null 2>&1
    )

    local url
    url=$(gh pr create --repo microsoft/winget-pkgs \
        --head "${YOUR_GH}:add-solomd-${VERSION}" \
        --title "New version: zhitong.SoloMD version ${VERSION}" \
        --body "Update SoloMD to v${VERSION}. Release notes: https://github.com/${REPO}/releases/tag/v${VERSION}" 2>&1 | tail -1 || true)
    ok "winget PR: $url"
}

# ==================================================================
# Scoop
# ==================================================================
publish_scoop() {
    info "Publishing to Scoop Extras…"
    local sha
    sha=$(fetch_sha256 "$EXE") || return 1
    ok "EXE SHA256: $sha"

    local repo_dir="/tmp/scoop-extras"
    if [ ! -d "$repo_dir/.git" ]; then
        info "Cloning ScoopInstaller/Extras (this takes a while)…"
        gh repo clone ScoopInstaller/Extras "$repo_dir" -- --depth=1 >/dev/null 2>&1
        (cd "$repo_dir" && git remote add fork "https://github.com/${YOUR_GH}/Extras.git" 2>/dev/null || true; git remote add upstream https://github.com/ScoopInstaller/Extras.git 2>/dev/null || true)
    fi

    (
        cd "$repo_dir"
        git fetch upstream master 2>&1 | tail -1
        git checkout master 2>/dev/null || git checkout -b master upstream/master
        git reset --hard upstream/master >/dev/null
        local branch="update-solomd-${VERSION}"
        git checkout -B "$branch" >/dev/null

        cat > "bucket/solomd.json" <<JSON
{
    "version": "${VERSION}",
    "description": "A lightweight Markdown and plain text editor built with Tauri 2",
    "homepage": "https://solomd.app",
    "license": "MIT",
    "architecture": {
        "64bit": {
            "url": "https://github.com/${REPO}/releases/download/v${VERSION}/SoloMD_${VERSION}_x64-setup.exe#/setup.exe",
            "hash": "${sha}"
        }
    },
    "installer": {
        "script": [
            "Start-Process -FilePath \"\$dir\\\\setup.exe\" -ArgumentList '/S', \"/D=\$dir\" -Wait"
        ]
    },
    "uninstaller": {
        "script": [
            "Start-Process -FilePath \"\$dir\\\\uninstall.exe\" -ArgumentList '/S' -Wait"
        ]
    },
    "shortcuts": [
        [
            "SoloMD.exe",
            "SoloMD"
        ]
    ],
    "checkver": "github",
    "autoupdate": {
        "architecture": {
            "64bit": {
                "url": "https://github.com/${REPO}/releases/download/v\$version/SoloMD_\$version_x64-setup.exe#/setup.exe",
                "hash": {
                    "url": "https://github.com/${REPO}/releases/tag/v\$version",
                    "regex": "SoloMD_\$version_x64-setup\\\\.exe.*?\$sha256"
                }
            }
        }
    }
}
JSON

        git add bucket/solomd.json
        git -c user.email=dev@solomd.local -c user.name="${YOUR_GH}" commit -q -m "solomd: Update to ${VERSION}"
        git push fork "$branch" --force >/dev/null 2>&1
    )

    local url
    url=$(gh pr create --repo ScoopInstaller/Extras \
        --head "${YOUR_GH}:update-solomd-${VERSION}" \
        --title "solomd: Update to ${VERSION}" \
        --body "Update SoloMD to v${VERSION}. Release notes: https://github.com/${REPO}/releases/tag/v${VERSION}" 2>&1 | tail -1 || true)
    ok "Scoop PR: $url"
}

# ==================================================================
# Chocolatey
# ==================================================================
publish_choco() {
    info "Publishing to Chocolatey…"

    # Load API key
    local api_key="${CHOCOLATEY_API_KEY:-}"
    if [ -z "$api_key" ] && [ -f "${PWD}/.env.local" ]; then
        # Try to source it
        api_key=$(grep -E '^CHOCOLATEY_API_KEY=' "${PWD}/.env.local" | head -1 | cut -d= -f2- | tr -d '"'"'"'"')
    fi
    if [ -z "$api_key" ]; then
        fail "CHOCOLATEY_API_KEY not set. Export it or put in .env.local"
        return 1
    fi

    local sha
    sha=$(fetch_sha256 "$MSI") || return 1
    ok "MSI SHA256: $sha"

    if ! command -v nuget >/dev/null 2>&1; then
        fail "nuget not installed. Run: brew install nuget"
        return 1
    fi

    local pkg_dir="/tmp/choco-solomd-${VERSION}"
    rm -rf "$pkg_dir"
    mkdir -p "$pkg_dir/tools"
    cd "$pkg_dir"

    cat > solomd.nuspec <<NUSPEC
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd">
  <metadata>
    <id>solomd</id>
    <version>${VERSION}</version>
    <title>SoloMD</title>
    <authors>zhitong</authors>
    <owners>zhitong</owners>
    <projectUrl>https://solomd.app</projectUrl>
    <iconUrl>https://raw.githubusercontent.com/${REPO}/main/brand/solomd_icon_fullbleed.png</iconUrl>
    <licenseUrl>https://github.com/${REPO}/blob/main/LICENSE</licenseUrl>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <tags>markdown editor text-editor tauri vim lightweight</tags>
    <summary>A lightweight Markdown and plain text editor built with Tauri 2</summary>
    <description>SoloMD is a free, open-source Markdown + plain text editor. Under 15 MB installed.

Built with Tauri 2 + Vue 3 + CodeMirror 6 + Rust.

Project source: https://github.com/${REPO}
Documentation: https://solomd.app</description>
    <releaseNotes>https://github.com/${REPO}/releases/tag/v${VERSION}</releaseNotes>
    <copyright>Copyright (c) 2026 xiangdong li</copyright>
  </metadata>
  <files>
    <file src="tools\\**" target="tools" />
  </files>
</package>
NUSPEC

    cat > tools/chocolateyinstall.ps1 <<PS1
\$ErrorActionPreference = 'Stop'
\$packageArgs = @{
    packageName    = 'solomd'
    fileType       = 'msi'
    url64bit       = 'https://github.com/${REPO}/releases/download/v${VERSION}/SoloMD_${VERSION}_x64_en-US.msi'
    checksum64     = '${sha}'
    checksumType64 = 'sha256'
    silentArgs     = '/qn /norestart'
    validExitCodes = @(0, 3010, 1641)
}
Install-ChocolateyPackage @packageArgs
PS1

    cat > tools/chocolateyuninstall.ps1 <<'PS1'
$ErrorActionPreference = 'Stop'
$packageArgs = @{
    packageName    = 'solomd'
    softwareName   = 'SoloMD*'
    fileType       = 'msi'
    silentArgs     = '/qn /norestart'
    validExitCodes = @(0, 3010, 1605, 1614, 1641)
}
[array]$key = Get-UninstallRegistryKey -SoftwareName $packageArgs['softwareName']
if ($key.Count -ge 1) {
    $key[0] | ForEach-Object {
        $packageArgs['file'] = ''
        $packageArgs['silentArgs'] = "$($_.PSChildName) $($packageArgs['silentArgs'])"
        Uninstall-ChocolateyPackage @packageArgs
    }
}
PS1

    nuget pack solomd.nuspec 2>&1 | tail -2
    nuget push "solomd.${VERSION}.nupkg" -Source https://push.chocolatey.org/ -ApiKey "$api_key" 2>&1 | tail -3 \
        && ok "Chocolatey: pushed (awaiting moderation)" \
        || fail "Chocolatey: push failed (previous version may still be in moderation)"
}

# ==================================================================
# Run selected targets
# ==================================================================
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

for target in "${TARGETS[@]}"; do
    case "$target" in
        brew)   publish_brew ;;
        winget) publish_winget ;;
        scoop)  publish_scoop ;;
        choco)  publish_choco ;;
        all)    publish_brew; publish_winget; publish_scoop; publish_choco ;;
        *)      fail "Unknown target: $target (use: brew|winget|scoop|choco|all)" ;;
    esac
done

info "Done."
