# title: Search screen finds a note in the open folder by its text
# row: 5.0 §8
run_check() {
  go_home || launch_app
  local w h; read -r w h < <(screen_size)
  tap "$RX_SEARCH" --class Button --within "$((h * 8 / 10)),$h" || { fail "no Search tab"; return; }
  sleep 1
  tap '' --class EditText >/dev/null 2>&1
  type_ascii "zebracorn"; key KEYCODE_ENTER
  sleep 4; dump
  shot A12-search >/dev/null
  local hits; hits=$(bounds_all '[0-9]+ (hits?|个结果|条)' | cut -d' ' -f5- | head -1)
  note "result line: $hits"
  if has 'alpha' && ! has '^(No matches|无匹配|没有匹配)'; then
    pass "zebracorn -> alpha.md ($hits)"
  else
    fail "full-text search for 'zebracorn' (in alpha.md) returns no matches in a SAF folder ($hits)"
  fi
  key KEYCODE_BACK; sleep 1
  [ "$(foreground_pkg)" = "$PKG" ] || launch_app
}
