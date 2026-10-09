# Ctrl+Shift+Z is redo and does not start a pomodoro.
start_on plain.md || fail "app did not start"
key ctrl+End; typ " REDOME"; sleep 0.8
key ctrl+z; sleep 0.5
t1=$(editor_text)
key ctrl+shift+z; sleep 1
t2=$(editor_text)
img=$(shot after)
expect "Ctrl+Z undid the typing" bash -c "[[ \"\$1\" != *REDOME* ]]" _ "$t1"
expect "Ctrl+Shift+Z redid it" contains "$t2" "REDOME"
expect "no pomodoro timer on screen (no mm:ss countdown)" bash -c "! python3 '$RG_SUITE/lib/ocr.py' text '$img' eng | grep -Eq '\b(2[0-9]|[0-9]):[0-5][0-9]\b'"
app_quit 10 || app_kill
expect "no pomodoro state persisted" bash -c "! python3 '$RG_SUITE/lib/ls.py' get '$LS_DB' solomd.pomodoro.state.v1 >/dev/null"
finish "redo is redo"
