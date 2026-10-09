# File > Export > Export to Image (PNG) writes a real PNG.
start_on index.md || fail "app did not start"
palette "Export to Image (PNG)"
gtk_save "$EXP/index.png" || { shot dialog >/dev/null; fail "no / undrivable save dialog"; }
wait_file "$EXP/index.png" 30 || { shot after >/dev/null; fail "no PNG written"; }
info=$(identify -format '%m %w %h' "$EXP/index.png" 2>/dev/null)
note "exported: $info, $(stat -c %s "$EXP/index.png") bytes"
cp "$EXP/index.png" "$SHOTS/$CHECK_ID-exported.png"
read -r fmt w h <<<"$info"
expect "file is a PNG" test "$fmt" = PNG
expect "image is page-sized (w>=600, h>=600)" test "${w:-0}" -ge 600 -a "${h:-0}" -ge 600
expect "image is not blank (>50 colours)" test "$(img_colors "$EXP/index.png")" -gt 50
finish "PNG exported"
