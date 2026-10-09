# No false "File Changed on Disk": restored dirty session + window switches.
start_on index.md || fail "app did not start"
key ctrl+End; typ " rs0"; sleep 1
app_quit 10 || app_kill
app_launch || fail "relaunch failed"
wait_title '^index\.md — SoloMD$' 10
for n in 1 2 3 4; do
  away 2.2
  focus_main; click_editor 1300 600; key ctrl+End
  typ " rs$n"; sleep 2.2
  if file_changed_dialog "round$n"; then FAILS+=("false File Changed dialog in round $n"); note "dialog in round $n"; key Escape; fi
done
txt=$(editor_text)
for n in 0 1 2 3 4; do expect "rs$n landed" contains "$txt" "rs$n"; done
finish "no false dialog after restore"
