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
#
# Notarization credentials — an App Store Connect API key is preferred and
# used automatically when present; see scripts/lib/asc-auth.sh:
#   ASC_KEY_ID + ASC_ISSUER_ID (+ ASC_KEY_PATH)     preferred
#   APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID       fallback

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY}"

# shellcheck source=lib/asc-auth.sh
source "$(dirname "$0")/lib/asc-auth.sh"
asc_resolve_auth

cd app
VERSION=$(node -p "require('./package.json').version")
echo "==> SoloMD v${VERSION} — local Mac build with file-icon injection"

echo "==> Installing frontend deps"
pnpm install --frozen-lockfile

echo "==> Building a matching universal MCP sidecar"
../scripts/build-mcp-sidecar.sh aarch64-apple-darwin
../scripts/build-mcp-sidecar.sh x86_64-apple-darwin
lipo -create \
  src-tauri/binaries/solomd-mcp-aarch64-apple-darwin \
  src-tauri/binaries/solomd-mcp-x86_64-apple-darwin \
  -output src-tauri/binaries/solomd-mcp-universal-apple-darwin

echo "==> Building .app (no dmg yet)"
# Every credential Tauri would notarize with is unset here on purpose: it must
# skip notarization, because the .app is still going to be patched (file icons,
# then re-signed) below and a ticket issued now would not cover that.
env -u APPLE_ID -u APPLE_PASSWORD \
  -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
  APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
  pnpm tauri build --target universal-apple-darwin --bundles app

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/SoloMD.app"
[ -d "$APP" ] || { echo "ERROR: .app not found at $APP" >&2; exit 1; }

echo "==> Injecting file-type icon into Info.plist"
cp src-tauri/icons/file_icon.icns "$APP/Contents/Resources/file_icon.icns"
PLIST="$APP/Contents/Info.plist"
# CFBundleDocumentTypes entries: add CFBundleTypeIconFile to each existing entry.
for i in 0 1; do
  if /usr/libexec/PlistBuddy -c "Print :CFBundleDocumentTypes:${i}" "$PLIST" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Delete :CFBundleDocumentTypes:${i}:CFBundleTypeIconFile" "$PLIST" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:${i}:CFBundleTypeIconFile string file_icon.icns" "$PLIST"
  fi
done

echo "==> Embedding the Quick Look extension (#351)"
# Finder's space-bar preview renders .md with it instead of showing plain text.
# Built unsigned here; it is signed below, after the --deep pass.
mkdir -p "$APP/Contents/PlugIns"
src-tauri/quicklook/build.sh "$VERSION" "$APP/Contents/PlugIns"
QL_APPEX="$APP/Contents/PlugIns/SoloMDQuickLook.appex"

echo "==> Re-signing .app (signature must cover patched plist)"
codesign --force --deep --options runtime \
  --sign "$APPLE_SIGNING_IDENTITY" "$APP"

# --deep just re-signed the extension without entitlements, and PlugInKit
# refuses an extension that isn't sandboxed. Sign it again with its own
# entitlements, then seal the app over it (not --deep, which would undo it).
codesign --force --options runtime --timestamp \
  --entitlements src-tauri/quicklook/QuickLook.entitlements \
  --sign "$APPLE_SIGNING_IDENTITY" "$QL_APPEX"
codesign --force --options runtime \
  --sign "$APPLE_SIGNING_IDENTITY" "$APP"
codesign -d --entitlements - "$QL_APPEX" 2>/dev/null | grep -q app-sandbox \
  || { echo "ERROR: Quick Look extension lost its sandbox entitlement" >&2; exit 1; }
codesign --verify --deep --strict "$APP"

echo "==> Notarizing .app"
ZIP="/tmp/SoloMD-${VERSION}.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" \
  "${ASC_NOTARY_AUTH[@]}" \
  --no-s3-acceleration \
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
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"

echo "==> Notarizing + stapling dmg"
xcrun notarytool submit "$DMG" \
  "${ASC_NOTARY_AUTH[@]}" \
  --no-s3-acceleration \
  --wait
xcrun stapler staple "$DMG"

echo ""
echo "==> Verifying"
spctl -a -vvv "$APP" || echo "(spctl app: check above)"
spctl -a -t open --context context:primary-signature -vvv "$DMG" || echo "(spctl dmg: check above)"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

echo ""
echo "==> Done: $DMG"
echo "    Open: open \"$DMG\""
