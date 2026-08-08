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
YELLOW='\033[0;93m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${ORANGE}==>${RESET} ${BOLD}%s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}warn:${RESET} %s\n" "$*"; }
error() { printf "${ORANGE}Error:${RESET} %s\n" "$*" >&2; exit 1; }

# ---- WSL detection -----------------------------------------------
is_wsl() {
  if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSLENV:-}" ]; then
    return 0
  fi
  if [ -r /proc/version ] && grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
    return 0
  fi
  return 1
}

has_wslg() {
  [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]
}

# ---- Resolve package file names from uname -m --------------------
# Different package formats use different naming conventions for the
# same CPU architecture (e.g., .deb uses "arm64", .rpm uses "aarch64").
resolve_arch() {
  local raw="$(uname -m)"

  case "$raw" in
    x86_64|amd64)
      DEB_ARCH="amd64"
      RPM_ARCH="x86_64"
      APPIMAGE_ARCH="amd64"
      PORTABLE_ARCH="x64"
      ;;
    aarch64|arm64)
      DEB_ARCH="arm64"
      RPM_ARCH="aarch64"
      APPIMAGE_ARCH="aarch64"
      PORTABLE_ARCH="arm64"
      ;;
    *)
      error "Unsupported architecture: $raw. Supported: x86_64/amd64, aarch64/arm64."
      ;;
  esac
}

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
info "Detected architecture: $(uname -m)"

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

  xattr -dr com.apple.quarantine /Applications/SoloMD.app 2>/dev/null || true

  printf "\n✨ ${BOLD}SoloMD installed to /Applications/SoloMD.app${RESET}\n"
  printf "Launch with: ${BOLD}open /Applications/SoloMD.app${RESET} or Launchpad.\n\n"
}

# ---- GUI dependencies ---------------------------------------------
install_gui_deps() {
  if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    info "Installing GUI dependencies (WebKitGTK, GTK3, fuse)…"
    sudo apt-get update -qq
    sudo apt-get install -y -qq \
      libwebkit2gtk-4.1-0 \
      libgtk-3-0 \
      libayatana-appindicator3-1 \
      librsvg2-2 \
      libsoup-3.0-0 \
      fuse 2>/dev/null || true
  elif command -v dnf >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    info "Installing GUI dependencies (WebKitGTK, GTK3, fuse)…"
    sudo dnf install -y -q \
      webkit2gtk4.1 \
      gtk3 \
      libappindicator-gtk3 \
      librsvg2 \
      fuse 2>/dev/null || true
  fi
}

# ---- Linux --------------------------------------------------------
install_linux() {
  resolve_arch

  if is_wsl; then
    info "Detected WSL environment."
    if ! has_wslg; then
      warn "No DISPLAY or WAYLAND_DISPLAY found — your WSL does not have WSLg."
      warn "SoloMD will install but WON'T launch. Fix by:"
      warn "  • Upgrading to Windows 11 (has WSLg built-in), OR"
      warn "  • Running 'wsl --update' on Windows 10 21H2+, OR"
      warn "  • Installing an external X server (VcXsrv / X410)"
      printf "\nContinue anyway? (y/N) "
      read -r answer < /dev/tty 2>/dev/null || answer=n
      case "$answer" in
        [yY]*) ;;
        *) error "Aborted. Set up WSLg first, then re-run this script." ;;
      esac
    else
      info "WSLg GUI support detected ✓"
    fi
    install_gui_deps
  fi

  if command -v dpkg >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    # ---- .deb path (Debian / Ubuntu / Kali / Mint) ----------------
    local url="$BASE_URL/SoloMD_${VERSION}_${DEB_ARCH}.deb"
    local tmp="/tmp/solomd_${VERSION}.deb"
    info "Detected Debian/Ubuntu. Downloading $url"
    curl -fL --progress-bar -o "$tmp" "$url" || error "Download failed"
    info "Installing with sudo dpkg…"
    sudo dpkg -i "$tmp" || {
      info "Resolving dependencies (sudo apt-get install -f)…"
      sudo apt-get install -f -y
    }
    rm -f "$tmp"
    if [ -x /usr/bin/SoloMD ] && ! [ -e /usr/bin/solomd ]; then
      sudo ln -sf /usr/bin/SoloMD /usr/bin/solomd
      info "Created symlink: solomd → SoloMD"
    fi
    printf "\n✨ ${BOLD}SoloMD installed. Run with: solomd${RESET}\n\n"

  elif command -v rpm >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    # ---- .rpm path (Fedora / RHEL / openSUSE) --------------------
    local url="$BASE_URL/SoloMD-${VERSION}-1.${RPM_ARCH}.rpm"
    local tmp="/tmp/solomd_${VERSION}.rpm"
    info "Detected RPM system. Downloading $url"
    curl -fL --progress-bar -o "$tmp" "$url" || error "Download failed"
    info "Installing with sudo rpm…"
    sudo rpm -i --replacepkgs "$tmp"
    rm -f "$tmp"
    if [ -x /usr/bin/SoloMD ] && ! [ -e /usr/bin/solomd ]; then
      sudo ln -sf /usr/bin/SoloMD /usr/bin/solomd
      info "Created symlink: solomd → SoloMD"
    fi
    printf "\n✨ ${BOLD}SoloMD installed. Run with: solomd${RESET}\n\n"

  else
    # ---- AppImage fallback ---------------------------------------
    info "No dpkg/rpm detected — falling back to AppImage (no sudo needed)"
    install_gui_deps
    mkdir -p "$HOME/Applications"
    local url="$BASE_URL/SoloMD_${VERSION}_${APPIMAGE_ARCH}.AppImage"
    local dest="$HOME/Applications/SoloMD.AppImage"
    info "Downloading $url"
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

