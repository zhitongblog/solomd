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

# Android 15 uses 16 KB memory pages, and Play now REFUSES to save a release
# whose native libraries are still aligned to 4 KB — for 4.12.0 it was an error
# you could wave through, by 4.13.0 it greys out the Save button on the review
# screen. The NDK's own prebuilts are fine; ours were not, because Rust links
# `libapp_lib.so` itself and never passes the flag.
#
# These are env vars rather than `[target.*] rustflags` in .cargo/config.toml:
# the Gradle plugin invokes cargo from a directory where that file is not on
# the config search path, so the config version silently did nothing (verified
# — the .so came out 0x1000 aligned anyway). The linker exports above already
# take this route, so the flags travel with them.
#
# Verify after a build:
#   llvm-readelf -l target/aarch64-linux-android/release/libapp_lib.so
# every LOAD segment must read 0x4000.
ANDROID_PAGE_FLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="$ANDROID_PAGE_FLAGS"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_RUSTFLAGS="$ANDROID_PAGE_FLAGS"
export CARGO_TARGET_I686_LINUX_ANDROID_RUSTFLAGS="$ANDROID_PAGE_FLAGS"
export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="$ANDROID_PAGE_FLAGS"

cd app

echo "==> SoloMD Android build ($([ "$DEBUG" -eq 1 ] && echo debug || echo release))"
echo "    NDK:        $ANDROID_NDK_HOME"
echo "    Keystore:   ${ANDROID_KEYSTORE_PATH:-<debug, no signing>}"

if [ "$DEBUG" -eq 1 ]; then
  pnpm tauri android build --apk --debug
else
  # Build AAB first and APKs second so `splits.abi` is enabled for APK splits
  # and disabled for the AAB (allowing `isShrinkResources = true` without
  # hitting AGP issue #402800800), and so `merged_jni_libs` + the APKs are
  # always newer than `app/dist/index.html` for A00-install-verify.
  pnpm tauri android build --aab
  rm -rf src-tauri/gen/android/app/build/intermediates/merged_jni_libs
  pnpm tauri android build --apk --config '{"build":{"beforeBuildCommand":""}}'
  for jni_so in src-tauri/gen/android/app/build/intermediates/merged_jni_libs/*/*/out/arm64-v8a/libapp_lib.so; do
    [ -f "$jni_so" ] && [ -f src-tauri/target/aarch64-linux-android/release/libapp_lib.so ] && \
      touch -r src-tauri/target/aarch64-linux-android/release/libapp_lib.so "$jni_so"
  done
fi

OUT_DIR="src-tauri/gen/android/app/build/outputs"
echo ""
echo "==> Done. Artifacts:"
find "$OUT_DIR" -name "*.apk" -o -name "*.aab" 2>/dev/null | sort | while read -r f; do
  size=$(du -h "$f" | cut -f1)
  echo "    $size  $f"
done

# Signing is not something to take on trust. Gradle emits an unsigned release
# artifact without a word when the keystore env is missing, and the first thing
# that notices is the Play Console, after a 39 MB upload, with 「所有上传的软件包
# 都必须签名」. Assert it here, on every release artifact, before anyone ships.
if [ "$DEBUG" -eq 0 ]; then
  unsigned=0
  while read -r f; do
    if ! python3 - "$f" <<'PYCHECK'
import sys, zipfile, struct

# An APK and an AAB are signed differently, and checking only one way reports a
# perfectly good build as unsigned — which is exactly what this check did on its
# first real run. An AAB carries a JAR signature (META-INF/*.RSA). An APK built
# today carries APK Signature Scheme v2/v3, which is a block appended just
# before the central directory and leaves NOTHING in META-INF. Accept either.
path = sys.argv[1]

with zipfile.ZipFile(path) as z:
    jar_signed = any(
        n.startswith("META-INF/") and n.upper().endswith((".RSA", ".EC", ".DSA"))
        for n in z.namelist()
    )

def apk_sig_block(path):
    """True if the APK Signing Block magic sits right before the central directory."""
    with open(path, "rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        # Walk back over the End Of Central Directory record (22 bytes + comment).
        window = min(size, 65535 + 22)
        fh.seek(size - window)
        tail = fh.read(window)
        i = tail.rfind(b"PK\x05\x06")
        if i < 0:
            return False
        cd_offset = struct.unpack_from("<I", tail, i + 16)[0]
        if cd_offset < 16 or cd_offset > size:
            return False
        fh.seek(cd_offset - 16)
        return fh.read(16) == b"APK Sig Block 42"

sys.exit(0 if jar_signed or apk_sig_block(path) else 1)
PYCHECK
    then
      echo "    UNSIGNED: $f" >&2
      unsigned=1
    fi
  done < <(find "$OUT_DIR" \( -name "*.apk" -o -name "*.aab" \) 2>/dev/null | sort)
  if [ "$unsigned" -ne 0 ]; then
    echo "" >&2
    echo "ERROR: release artifacts above carry no JAR signature. They cannot be" >&2
    echo "       uploaded to Play and cannot update an installed sideload." >&2
    echo "       Check that ANDROID_KEYSTORE_PATH / ANDROID_KEYSTORE_PASS /" >&2
    echo "       ANDROID_KEY_ALIAS / ANDROID_KEY_PASS reached gradle." >&2
    exit 1
  fi
  echo "    (all release artifacts carry a JAR signature)"
fi

if [ "$DEBUG" -eq 0 ]; then
  VERSION=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
  STAGE_DIR="../dist-android"
  mkdir -p "$STAGE_DIR"
  cp "$OUT_DIR/apk/universal/release/app-universal-universal-release.apk"   "$STAGE_DIR/SoloMD_${VERSION}_universal.apk"
  cp "$OUT_DIR/apk/universal/release/app-universal-arm64-v8a-release.apk"   "$STAGE_DIR/SoloMD_${VERSION}_arm64-v8a.apk"
  cp "$OUT_DIR/apk/universal/release/app-universal-armeabi-v7a-release.apk" "$STAGE_DIR/SoloMD_${VERSION}_armeabi-v7a.apk"
  cp "$OUT_DIR/apk/universal/release/app-universal-x86_64-release.apk"      "$STAGE_DIR/SoloMD_${VERSION}_x86_64.apk"
  cp "$OUT_DIR/bundle/universalRelease/app-universal-release.aab"           "$STAGE_DIR/SoloMD_${VERSION}.aab"
  echo ""
  echo "==> Staged canonical release files in dist-android/:"
  ls -lh "$STAGE_DIR"/SoloMD_"${VERSION}"*
  echo ""
  echo "Next:"
  echo "  - Sideload: pick the per-ABI APK matching the user's phone (arm64-v8a covers ~all 2019+ devices)."
  echo "  - Play Console: upload app-release.aab via https://play.google.com/console/"
  echo "  - F-Droid: open MR on fdroiddata with metadata pointing at this release."
fi
