# title: display size 600 dpi + font 1.3: More menu and header stay on screen
# row: L9
run_check() {
  open_note beta >/dev/null || true
  sh_ wm density 600; sh_ settings put system font_scale 1.3; sleep 5
  [ "$(foreground_pkg)" = "$PKG" ] || launch_app
  local errs=() w h sb; read -r w h < <(screen_size); sb=$(status_bar_bottom)
  # the display change recreates the activity; the WebView reloads to home
  on_home && note "display change reloaded the app to home"
  open_note alpha >/dev/null || { go_home; open_note beta >/dev/null; } || { sh_ wm density reset; sh_ settings put system font_scale 1.0; fail "cannot open a note at density 600"; return; }
  shot A18-editor >/dev/null
  local line
  for rx in "$RX_NOTES" "$RX_MORE"; do
    line=$(bounds_all "$rx" --class Button --within 0,700 | head -1)
    [ -z "$line" ] && { errs+=("header: no $rx"); continue; }
    set -- $line; { [ "$1" -lt 0 ] || [ "$3" -gt "$w" ] || [ "$2" -lt "$sb" ]; } && errs+=("header $5 off screen: $line")
  done
  if open_more; then
    dump; shot A18-more >/dev/null
    local n; n=$(ui count "$DUMP" '' --class MenuItem)
    while read -r line; do set -- $line
      { [ "$1" -lt 0 ] || [ "$3" -gt "$w" ] || [ "$2" -lt "$sb" ]; } && errs+=("menu item off screen: $line")
    done < <(bounds_all '' --class MenuItem)
    local last; last=$(bounds_all '' --class MenuItem | tail -1)
    note "$n items visible, last: $last (menu scrolls)"
    has "$RX_LIVE" --class MenuItem || errs+=("first menu items (view modes) not visible")
    close_more
  else errs+=("no More button at density 600"); fi
  sh_ wm density reset; sh_ settings put system font_scale 1.0; sleep 4
  [ "$(foreground_pkg)" = "$PKG" ] || launch_app
  if [ ${#errs[@]} -eq 0 ]; then pass "density 600 + font 1.3: header and More menu inside the screen (left/right/top)"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
