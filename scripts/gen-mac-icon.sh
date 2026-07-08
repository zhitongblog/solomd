#!/usr/bin/env bash
# gen-mac-icon.sh — Regenerate the macOS app icon for SoloMD (GitHub issue #111).
#
# Takes the full-bleed square design (app/src-tauri/icons/icon.png — black bg +
# orange "#" + white "MD") and produces a Big Sur-spec macOS app icon:
#   - 1024x1024 transparent canvas
#   - design body scaled to 824x824 (≈100px transparent margin on all sides)
#   - body corners cut to a macOS-style continuous "squircle" (superellipse n=5,
#     ≈22% corner) with transparent outside
#   - emits icon-macos-source-1024.png + a full .iconset + icon.icns
#
# Only the macOS app icon (icon.icns) is touched. Windows (.ico), Linux/Android
# square PNGs and file_icon.* are left as full-bleed squares on purpose.
#
# Requires: magick (ImageMagick 7), sips, iconutil, python3
set -euo pipefail

ICONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/app/src-tauri/icons"
SRC="$ICONS_DIR/icon.png"            # full-bleed square design source
CANVAS=1024
BODY=824                             # icon body size (≈80.5% of canvas)
PAD=$(( (CANVAS - BODY) / 2 ))       # 100px margin
SS=3                                 # supersample factor for crisp antialiasing
BODY_HI=$(( BODY * SS ))
N=5.0                                # superellipse exponent (macOS squircle ≈ 5)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. superellipse (squircle) polygon points, centered in a BODY_HI box ---
POINTS="$(python3 - "$BODY_HI" "$N" <<'PY'
import sys, math
size = int(sys.argv[1]); n = float(sys.argv[2])
a = b = size / 2.0
cx = cy = size / 2.0
pts = []
steps = 1440
for i in range(steps):
    t = 2.0 * math.pi * i / steps
    ct, st = math.cos(t), math.sin(t)
    x = cx + a * math.copysign(abs(ct) ** (2.0 / n), ct)
    y = cy + b * math.copysign(abs(st) ** (2.0 / n), st)
    pts.append(f"{x:.3f},{y:.3f}")
print(" ".join(pts))
PY
)"

# --- 2. render squircle mask (white on black) at high res ---
magick -size "${BODY_HI}x${BODY_HI}" xc:black \
  -fill white -draw "polygon $POINTS" \
  "$WORK/mask_hi.png"

# --- 3. scale design to body size (hi-res) and clip to the squircle ---
magick "$SRC" -resize "${BODY_HI}x${BODY_HI}!" "$WORK/body_hi.png"
magick "$WORK/body_hi.png" "$WORK/mask_hi.png" \
  -alpha off -compose CopyOpacity -composite "$WORK/body_clipped_hi.png"

# --- 4. downsample body to 824 and center on a 1024 transparent canvas ---
magick "$WORK/body_clipped_hi.png" -resize "${BODY}x${BODY}" "$WORK/body.png"
magick -size "${CANVAS}x${CANVAS}" xc:none \
  "$WORK/body.png" -geometry "+${PAD}+${PAD}" -compose over -composite \
  "$ICONS_DIR/icon-macos-source-1024.png"

echo "Wrote $ICONS_DIR/icon-macos-source-1024.png"

# --- 5. build .iconset from the 1024 source and convert to icns ---
ISET="$WORK/icon.iconset"
mkdir -p "$ISET"
SRC1024="$ICONS_DIR/icon-macos-source-1024.png"
gen() { sips -z "$2" "$2" "$SRC1024" --out "$ISET/$1" >/dev/null; }
gen icon_16x16.png        16
gen icon_16x16@2x.png     32
gen icon_32x32.png        32
gen icon_32x32@2x.png     64
gen icon_128x128.png     128
gen icon_128x128@2x.png  256
gen icon_256x256.png     256
gen icon_256x256@2x.png  512
gen icon_512x512.png     512
gen icon_512x512@2x.png 1024
iconutil -c icns "$ISET" -o "$ICONS_DIR/icon.icns"
echo "Wrote $ICONS_DIR/icon.icns"
