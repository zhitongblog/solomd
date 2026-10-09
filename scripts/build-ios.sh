#!/usr/bin/env bash
#
# iOS App Store distribution build for SoloMD.
#
# This script captures the workflow from the v4.1.0 iOS-build session
# (2026-05-11), where each clean iOS build runs into the same family
# of issues:
#
#   1. gen/apple/project.yml is generated and gitignored, but is not the whole
#      truth — signing, file associations, the #139 open-in-place fix and
#      several build settings are ours. They live in
#      app/src-tauri/ios-project-overlay.yml and are re-applied below.
#      (Measured 2026-09-07: `tauri ios init` does NOT rewrite an existing
#      project.yml — it only writes one when the file is absent. The older note
#      here, that Tauri regenerates it from a template on every build and undoes
#      manual signing, was wrong; the real hazard is the opposite one, that a
#      regeneration drops everything hand-added and nothing says so.)
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
#   IOS_BUNDLE_VERSION         CFBundleVersion override, for an extra TestFlight
#                              build of a version already uploaded (e.g. 4.14.61
#                              under 4.14.6 — higher than the existing build, at
#                              most three integers). Default: the app version.
#   IOS_APP_VERSION            CFBundleShortVersionString override. Once a
#                              version is approved it takes no more builds, so
#                              a TestFlight build after that needs the NEXT
#                              version (e.g. 4.14.7) with a build number below
#                              the one the real release will use (e.g. 4.14.1).
#   IOS_LAUNCHCTL_PROXY        URL like http://127.0.0.1:7897 — if set,
#                              we register it at launchctl so Xcode
#                              subprocess can reach GitHub
#
# Output: app/src-tauri/gen/apple/build/arm64/SoloMD.ipa

set -euo pipefail

cd "$(dirname "$0")/.."

# A pin given on the command line wins over the one in .env.local: main
# (4.14.x, no UIScene) must build with Xcode 26, the 5.0 line with Xcode 27.
_IOS_DEVELOPER_DIR_ARG="${IOS_DEVELOPER_DIR:-}"
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi
[ -n "$_IOS_DEVELOPER_DIR_ARG" ] && IOS_DEVELOPER_DIR="$_IOS_DEVELOPER_DIR_ARG"

: "${IOS_SIGNING_PROFILE_NAME:?Set IOS_SIGNING_PROFILE_NAME — name of the iOS Distribution profile}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID — the ten-character team identifier}"

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

# The deployment target lives in tauri.conf.json, but `tauri ios init` only
# writes project.yml when there is no project.yml — an existing one keeps
# whatever it was generated with, silently, forever. Raising the minimum in the
# config therefore does nothing to this machine's build unless it is also
# applied here. Apple stops accepting uploads below iOS 15 in spring 2027.
IOS_MIN=$(python3 -c "import json;print(json.load(open('app/src-tauri/tauri.conf.json'))['bundle'].get('iOS',{}).get('minimumSystemVersion','14.0'))")
CURRENT_MIN=$(awk '/^    iOS: /{print $2; exit}' "$PROJECT_YML")
if [ "$CURRENT_MIN" != "$IOS_MIN" ]; then
  echo "==> Deployment target: $CURRENT_MIN -> $IOS_MIN (from tauri.conf.json)"
  /usr/bin/sed -i.bak "s|^\( *\)iOS: ${CURRENT_MIN}\$|\1iOS: ${IOS_MIN}|" "$PROJECT_YML"
  rm "$PROJECT_YML.bak"
fi

# Everything else the project needs — signing, the file associations, the #139
# open-in-place fix, the extra link flags, the PATH the Rust build phase needs —
# lives in app/src-tauri/ios-project-overlay.yml and is applied here.
#
# It used to be a stack of seds against this file. Two of them anchored on
# lines that a freshly generated project.yml does not contain
# (DEVELOPMENT_TEAM, OTHER_LDFLAGS) and two only rewrote keys that were already
# present, so on a regenerated project they silently did nothing at all and the
# build would have shipped without signing config or file associations.
echo "==> Applying the iOS project overlay"
python3 scripts/lib/ios_project_overlay.py "$PROJECT_YML" app/src-tauri/ios-project-overlay.yml

echo "==> Patching ExportOptions.plist for app-store-connect + Manual"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>${APPLE_TEAM_ID}</string>
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

