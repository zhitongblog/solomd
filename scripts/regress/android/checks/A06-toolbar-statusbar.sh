# title: editor toolbar and home title sit below the status bar
# row: L8
run_check() {
  in_editor || open_note alpha >/dev/null
  local sb errs=() line; sb=$(status_bar_bottom)
  note "status bar bottom: ${sb}px"
  [ "$sb" -gt 0 ] || { fail "could not read the status bar height"; return; }
  shot A06-editor >/dev/null
  for rx in "$RX_NOTES" "$RX_MORE"; do
    line=$(bounds_all "$rx" --class Button --within 0,600 | head -1)
    [ -z "$line" ] && { errs+=("no $rx button in the header"); continue; }
    set -- $line
    note "$5 top=$2"
    [ "$2" -ge "$sb" ] || errs+=("$5 top $2 < status bar $sb")
  done
  go_home
  line=$(bounds_all "$RX_NOTES" --class TextView --within 0,600 | head -1)
  # The title is text, not a control: its element box includes top padding,
  # so allow 8px of box (not glyph) overlap before calling it "under".
  if [ -n "$line" ]; then set -- $line; note "home title box top=$2"; [ "$2" -ge $((sb - 8)) ] || errs+=("home title box top $2 under the ${sb}px status bar"); fi
  if [ ${#errs[@]} -eq 0 ]; then pass "header buttons and home title start below the ${sb}px status bar"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
