# title: New note (FAB) -> type -> Save into the folder (SAF save dialog) -> listed on home
# row: 5.0 §8 / L8
run_check() {
  go_home || launch_app
  tap "$RX_NEWNOTE" --class Button || { fail "no New note button"; return; }
  sleep 2
  in_editor || { shot A11-new >/dev/null; fail "New note did not open the editor"; return; }
  local tok="newnote-$RANDOM" fname="regress-new-$RANDOM.md"
  type_ascii "# Gamma"; key KEYCODE_ENTER; type_ascii "body $tok"; sleep 1
  shot A11-typed >/dev/null
  menu_pick "$RX_SAVE" || { fail "no Save in More"; return; }
  # An untitled note has no path: Android shows the SAF create-document dialog.
  if ! wait_for '^(SAVE|Save|保存)$' 15 --class Button; then shot A11-no-dialog >/dev/null; fail "no save dialog (fg=$(foreground_pkg))"; return; fi
  shot A11-save-dialog >/dev/null
  tap '' --class EditText
  sh_ input keycombination 113 29; key KEYCODE_DEL     # Ctrl+A, delete
  type_ascii "$fname"; sleep 1
  tap '^(SAVE|Save|保存)$' --class Button
  local end=$(( $(date +%s) + 15 ))
  while [ "$(foreground_pkg)" != "$PKG" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 1; done
  sleep 2
  local body; body=$(sh_ cat "$REMOTE_DIR/$fname" 2>&1)
  note "on device: $(tr '\n' '|' <<<"$body")"
  local errs=()
  grep -q "$tok" <<<"$body" || errs+=("$REMOTE_DIR/$fname missing or without the typed text")
  grep -q '^# Gamma' <<<"$body" || errs+=("heading '# Gamma' not saved")
  go_home; sleep 1; dump
  shot A11-listed >/dev/null
  has "^${fname%.md}\$" --class TextView || errs+=("${fname%.md} not listed on home")
  if [ ${#errs[@]} -eq 0 ]; then pass "saved $fname via the SAF dialog, bytes on /sdcard, listed on home"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