# ---------------------------------------------------------------------------
# Which Xcode builds this. Set IOS_DEVELOPER_DIR (in .env.local) to pin one,
# e.g. /Volumes/Dev/xcode26/Xcode-26.app/Contents/Developer.
#
# Why it matters: an app linked against the iOS 27 SDK is killed at launch on
# iOS 27 unless it has adopted the UIScene lifecycle, and Tauri 2.10/2.11 has
# not (proper support is unreleased as of 2026-09). Apple rejected 4.13.3 for
# exactly that (2.1a, crash in
# _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption). Linked
# against the iOS 26 SDK the same code runs fine on iOS 27.
#
# Exporting DEVELOPER_DIR is NOT enough: the Tauri mobile CLI scrubs the
# environment before it runs xcodebuild and keeps little more than PATH, so
# the build silently falls back to `xcode-select -p`. PATH survives, so put
# forwarding shims first on it.
# ---------------------------------------------------------------------------
if [ -n "${IOS_DEVELOPER_DIR:-}" ]; then
  [ -x "$IOS_DEVELOPER_DIR/usr/bin/xcodebuild" ] || { echo "ERROR: IOS_DEVELOPER_DIR has no xcodebuild: $IOS_DEVELOPER_DIR" >&2; exit 1; }
  SHIMS="$(mktemp -d)"
  for tool in xcodebuild xcrun; do
    printf '#!/bin/sh\nexport DEVELOPER_DIR=%s\nexec /usr/bin/%s "$@"\n' "$IOS_DEVELOPER_DIR" "$tool" > "$SHIMS/$tool"
    chmod +x "$SHIMS/$tool"
  done
  export DEVELOPER_DIR="$IOS_DEVELOPER_DIR"
  export PATH="$SHIMS:$PATH"
  echo "==> Xcode pinned: $(xcodebuild -version | tr '\n' ' ')"
fi

echo "==> Building iOS .ipa (release / arm64)"
# App Store distribution: strip the AI / Agent / Recipe surface (Apple 3.1.1).
# SOLOMD_APP_STORE_BUILD gates Rust commands (option_env! in app_build.rs);
# VITE_APP_STORE_BUILD gates the Vue UI (import.meta.env in app-build.ts).
export SOLOMD_APP_STORE_BUILD=1
export VITE_APP_STORE_BUILD=true
OVERRIDE=$(IOS_APP_VERSION="${IOS_APP_VERSION:-}" IOS_BUNDLE_VERSION="${IOS_BUNDLE_VERSION:-}" python3 -c '
import json, os
c = {}
if os.environ["IOS_APP_VERSION"]: c["version"] = os.environ["IOS_APP_VERSION"]
if os.environ["IOS_BUNDLE_VERSION"]: c["bundle"] = {"iOS": {"bundleVersion": os.environ["IOS_BUNDLE_VERSION"]}}
print(json.dumps(c) if c else "")')
if [ -n "$OVERRIDE" ]; then
  echo "==> Version override: $OVERRIDE"
  ( cd app && pnpm tauri ios build --config "$OVERRIDE" )
else
  ( cd app && pnpm tauri ios build )
fi

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
# Read the SDK the binary was actually linked against — out of the artifact,
# not out of what we asked for. A 27-SDK build is what got 4.13.3 rejected, and
# nothing about it looks wrong until it is launched on iOS 27.
SDK_NAME="$(unzip -p "$IPA" 'Payload/*.app/Info.plist' | plutil -extract DTSDKName raw -o - - 2>/dev/null || true)"
echo "==> Linked SDK: ${SDK_NAME:-unknown}"
# Since Tauri 2.12 the app runs on the scene lifecycle (the overlay declares a
# UIApplicationSceneManifest), and a newer SDK is fine. What must never ship
# again is a newer-SDK build WITHOUT the manifest — check the artifact for it.
HAS_SCENES=$(unzip -p "$IPA" 'Payload/*.app/Info.plist' | plutil -extract UIApplicationSceneManifest xml1 -o - - >/dev/null 2>&1 && echo yes || echo no)
echo "==> UIScene manifest: $HAS_SCENES"
case "$SDK_NAME" in
  iphoneos26.*) ;;
  *)
    if [ "$HAS_SCENES" != yes ] && [ -z "${IOS_ALLOW_NEW_SDK:-}" ]; then
      echo "ERROR: $IPA is linked against '${SDK_NAME:-unknown}' but declares no" >&2
      echo "       UIApplicationSceneManifest: it would crash at launch on iOS 27" >&2
      echo "       (4.13.3's rejection). Check app/src-tauri/ios-project-overlay.yml." >&2
      exit 1
    fi
    ;;
esac

echo "==> Done: $IPA ($(du -h "$IPA" | cut -f1))"
echo "    Submit: ./scripts/submit-ios.sh"
