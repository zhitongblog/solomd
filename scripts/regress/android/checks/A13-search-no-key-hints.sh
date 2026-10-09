# title: Search screen shows no keyboard hints on a phone
# row: L9
run_check() {
  go_home || launch_app
  local w h; read -r w h < <(screen_size)
  tap "$RX_SEARCH" --class Button --within "$((h * 8 / 10)),$h" || { fail "no Search tab"; return; }
  sleep 1; hide_keyboard; dump
  shot A13-search >/dev/null
  local hints; hints=$(bounds_all "$RX_HINT" | cut -d' ' -f5- | tr '\n' ';')
  [ "$(foreground_pkg)" = "$PKG" ] || launch_app
  go_home >/dev/null 2>&1 || tap "$RX_NOTES" --class Button --within "$((h * 8 / 10)),$h"
  if [ -z "$hints" ]; then pass "no shortcut hints on the search screen"
  else fail "search screen shows desktop key hints: $hints"; fi
}
