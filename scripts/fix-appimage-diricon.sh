#!/usr/bin/env bash
#
# Repair the dangling `.DirIcon` symlink tauri-bundler bakes into AppImages.
#
# #291 — every AppImage we have shipped carries this at the AppDir root:
#
#   .DirIcon -> /home/runner/work/solomd/solomd/app/src-tauri/target/release/\
#               bundle/appimage/SoloMD.AppDir/SoloMD.png
#
# an absolute path to the CI runner's build directory, which exists on no
# user's machine. Running the AppImage directly is unaffected — nothing
# resolves .DirIcon at launch — but installers that unpack it (AppManager,
# Gear Lever, and anything else walking the AppDir) refuse the package:
# "Symlink target not found". The sibling `SoloMD.png` symlink right next to
# it is relative and correct, so this is purely tauri-bundler writing the
# wrong one of the two. Reported upstream against other Tauri apps too.
#
# The repair is a symlink swap, but a squashfs is immutable, so the image has
# to be rebuilt: keep the original ELF runtime bytes verbatim, re-pack the
# AppDir with the same compressor and block size, concatenate. That is all
# `appimagetool` does for a type-2 image, minus the FUSE requirement — which
# matters, because it makes this runnable (and testable) off Linux too.
#
# Usage: scripts/fix-appimage-diricon.sh <file.AppImage> [more.AppImage ...]
#
# Idempotent: an image whose .DirIcon is already relative is left untouched
# and reported as such, so the day tauri-bundler fixes this upstream the
# script quietly becomes a no-op instead of needlessly repacking.

set -euo pipefail

WORKDIRS=""
cleanup() { for d in $WORKDIRS; do rm -rf "$d"; done; }
trap cleanup EXIT

if [ $# -eq 0 ]; then
  echo "usage: $0 <file.AppImage> [...]" >&2
  exit 2
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 is required but not installed" >&2
    exit 1
  }
}
need unsquashfs
need mksquashfs
need python3

# The squashfs starts where the ELF ends. A type-2 runtime finds it the same
# way at launch, so this is the offset by definition, not a guess — unlike
# scanning for the 'hsqs' magic, which finds compressed payload bytes first.
elf_end() {
  python3 - "$1" <<'PY'
import struct, sys
with open(sys.argv[1], 'rb') as f:
    h = f.read(64)
if h[:4] != b'\x7fELF':
    raise SystemExit('not an ELF: %s' % sys.argv[1])
shoff = struct.unpack_from('<Q', h, 0x28)[0]
shentsize = struct.unpack_from('<H', h, 0x3a)[0]
shnum = struct.unpack_from('<H', h, 0x3c)[0]
print(shoff + shentsize * shnum)
PY
}

fix_one() {
  local img="$1"
  [ -f "$img" ] || { echo "error: no such file: $img" >&2; exit 1; }

  local off
  off="$(elf_end "$img")"
  python3 -c "
import sys
f = open(sys.argv[1], 'rb'); f.seek(int(sys.argv[2]))
raise SystemExit(0 if f.read(4) == b'hsqs' else 'no squashfs at offset ' + sys.argv[2])
" "$img" "$off"

  local work
  work="$(mktemp -d)"
  WORKDIRS="$WORKDIRS $work"

  # Compressor and block size are read back off the image rather than assumed:
  # a future tauri-bundler that switches from zstd would otherwise silently get
  # its images re-packed as gzip, inflating every download.
  local super comp bs
  super="$(unsquashfs -s -o "$off" "$img")"
  comp="$(printf '%s\n' "$super" | sed -n 's/^Compression *//p' | head -1)"
  bs="$(printf '%s\n' "$super" | sed -n 's/^Block size *//p' | head -1)"
  [ -n "$comp" ] && [ -n "$bs" ] || { echo "error: cannot read superblock of $img" >&2; exit 1; }

  unsquashfs -q -n -o "$off" -d "$work/AppDir" "$img" >/dev/null

  local icon target
  icon="$work/AppDir/.DirIcon"
  if [ ! -L "$icon" ]; then
    echo "$(basename "$img"): no .DirIcon symlink — nothing to repair"
    return 0
  fi
  target="$(readlink "$icon")"
  case "$target" in
    /*) ;;
    *)
      echo "$(basename "$img"): .DirIcon -> $target (already relative) — left alone"
      return 0
      ;;
  esac

  # Point it at the sibling the bundler already got right. Verified below to
  # be a real file inside the AppDir, so a bundler that one day stops emitting
  # that sibling fails here loudly rather than shipping a second dead link.
  local rel
  rel="$(basename "$target")"
  [ -e "$work/AppDir/$rel" ] || {
    echo "error: $img: .DirIcon pointed at $target but no ./$rel exists in the AppDir" >&2
    exit 1
  }
  ln -sf "$rel" "$icon"

  # Nothing else may reach outside the AppDir either.
  local strays
  strays="$(find "$work/AppDir" -type l -exec sh -c 'case "$(readlink "$1")" in /*) echo "$1 -> $(readlink "$1")";; esac' _ {} \; || true)"
  if [ -n "$strays" ]; then
    echo "error: $img still carries absolute symlinks:" >&2
    printf '%s\n' "$strays" >&2
    exit 1
  fi

  head -c "$off" "$img" > "$work/runtime.bin"
  # -all-root matches what the shipped images already contain (uid/gid 0) and
  # keeps the result independent of who ran the script; -no-xattrs because the
  # originals carry none and an unpack on macOS would otherwise smuggle
  # com.apple.provenance into the rebuild.
  mksquashfs "$work/AppDir" "$work/fs.squashfs" \
    -noappend -no-progress -quiet \
    -comp "$comp" -b "$bs" \
    -all-root -no-xattrs -mkfs-time 0 >/dev/null

  cat "$work/runtime.bin" "$work/fs.squashfs" > "$work/new.AppImage"
  chmod +x "$work/new.AppImage"

  # --- verify before overwriting anything -------------------------------
  local noff
  noff="$(elf_end "$work/new.AppImage")"
  [ "$noff" = "$off" ] || {
    echo "error: runtime length changed ($off -> $noff)" >&2
    exit 1
  }
  local before after
  before="$(unsquashfs -l -o "$off" "$img" | grep -c '^squashfs-root')"
  after="$(unsquashfs -l -o "$noff" "$work/new.AppImage" | grep -c '^squashfs-root')"
  [ "$before" = "$after" ] || {
    echo "error: entry count changed ($before -> $after)" >&2
    exit 1
  }
  unsquashfs -q -n -o "$noff" -d "$work/check" "$work/new.AppImage" >/dev/null
  [ -L "$work/check/.DirIcon" ] || { echo "error: .DirIcon is not a symlink in the rebuild" >&2; exit 1; }
  case "$(readlink "$work/check/.DirIcon")" in
    /*) echo "error: .DirIcon is still absolute in the rebuild" >&2; exit 1 ;;
  esac
  [ -e "$work/check/.DirIcon" ] || { echo "error: .DirIcon does not resolve in the rebuild" >&2; exit 1; }

  # Written in place only now that the rebuild has been checked end to end.
  cat "$work/new.AppImage" > "$img"
  chmod +x "$img"

  echo "$(basename "$img"): was  .DirIcon -> $target"
  echo "$(basename "$img"): now  .DirIcon -> $rel   ($after entries, $comp, ${bs}-byte blocks)"
}

for f in "$@"; do
  fix_one "$f"
done
