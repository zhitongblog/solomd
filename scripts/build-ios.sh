#!/usr/bin/env bash
#
# iOS App Store distribution build for SoloMD.
#
# This script captures the workflow from the v4.1.0 iOS-build session
# (2026-05-11), where each clean iOS build runs into the same family
# of issues:
#
#   1. Tauri's `tauri ios build` regenerates parts of gen/apple/project.yml
#      from a template, undoing manual signing config.
#   2. The OTHER_LDFLAGS Xcode build setting needs -lz -liconv to link
#      libgit2 + iconv on iOS — libz / libiconv aren't auto-linked.
#   3. Externals/ contains stale debug variants that cause
#      "Multiple commands produce libapp.a" Xcode errors.
#   4. Tauri's `tauri ios build` spawns a JSON-RPC server which
#      tauri ios xcode-script calls back to — so we must run via
#      `tauri ios build` (NOT raw xcodebuild).
#   5. Xcode subprocess doesn't inherit shell proxy env — for users
#      behind a Clash-style proxy, GitHub clones (swift-rs) time out
#      after 75s unless launchctl-level proxy is set.
#   6. Apple Distribution signing requires a manually-managed
#      provisioning profile (Xcode-managed ones cause CODE_SIGN_STYLE
#      conflicts). Drop one in app/src-tauri/SoloMD-iOS.provisionprofile
#      before running this script.
#
# Required env (export or .env.local):
#   IOS_SIGNING_PROFILE_NAME  e.g. "SoloMD iOS App Store 2026-05"
#                              (the profile Name as it appears in the
#                               profile file — used as
#                               PROVISIONING_PROFILE_SPECIFIER)
# Optional env:
#   IOS_LAUNCHCTL_PROXY        URL like http://127.0.0.1:7897 — if set,
#                              we register it at launchctl so Xcode
#                              subprocess can reach GitHub
#
# Output: app/src-tauri/gen/apple/build/arm64/SoloMD.ipa

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${IOS_SIGNING_PROFILE_NAME:?Set IOS_SIGNING_PROFILE_NAME — name of the iOS Distribution profile}"

# Optional launchctl proxy for Xcode subprocess
if [ -n "${IOS_LAUNCHCTL_PROXY:-}" ]; then
  echo "==> Registering proxy at launchctl level (for Xcode subprocess)"
  launchctl setenv http_proxy  "$IOS_LAUNCHCTL_PROXY"
  launchctl setenv https_proxy "$IOS_LAUNCHCTL_PROXY"
  launchctl setenv HTTP_PROXY  "$IOS_LAUNCHCTL_PROXY"
  launchctl setenv HTTPS_PROXY "$IOS_LAUNCHCTL_PROXY"
fi

PROJECT_YML=app/src-tauri/gen/apple/project.yml
EXPORT_PLIST=app/src-tauri/gen/apple/ExportOptions.plist

[ -f "$PROJECT_YML"   ] || { echo "ERROR: $PROJECT_YML missing — run \`pnpm tauri ios init\` first" >&2; exit 1; }
[ -f "$EXPORT_PLIST"  ] || { echo "ERROR: $EXPORT_PLIST missing" >&2; exit 1; }

echo "==> Patching project.yml for Manual signing + Distribution profile"
# Idempotent: only adds the lines if they're not already there.
if ! grep -q "PROVISIONING_PROFILE_SPECIFIER" "$PROJECT_YML"; then
  /usr/bin/sed -i.bak \
    -e 's/^      CODE_SIGN_STYLE: Automatic$/      CODE_SIGN_STYLE: Manual/' \
    -e "s|^      DEVELOPMENT_TEAM: .*\$|&\\n      CODE_SIGN_IDENTITY: \"Apple Distribution\"\\n      PROVISIONING_PROFILE_SPECIFIER: \"${IOS_SIGNING_PROFILE_NAME}\"|" \
    "$PROJECT_YML"
  rm "$PROJECT_YML.bak"
fi

# Patch OTHER_LDFLAGS for libz + libiconv (libgit2 needs them on iOS)
if ! grep -q -- "-lz -liconv" "$PROJECT_YML"; then
  /usr/bin/sed -i.bak \
    's|OTHER_LDFLAGS: \$(inherited) -lswiftCompatibility56 -lswiftCompatibilityConcurrency$|OTHER_LDFLAGS: $(inherited) -lswiftCompatibility56 -lswiftCompatibilityConcurrency -lz -liconv|' \
    "$PROJECT_YML"
  rm "$PROJECT_YML.bak"
fi

# Remove Externals from sources (it's duplicated via build phase output + framework dep)
# Idempotent sed: only removes the line if present
/usr/bin/sed -i.bak '/^      - path: Externals$/d' "$PROJECT_YML" && rm "$PROJECT_YML.bak"

echo "==> Patching ExportOptions.plist for app-store-connect + Manual"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>6NQM3XP5RF</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>signingCertificate</key>
    <string>Apple Distribution</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>app.solomd</key>
        <string>${IOS_SIGNING_PROFILE_NAME}</string>
    </dict>
    <key>uploadSymbols</key>
    <true/>
    <key>destination</key>
    <string>export</string>
</dict>
</plist>
EOF

echo "==> Removing stale Externals/arm64/debug to avoid duplicate libapp.a copy"
rm -rf app/src-tauri/gen/apple/Externals/arm64/debug

echo "==> Regenerating .xcodeproj from project.yml"
( cd app/src-tauri/gen/apple && xcodegen generate )

echo "==> Building iOS .ipa (release / arm64)"
( cd app && pnpm tauri ios build )

IPA=app/src-tauri/gen/apple/build/arm64/SoloMD.ipa
[ -f "$IPA" ] || { echo "ERROR: build didn't produce $IPA" >&2; exit 1; }

echo ""
echo "==> Verifying .ipa signature"
TMP=$(mktemp -d)
unzip -p "$IPA" Payload/SoloMD.app/embedded.mobileprovision > "$TMP/profile"
echo "  Profile name: $(security cms -D -i "$TMP/profile" | plutil -extract Name xml1 -o - - | grep -o "<string>.*</string>" | head -1)"
echo "  Platform:     $(security cms -D -i "$TMP/profile" | plutil -extract Platform xml1 -o - - | grep -o "<string>.*</string>" | head -1)"
echo "  Xcode-managed: $(security cms -D -i "$TMP/profile" | plutil -extract IsXcodeManaged xml1 -o - - | grep -o "<true\\|false/>" || echo "unknown")"
rm -rf "$TMP"

echo ""
echo "==> Done: $IPA ($(du -h "$IPA" | cut -f1))"
echo "    Submit: ./scripts/submit-ios.sh"
