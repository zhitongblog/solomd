# title: cold first launch lands on the 5.0 phone home (笔记, bottom bar, new-note button)
# row: 5.0 §8
run_check() {
  force_stop; sh_ pm clear "$PKG" >/dev/null
  launch_app
  wait_for "$RX_NOTES" 30 --class TextView --within 0,450 || true
  shot A01-home >/dev/null
  local w h errs=(); read -r w h < <(screen_size)
  local bottom="$((h * 8 / 10)),$h"
  [ "$(foreground_pkg)" = "$PKG" ] || errs+=("app not in foreground")
  has "$RX_NOTES" --class TextView --within 0,450 || errs+=("no large '笔记/Notes' title")
  has "$RX_NOTES"    --class Button --within "$bottom" || errs+=("bottom bar: no Notes tab")
  has "$RX_SEARCH"   --class Button --within "$bottom" || errs+=("bottom bar: no Search tab")
  has "$RX_SETTINGS" --class Button --within "$bottom" || errs+=("bottom bar: no Settings tab")
  has "$RX_NEWNOTE"  --class Button || errs+=("no floating New note button")
  has "$RX_OPENFOLDER" --class Button || errs+=("no Open Folder… on an empty home")
  # The editor screen must NOT be what a cold start shows.
  has "$RX_MORE" --class Button && errs+=("editor header visible on cold start")
  if [ ${#errs[@]} -eq 0 ]; then pass "home: title, bottom bar Notes/Search/Settings, FAB New note, Open Folder…"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
