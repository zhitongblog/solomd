# Ctrl+N → new untitled tab with keyboard focus in its editor (no click).
start_on index.md || fail "app did not start"
key ctrl+n
wait_title '^Untitled' 5 || { shot nonew >/dev/null; fail "Ctrl+N: no Untitled tab (title: $(main_title))"; }
note "title: $(main_title)"
typ "NEWFILE-L06"
sleep 0.5
shot typed >/dev/null
txt=$(editor_text)
note "editor text: $(printf '%s' "$txt" | head -c 80)"
expect "typed text landed in the new note without a click" test "$txt" = "NEWFILE-L06"
finish "new note focused"
