# title: rotate to landscape and back with a note open — layout survives
# row: 5.0
run_check() {
  open_note alpha >/dev/null || in_editor || { fail "cannot open alpha"; return; }
  local pid0 errs=() w h sb; pid0=$(app_pid)
  sh_ settings put system accelerometer_rotation 0
  sh_ settings put system user_rotation 1; sleep 3
  read -r w h < <(screen_size); note "landscape ${w}x${h}"
  [ "$w" -gt "$h" ] || errs+=("device did not rotate")
  dump; shot A17-landscape >/dev/null
  has 'zebracorn' || errs+=("landscape: note text not visible")
  if has "$RX_NOTES" --class Button --within 0,450; then note "landscape uses the phone shell"
  else note "landscape uses the desktop header (tab strip + segmented view switch); on this emulator the pointer may report fine (stylus input), so the (max-height:480)&(pointer:coarse) phone query may not match"; fi
  # the More menu must stay on screen sideways too
  if open_more; then
    dump; sb=$(status_bar_bottom)
    local line; while read -r line; do set -- $line
      { [ "$1" -lt 0 ] || [ "$3" -gt "$w" ]; } && errs+=("landscape menu item off screen: $line")
    done < <(bounds_all '' --class MenuItem)
    shot A17-landscape-more >/dev/null
    close_more
  else errs+=("landscape: no More button"); fi
  sh_ settings put system user_rotation 0; sleep 3
  read -r w h < <(screen_size)
  dump; shot A17-portrait >/dev/null
  [ "$(app_pid)" = "$pid0" ] || note "process restarted during rotation"
  [ "$h" -gt "$w" ] || errs+=("did not rotate back")
  in_editor && has 'zebracorn' || on_home || errs+=("after rotating back neither the editor nor home is shown")
  in_editor || note "after rotating back the app shows home, not the note that was open"
  if [ ${#errs[@]} -eq 0 ]; then pass "landscape renders the note + menu on screen; portrait restored"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
