# Quick Capture files a note; afterwards Ctrl+Q exits the whole app (no
# hidden capture window keeping it alive) and a relaunch shows a window.
start_on index.md || fail "app did not start"
palette "Quick Capture"
w=$(wait_window 'Quick Capture' 10) || { shot noqc >/dev/null; fail "Quick Capture window did not open"; }
sleep 1; shot qc >/dev/null
xdotool windowactivate --sync "$w" 2>/dev/null; sleep 0.3
typ "captured L13 note"; key Return; sleep 2
f=$(grep -rl "captured L13 note" "$VAULT/inbox" 2>/dev/null | head -1)
note "captured file: ${f:-none}"
expect "capture written to inbox/" test -n "$f"
app_quit 10; q=$?
left=$(our_app_pids | tr '\n' ' ')
note "processes after Ctrl+Q: ${left:-none}"
expect "Ctrl+Q after Quick Capture exits every process" test "$q" -eq 0
app_kill
app_launch || { shot relaunch >/dev/null; FAILS+=("relaunch shows a window"); finish x; }
shot relaunch >/dev/null
expect "relaunch shows the main window" main_window
finish "quick capture + quit + relaunch OK"
