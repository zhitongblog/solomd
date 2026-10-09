# Pasting an image from the clipboard saves it under _assets/ and links it.
start_on plain.md || fail "app did not start"
clip_put_file "$RG_ROOT/paste.png" image/png
note "clipboard TARGETS: $(clip_targets | tr '\n' ' ')"
key ctrl+End Return
key ctrl+v; sleep 3
shot pasted >/dev/null
a=$(ls "$VAULT/_assets"/*.png 2>/dev/null | head -1)
note "asset: ${a:-none}"
expect "image saved under _assets/" test -n "$a"
[ -n "$a" ] && expect "saved image is the pasted 48x32 picture" test "$(identify -format '%wx%h' "$a" 2>/dev/null)" = 48x32
key ctrl+s; sleep 1.5
expect "note links _assets/… on disk" grep -q '](_assets/.*\.png)' "$VAULT/plain.md"
finish "image paste works"
