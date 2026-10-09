# Closing a second window with unsaved edits prompts; Don't Save drops them.
start_on plain.md || fail "app did not start"
mainw=$(main_window)
key ctrl+shift+n; sleep 4
w2=""
for i in $(seq 1 20); do
  for w in $(app_windows); do [ "$w" != "$mainw" ] && w2=$w; done
  [ -n "$w2" ] && break; sleep 0.5
done
[ -n "$w2" ] || { shot nowin >/dev/null; fail "Ctrl+Shift+N opened no second window"; }
note "second window $w2: $(xdotool getwindowname "$w2") $(win_geom "$w2")"
xdotool windowactivate --sync "$w2"; sleep 1.5
read -r x y ww hh < <(win_geom "$w2")
click $((x + ww * 3 / 4)) $((y + hh / 2)); key ctrl+End
typ " W2EDIT"; sleep 0.8
shot w2typed >/dev/null
xdotool windowactivate --sync "$w2"; sleep 0.3
key alt+F4; sleep 1.5
prompts=0
for i in 1 2 3 4 5 6; do
  img=$(shot "close$i")
  if ocr_has "Unsaved Changes" "$img"; then prompts=$((prompts + 1)); key n; sleep 1.2; else break; fi
done
note "unsaved prompts answered: $prompts"
expect "closing the second window prompted for unsaved changes" test $prompts -ge 1
gone=1; xdotool search --onlyvisible --name . 2>/dev/null | grep -qx "$w2" && gone=0
expect "second window closed after Don't Save" test $gone = 1
expect "main window still alive" main_window
expect "W2EDIT not written to disk" bash -c "! grep -q W2EDIT '$VAULT/plain.md'"
[ $prompts -gt 1 ] && note "side note: $prompts prompts for one edit (window copies the main window's tabs)"
finish "second window asks before dropping edits"
