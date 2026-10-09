# Genuine external change → dialog → Reload from Disk; afterwards typing and
# window switches raise no further dialog.
start_on index.md || fail "app did not start"
key ctrl+End; typ " dirty"; sleep 1
printf '\nEXTERNAL-L15B\n' >>"$VAULT/index.md"
seen=0
for i in 1 2 3 4 5 6 7 8; do file_changed_dialog genuine && { seen=1; break; }; sleep 1; done
expect "genuine change raises the dialog" test $seen = 1
ocr_click "Reload from Disk" || ocr_click "Reload" || note "no Reload button"
sleep 1.5
for n in 1 2 3; do
  focus_main; click_editor 1300 600; key ctrl+End
  typ " rl$n"; sleep 2.5
  away 2; focus_main; click_editor 1300 600; key ctrl+End
  typ " more$n"; sleep 3
  if file_changed_dialog "cycle$n"; then FAILS+=("false dialog in cycle $n"); key Escape; fi
done
txt=$(editor_text)
expect "reload took the disk text (EXTERNAL-L15B in editor)" contains "$txt" "EXTERNAL-L15B"
for n in 1 2 3; do expect "rl$n/more$n landed" bash -c "[[ \"\$1\" == *rl$n* && \"\$1\" == *more$n* ]]" _ "$txt"; done
finish "no false dialog after reload"
