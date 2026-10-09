# title: edit a note in the SAF folder, Save, bytes land in the real /sdcard file
# row: L8
run_check() {
  in_editor || open_note alpha >/dev/null || { fail "cannot open alpha"; return; }
  local tok="regress-edit-$RANDOM"
  # tap the empty area under the text: caret goes to the end of the document
  local w h; read -r w h < <(screen_size)
  tap_xy $((w / 2)) $((h * 6 / 10)); sleep 1
  key KEYCODE_ENTER
  type_ascii "$tok"; sleep 1
  menu_pick "$RX_SAVE" || { fail "no Save in More"; return; }
  sleep 2; shot A09-saved >/dev/null
  local body; body=$(sh_ cat "$REMOTE_DIR/alpha.md")
  if grep -q "$tok" <<<"$body" && grep -q zebracorn <<<"$body"; then
    pass "$REMOTE_DIR/alpha.md now ends with '$(tail -1 <<<"$body")' (original text intact)"
  else
    fail "token $tok not in $REMOTE_DIR/alpha.md after Save: $(tr '\n' '|' <<<"$body")"
  fi
}
