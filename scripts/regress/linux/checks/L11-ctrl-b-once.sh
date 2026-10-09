# Ctrl+B (held like a person, 0.15 s) toggles the file tree exactly once.
TREE=250x650+0+200
start_on index.md || fail "app did not start"
has_tree() { python3 "$RG_SUITE/lib/ocr.py" has "$1" eng long.md "$TREE"; }
states=""
img=$(shot s0); has_tree "$img" && states+="shown" || states+="hidden"
for i in 1 2 3 4; do
  key ctrl+b; sleep 0.8
  img=$(shot "s$i"); has_tree "$img" && states+=" shown" || states+=" hidden"
done
note "tree after 0..4 presses: $states"
expect "each press toggles once (shown hidden shown hidden shown)" test "$states" = "shown hidden shown hidden shown"
app_quit 10 || app_kill
expect "settings.showFileTree ends true" test "$(ls_json solomd.settings.v1 'v.get("showFileTree")')" = true
finish "Ctrl+B toggles once per press"
