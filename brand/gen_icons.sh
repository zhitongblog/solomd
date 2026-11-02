#!/usr/bin/env bash
# Regenerate SoloMD app and Markdown document icons from the SVG masters.
set -euo pipefail

BRAND_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$BRAND_DIR/.." && pwd)"
ICON_DIR="$REPO_DIR/app/src-tauri/icons"

command -v magick >/dev/null
command -v iconutil >/dev/null
command -v rsvg-convert >/dev/null

# App icon: Tauri creates the cross-platform matrix, then the macOS helper
# applies the platform-specific safe area and continuous-corner mask.
magick -background none "$BRAND_DIR/solomd-mark.svg" -resize 1024x1024 -depth 8 -strip \
  "$BRAND_DIR/solomd_icon_fullbleed.png"
magick "$BRAND_DIR/solomd_icon_fullbleed.png" -alpha off -depth 8 -strip \
  "$REPO_DIR/app-store/icon-1024.png"
mkdir -p "$REPO_DIR/app-store/google-play"
grep -v 'rx="206"' "$BRAND_DIR/solomd-mark.svg" \
  | rsvg-convert -w 512 -h 512 \
  | magick png:- -alpha off -depth 8 -strip \
  "$REPO_DIR/app-store/google-play/icon-512.png"
for locale in "" "-zh"; do
  rsvg-convert -w 1024 -h 538 "$BRAND_DIR/og-image${locale}.svg" \
    | magick png:- -gravity center -crop 1024x500+0+0 +repage -depth 8 -strip \
    "$REPO_DIR/app-store/google-play/feature-graphic${locale}.png"
done
(
  cd "$REPO_DIR/app"
  pnpm tauri icon ../brand/solomd_icon_fullbleed.png --output src-tauri/icons
)
"$REPO_DIR/scripts/gen-mac-icon.sh"

# Tauri's mobile generators can skip pre-existing native project assets. Make
# the checked-in iOS and Android matrices deterministic as a final pass.
for target in "$ICON_DIR"/ios/AppIcon-*.png; do
  read -r width height < <(magick identify -format '%w %h\n' "$target")
  magick "$BRAND_DIR/solomd_icon_fullbleed.png" -resize "${width}x${height}!" \
    -depth 8 -strip "$target"
done

# When the native mobile projects already exist locally, keep the assets they
# compile in sync as well. These directories are generated/ignored, so this is
# intentionally conditional and does not make them release sources of truth.
APPLE_APPICON_DIR="$REPO_DIR/app/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"
if [[ -d "$APPLE_APPICON_DIR" ]]; then
  cp "$ICON_DIR"/ios/AppIcon-*.png "$APPLE_APPICON_DIR/"
fi

for spec in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  IFS=: read -r density launcher foreground <<< "$spec"
  android_dir="$ICON_DIR/android/mipmap-$density"
  magick "$BRAND_DIR/solomd_icon_fullbleed.png" -resize "${launcher}x${launcher}!" -depth 8 -strip \
    "$android_dir/ic_launcher.png"
  half=$((launcher / 2))
  magick "$BRAND_DIR/solomd_icon_fullbleed.png" -resize "${launcher}x${launcher}!" \
    \( -size "${launcher}x${launcher}" xc:none -fill white \
       -draw "circle $half,$half $half,0" \) \
    -alpha off -compose CopyOpacity -composite -depth 8 -strip "$android_dir/ic_launcher_round.png"
  # Android adaptive icon foreground is a 108dp canvas masked to the inner 66dp
  # safe zone (~66%). Render the mark without the outer squircle stroke so no
  # launcher mask clips the arms of the `#` or shows an inner border.
  safe=$((foreground * 66 / 100))
  grep -v 'rx="206"' "$BRAND_DIR/solomd-mark.svg" \
    | rsvg-convert -w "$safe" -h "$safe" \
    | magick -size "${foreground}x${foreground}" xc:"#121110" png:- \
      -gravity center -composite -depth 8 -strip \
      "$android_dir/ic_launcher_foreground.png"
done

ANDROID_RES_DIR="$REPO_DIR/app/src-tauri/gen/android/app/src/main/res"
cat > "$ICON_DIR/android/values/ic_launcher_background.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">#121110</color>
</resources>
EOF
if [[ -d "$ANDROID_RES_DIR" ]]; then
  rm -f "$ANDROID_RES_DIR/drawable-v24/ic_launcher_foreground.xml" \
        "$ANDROID_RES_DIR/drawable/ic_launcher_background.xml"
  cp "$ICON_DIR/android/values/ic_launcher_background.xml" "$ANDROID_RES_DIR/values/ic_launcher_background.xml"
  cp "$ICON_DIR/android/mipmap-anydpi-v26"/ic_launcher*.xml "$ANDROID_RES_DIR/mipmap-anydpi-v26/"
  for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    cp "$ICON_DIR/android/mipmap-$density"/ic_launcher*.png \
      "$ANDROID_RES_DIR/mipmap-$density/"
  done
fi

# Document icon: keep transparent padding so Finder and Explorer can add their
# own selection/background treatment without a visible square.
for size in 32 64 128 256 512 1024; do
  magick -background none "$BRAND_DIR/file_icon.svg" -resize "${size}x${size}" -depth 8 -strip \
    "$BRAND_DIR/file_icon_${size}.png"
done

ICONSET="$BRAND_DIR/file_icon.iconset"
mkdir -p "$ICONSET"
cp "$BRAND_DIR/file_icon_32.png" "$ICONSET/icon_16x16@2x.png"
cp "$BRAND_DIR/file_icon_32.png" "$ICONSET/icon_32x32.png"
magick "$BRAND_DIR/file_icon_1024.png" -resize 16x16 "$ICONSET/icon_16x16.png"
cp "$BRAND_DIR/file_icon_64.png" "$ICONSET/icon_32x32@2x.png"
cp "$BRAND_DIR/file_icon_128.png" "$ICONSET/icon_128x128.png"
cp "$BRAND_DIR/file_icon_256.png" "$ICONSET/icon_128x128@2x.png"
cp "$BRAND_DIR/file_icon_256.png" "$ICONSET/icon_256x256.png"
cp "$BRAND_DIR/file_icon_512.png" "$ICONSET/icon_256x256@2x.png"
cp "$BRAND_DIR/file_icon_512.png" "$ICONSET/icon_512x512.png"
cp "$BRAND_DIR/file_icon_1024.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$BRAND_DIR/file_icon.icns"

magick "$BRAND_DIR/file_icon_256.png" \
  -define icon:auto-resize=256,128,64,48,32,16 "$BRAND_DIR/file_icon.ico"
cp "$BRAND_DIR/file_icon_256.png" "$ICON_DIR/file_icon.png"
cp "$BRAND_DIR/file_icon.icns" "$ICON_DIR/file_icon.icns"
cp "$BRAND_DIR/file_icon.ico" "$ICON_DIR/file_icon.ico"

# Website social cards: exact SVG composition keeps the Portal geometry and
# typography deterministic instead of asking a raster generator to redraw it.
for locale in "" "-zh"; do
  rsvg-convert -w 1200 -h 630 "$BRAND_DIR/og-image${locale}.svg" \
    -o "$BRAND_DIR/og-image${locale}.png"
  cp "$BRAND_DIR/og-image${locale}.png" "$REPO_DIR/web/public/og-image${locale}.png"
done

echo "Regenerated SoloMD app and document icon families."
