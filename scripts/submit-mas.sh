#!/usr/bin/env bash
#
# Upload a built MAS .pkg to App Store Connect via altool.
#
# Usage: ./scripts/submit-mas.sh [path/to/SoloMD_X.Y.Z.pkg]
#
# Defaults to the newest .pkg in dist-mas/ when no arg is given.
#
# Required env (from .env.local):
#   APPLE_ID         your Apple ID email
#   APPLE_PASSWORD   app-specific password (not your Apple ID password)
#   APPLE_TEAM_ID    Apple Developer team ID, e.g. 6NQM3XP5RF
#
# altool is technically deprecated in favor of `notarytool` + ASC API key,
# but for MAS uploads it remains supported and matches the credentials
# already in .env.local. If/when we get an ASC API key, swap this for
# `xcrun iTMSTransporter -m upload -assetFile ...`.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${APPLE_ID:?Set APPLE_ID}"
: "${APPLE_PASSWORD:?Set APPLE_PASSWORD}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID}"

PKG="${1:-}"
if [ -z "$PKG" ]; then
  PKG=$(ls -t dist-mas/*.pkg 2>/dev/null | head -1)
fi
if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  echo "ERROR: no .pkg given and dist-mas/ is empty. Run scripts/build-mas.sh first." >&2
  exit 1
fi

echo "==> Validating $PKG against App Store Connect"
xcrun altool --validate-app \
  -f "$PKG" \
  -t osx \
  -u "$APPLE_ID" \
  -p "$APPLE_PASSWORD" \
  --asc-provider "$APPLE_TEAM_ID"

echo ""
echo "==> Uploading $PKG"
xcrun altool --upload-app \
  -f "$PKG" \
  -t osx \
  -u "$APPLE_ID" \
  -p "$APPLE_PASSWORD" \
  --asc-provider "$APPLE_TEAM_ID"

echo ""
echo "==> Upload complete. Build will appear in App Store Connect after ~5-15 min."
echo "    https://appstoreconnect.apple.com/apps/6762498874/distribution/macos"
