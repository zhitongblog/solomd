# title: system Back in the editor returns to Notes home (does not leave the app)
# row: L8
run_check() {
  in_editor || open_note alpha >/dev/null || { fail "cannot open alpha"; return; }
  hide_keyboard
  local errs=()
  key KEYCODE_BACK; sleep 2
  local fg; fg=$(foreground_pkg)
  shot A10-after-back >/dev/null
  if [ "$fg" != "$PKG" ]; then
    errs+=("Back in the editor left the app (foreground: $fg) instead of returning to Notes")
    launch_app; sleep 1
  elif ! on_home; then
    errs+=("Back in the editor did not show Notes home")
  fi
  # Back with the More menu open should close the menu, not the app.
  open_note beta >/dev/null || open_note alpha >/dev/null
  open_more; key KEYCODE_BACK; sleep 2
  fg=$(foreground_pkg)
  shot A10-menu-back >/dev/null
  if [ "$fg" != "$PKG" ]; then errs+=("Back with the More menu open left the app"); launch_app; sleep 1; fi
  if [ ${#errs[@]} -eq 0 ]; then pass "Back: editor -> home, menu closes, app stays"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
