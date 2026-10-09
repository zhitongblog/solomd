# Ctrl+Shift+S → GTK Save dialog → new name: byte-identical copy, tab renamed.
start_on index.md || fail "app did not start"
key ctrl+shift+s
gtk_save "$VAULT/saveas-copy.md" || { shot dialog >/dev/null; fail "could not drive the Save As dialog"; }
sleep 1.5
shot after >/dev/null
expect "saveas-copy.md written" test -f "$VAULT/saveas-copy.md"
expect "byte-identical to index.md" cmp -s "$VAULT/index.md" "$VAULT/saveas-copy.md"
expect "window title follows (saveas-copy.md — SoloMD)" wait_title '^saveas-copy\.md — SoloMD$' 5
# a later save goes to the new file, not the old one
key ctrl+End; typ "AFTER-SAVEAS"; key ctrl+s; sleep 1.5
expect "next Ctrl+S writes the new file" grep -q AFTER-SAVEAS "$VAULT/saveas-copy.md"
expect "original left untouched" bash -c "! grep -q AFTER-SAVEAS '$VAULT/index.md'"
finish "save-as wrote a copy and retargeted the tab"
