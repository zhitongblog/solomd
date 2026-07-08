#!/usr/bin/env bash
#
# Local macOS build with Developer ID signing + notarization + per-filetype icons.
#
# Flow:
#   1. pnpm tauri build --bundles app       (builds + signs .app, no dmg/notarize)
#   2. Patch Info.plist to add CFBundleTypeIconFile for md / txt associations
#   3. Copy file_icon.icns into Contents/Resources/
#   4. Re-sign .app so signature covers the changes
#   5. Notarize + staple
#   6. Build dmg via hdiutil from the patched .app
#   7. Sign dmg
#
# Run from repo root: ./scripts/build-mac.sh
#
# Required environment variables (export them or put in .env.local):
#   APPLE_SIGNING_IDENTITY  e.g. "Developer ID Application: xiangdong li (6NQM3XP5RF)"
#   APPLE_ID                your Apple ID email
#   APPLE_PASSWORD          app-specific password
#   APPLE_TEAM_ID           e.g. 6NQM3XP5RF

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY}"
: "${APPLE_ID:?Set APPLE_ID}"
: "${APPLE_PASSWORD:?Set APPLE_PASSWORD}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID}"

cd app
VERSION=$(node -p "require('./package.json').version")
echo "==> SoloMD v${VERSION} — local Mac build with file-icon injection"

echo "==> Installing frontend deps"
pnpm install --frozen-lockfile

echo "==> Building .app (no dmg yet)"
# APPLE_ID / APPLE_PASSWORD intentionally unset so Tauri skips notarization —
# we'll notarize manually after patching the .app below.
APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
  pnpm tauri build --target universal-apple-darwin --bundles app

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/SoloMD.app"
[ -d "$APP" ] || { echo "ERROR: .app not found at $APP" >&2; exit 1; }

echo "==> Injecting file-type icon into Info.plist"
cp src-tauri/icons/file_icon.icns "$APP/Contents/Resources/file_icon.icns"
PLIST="$APP/Contents/Info.plist"
# CFBundleDocumentTypes has two entries (md + txt). Add CFBundleTypeIconFile to each.
for i in 0 1; do
  /usr/libexec/PlistBuddy -c "Delete :CFBundleDocumentTypes:${i}:CFBundleTypeIconFile" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:${i}:CFBundleTypeIconFile string file_icon.icns" "$PLIST"
done

echo "==> Re-signing .app (signature must cover patched plist)"
codesign --force --deep --options runtime \
  --sign "$APPLE_SIGNING_IDENTITY" "$APP"

echo "==> Notarizing .app"
ZIP="/tmp/SoloMD-${VERSION}.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
rm -f "$ZIP"

echo "==> Stapling notarization ticket"
xcrun stapler staple "$APP"

echo "==> Building dmg"
STAGE="/tmp/solomd-dmg-stage-${VERSION}"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/SoloMD.app"
ln -s /Applications "$STAGE/Applications"
DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
mkdir -p "$DMG_DIR"
DMG="$DMG_DIR/SoloMD_${VERSION}_universal.dmg"
rm -f "$DMG"
hdiutil create -volname SoloMD -srcfolder "$STAGE" -ov -format UDZO "$DMG"

echo "==> Signing dmg"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$DMG"

echo ""
echo "==> Verifying"
spctl -a -vvv "$APP" || echo "(spctl: check above)"
xcrun stapler validate "$APP"

echo ""
echo "==> Done: $DMG"
echo "    Open: open \"$DMG\""
