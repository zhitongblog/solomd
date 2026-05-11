#!/usr/bin/env bash
#
# Mac App Store distribution build for SoloMD.
#
# Differences from build-mac.sh:
#   - Signed with `Apple Distribution: ...` instead of `Developer ID Application:`
#   - Embeds `entitlements.mas.plist` (app-sandbox + JIT + network + sidecar)
#   - Embeds the Mac App Store provisioning profile at
#     SoloMD.app/Contents/embedded.provisionprofile
#   - Wraps the .app in a signed .pkg via `productbuild` instead of `hdiutil`
#   - Does NOT notarize (MAS submissions go through Apple's review pipeline
#     after upload, which performs its own notarization)
#   - Overrides the Info.plist version fields so the binary lines up with the
#     existing MAS "Version 1.0.0" record in App Store Connect — the user-
#     visible Tauri version (4.1.0 from package.json) is mapped to:
#         CFBundleShortVersionString = MAS_VERSION       (default 1.0.0)
#         CFBundleVersion            = MAS_BUILD_NUMBER  (default 1.0.1)
#
# Required env (export in shell or put in .env.local):
#   MAS_SIGNING_IDENTITY      e.g. "Apple Distribution: xiangdong li (6NQM3XP5RF)"
#   MAS_INSTALLER_IDENTITY    e.g. "3rd Party Mac Developer Installer: ..."
#   MAS_PROVISIONING_PROFILE  path to the downloaded .provisionprofile
#
# Optional env:
#   MAS_VERSION       short version visible in App Store (default 1.0.0)
#   MAS_BUILD_NUMBER  monotonic build counter (default 1.0.1, bump on each
#                     resubmission of the same version)
#
# Usage: ./scripts/build-mas.sh
# Output: dist-mas/SoloMD_<MAS_VERSION>_<MAS_BUILD_NUMBER>.pkg

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${MAS_SIGNING_IDENTITY:?Set MAS_SIGNING_IDENTITY (Apple Distribution cert)}"
: "${MAS_INSTALLER_IDENTITY:?Set MAS_INSTALLER_IDENTITY (3rd Party Mac Developer Installer cert)}"
: "${MAS_PROVISIONING_PROFILE:?Set MAS_PROVISIONING_PROFILE (path to .provisionprofile)}"

MAS_VERSION="${MAS_VERSION:-1.0.0}"
MAS_BUILD_NUMBER="${MAS_BUILD_NUMBER:-1.0.1}"

if [ ! -f "$MAS_PROVISIONING_PROFILE" ]; then
  echo "ERROR: provisioning profile not found at $MAS_PROVISIONING_PROFILE" >&2
  exit 1
fi

ENTITLEMENTS="app/src-tauri/entitlements.mas.plist"
[ -f "$ENTITLEMENTS" ] || { echo "ERROR: $ENTITLEMENTS missing" >&2; exit 1; }

echo "==> SoloMD MAS build"
echo "    Short version: $MAS_VERSION"
echo "    Build number:  $MAS_BUILD_NUMBER"
echo "    App cert:      $MAS_SIGNING_IDENTITY"
echo "    Installer:     $MAS_INSTALLER_IDENTITY"
echo "    Profile:       $MAS_PROVISIONING_PROFILE"

cd app

echo "==> Installing frontend deps"
pnpm install --frozen-lockfile

echo "==> Building .app (universal)"
# Build without auto-signing so we can re-sign with MAS identity + entitlements.
# Tauri's default macOS signing uses APPLE_SIGNING_IDENTITY which is the
# Developer ID cert; we unset it for this build.
unset APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
pnpm tauri build --target universal-apple-darwin --bundles app

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/SoloMD.app"
[ -d "$APP" ] || { echo "ERROR: .app not found at $APP" >&2; exit 1; }

cd ..

