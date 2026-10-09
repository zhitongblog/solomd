# title: Settings (bottom bar) opens full-screen and closes again
# row: 5.0 §8
run_check() {
  local w h; read -r w h < <(screen_size)
  tap "$RX_SETTINGS" --class Button --within "$((h * 8 / 10)),$h" || { fail "no Settings tab"; return; }
  wait_for "$RX_BASICS" 10 --class Button || true
  shot A02-settings >/dev/null
  if ! has "$RX_SETTINGS" --class Dialog; then fail "Settings dialog did not open"; return; fi
  has "$RX_BASICS" --class Button || { fail "Settings opened without its section chips"; return; }
  local sb; sb=$(status_bar_bottom)
  local c; c=$(find_el '^(Close|关闭)$' --class Button) || { fail "Settings has no Close button"; return; }
  set -- $c
  [ "$4" -ge "$sb" ] || { fail "Settings Close button (y=$4) under the status bar ($sb)"; return; }
  tap_xy "$1" "$2"; sleep 1; dump
  if has "$RX_SETTINGS" --class Dialog; then fail "Close did not dismiss Settings"; return; fi
  pass "Settings dialog opens (Basics chip, Close at y=$4 below status bar $sb) and closes"
}
