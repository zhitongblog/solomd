#!/usr/bin/env bash
#
# Local macOS build with Developer ID signing + notarization.
# Run from repo root: ./scripts/build-mac.sh
#
# Required environment variables (export them or put in .env.local):
#   APPLE_SIGNING_IDENTITY  e.g. "Developer ID Application: xiangdong li (6NQM3XP5RF)"
#   APPLE_ID                your Apple ID email
#   APPLE_PASSWORD          app-specific password (https://account.apple.com → Security → App-Specific Passwords)
#   APPLE_TEAM_ID           e.g. 6NQM3XP5RF
#
# The signing identity must already be in your keychain (it is if
# `security find-identity -v -p codesigning` lists it).

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY (e.g. 'Developer ID Application: xiangdong li (6NQM3XP5RF)')}"
: "${APPLE_ID:?Set APPLE_ID to your Apple account email}"
: "${APPLE_PASSWORD:?Set APPLE_PASSWORD to an app-specific password}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID (e.g. 6NQM3XP5RF)}"

cd app

echo "==> Installing frontend deps"
pnpm install --frozen-lockfile

echo "==> Building universal binary (Apple Silicon + Intel)"
APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
APPLE_ID="$APPLE_ID" \
APPLE_PASSWORD="$APPLE_PASSWORD" \
APPLE_TEAM_ID="$APPLE_TEAM_ID" \
pnpm tauri build --target universal-apple-darwin

OUT_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
DMG=$(ls -1 "$OUT_DIR"/*.dmg | head -1)

if [ -z "$DMG" ]; then
  echo "ERROR: no .dmg produced" >&2
  exit 1
fi

echo ""
echo "==> Built: $DMG"
echo ""
echo "==> Verifying signature"
codesign --verify --verbose "$(dirname "$DMG")"/../macos/SoloMD.app
spctl --assess --verbose "$(dirname "$DMG")"/../macos/SoloMD.app || \
  echo "(spctl assessment may need stapled notarization to pass)"

echo ""
echo "==> Done. Test by running:"
echo "    open \"$DMG\""
