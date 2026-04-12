#!/usr/bin/env bash
# SoloMD installer — https://solomd.app
#
# Works on macOS and Linux. Windows users: use install.ps1 instead.
#
# Usage:
#   curl -fsSL https://solomd.app/install.sh | bash
#
# What it does:
#   1. Detects your OS (macOS / Linux) + architecture
#   2. Fetches the latest release from GitHub
#   3. Downloads and installs the right package
#
# macOS: no root needed (copies to /Applications)
# Linux: uses .deb / .rpm with sudo, falls back to ~/Applications/SoloMD.AppImage

set -e

REPO="zhitongblog/solomd"
ORANGE='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${ORANGE}==>${RESET} ${BOLD}%s${RESET}\n" "$*"; }
error() { printf "${ORANGE}Error:${RESET} %s\n" "$*" >&2; exit 1; }

# ---- OS detect ----------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin) OS_KIND=macos ;;
  Linux)  OS_KIND=linux ;;
  *) error "Unsupported OS: $OS. For Windows use https://solomd.app/install.ps1" ;;
esac

# ---- Fetch latest tag ---------------------------------------------
info "Fetching latest SoloMD release from GitHub…"
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
  | grep -E '"tag_name":' | head -1 \
  | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
[ -z "$LATEST_TAG" ] && error "Failed to fetch latest version. Check your internet connection."
VERSION="${LATEST_TAG#v}"
BASE_URL="https://github.com/$REPO/releases/download/$LATEST_TAG"
info "Latest version: $LATEST_TAG"

# ---- macOS --------------------------------------------------------
install_macos() {
  local dmg_url="$BASE_URL/SoloMD_${VERSION}_universal.dmg"
  local tmp_dmg="/tmp/SoloMD_${VERSION}.dmg"

  info "Downloading $dmg_url"
  curl -fL --progress-bar -o "$tmp_dmg" "$dmg_url" || error "Download failed"

  info "Mounting DMG…"
  local mount_point
  mount_point=$(hdiutil attach -nobrowse -quiet "$tmp_dmg" | tail -1 | awk '{$1=$2=""; sub(/^ +/,""); print}')
  [ -z "$mount_point" ] && error "Failed to mount DMG"

  info "Copying SoloMD.app to /Applications…"
  rm -rf /Applications/SoloMD.app
  cp -R "$mount_point/SoloMD.app" /Applications/ || {
    hdiutil detach "$mount_point" -quiet
    error "Copy failed — do you have write permission to /Applications?"
  }
  hdiutil detach "$mount_point" -quiet
  rm -f "$tmp_dmg"

  # Remove quarantine flag so Gatekeeper doesn't complain on first launch
  xattr -dr com.apple.quarantine /Applications/SoloMD.app 2>/dev/null || true

  printf "\n✨ ${BOLD}SoloMD installed to /Applications/SoloMD.app${RESET}\n"
  printf "Launch with: ${BOLD}open /Applications/SoloMD.app${RESET} or Launchpad.\n\n"
}

# ---- Linux --------------------------------------------------------
install_linux() {
  local arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) ;;
    *) error "Unsupported architecture: $arch. Only x86_64/amd64 is supported." ;;
  esac

  if command -v dpkg >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    local url="$BASE_URL/SoloMD_${VERSION}_amd64.deb"
    local tmp="/tmp/solomd_${VERSION}.deb"
    info "Detected Debian/Ubuntu. Downloading .deb…"
    curl -fL --progress-bar -o "$tmp" "$url" || error "Download failed"
    info "Installing with sudo dpkg…"
    sudo dpkg -i "$tmp" || {
      info "Resolving dependencies (sudo apt-get install -f)…"
      sudo apt-get install -f -y
    }
    rm -f "$tmp"
    printf "\n✨ ${BOLD}SoloMD installed. Run with: solomd${RESET}\n\n"
  elif command -v rpm >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    local url="$BASE_URL/SoloMD-${VERSION}-1.x86_64.rpm"
    local tmp="/tmp/solomd_${VERSION}.rpm"
    info "Detected RPM system. Downloading .rpm…"
    curl -fL --progress-bar -o "$tmp" "$url" || error "Download failed"
    info "Installing with sudo rpm…"
    sudo rpm -i --replacepkgs "$tmp"
    rm -f "$tmp"
    printf "\n✨ ${BOLD}SoloMD installed. Run with: solomd${RESET}\n\n"
  else
    info "No dpkg/rpm detected — falling back to AppImage (no sudo needed)"
    mkdir -p "$HOME/Applications"
    local url="$BASE_URL/SoloMD_${VERSION}_amd64.AppImage"
    local dest="$HOME/Applications/SoloMD.AppImage"
    curl -fL --progress-bar -o "$dest" "$url" || error "Download failed"
    chmod +x "$dest"
    printf "\n✨ ${BOLD}SoloMD installed to ~/Applications/SoloMD.AppImage${RESET}\n"
    printf "Run with: ${BOLD}%s${RESET}\n\n" "$dest"
  fi
}

case "$OS_KIND" in
  macos) install_macos ;;
  linux) install_linux ;;
esac

info "Docs + support: https://solomd.app"
