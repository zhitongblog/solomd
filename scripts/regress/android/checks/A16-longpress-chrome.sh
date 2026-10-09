# title: long-press on chrome text (home title, bottom bar) selects nothing
# row: L9
run_check() {
  go_home || launch_app
  local c errs=() w h; read -r w h < <(screen_size)
  for spec in "$RX_NOTES#TextView#0,450" "$RX_SEARCH#Button#$((h * 8 / 10)),$h"; do
    IFS='#' read -r rx cls within <<<"$spec"
    dump; c=$(find_el "$rx" --class "$cls" --within "$within") || { errs+=("no $rx $cls"); continue; }
    set -- $c
    sh_ input swipe "$1" "$2" "$1" "$2" 1200; sleep 1; dump
    if has '^(Copy|Select all|复制|全选)$'; then errs+=("long-press on $rx ($cls) selected text"); shot A16-selected >/dev/null; key KEYCODE_BACK; fi
  done
  shot A16-after >/dev/null
  go_home >/dev/null 2>&1
  [ "$(foreground_pkg)" = "$PKG" ] || launch_app
  if [ ${#errs[@]} -eq 0 ]; then pass "no text-selection toolbar after long-press on title / tab bar"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
