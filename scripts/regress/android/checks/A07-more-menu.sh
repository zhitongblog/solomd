# title: More (⋯) menu stays on screen, offers view modes, shows no shortcut hints
# row: L9
run_check() {
  open_note alpha >/dev/null || in_editor || { fail "cannot open alpha"; return; }
  open_more || { fail "no More button"; return; }
  dump; shot A07-more >/dev/null
  local n errs=() w h sb; n=$(ui count "$DUMP" '' --class MenuItem); read -r w h < <(screen_size); sb=$(status_bar_bottom)
  note "$n menu items"
  [ "$n" -gt 5 ] || { fail "More menu did not open ($n items)"; return; }
  local line
  while read -r line; do
    set -- $line
    { [ "$1" -lt 0 ] || [ "$3" -gt "$w" ] || [ "$2" -lt "$sb" ]; } && errs+=("item off screen: $line")
  done < <(bounds_all '' --class MenuItem)
  local hints; hints=$(bounds_all "$RX_HINT" --class MenuItem | cut -d' ' -f5- | tr '\n' ';')
  [ -z "$hints" ] || errs+=("shortcut hints shown: $hints")
  for rx in "$RX_LIVE" "$RX_SOURCE" "$RX_PREVIEW"; do has "$rx" --class MenuItem || errs+=("view mode $rx missing"); done
  close_more
  if [ ${#errs[@]} -eq 0 ]; then pass "$n items inside ${w}px, below status bar, Live/Source/Preview present, no shortcut hints"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
