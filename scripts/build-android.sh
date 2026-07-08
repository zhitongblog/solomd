#!/usr/bin/env bash
#
# Build signed Android release artifacts for SoloMD.
#
# Outputs (under app/src-tauri/gen/android/app/build/outputs/):
#   - apk/{arm64-v8a,armeabi-v7a,x86_64,universal}/release/app-*-release.apk
#   - bundle/release/app-release.aab          (Google Play upload format)
#
# The per-ABI APKs (arm64-v8a / armeabi-v7a / x86_64) are for sideload +
# F-Droid distribution. The universal APK is a one-binary-fits-all for users
# who don't want to figure out their CPU arch. The .aab is for Play Console
# (Google does the per-device splitting server-side).
#
# Requirements (already in .env.local on alexlee's machine):
#   ANDROID_HOME              /opt/homebrew/share/android-commandlinetools
#   ANDROID_NDK_HOME          $ANDROID_HOME/ndk/<version>
#   ANDROID_KEYSTORE_PATH     path to solomd-release.jks
#   ANDROID_KEYSTORE_PASS     keystore password
#   ANDROID_KEY_ALIAS         key alias (default: solomd)
#   ANDROID_KEY_PASS          key password
#
# Rust Android targets: aarch64 / armv7 / i686 / x86_64-linux-android.
# Install with: rustup target add aarch64-linux-android armv7-linux-androideabi
#                 i686-linux-android x86_64-linux-android
# (rsproxy.cn mirror works around CN-network TLS issues for x86_64-linux-android.)
#
# Usage: ./scripts/build-android.sh [--debug]
# `--debug` skips ProGuard / signing and produces a fast iteration APK.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

DEBUG=0
if [ "${1:-}" = "--debug" ]; then
  DEBUG=1
fi

: "${ANDROID_HOME:?Set ANDROID_HOME (Android SDK)}"
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME (NDK 26+)}"

if [ "$DEBUG" -eq 0 ]; then
  : "${ANDROID_KEYSTORE_PATH:?Set ANDROID_KEYSTORE_PATH for release build (or pass --debug)}"
  : "${ANDROID_KEYSTORE_PASS:?Set ANDROID_KEYSTORE_PASS}"
  : "${ANDROID_KEY_ALIAS:?Set ANDROID_KEY_ALIAS}"
  : "${ANDROID_KEY_PASS:?Set ANDROID_KEY_PASS}"
  if [ ! -f "$ANDROID_KEYSTORE_PATH" ]; then
    echo "ERROR: keystore not found at $ANDROID_KEYSTORE_PATH" >&2
    exit 1
  fi
fi

# NDK toolchain — needed by cargo for per-arch linker. The host-tag dir is
# `darwin-x86_64` on both Intel and Apple Silicon Macs (NDK r23+ uses a
# universal binary inside).
HOST_TAG=darwin-x86_64
TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG/bin"
[ -d "$TOOLCHAIN" ] || { echo "ERROR: NDK toolchain not found at $TOOLCHAIN" >&2; exit 1; }

# Symlink legacy `<triple>-ranlib` names so vendored openssl-sys / libgit2
# perl build scripts find the right archiver. Idempotent.
ln -sf "$TOOLCHAIN/llvm-ranlib" "$TOOLCHAIN/aarch64-linux-android-ranlib" 2>/dev/null || true
ln -sf "$TOOLCHAIN/llvm-ar"     "$TOOLCHAIN/aarch64-linux-android-ar"     2>/dev/null || true
ln -sf "$TOOLCHAIN/llvm-ranlib" "$TOOLCHAIN/armv7a-linux-androideabi-ranlib" 2>/dev/null || true
ln -sf "$TOOLCHAIN/llvm-ar"     "$TOOLCHAIN/armv7a-linux-androideabi-ar"     2>/dev/null || true

export PATH="$TOOLCHAIN:$PATH"
export NDK_HOME="$ANDROID_NDK_HOME"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/aarch64-linux-android24-clang"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$TOOLCHAIN/armv7a-linux-androideabi24-clang"
export CARGO_TARGET_I686_LINUX_ANDROID_LINKER="$TOOLCHAIN/i686-linux-android24-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$TOOLCHAIN/x86_64-linux-android24-clang"

cd app

echo "==> SoloMD Android build ($([ "$DEBUG" -eq 1 ] && echo debug || echo release))"
echo "    NDK:        $ANDROID_NDK_HOME"
echo "    Keystore:   ${ANDROID_KEYSTORE_PATH:-<debug, no signing>}"

if [ "$DEBUG" -eq 1 ]; then
  pnpm tauri android build --apk --debug
else
  # Build both signed APKs (per-ABI + universal) and the AAB for Play.
  pnpm tauri android build --apk --aab
fi

OUT_DIR="src-tauri/gen/android/app/build/outputs"
echo ""
echo "==> Done. Artifacts:"
find "$OUT_DIR" -name "*.apk" -o -name "*.aab" 2>/dev/null | sort | while read -r f; do
  size=$(du -h "$f" | cut -f1)
  echo "    $size  $f"
done

if [ "$DEBUG" -eq 0 ]; then
  echo ""
  echo "Next:"
  echo "  - Sideload: pick the per-ABI APK matching the user's phone (arm64-v8a covers ~all 2019+ devices)."
  echo "  - Play Console: upload app-release.aab via https://play.google.com/console/"
  echo "  - F-Droid: open MR on fdroiddata with metadata pointing at this release."
fi
