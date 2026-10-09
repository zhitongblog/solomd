# title: view modes via More: Source, Preview, back to Live
# row: 5.0 §8
run_check() {
  in_editor || open_note alpha >/dev/null || { fail "cannot open alpha"; return; }
  local errs=()
  menu_pick "$RX_SOURCE" || errs+=("could not pick Source")
  sleep 1; open_more; dump
  has '^✓ (Source|源码)$' --class MenuItem || errs+=("Source not checked after picking it")
  shot A08-source >/dev/null
  tap "$RX_PREVIEW" --class MenuItem; sleep 2; dump
  shot A08-preview >/dev/null
  has '' --class EditText && errs+=("Preview still shows the editor (EditText)")
  has '^Alpha$' --class TextView || errs+=("Preview does not render the heading 'Alpha'")
  menu_pick "$RX_LIVE"; sleep 2; dump
  shot A08-live >/dev/null
  has 'zebracorn' --class EditText || errs+=("back to Live: editor missing")
  if [ ${#errs[@]} -eq 0 ]; then pass "Source ✓ / Preview renders heading, no editor / Live restores the editor"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
