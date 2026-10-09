# No false dialog while typing into a note the app just created
# (New Note in Selected Folder, Ctrl+Alt+Shift+N).
start_on index.md || fail "app did not start"
key ctrl+alt+shift+n; sleep 1.2
shot nameprompt >/dev/null
typ "fresh1"; key Return; sleep 1.5
f=$(find "$VAULT" -name 'fresh1*.md' | head -1)
note "created: ${f:-none}; title: $(main_title)"
[ -n "$f" ] || { shot nofile >/dev/null; fail "New Note in Selected Folder did not create fresh1.md"; }
typ "nofocus-probe"; sleep 0.5
shot afternew >/dev/null
click_editor 1300 300; key ctrl+End
typ " typed1"; sleep 2.5
away 2.5; focus_main; click_editor 1300 300; key ctrl+End
typ " typed2"; sleep 2.5
key ctrl+s; sleep 1; typ " typed3"; sleep 3
key ctrl+s; sleep 1.5
if file_changed_dialog final; then FAILS+=("false File Changed dialog on the new note"); fi
disk=$(cat "$f")
note "disk: $disk"
expect "all typing saved (typed1..3)" bash -c "[[ \"\$1\" == *typed1* && \"\$1\" == *typed2* && \"\$1\" == *typed3* ]]" _ "$disk"
contains "$disk" "nofocus-probe" || note "side note: text typed right after creating the note (before any click) did not land"
finish "no false dialog on a new note"
