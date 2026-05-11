#!/usr/bin/env bash
#
# Upload a built iOS .ipa to App Store Connect via altool.
#
# Usage: ./scripts/submit-ios.sh [path/to/SoloMD.ipa]
#
# Defaults to app/src-tauri/gen/apple/build/arm64/SoloMD.ipa when no arg.
#
# Required env (from .env.local):
#   APPLE_ID         your Apple ID email
#   APPLE_PASSWORD   app-specific password (not your Apple ID password)
#   APPLE_TEAM_ID    Apple Developer team ID, e.g. 6NQM3XP5RF

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

IPA="${1:-app/src-tauri/gen/apple/build/arm64/SoloMD.ipa}"
[ -f "$IPA" ] || { echo "ERROR: $IPA not found. Run ./scripts/build-ios.sh first." >&2; exit 1; }

echo "==> Validating $IPA against App Store Connect"
xcrun altool --validate-app \
  -f "$IPA" \
  -t ios \
  -u "$APPLE_ID" \
  -p "$APPLE_PASSWORD" \
  --asc-provider "$APPLE_TEAM_ID"

echo ""
echo "==> Uploading $IPA"
xcrun altool --upload-app \
  -f "$IPA" \
  -t ios \
  -u "$APPLE_ID" \
  -p "$APPLE_PASSWORD" \
  --asc-provider "$APPLE_TEAM_ID"

echo ""
echo "==> Upload complete. Build will appear in App Store Connect after ~5-15 min."
echo "    Builds:   https://appstoreconnect.apple.com/apps/6762498874/testflight/ios"
echo "    Versions: https://appstoreconnect.apple.com/apps/6762498874/distribution/ios"