echo "==> Patching Info.plist with MAS version fields"
PLIST="app/$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MAS_VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $MAS_BUILD_NUMBER" "$PLIST"
# Per-file-type icons (mirrors build-mac.sh): use SoloMD's bundled icon for
# .md / .txt associations so MAS users see the brand icon when previewing.
cp app/src-tauri/icons/file_icon.icns "app/$APP/Contents/Resources/file_icon.icns"
for i in 0 1; do
  /usr/libexec/PlistBuddy -c "Delete :CFBundleDocumentTypes:${i}:CFBundleTypeIconFile" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:${i}:CFBundleTypeIconFile string file_icon.icns" "$PLIST"
done

echo "==> Embedding provisioning profile"
cp "$MAS_PROVISIONING_PROFILE" "app/$APP/Contents/embedded.provisionprofile"

echo "==> Embedding privacy manifest"
# Required for macOS 14+ MAS submissions when the app touches "required
# reason" APIs (file timestamps, UserDefaults, disk space, system boot time).
# Missing manifest → upload accepted, then review warning email, then
# rejection in the next pipeline. Bake it in to avoid the round-trip.
cp app/src-tauri/PrivacyInfo.xcprivacy "app/$APP/Contents/Resources/PrivacyInfo.xcprivacy"

echo "==> Stripping existing signatures so we can re-sign with MAS identity"
# `--remove-signature` on the wrapper isn't enough — Tauri's build pipeline
# already signed every nested binary (frameworks, sidecar). We strip all of
# them so codesign --deep below can do a fresh signature with our entitlements.
find "app/$APP" -type f \( -perm -u+x -o -name "*.dylib" -o -name "*.framework" \) -print0 |
  while IFS= read -r -d '' f; do
    codesign --remove-signature "$f" 2>/dev/null || true
  done
codesign --remove-signature "app/$APP" 2>/dev/null || true

echo "==> Signing sidecar binaries with MAS identity"
# Sidecars in Contents/MacOS/ — solomd-mcp universal binary. Must be signed
# with the same identity as the parent or library validation rejects it.
# Entitlements are the same since they inherit the sandbox from the parent.
for bin in app/$APP/Contents/MacOS/*; do
  [ -f "$bin" ] || continue
  # Skip the main executable — it gets signed last (after frameworks).
  if [ "$(basename "$bin")" = "SoloMD" ]; then continue; fi
  echo "    signing sidecar: $(basename "$bin")"
  codesign --force --sign "$MAS_SIGNING_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    --identifier "app.solomd.$(basename "$bin")" \
    "$bin"
done

echo "==> Signing frameworks (deep)"
if [ -d "app/$APP/Contents/Frameworks" ]; then
  find "app/$APP/Contents/Frameworks" -type d -name "*.framework" -print0 |
    while IFS= read -r -d '' fw; do
      echo "    signing framework: $(basename "$fw")"
      codesign --force --deep --sign "$MAS_SIGNING_IDENTITY" "$fw"
    done
fi

echo "==> Signing .app bundle"
codesign --force --sign "$MAS_SIGNING_IDENTITY" \
  --entitlements "$ENTITLEMENTS" \
  --identifier app.solomd \
  --options runtime \
  "app/$APP"

echo "==> Verifying signature"
codesign --verify --strict --deep --verbose=2 "app/$APP"

echo "==> Building .pkg"
mkdir -p dist-mas
PKG="dist-mas/SoloMD_${MAS_VERSION}_${MAS_BUILD_NUMBER}.pkg"
rm -f "$PKG"
productbuild --component "app/$APP" /Applications \
  --sign "$MAS_INSTALLER_IDENTITY" \
  "$PKG"

echo "==> Verifying .pkg signature"
pkgutil --check-signature "$PKG"

echo ""
echo "==> Done: $PKG"
echo "    Inspect:  pkgutil --payload-files \"$PKG\""
echo "    Upload:   xcrun altool --upload-app -f \"$PKG\" -t osx \\"
echo "                  -u \"\$APPLE_ID\" -p \"\$APPLE_PASSWORD\""
echo ""
echo "Next: run ./scripts/submit-mas.sh \"$PKG\" — uploads to App Store Connect."
