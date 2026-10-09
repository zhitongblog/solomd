# title: Dark mode toggle (More menu) darkens the UI and toggles back
# row: 5.0
run_check() {
  open_note alpha >/dev/null || in_editor || { fail "cannot open alpha"; return; }
  local l0 l1 l2
  l0=$(luma "$(shot A15-light)")
  menu_pick "$RX_DARK" || { fail "no Dark mode item"; return; }
  sleep 2; l1=$(luma "$(shot A15-dark)")
  open_more; dump; local checked=0; has '^✓ (Dark mode|深色模式)$' --class MenuItem && checked=1
  tap "$RX_DARK" --class MenuItem; sleep 2
  l2=$(luma "$(shot A15-light-again)")
  note "mean luma light=$l0 dark=$l1 back=$l2, ✓ shown=$checked"
  if [ "$l0" -gt 180 ] && [ "$l1" -lt 80 ] && [ "$l2" -gt 180 ] && [ "$checked" = 1 ]; then
    pass "luma $l0 -> $l1 -> $l2, menu shows ✓ Dark mode while on"
  else fail "luma light=$l0 dark=$l1 back=$l2 checked=$checked"; fi
}
