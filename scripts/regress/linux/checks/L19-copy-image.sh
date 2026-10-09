# Copy as Image (PNG): no save dialog; clipboard offers image/png.
start_on index.md || fail "app did not start"
printf 'placeholder' | app_env xclip -selection clipboard -i >/dev/null 2>&1; sleep 0.3
palette "Copy as Image (PNG)"
sleep 5
dlg=$(xdotool search --onlyvisible --name '^(Save|Save File)' 2>/dev/null)
shot after >/dev/null
[ -n "$dlg" ] && { key Escape; }
expect "no Save dialog (copy, not export)" test -z "$dlg"
t=$(clip_targets | tr '\n' ' '); note "clipboard TARGETS: $t"
expect "clipboard offers image/png" contains " $t" " image/png "
clip_get image/png >"$RG_ROOT/clip.png"
info=$(identify -format '%m %w %h' "$RG_ROOT/clip.png" 2>/dev/null); note "clipboard image: ${info:-unreadable}"
expect "clipboard image decodes as PNG" contains "$info" "PNG"
finish "copy as image puts a PNG on the clipboard"
