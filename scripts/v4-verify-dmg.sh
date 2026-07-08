#!/bin/bash
#
# v4-verify-dmg.sh — post-build verification for the macOS signed dmg.
#
# Run after `./scripts/build-mac.sh`. Confirms the .app + dmg pass every
# release-channel check we'd hit in CI: codesign authority, notarization
# stapled, spctl/Gatekeeper accept, universal slices present, file-icon
# patched, sidecar signed, dmg mounts cleanly. Exit 0 = ready to publish.
#
# Lives at $REPO/scripts/v4-verify-dmg.sh — invoked from v4-self-test.sh
# when --with-dmg is passed.

set -uo pipefail
DMG=$(ls /Volumes/Dev/code/notebook/app/src-tauri/target/universal-apple-darwin/release/bundle/dmg/SoloMD_*_universal.dmg 2>/dev/null | head -1)
APP="/Volumes/Dev/code/notebook/app/src-tauri/target/universal-apple-darwin/release/bundle/macos/SoloMD.app"
[ -z "$DMG" ] || [ ! -f "$DMG" ] && { echo "ERROR: no dmg"; exit 1; }
[ ! -d "$APP" ] && { echo "ERROR: no .app"; exit 1; }

GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'
FAIL=0
chk() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then printf "  %-44s ${GREEN}PASS${RESET}\n" "$label"
  else                          printf "  %-44s ${RED}FAIL${RESET}\n" "$label"; FAIL=$((FAIL+1)); fi
}

echo "=== SoloMD signed-build verification ==="
echo "  dmg: $DMG"
echo "  app: $APP"
echo

chk ".app signed by Developer ID"     bash -c "codesign -dvvv '$APP' 2>&1 | grep -q 'Developer ID Application: xiangdong li'"
chk ".app notarization stapled"        xcrun stapler validate "$APP"
chk "spctl Gatekeeper accept"          bash -c "spctl -a -vvv '$APP' 2>&1 | grep -q accepted"
chk "binary is universal (x86_64+arm64)" bash -c "file '$APP/Contents/MacOS/SoloMD' 2>&1 | grep -q 'universal binary'"
chk "x86_64 slice present"             bash -c "lipo -info '$APP/Contents/MacOS/SoloMD' 2>&1 | grep -q x86_64"
chk "arm64 slice present"              bash -c "lipo -info '$APP/Contents/MacOS/SoloMD' 2>&1 | grep -q arm64"
chk "file_icon.icns injected"          test -f "$APP/Contents/Resources/file_icon.icns"
chk "Info.plist md icon patched"       bash -c "/usr/libexec/PlistBuddy -c 'Print :CFBundleDocumentTypes:0:CFBundleTypeIconFile' '$APP/Contents/Info.plist' | grep -q file_icon"
chk "Info.plist txt icon patched"      bash -c "/usr/libexec/PlistBuddy -c 'Print :CFBundleDocumentTypes:1:CFBundleTypeIconFile' '$APP/Contents/Info.plist' | grep -q file_icon"
chk "solomd-mcp sidecar bundled"       test -f "$APP/Contents/MacOS/solomd-mcp"
chk "solomd-mcp sidecar signed"        bash -c "codesign -dvvv '$APP/Contents/MacOS/solomd-mcp' 2>&1 | grep -q 'Developer ID Application: xiangdong li'"
chk "dmg signed by Developer ID"       bash -c "codesign -dvvv '$DMG' 2>&1 | grep -q 'Developer ID Application: xiangdong li'"
MNT=$(hdiutil attach -nobrowse "$DMG" 2>&1 | tail -1 | awk '{print $NF}')
chk "dmg mounts + contains SoloMD.app" test -d "$MNT/SoloMD.app"
chk "dmg has /Applications symlink"    test -L "$MNT/Applications"
hdiutil detach "$MNT" >/dev/null 2>&1
SIZE=$(stat -f%z "$DMG")
SIZE_MB=$((SIZE / 1024 / 1024))
chk "dmg size ${SIZE_MB} MB (20-100)"  bash -c "[ $SIZE_MB -gt 20 ] && [ $SIZE_MB -lt 100 ]"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "${GREEN}✓ all signed-build checks green${RESET}"
  echo "  dmg ready: $DMG"
  exit 0
else
  echo "${RED}✗ $FAIL failed${RESET}"
  exit 1
fi
